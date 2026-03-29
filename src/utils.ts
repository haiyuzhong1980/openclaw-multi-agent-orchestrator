/**
 * Common utility functions shared across modules.
 * 
 * This module contains shared functionality to avoid code duplication
 * and ensure consistent behavior across the codebase.
 */

// ============================================================================
// ID Generation
// ============================================================================

/**
 * Generate a unique message ID.
 * Format: msg-{timestamp36}-{random36}
 * 
 * Uses base-36 encoding for compact representation.
 * Example: msg-lz1abc-x7k9m2
 */
export function generateMessageId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `msg-${timestamp}-${random}`;
}

/**
 * Generate a unique observation ID.
 * Format: obs-{timestamp}-{random_hex}
 */
export function generateObservationId(): string {
  const ts = Date.now();
  const rand = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, "0");
  return `obs-${ts}-${rand}`;
}

// ============================================================================
// Path Utilities (re-exported from path-utils for convenience)
// ============================================================================

// Re-export sanitizePathPart for consumers
export { sanitizePathPart } from "./path-utils.ts";

// ============================================================================
// Async Helpers
// ============================================================================

/**
 * Retry helper for async operations that may transiently fail.
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: {
    maxAttempts?: number;
    delayMs?: number;
    shouldRetry?: (error: unknown) => boolean;
    operationName?: string;
  } = {}
): Promise<T> {
  const {
    maxAttempts = 3,
    delayMs = 10,
    shouldRetry = (err: unknown) => {
      const code = (err as NodeJS.ErrnoException)?.code;
      return code === "EBUSY" || code === "EAGAIN" || code === "EACCES";
    },
    operationName = "operation",
  } = options;

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error: unknown) {
      lastError = error as Error;

      if (shouldRetry(error) && attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
        continue;
      }

      throw error;
    }
  }

  throw lastError;
}

// ============================================================================
// Time Utilities
// ============================================================================

/**
 * Check if a timestamp is older than a given number of hours.
 */
export function isOlderThan(timestamp: string | Date, hours: number): boolean {
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
  const ts = typeof timestamp === "string" ? new Date(timestamp) : timestamp;
  return ts < cutoff;
}

/**
 * Get cutoff date for a given number of hours ago.
 */
export function getHoursAgoCutoff(hours: number): Date {
  return new Date(Date.now() - hours * 60 * 60 * 1000);
}

/**
 * Get cutoff date for a given number of days ago.
 */
export function getDaysAgoCutoff(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}
