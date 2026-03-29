import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, promises as fs } from "node:fs";
import { join } from "node:path";
import { ACTION_VERBS, ESCALATION_SIGNALS, DE_ESCALATION_SIGNALS } from "./constants.ts";
import { loggers, ErrorCode } from "./errors.ts";
import { generateObservationId, getHoursAgoCutoff, getDaysAgoCutoff } from "./utils.ts";

// Re-export for backward compatibility
export { generateObservationId };

/**
 * Persistence configuration options.
 */
export interface PersistenceConfig {
  /** Flush buffer immediately after each update (default: false) */
  flushOnUpdate?: boolean;
  /** Enable periodic flush at specified interval in ms (default: 30000 = 30 seconds) */
  periodicFlushInterval?: number;
  /** Enable graceful shutdown hooks (default: true) */
  enableShutdownHooks?: boolean;
}

export interface ObservationRecord {
  id: string;                    // unique ID (timestamp + random)
  timestamp: string;             // ISO8601
  agent: string;                 // which agent received the message

  // User message features
  messageText: string;           // first 200 chars
  messageLength: number;
  language: "zh" | "en" | "mixed";
  hasNumberedList: boolean;
  actionVerbCount: number;

  // OMA classification
  predictedTier: "light" | "tracked" | "delegation";

  // Outcome (filled asynchronously)
  toolsCalled: string[];
  didSpawnSubagent: boolean;
  spawnCount: number;

  // User feedback (filled on next message)
  userFollowUp: "satisfied" | "corrected_up" | "corrected_down" | "continued" | null;
  actualTier: "light" | "tracked" | "delegation" | null;
}

export interface ObservationStats {
  totalObservations: number;
  last24h: number;
  last7d: number;
  tierDistribution: { light: number; tracked: number; delegation: number };
  accuracy: number;              // % where predicted == actual (from corrections)
  correctionRate: number;        // % of messages that got corrected
  topMispredictions: Array<{ text: string; predicted: string; actual: string }>;
}

const OBS_FILE = "observation-log.jsonl";
const INDEX_FILE = "observation-index.json";
const MAX_AGE_DAYS = 30;

// ACTION_VERBS, ESCALATION_SIGNALS, DE_ESCALATION_SIGNALS imported from constants.ts

const SATISFACTION_SIGNALS: RegExp[] = [
  /^(ok|好|好的|嗯|可以|行|收到|明白|对|是的|nice|great|perfect|thanks|谢谢)[\s!！.。]*$/i,
];

// In-memory buffer for recent observations
let recentBuffer: ObservationRecord[] = [];
let bufferDirty = false;

// ============================================================================
// CACHE LAYER for loadRecentObservations
// ============================================================================

interface ObservationCache {
  /** Cached records by hour bucket */
  hourlyBuckets: Map<string, ObservationRecord[]>;
  /** File modification time when cache was built */
  fileMtime: number;
  /** Total records in cache */
  totalRecords: number;
  /** Cache hit count for metrics */
  hitCount: number;
  /** Cache miss count for metrics */
  missCount: number;
}

// Global cache instance
let observationCache: ObservationCache = {
  hourlyBuckets: new Map(),
  fileMtime: 0,
  totalRecords: 0,
  hitCount: 0,
  missCount: 0,
};

/**
 * Get hour bucket key from timestamp.
 * Format: YYYY-MM-DD-HH
 */
function getHourBucket(timestamp: string): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}-${String(date.getHours()).padStart(2, "0")}`;
}

/**
 * Build cache from file.
 * Reads the JSONL file and organizes records by hour bucket.
 */
function buildCache(filePath: string): void {
  try {
    const stat = require("fs").statSync(filePath);
    const mtime = stat.mtimeMs;
    
    // Check if cache is still valid
    if (observationCache.fileMtime === mtime && observationCache.totalRecords > 0) {
      return; // Cache is fresh
    }
    
    const raw = readFileSync(filePath, "utf-8");
    const lines = raw.split("\n").filter((l: string) => l.trim().length > 0);
    
    const newBuckets = new Map<string, ObservationRecord[]>();
    let total = 0;
    
    for (const line of lines) {
      try {
        const rec = JSON.parse(line) as ObservationRecord;
        const bucket = getHourBucket(rec.timestamp);
        
        if (!newBuckets.has(bucket)) {
          newBuckets.set(bucket, []);
        }
        newBuckets.get(bucket)!.push(rec);
        total++;
      } catch {
        // Skip malformed lines
      }
    }
    
    observationCache = {
      hourlyBuckets: newBuckets,
      fileMtime: mtime,
      totalRecords: total,
      hitCount: 0,
      missCount: 0,
    };
  } catch {
    // File doesn't exist or can't be read - reset cache
    observationCache = {
      hourlyBuckets: new Map(),
      fileMtime: 0,
      totalRecords: 0,
      hitCount: 0,
      missCount: 0,
    };
  }
}

/**
 * Get cache statistics.
 */
export function getCacheStats(): { hitRate: number; totalRecords: number; bucketCount: number } {
  const total = observationCache.hitCount + observationCache.missCount;
  return {
    hitRate: total > 0 ? observationCache.hitCount / total : 0,
    totalRecords: observationCache.totalRecords,
    bucketCount: observationCache.hourlyBuckets.size,
  };
}

/**
 * Invalidate the cache.
 * Call this after modifying the observation file.
 */
export function invalidateCache(): void {
  observationCache.fileMtime = 0;
}

// ============================================================================
// Persistence configuration
// ============================================================================

let persistenceConfig: PersistenceConfig = {
  flushOnUpdate: false,
  periodicFlushInterval: 30000,
  enableShutdownHooks: true,
};

// Timer and state for periodic flush
let periodicFlushTimer: ReturnType<typeof setInterval> | null = null;
let shutdownHooksRegistered = false;
let currentSharedRoot: string | null = null;

/**
 * Initialize the observation engine with persistence configuration.
 * Must be called before any observation operations if you want custom persistence behavior.
 * 
 * @param sharedRoot - The shared root directory for observation files
 * @param config - Persistence configuration options
 */
export function initObservationEngine(sharedRoot: string, config?: PersistenceConfig): void {
  currentSharedRoot = sharedRoot;
  
  if (config) {
    persistenceConfig = { ...persistenceConfig, ...config };
  }
  
  // Register shutdown hooks if enabled
  if (persistenceConfig.enableShutdownHooks && !shutdownHooksRegistered) {
    registerShutdownHooks();
    shutdownHooksRegistered = true;
  }
  
  // Start periodic flush timer if interval > 0
  if (persistenceConfig.periodicFlushInterval && persistenceConfig.periodicFlushInterval > 0) {
    startPeriodicFlush();
  }
}

/**
 * Register shutdown hooks to ensure buffer is flushed before exit.
 */
function registerShutdownHooks(): void {
  const flushAndExit = (signal: string) => {
    if (currentSharedRoot && bufferDirty) {
      try {
        flushBuffer(currentSharedRoot);
      } catch (err) {
        // Best effort flush - don't throw during shutdown
        console.error(`[observation-engine] Error flushing during ${signal}:`, err);
      }
    }
    process.exit(0);
  };
  
  // Handle normal exit
  process.on("exit", () => {
    if (currentSharedRoot && bufferDirty) {
      try {
        flushBuffer(currentSharedRoot);
      } catch (err) {
        console.error("[observation-engine] Error flushing on exit:", err);
      }
    }
  });
  
  // Handle termination signals
  process.on("SIGINT", () => flushAndExit("SIGINT"));
  process.on("SIGTERM", () => flushAndExit("SIGTERM"));
  
  // Handle uncaught exceptions - flush before crash
  process.on("uncaughtException", (err) => {
    console.error("[observation-engine] Uncaught exception, attempting flush:", err);
    if (currentSharedRoot && bufferDirty) {
      try {
        flushBuffer(currentSharedRoot);
      } catch (flushErr) {
        console.error("[observation-engine] Error flushing during exception:", flushErr);
      }
    }
    // Re-throw to let the process crash
    throw err;
  });
}

/**
 * Start the periodic flush timer.
 */
function startPeriodicFlush(): void {
  if (periodicFlushTimer) {
    clearInterval(periodicFlushTimer);
  }
  
  const interval = persistenceConfig.periodicFlushInterval ?? 30000;
  periodicFlushTimer = setInterval(() => {
    if (currentSharedRoot && bufferDirty) {
      try {
        flushBuffer(currentSharedRoot);
      } catch (err) {
        console.error("[observation-engine] Error during periodic flush:", err);
      }
    }
  }, interval);
  
  // Allow the process to exit even if this timer is active
  if (periodicFlushTimer.unref) {
    periodicFlushTimer.unref();
  }
}

/**
 * Stop the periodic flush timer.
 */
export function stopPeriodicFlush(): void {
  if (periodicFlushTimer) {
    clearInterval(periodicFlushTimer);
    periodicFlushTimer = null;
  }
}

/**
 * Manually flush the buffer and optionally stop periodic flush.
 * Call this for graceful shutdown.
 */
export function shutdown(sharedRoot?: string): void {
  const root = sharedRoot ?? currentSharedRoot;
  if (root && bufferDirty) {
    flushBuffer(root);
  }
  stopPeriodicFlush();
}

/**
 * Check if the engine has been initialized.
 */
export function isInitialized(): boolean {
  return currentSharedRoot !== null;
}

/**
 * Get current persistence configuration.
 */
export function getPersistenceConfig(): Readonly<PersistenceConfig> {
  return { ...persistenceConfig };
}

/**
 * Update persistence configuration at runtime.
 * Note: Changes to periodicFlushInterval will restart the timer if it's running.
 * 
 * @param config - Partial configuration to update
 */
export function setPersistenceConfig(config: Partial<PersistenceConfig>): void {
  const wasPeriodicRunning = periodicFlushTimer !== null;
  
  persistenceConfig = { ...persistenceConfig, ...config };
  
  // Restart periodic flush if interval changed and timer was running
  if (wasPeriodicRunning && config.periodicFlushInterval !== undefined) {
    startPeriodicFlush();
  }
}

/**
 * Force an immediate flush using the tracked sharedRoot.
 * Useful for manual control over persistence timing.
 * 
 * @returns true if flush was performed, false if no sharedRoot or buffer not dirty
 */
export function forceFlush(): boolean {
  if (!currentSharedRoot || !bufferDirty) {
    return false;
  }
  flushBuffer(currentSharedRoot);
  return true;
}

/**
 * Ensure shutdown hooks are registered.
 * Called automatically when needed if not explicitly initialized.
 */
function ensureShutdownHooks(): void {
  if (persistenceConfig.enableShutdownHooks && !shutdownHooksRegistered) {
    registerShutdownHooks();
    shutdownHooksRegistered = true;
  }
}

/**
 * Detect language of a message.
 */
export function detectLanguage(text: string): "zh" | "en" | "mixed" {
  if (!text) return "en";
  const cjkCount = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f]/g) ?? []).length;
  const latinCount = (text.match(/[a-zA-Z]/g) ?? []).length;
  const total = cjkCount + latinCount;
  if (total === 0) return "en";
  const cjkRatio = cjkCount / total;
  const latinRatio = latinCount / total;
  if (cjkRatio > 0.7) return "zh";
  if (latinRatio > 0.7) return "en";
  return "mixed";
}

/**
 * Count action verbs in a message.
 */
export function countActionVerbs(text: string): number {
  const lower = text.toLowerCase();
  const matched = ACTION_VERBS.filter((v) => lower.includes(v.toLowerCase()));
  return new Set(matched).size;
}

/**
 * Check if message contains a numbered list.
 */
export function hasNumberedList(text: string): boolean {
  const matches = text.match(/(?:^|\n)\s*[0-9]+[.、)）]/gm);
  return matches !== null && matches.length >= 3;
}

/**
 * Create a new observation record from a user message.
 */
export function createObservation(params: {
  message: string;
  agent: string;
  predictedTier: "light" | "tracked" | "delegation";
}): ObservationRecord {
  const { message, agent, predictedTier } = params;
  return {
    id: generateObservationId(),
    timestamp: new Date(Date.now()).toISOString(),
    agent,
    messageText: message.slice(0, 200),
    messageLength: message.length,
    language: detectLanguage(message),
    hasNumberedList: hasNumberedList(message),
    actionVerbCount: countActionVerbs(message),
    predictedTier,
    toolsCalled: [],
    didSpawnSubagent: false,
    spawnCount: 0,
    userFollowUp: null,
    actualTier: null,
  };
}

/**
 * Append an observation to the log file (JSONL format).
 */
export function appendObservation(sharedRoot: string, record: ObservationRecord): void {
  const filePath = join(sharedRoot, OBS_FILE);
  if (!existsSync(sharedRoot)) {
    mkdirSync(sharedRoot, { recursive: true });
  }
  appendFileSync(filePath, JSON.stringify(record) + "\n", "utf-8");
  
  // Invalidate cache since file changed
  invalidateCache();

  // Track sharedRoot for shutdown hooks if not already set
  if (!currentSharedRoot) {
    currentSharedRoot = sharedRoot;
    // Auto-register shutdown hooks on first use
    ensureShutdownHooks();
  }

  // Keep a copy in the buffer for fast in-memory updates
  recentBuffer.push(record);
  if (recentBuffer.length > 20) {
    recentBuffer = recentBuffer.slice(recentBuffer.length - 20);
  }
}

/**
 * Get a buffered observation by ID.
 */
export function getBufferedObservation(id: string): ObservationRecord | undefined {
  return recentBuffer.find((r) => r.id === id);
}

/**
 * Flush the in-memory buffer back to disk by rewriting matching lines.
 * Reads the JSONL file, replaces lines whose IDs are in the buffer, writes back.
 */
export function flushBuffer(sharedRoot: string): void {
  if (!bufferDirty) return;
  const filePath = join(sharedRoot, OBS_FILE);
  if (!existsSync(filePath)) return;

  const bufferMap = new Map<string, ObservationRecord>();
  for (const rec of recentBuffer) {
    bufferMap.set(rec.id, rec);
  }

  const raw = readFileSync(filePath, "utf-8");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  const updated = lines.map((line) => {
    try {
      const rec = JSON.parse(line) as ObservationRecord;
      if (bufferMap.has(rec.id)) {
        return JSON.stringify(bufferMap.get(rec.id));
      }
      return line;
    } catch (error) {
      loggers.observation.debug(`Failed to parse observation line during flush`, { line: line.slice(0, 50), error: String(error) });
      return line;
    }
  });

  writeFileSync(filePath, updated.join("\n") + "\n", "utf-8");
  bufferDirty = false;
  
  // Invalidate cache since file changed
  invalidateCache();
}

/**
 * Update the most recent observation's outcome (tools called, spawn status).
 * Uses Option A: in-memory buffer with periodic flush.
 * 
 * @param sharedRoot - The shared root directory
 * @param observationId - The observation ID to update
 * @param outcome - The outcome data to merge
 * @param immediateFlush - Override config to force immediate flush (optional)
 */
export function updateObservationOutcome(
  sharedRoot: string,
  observationId: string,
  outcome: {
    toolsCalled?: string[];
    didSpawnSubagent?: boolean;
    spawnCount?: number;
  },
  immediateFlush?: boolean,
): void {
  const rec = recentBuffer.find((r) => r.id === observationId);
  if (!rec) return;

  if (outcome.toolsCalled !== undefined) {
    // Merge tool calls (accumulate across multiple after_tool_call events)
    const merged = new Set([...rec.toolsCalled, ...outcome.toolsCalled]);
    rec.toolsCalled = [...merged];
  }
  if (outcome.didSpawnSubagent !== undefined && outcome.didSpawnSubagent) {
    rec.didSpawnSubagent = true;
  }
  if (outcome.spawnCount !== undefined) {
    rec.spawnCount = rec.spawnCount + outcome.spawnCount;
  }
  bufferDirty = true;
  
  // Immediate flush if configured or explicitly requested
  if (immediateFlush === true || (immediateFlush === undefined && persistenceConfig.flushOnUpdate)) {
    flushBuffer(sharedRoot);
  }
}

/**
 * Update the most recent observation's user feedback.
 * 
 * @param sharedRoot - The shared root directory
 * @param observationId - The observation ID to update
 * @param feedback - The feedback data
 * @param immediateFlush - Override config to force immediate flush (optional)
 */
export function updateObservationFeedback(
  sharedRoot: string,
  observationId: string,
  feedback: {
    userFollowUp: "satisfied" | "corrected_up" | "corrected_down" | "continued";
    actualTier?: "light" | "tracked" | "delegation";
  },
  immediateFlush?: boolean,
): void {
  const rec = recentBuffer.find((r) => r.id === observationId);
  if (!rec) {
    // Not in buffer — fall back to disk scan of last 50 lines
    // Note: This fallback path writes directly to disk, so no flush needed
    const filePath = join(sharedRoot, OBS_FILE);
    if (!existsSync(filePath)) return;
    const raw = readFileSync(filePath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    const last50 = lines.slice(-50);
    const idx = last50.findIndex((l) => {
      try {
        return (JSON.parse(l) as ObservationRecord).id === observationId;
      } catch (error) {
        loggers.observation.debug(`Failed to parse line during feedback update`, { error: String(error) });
        return false;
      }
    });
    if (idx < 0) return;
    const target = JSON.parse(last50[idx]) as ObservationRecord;
    target.userFollowUp = feedback.userFollowUp;
    if (feedback.actualTier !== undefined) target.actualTier = feedback.actualTier;
    last50[idx] = JSON.stringify(target);
    const beginning = lines.slice(0, lines.length - last50.length);
    writeFileSync(filePath, [...beginning, ...last50].join("\n") + "\n", "utf-8");
    invalidateCache();
    return;
  }

  rec.userFollowUp = feedback.userFollowUp;
  if (feedback.actualTier !== undefined) {
    rec.actualTier = feedback.actualTier;
  }
  bufferDirty = true;
  
  // Immediate flush if configured or explicitly requested
  if (immediateFlush === true || (immediateFlush === undefined && persistenceConfig.flushOnUpdate)) {
    flushBuffer(sharedRoot);
  }
}

/**
 * Load recent observations (last N hours).
 * 
 * OPTIMIZED: Uses an in-memory cache with hour-based bucketing.
 * Instead of reading the entire file every time, we:
 * 1. Build a cache organized by hour buckets on first read
 * 2. Only read from the relevant hour buckets based on the cutoff
 * 3. Cache is invalidated when the file is modified
 * 
 * For large observation files, this can reduce read time from O(n) to O(1)
 * when the cache is hot.
 */
export function loadRecentObservations(sharedRoot: string, hours = 24): ObservationRecord[] {
  const filePath = join(sharedRoot, OBS_FILE);
  if (!existsSync(filePath)) return [];

  const cutoff = getHoursAgoCutoff(hours);
  
  // Build or refresh cache
  buildCache(filePath);
  
  // Calculate which hour buckets we need
  const now = new Date();
  const records: ObservationRecord[] = [];
  
  // Generate hour bucket keys for the requested time range
  for (let h = 0; h < hours; h++) {
    const bucketDate = new Date(now.getTime() - h * 60 * 60 * 1000);
    const bucketKey = getHourBucket(bucketDate.toISOString());
    
    const bucket = observationCache.hourlyBuckets.get(bucketKey);
    if (bucket) {
      observationCache.hitCount++;
      for (const rec of bucket) {
        if (new Date(rec.timestamp) >= cutoff) {
          records.push(rec);
        }
      }
    } else {
      observationCache.missCount++;
    }
  }
  
  // If cache was empty or stale, fall back to full file read
  if (records.length === 0 && observationCache.totalRecords === 0) {
    return loadRecentObservationsFallback(filePath, cutoff);
  }

  return records;
}

/**
 * Fallback implementation that reads the entire file.
 * Used when cache is empty or for backward compatibility.
 */
function loadRecentObservationsFallback(filePath: string, cutoff: Date): ObservationRecord[] {
  const raw = readFileSync(filePath, "utf-8");
  const records: ObservationRecord[] = [];

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const rec = JSON.parse(trimmed) as ObservationRecord;
      if (new Date(rec.timestamp) >= cutoff) {
        records.push(rec);
      }
    } catch (error) {
      // skip malformed lines but log
      loggers.observation.debug(`Failed to parse observation line`, { line: trimmed.slice(0, 50), error: String(error) });
    }
  }

  return records;
}

/**
 * Compute observation statistics.
 */
export function computeStats(observations: ObservationRecord[]): ObservationStats {
  const now = Date.now();
  const ms24h = 24 * 60 * 60 * 1000;
  const ms7d = 7 * 24 * 60 * 60 * 1000;

  const tierDist = { light: 0, tracked: 0, delegation: 0 };
  let correctCount = 0;
  let correctedCount = 0;
  const mispredictions: Array<{ text: string; predicted: string; actual: string }> = [];

  let last24hCount = 0;
  let last7dCount = 0;

  for (const obs of observations) {
    const age = now - new Date(obs.timestamp).getTime();
    if (age <= ms24h) last24hCount++;
    if (age <= ms7d) last7dCount++;

    tierDist[obs.predictedTier]++;

    if (obs.userFollowUp === "corrected_up" || obs.userFollowUp === "corrected_down") {
      correctedCount++;
      if (obs.actualTier && obs.actualTier !== obs.predictedTier) {
        mispredictions.push({
          text: obs.messageText.slice(0, 60),
          predicted: obs.predictedTier,
          actual: obs.actualTier,
        });
      }
    } else if (obs.userFollowUp === "satisfied") {
      correctCount++;
    }
  }

  const feedbackCount = correctedCount + correctCount;
  const accuracy = feedbackCount > 0 ? correctCount / feedbackCount : 0;
  const correctionRate = observations.length > 0 ? correctedCount / observations.length : 0;

  return {
    totalObservations: observations.length,
    last24h: last24hCount,
    last7d: last7dCount,
    tierDistribution: tierDist,
    accuracy,
    correctionRate,
    topMispredictions: mispredictions.slice(0, 5),
  };
}

/**
 * Prune old observations (> MAX_AGE_DAYS).
 * Returns the number of pruned records.
 */
export function pruneObservations(sharedRoot: string, maxAgeDays = MAX_AGE_DAYS): number {
  const filePath = join(sharedRoot, OBS_FILE);
  if (!existsSync(filePath)) return 0;

  const cutoff = getDaysAgoCutoff(maxAgeDays);
  const raw = readFileSync(filePath, "utf-8");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);

  let pruned = 0;
  const kept: string[] = [];

  for (const line of lines) {
    try {
      const rec = JSON.parse(line) as ObservationRecord;
      if (new Date(rec.timestamp) < cutoff) {
        pruned++;
      } else {
        kept.push(line);
      }
    } catch (error) {
      kept.push(line); // keep malformed lines to avoid data loss
      loggers.observation.debug(`Kept malformed line during prune`, { line: line.slice(0, 50), error: String(error) });
    }
  }

  if (pruned > 0) {
    writeFileSync(filePath, kept.join("\n") + (kept.length > 0 ? "\n" : ""), "utf-8");
    invalidateCache();
  }

  return pruned;
}

/**
 * Detect if a new user message is a correction of the previous prediction.
 */
export function detectFeedbackSignal(
  currentMessage: string,
  previousPrediction: "light" | "tracked" | "delegation",
): { type: "satisfied" | "corrected_up" | "corrected_down" | "continued"; actualTier?: "light" | "tracked" | "delegation" } {
  const lower = currentMessage.toLowerCase().trim();

  // Check satisfaction signals first (short positive replies)
  if (SATISFACTION_SIGNALS.some((r) => r.test(lower))) {
    return { type: "satisfied" };
  }

  // Check escalation signals (user wants more agents)
  if (ESCALATION_SIGNALS.some((r) => r.test(lower))) {
    const actualTier: "light" | "tracked" | "delegation" = "delegation";
    return { type: "corrected_up", actualTier };
  }

  // Check de-escalation signals (user wants less complexity)
  if (DE_ESCALATION_SIGNALS.some((r) => r.test(lower))) {
    const actualTier: "light" | "tracked" | "delegation" = "light";
    return { type: "corrected_down", actualTier };
  }

  return { type: "continued" };
}
