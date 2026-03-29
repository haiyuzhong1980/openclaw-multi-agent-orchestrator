/**
 * Path Security Utilities
 * 
 * Provides functions for sanitizing and validating path components
 * to prevent path injection attacks.
 * 
 * Security considerations:
 * - Prevents directory traversal attacks (../, ..\)
 * - Prevents null byte injection
 * - Only allows safe characters in path components
 */

import { ErrorCode, createError, type AppError, type Result, err, ok } from "./errors.ts";

// ============================================================================
// Path Part validation configuration
// ============================================================================

/**
 * Allowed characters in path parts.
 * - Alphanumeric: a-z, A-Z, 0-9
 * - Underscore: _
 * - Hyphen: -
 * - Dot: . (but not at the start to prevent hidden files)
 * 
 * This whitelist approach is more secure than blacklisting.
 */
const SAFE_PATH_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/**
 * Maximum length for a path part (filesystem limit is typically 255)
 */
const MAX_PATH_PART_LENGTH = 200;

/**
 * Reserved path names that should not be used
 */
const RESERVED_NAMES = new Set([
  // Unix reserved
  '.', '..', '.DS_Store', '.git', '.gitignore',
  // Windows reserved
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
  // Special directories
  'inbox', 'pending', 'processed', 'claiming',
]);

// ============================================================================
// Path sanitization functions
// ============================================================================

/**
 * Validation options for path parts
 */
export interface PathValidationOptions {
  /** Allow empty strings (default: false) */
  allowEmpty?: boolean;
  /** Custom maximum length (default: 200) */
  maxLength?: number;
  /** Additional reserved names to block */
  extraReservedNames?: string[];
  /** Context for error messages */
  context?: string;
}

/**
 * Result of path part validation
 */
export interface PathValidationResult {
  /** Whether the path part is valid */
  valid: boolean;
  /** The sanitized path part (or original if valid) */
  value: string;
  /** Error message if invalid */
  error?: string;
}

/**
 * Validate a path part against security rules.
 * 
 * This function checks:
 * 1. Length limits
 * 2. Character whitelist
 * 3. Reserved names
 * 4. No directory traversal patterns
 * 
 * @param part - The path part to validate
 * @param options - Validation options
 * @returns Validation result
 */
export function validatePathPart(
  part: string,
  options: PathValidationOptions = {}
): PathValidationResult {
  const {
    allowEmpty = false,
    maxLength = MAX_PATH_PART_LENGTH,
    extraReservedNames = [],
    context = 'path part',
  } = options;

  // Check for empty
  if (part === '' || part === null || part === undefined) {
    if (allowEmpty) {
      return { valid: true, value: '' };
    }
    return {
      valid: false,
      value: '',
      error: `Empty ${context} is not allowed`,
    };
  }

  // Type check
  if (typeof part !== 'string') {
    return {
      valid: false,
      value: '',
      error: `${context} must be a string, got ${typeof part}`,
    };
  }

  // Length check
  if (part.length > maxLength) {
    return {
      valid: false,
      value: '',
      error: `${context} exceeds maximum length (${part.length} > ${maxLength})`,
    };
  }

  // Check for null bytes
  if (part.includes('\0')) {
    return {
      valid: false,
      value: '',
      error: `${context} contains null byte injection attempt`,
    };
  }

  // Check for directory traversal
  if (part.includes('..') || part.includes('/') || part.includes('\\')) {
    return {
      valid: false,
      value: '',
      error: `${context} contains directory traversal pattern`,
    };
  }

  // Check against reserved names (case-insensitive)
  const upperPart = part.toUpperCase();
  const allReserved = new Set([...RESERVED_NAMES, ...extraReservedNames.map(n => n.toUpperCase())]);
  
  // Skip reserved name check for specific system directories
  if (upperPart === '_DEFAULT' || upperPart === '_BROADCAST') {
    // These are allowed as special system directories
  } else if (allReserved.has(upperPart)) {
    return {
      valid: false,
      value: '',
      error: `${context} uses reserved name: ${part}`,
    };
  }

  // Check against whitelist pattern
  if (!SAFE_PATH_PATTERN.test(part)) {
    return {
      valid: false,
      value: '',
      error: `${context} contains invalid characters. Only alphanumeric, underscore, hyphen, and dot are allowed. Must start with alphanumeric.`,
    };
  }

  return { valid: true, value: part };
}

/**
 * Sanitize a path part for safe use in file paths.
 * 
 * This function validates and returns a safe path part.
 * Throws an error if the path part is invalid.
 * 
 * @param part - The path part to sanitize
 * @param context - Description of what the path part represents (for error messages)
 * @returns The sanitized path part
 * @throws AppError if the path part is invalid
 */
export function sanitizePathPart(part: string, context: string = 'path part'): string {
  const result = validatePathPart(part, { context });
  
  if (!result.valid) {
    throw createError(
      ErrorCode.INVALID_PATH_PART,
      result.error!,
      undefined,
      { part, context }
    );
  }
  
  return result.value;
}

/**
 * Sanitize a path part and return a Result instead of throwing.
 * 
 * @param part - The path part to sanitize
 * @param context - Description of what the path part represents
 * @returns Result containing the sanitized part or an error
 */
export function safeSanitizePathPart(
  part: string,
  context: string = 'path part'
): Result<string> {
  const result = validatePathPart(part, { context });
  
  if (!result.valid) {
    return err(createError(
      ErrorCode.INVALID_PATH_PART,
      result.error!,
      undefined,
      { part, context }
    ));
  }
  
  return ok(result.value);
}

/**
 * Sanitize an agent ID for use in paths.
 * 
 * Agent IDs should be identifiers like "agent-001", "coordinator", etc.
 * 
 * @param agentId - The agent ID to sanitize
 * @returns The sanitized agent ID
 * @throws AppError if the agent ID is invalid
 */
export function sanitizeAgentId(agentId: string): string {
  return sanitizePathPart(agentId, 'agentId');
}

/**
 * Sanitize a team name for use in paths.
 * 
 * Team names should be identifiers like "team-alpha", "default", etc.
 * 
 * @param teamName - The team name to sanitize
 * @returns The sanitized team name
 * @throws AppError if the team name is invalid
 */
export function sanitizeTeamName(teamName: string): string {
  return sanitizePathPart(teamName, 'teamName');
}

/**
 * Create a hash of a path part for use when the original value
 * cannot be safely represented in a path.
 * 
 * This is useful for values that may contain unsafe characters
 * but need to be uniquely represented in the filesystem.
 * 
 * @param value - The value to hash
 * @returns A safe hashed representation
 */
export function hashPathPart(value: string): string {
  // Simple hash function for path parts
  // Uses DJB2 hash algorithm
  let hash = 5381;
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) + hash) + value.charCodeAt(i);
  }
  // Convert to positive hex string with prefix
  return `id${Math.abs(hash).toString(16)}`;
}

/**
 * Sanitize or hash a path part.
 * 
 * If the part can be safely used as-is, returns it.
 * Otherwise, returns a hashed version that is safe for paths.
 * 
 * @param part - The path part to sanitize or hash
 * @returns A safe path part (either original or hashed)
 */
export function sanitizeOrHashPathPart(part: string): string {
  const result = validatePathPart(part);
  
  if (result.valid) {
    return result.value;
  }
  
  // If validation fails, use hash
  return hashPathPart(part);
}

/**
 * Build a safe path by sanitizing all parts.
 * 
 * @param base - Base path (assumed to be safe/validated externally)
 * @param parts - Path parts to sanitize and join
 * @returns The safe joined path
 * @throws AppError if any part is invalid
 */
export function safeJoin(base: string, ...parts: string[]): string {
  const sanitizedParts = parts.map((part, index) => {
    try {
      return sanitizePathPart(part, `path component ${index + 1}`);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error) {
        throw error;
      }
      throw createError(
        ErrorCode.INVALID_PATH_PART,
        `Invalid path component at position ${index + 1}: ${String(error)}`,
        error
      );
    }
  });
  
  return [base, ...sanitizedParts].join('/');
}

// ============================================================================
// Exports
// ============================================================================

export {
  SAFE_PATH_PATTERN,
  MAX_PATH_PART_LENGTH,
  RESERVED_NAMES,
};
