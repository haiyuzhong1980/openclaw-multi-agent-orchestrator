/**
 * Transport Layer — Abstract interface for inter-agent communication.
 *
 * Design principles:
 * - Pluggable transport implementations (File, P2P, etc.)
 * - Async-first API for network transports
 * - ACK mechanism for reliable delivery
 * - Message expiration for cleanup
 */

import type { TeamMessage, MessageType } from "./types.ts";
import { loggers, ErrorCode } from "./errors.ts";
import { sanitizePathPart, generateMessageId, withRetry } from "./utils.ts";

// ============================================================================
// Transport Interface
// ============================================================================

/**
 * Configuration for a transport instance.
 */
export interface TransportConfig {
  sharedRoot: string;
  teamName: string | null;
  agentId: string;
  /** Message TTL in milliseconds (default: 24 hours) */
  messageTtlMs?: number;
  /** Enable ACK mechanism */
  enableAck?: boolean;
}

/**
 * Message with delivery status.
 */
export interface Envelope {
  message: TeamMessage;
  status: "pending" | "delivered" | "acknowledged" | "expired";
  deliveredAt?: string;
  acknowledgedAt?: string;
}

/**
 * Abstract transport interface.
 * Implementations: FileTransport, P2PTransport, etc.
 */
export interface Transport {
  /** Transport type identifier */
  readonly type: string;

  /** Initialize the transport */
  initialize(): Promise<void>;

  /** Send a message */
  send(message: Omit<TeamMessage, "id" | "timestamp">): Promise<TeamMessage>;

  /** Receive pending messages */
  receive(): Promise<TeamMessage[]>;

  /** Acknowledge a message was processed */
  ack(messageId: string): Promise<boolean>;

  /** Get message history (processed messages) */
  history(limit?: number): Promise<TeamMessage[]>;

  /** Clean up expired messages */
  cleanup(): Promise<number>;

  /** Close the transport */
  close(): Promise<void>;
}

// ============================================================================
// FileTransport Implementation
// ============================================================================

import {
  existsSync,
  mkdirSync,
  promises as fs,
} from "node:fs";
import { join } from "node:path";

const INBOX_DIR = "inbox";
const PENDING_DIR = "pending";
const PROCESSED_DIR = "processed";
const CLAIMING_DIR = "claiming"; // Directory for atomically claimed messages
const EVENTS_LOG = "events.log";

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const CLAIM_TIMEOUT_MS = 60 * 1000; // 1 minute - after this, claimed messages can be recovered
const MAX_RETRY_ATTEMPTS = 3; // Maximum retry attempts for operations
const RETRY_DELAY_MS = 10; // Delay between retries

/**
 * File-based transport using the filesystem as message queue.
 * Messages are stored as JSON files in directory structure.
 * 
 * Uses async fs.promises API to avoid blocking the main thread.
 */
export class FileTransport implements Transport {
  readonly type = "file";

  private config: Required<TransportConfig>;
  private pendingPath: string;
  private processedPath: string;
  private claimingPath: string; // Path for claimed messages (atomic lock)
  private eventsLogPath: string;
  private inboxRoot: string;

  constructor(config: TransportConfig) {
    this.config = {
      messageTtlMs: DEFAULT_TTL_MS,
      enableAck: true,
      ...config,
    };

    // Sanitize path components to prevent path injection
    const teamDir = this.config.teamName 
      ? sanitizePathPart(this.config.teamName, "teamName") 
      : "_default";
    const safeAgentId = sanitizePathPart(this.config.agentId, "agentId");
    
    this.inboxRoot = join(this.config.sharedRoot, INBOX_DIR, teamDir, safeAgentId);
    this.pendingPath = join(this.inboxRoot, PENDING_DIR);
    this.processedPath = join(this.inboxRoot, PROCESSED_DIR);
    this.claimingPath = join(this.inboxRoot, CLAIMING_DIR);
    this.eventsLogPath = join(this.inboxRoot, EVENTS_LOG);
  }

  async initialize(): Promise<void> {
    // Create all required directories
    if (!existsSync(this.pendingPath)) {
      await fs.mkdir(this.pendingPath, { recursive: true });
    }
    if (!existsSync(this.processedPath)) {
      await fs.mkdir(this.processedPath, { recursive: true });
    }
    if (!existsSync(this.claimingPath)) {
      await fs.mkdir(this.claimingPath, { recursive: true });
    }
  }

  async send(message: Omit<TeamMessage, "id" | "timestamp">): Promise<TeamMessage> {
    const fullMessage: TeamMessage = {
      id: generateMessageId(),
      timestamp: new Date().toISOString(),
      ...message,
    };

    // Broadcast messages go to _broadcast directory
    if (message.to === null) {
      const broadcastPath = join(
        this.config.sharedRoot,
        INBOX_DIR,
        this.config.teamName 
          ? sanitizePathPart(this.config.teamName, "teamName") 
          : "_default",
        "_broadcast"
      );
      if (!existsSync(broadcastPath)) {
        await fs.mkdir(broadcastPath, { recursive: true });
      }
      await fs.writeFile(
        join(broadcastPath, `${fullMessage.id}.json`), 
        JSON.stringify(fullMessage, null, 2), 
        "utf-8"
      );
      return fullMessage;
    }

    // Direct message to target agent - sanitize the recipient agent ID
    const safeToAgentId = sanitizePathPart(message.to, "recipient agentId");
    const targetInbox = join(
      this.config.sharedRoot,
      INBOX_DIR,
      this.config.teamName 
        ? sanitizePathPart(this.config.teamName, "teamName") 
        : "_default",
      safeToAgentId,
      PENDING_DIR
    );

    if (!existsSync(targetInbox)) {
      await fs.mkdir(targetInbox, { recursive: true });
    }

    const filePath = join(targetInbox, `${fullMessage.id}.json`);
    await fs.writeFile(filePath, JSON.stringify(fullMessage, null, 2), "utf-8");

    // Log send event
    await this.logEvent(`SEND ${message.type} to=${message.to} id=${fullMessage.id}`);

    return fullMessage;
  }

  /**
   * Atomically claim a message by moving it to the claiming directory.
   * Uses rename which is atomic on POSIX systems when source and dest
   * are on the same filesystem.
   * 
   * @returns true if claim succeeded, false if message already claimed or doesn't exist
   */
  private async claimMessage(messageId: string): Promise<boolean> {
    const pendingFile = join(this.pendingPath, `${messageId}.json`);
    const claimedFile = join(this.claimingPath, `${messageId}.json`);
    
    try {
      // Atomic rename: if this succeeds, we own the message
      // If it fails (ENOENT), another process claimed it or it was deleted
      await fs.rename(pendingFile, claimedFile);
      return true;
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        // File doesn't exist - already claimed or deleted by another process
        return false;
      }
      // Other errors (permissions, etc.) - log and return false
      await this.logEvent(`CLAIM_ERROR ${messageId} error=${code}`);
      return false;
    }
  }

  /**
   * Recover stale claimed messages back to pending.
   * Called during receive() to handle messages that were claimed but never acked.
   */
  private async recoverStaleClaims(): Promise<void> {
    if (!existsSync(this.claimingPath)) {
      return;
    }

    const now = Date.now();
    const files = (await fs.readdir(this.claimingPath)).filter((f) => f.endsWith(".json"));

    for (const file of files) {
      try {
        const claimedFile = join(this.claimingPath, file);
        const stat = await fs.stat(claimedFile);
        const claimAge = now - stat.mtimeMs;

        // If claimed more than CLAIM_TIMEOUT_MS ago, return to pending
        if (claimAge > CLAIM_TIMEOUT_MS) {
          const pendingFile = join(this.pendingPath, file);
          try {
            await fs.rename(claimedFile, pendingFile);
            await this.logEvent(`RECOVERED_STALE_CLAIM ${file}`);
          } catch (renameError) {
            // If recovery fails, delete the stale claim
            try {
              await fs.unlink(claimedFile);
            } catch (unlinkError) {
              // Cleanup failed - log for debugging
              loggers.transport.debug(`Failed to delete stale claim during recovery`, { file, error: String(unlinkError) });
            }
          }
        }
      } catch (statError) {
        // Skip files that can't be stat'd
        loggers.transport.debug(`Could not stat claimed file`, { file, error: String(statError) });
      }
    }
  }

  /**
   * Receive pending messages using atomic claim mechanism.
   * 
   * This method atomically claims messages before returning them,
   * preventing race conditions where multiple processes could process
   * the same message.
   * 
   * Flow:
   * 1. Recover any stale claims (messages claimed but never acked)
   * 2. For each pending message, atomically rename to claiming dir
   * 3. Only return messages we successfully claimed
   * 4. Messages remain in claiming dir until ack() is called
   */
  async receive(): Promise<TeamMessage[]> {
    // Ensure claiming directory exists
    if (!existsSync(this.claimingPath)) {
      await fs.mkdir(this.claimingPath, { recursive: true });
    }

    // First, recover any stale claims that timed out
    await this.recoverStaleClaims();

    if (!existsSync(this.pendingPath)) {
      return [];
    }

    const files = (await fs.readdir(this.pendingPath)).filter((f) => f.endsWith(".json"));
    const messages: TeamMessage[] = [];

    for (const file of files) {
      // Extract message ID from filename (remove .json extension)
      const messageId = file.slice(0, -5);

      try {
        // Attempt to atomically claim this message
        if (!(await this.claimMessage(messageId))) {
          // Another process claimed it or it was deleted - skip
          continue;
        }

        // We successfully claimed it - read the message
        const claimedFile = join(this.claimingPath, file);
        const content = await fs.readFile(claimedFile, "utf-8");
        const msg = JSON.parse(content) as TeamMessage;

        // Check for expiration
        if (this.isExpired(msg)) {
          // Delete expired message
          try {
            await fs.unlink(claimedFile);
          } catch (cleanupError) {
            // Ignore cleanup errors but log for debugging
            loggers.transport.debug(`Failed to delete expired message file`, { file, error: String(cleanupError) });
          }
          await this.logEvent(`EXPIRED ${msg.id}`);
          continue;
        }

        messages.push(msg);
        await this.logEvent(`CLAIMED ${msg.id}`);
      } catch (error: unknown) {
        // If we claimed but couldn't read, try to recover the file back to pending
        const claimedFile = join(this.claimingPath, file);
        const pendingFile = join(this.pendingPath, file);
        try {
          if (existsSync(claimedFile)) {
            await fs.rename(claimedFile, pendingFile);
          }
        } catch (recoverError) {
          // If recovery fails, delete the corrupted claim
          try {
            await fs.unlink(claimedFile);
          } catch (unlinkError) {
            // Ignore cleanup errors but log
            loggers.transport.debug(`Failed to delete corrupted claim`, { file, error: String(unlinkError) });
          }
        }
        // Skip invalid files
        loggers.transport.warn(`Failed to process claimed message`, { file, error: String(error) });
      }
    }

    // Sort by timestamp (oldest first)
    messages.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    return messages;
  }

  /**
   * Acknowledge a message was processed.
   * 
   * This method atomically moves a claimed message to the processed directory.
   * The message must have been previously claimed via receive().
   * 
   * Flow:
   * 1. Check claiming directory first (message was claimed by this process)
   * 2. Atomically rename from claiming to processed
   * 3. Update with ACK timestamp
   * 
   * @returns true if ack succeeded, false if message not found in claiming
   */
  async ack(messageId: string): Promise<boolean> {
    const claimedFile = join(this.claimingPath, `${messageId}.json`);
    const processedFile = join(this.processedPath, `${messageId}.json`);

    // Check if message is in claiming directory (was claimed by this or another process)
    if (!existsSync(claimedFile)) {
      // Message not in claiming - could be:
      // 1. Never claimed (invalid ack call)
      // 2. Already processed
      // 3. Claimed by another process that recovered it
      await this.logEvent(`ACK_NOT_FOUND ${messageId}`);
      return false;
    }

    // Ensure processed directory exists
    if (!existsSync(this.processedPath)) {
      await fs.mkdir(this.processedPath, { recursive: true });
    }

    try {
      // Atomically move from claiming to processed
      // This is the critical section - rename is atomic
      await fs.rename(claimedFile, processedFile);

      // Update envelope with ACK timestamp (best effort, not critical)
      try {
        const content = await fs.readFile(processedFile, "utf-8");
        const msg = JSON.parse(content);
        msg._acknowledgedAt = new Date().toISOString();
        await fs.writeFile(processedFile, JSON.stringify(msg, null, 2), "utf-8");
      } catch (updateError) {
        // Ignore update errors - the message is already moved
        loggers.transport.debug(`Failed to update ACK timestamp`, { messageId, error: String(updateError) });
      }

      await this.logEvent(`ACK ${messageId}`);
      return true;
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code;
      
      // If rename failed, the file might have been moved by another process
      // or there was a filesystem error
      await this.logEvent(`ACK_ERROR ${messageId} error=${code}`);
      
      // Check if file still exists in claiming (our claim)
      if (existsSync(claimedFile)) {
        // We still have the claim, try to recover to pending
        try {
          const pendingFile = join(this.pendingPath, `${messageId}.json`);
          await fs.rename(claimedFile, pendingFile);
          await this.logEvent(`ACK_RECOVERED ${messageId}`);
        } catch (recoverError) {
          // Last resort - delete the claim
          try {
            await fs.unlink(claimedFile);
          } catch (unlinkError) {
            // Ignore cleanup errors but log
            loggers.transport.debug(`Failed to delete claim during ACK recovery`, { messageId, error: String(unlinkError) });
          }
        }
      }
      
      return false;
    }
  }

  async history(limit: number = 50): Promise<TeamMessage[]> {
    if (!existsSync(this.processedPath)) {
      return [];
    }

    const files = (await fs.readdir(this.processedPath))
      .filter((f) => f.endsWith(".json"))
      .slice(0, limit);

    const messages: TeamMessage[] = [];

    for (const file of files) {
      try {
        const content = await fs.readFile(join(this.processedPath, file), "utf-8");
        messages.push(JSON.parse(content) as TeamMessage);
      } catch (error) {
        // Skip invalid files but log
        loggers.transport.warn(`Failed to read processed message`, { file, error: String(error) });
      }
    }

    // Sort by timestamp (newest first for history)
    messages.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    return messages;
  }

  /**
   * Clean up expired messages and stale claims.
   * 
   * Cleans:
   * 1. Expired pending messages
   * 2. Stale claimed messages (timeout exceeded)
   * 3. Old processed messages
   */
  async cleanup(): Promise<number> {
    let cleaned = 0;

    // Clean expired pending messages
    if (existsSync(this.pendingPath)) {
      const files = (await fs.readdir(this.pendingPath)).filter((f) => f.endsWith(".json"));
      for (const file of files) {
        try {
          const content = await fs.readFile(join(this.pendingPath, file), "utf-8");
          const msg = JSON.parse(content) as TeamMessage;
          if (this.isExpired(msg)) {
            await fs.unlink(join(this.pendingPath, file));
            cleaned++;
          }
        } catch (error) {
          // Skip invalid files but log
          loggers.transport.debug(`Failed to process pending message during cleanup`, { file, error: String(error) });
        }
      }
    }

    // Clean stale claimed messages (timeout exceeded)
    if (existsSync(this.claimingPath)) {
      const now = Date.now();
      const files = (await fs.readdir(this.claimingPath)).filter((f) => f.endsWith(".json"));
      for (const file of files) {
        try {
          const claimedFile = join(this.claimingPath, file);
          const stat = await fs.stat(claimedFile);
          const claimAge = now - stat.mtimeMs;
          
          if (claimAge > CLAIM_TIMEOUT_MS) {
            // Delete stale claims (they will be recovered by receive() if still valid)
            await fs.unlink(claimedFile);
            cleaned++;
            await this.logEvent(`CLEANUP_STALE_CLAIM ${file}`);
          }
        } catch (statError) {
          // Skip files that can't be stat'd
          loggers.transport.debug(`Could not stat claimed file during cleanup`, { file, error: String(statError) });
        }
      }
    }

    // Clean old processed messages (older than TTL * 2)
    const doubleTtl = this.config.messageTtlMs * 2;
    if (existsSync(this.processedPath)) {
      const files = (await fs.readdir(this.processedPath)).filter((f) => f.endsWith(".json"));
      for (const file of files) {
        try {
          const stat = await fs.stat(join(this.processedPath, file));
          const age = Date.now() - stat.mtimeMs;
          if (age > doubleTtl) {
            await fs.unlink(join(this.processedPath, file));
            cleaned++;
          }
        } catch (statError) {
          // Skip files that can't be stat'd
          loggers.transport.debug(`Could not stat processed file during cleanup`, { file, error: String(statError) });
        }
      }
    }

    if (cleaned > 0) {
      await this.logEvent(`CLEANUP removed=${cleaned}`);
    }

    return cleaned;
  }

  async close(): Promise<void> {
    // No persistent resources to close for file transport
  }

  private isExpired(message: TeamMessage): boolean {
    const age = Date.now() - new Date(message.timestamp).getTime();
    return age > this.config.messageTtlMs;
  }

  private async logEvent(event: string): Promise<void> {
    try {
      if (!existsSync(this.inboxRoot)) {
        await fs.mkdir(this.inboxRoot, { recursive: true });
      }
      await fs.appendFile(this.eventsLogPath, `${new Date().toISOString()} ${event}\n`, "utf-8");
    } catch (error) {
      // Log errors to console instead of silently swallowing
      loggers.transport.error(`Failed to write to event log`, error, { event });
    }
  }
}

// ============================================================================
// Transport Factory
// ============================================================================

/**
 * Create a transport instance based on configuration.
 */
export function createTransport(type: "file" | "p2p", config: TransportConfig): Transport {
  switch (type) {
    case "file":
      return new FileTransport(config);
    case "p2p":
      throw new Error("P2PTransport not yet implemented");
    default:
      throw new Error(`Unknown transport type: ${type}`);
  }
}
