/**
 * Unified Error Handling Module
 * 
 * Provides Result<T, E> type for explicit error handling,
 * error codes for categorization, and logging utilities.
 */

// ============================================================================
// Error Code Enumeration
// ============================================================================

/**
 * Standardized error codes for the multi-agent orchestrator.
 * Categories:
 * - 1xxx: File/IO operations
 * - 2xxx: Network/Transport operations
 * - 3xxx: Parse/Format operations
 * - 4xxx: Agent/Orchestration operations
 * - 5xxx: Configuration/Setup operations
 */
export const ErrorCode = {
  // File/IO errors (1xxx)
  FILE_NOT_FOUND: 1001,
  FILE_READ_ERROR: 1002,
  FILE_WRITE_ERROR: 1003,
  FILE_DELETE_ERROR: 1004,
  FILE_RENAME_ERROR: 1005,
  FILE_PARSE_ERROR: 1006,
  BACKUP_FAILED: 1007,
  DIRECTORY_CREATE_ERROR: 1008,
  
  // Network/Transport errors (2xxx)
  TRANSPORT_INIT_FAILED: 2001,
  TRANSPORT_SEND_FAILED: 2002,
  TRANSPORT_RECEIVE_FAILED: 2003,
  TRANSPORT_ACK_FAILED: 2004,
  TRANSPORT_CLOSE_FAILED: 2005,
  MESSAGE_EXPIRED: 2006,
  MESSAGE_CLAIM_FAILED: 2007,
  
  // Parse/Format errors (3xxx)
  JSON_PARSE_ERROR: 3001,
  TOML_PARSE_ERROR: 3002,
  INVALID_FORMAT: 3003,
  SCHEMA_VALIDATION_ERROR: 3004,
  
  // Agent/Orchestration errors (4xxx)
  AGENT_NOT_FOUND: 4001,
  AGENT_REGISTRATION_FAILED: 4002,
  TASK_DISPATCH_FAILED: 4003,
  TASK_COMPLETION_FAILED: 4004,
  SESSION_ERROR: 4005,
  SUBAGENT_SPAWN_FAILED: 4006,
  
  // Configuration/Setup errors (5xxx)
  CONFIG_LOAD_FAILED: 5001,
  CONFIG_VALIDATION_FAILED: 5002,
  INIT_FAILED: 5003,
  
  // Path security errors (6xxx)
  INVALID_PATH_PART: 6001,
  PATH_INJECTION_DETECTED: 6002,
  
  // Unknown/Generic errors
  UNKNOWN: 9999,
} as const;

export type ErrorCodeType = typeof ErrorCode[keyof typeof ErrorCode];

// ============================================================================
// Result Type
// ============================================================================

/**
 * Successful result wrapper.
 */
export interface Ok<T> {
  ok: true;
  value: T;
}

/**
 * Failed result wrapper.
 */
export interface Err<E = AppError> {
  ok: false;
  error: E;
}

/**
 * Result type for explicit error handling.
 * Use `isOk` or `isErr` to narrow the type.
 * 
 * @example
 * function divide(a: number, b: number): Result<number> {
 *   if (b === 0) {
 *     return err(ErrorCode.INVALID_INPUT, "Division by zero");
 *   }
 *   return ok(a / b);
 * }
 * 
 * const result = divide(10, 2);
 * if (isOk(result)) {
 *   console.log(result.value); // 5
 * } else {
 *   console.error(result.error.message);
 * }
 */
export type Result<T, E = AppError> = Ok<T> | Err<E>;

/**
 * Create a successful result.
 */
export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

/**
 * Create a failed result.
 */
export function err<E = AppError>(error: E): Err<E>;
export function err(code: ErrorCodeType, message: string, cause?: unknown): Err<AppError>;
export function err(codeOrError: ErrorCodeType | AppError, message?: string, cause?: unknown): Err<AppError> {
  if (typeof codeOrError === 'object') {
    return { ok: false, error: codeOrError };
  }
  return {
    ok: false,
    error: createError(codeOrError, message!, cause),
  };
}

/**
 * Type guard for successful results.
 */
export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.ok === true;
}

/**
 * Type guard for failed results.
 */
export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return result.ok === false;
}

/**
 * Unwrap a result, throwing if it's an error.
 * Use only when you're certain the result is successful.
 */
export function unwrap<T, E>(result: Result<T, E>): T {
  if (isOk(result)) {
    return result.value;
  }
  throw new Error(`Unwrap called on Err: ${JSON.stringify(result.error)}`);
}

/**
 * Unwrap a result with a default value.
 */
export function unwrapOr<T, E>(result: Result<T, E>, defaultValue: T): T {
  if (isOk(result)) {
    return result.value;
  }
  return defaultValue;
}

/**
 * Map a successful result value.
 */
export function map<T, U, E>(result: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  if (isOk(result)) {
    return ok(fn(result.value));
  }
  return result;
}

/**
 * Map an error value.
 */
export function mapErr<T, E, F>(result: Result<T, E>, fn: (error: E) => F): Result<T, F> {
  if (isErr(result)) {
    return { ok: false, error: fn(result.error) };
  }
  return result as Result<T, F>;
}

// ============================================================================
// AppError Type
// ============================================================================

/**
 * Application error with structured information.
 */
export interface AppError {
  code: ErrorCodeType;
  message: string;
  cause?: unknown;
  context?: Record<string, unknown>;
  timestamp: string;
}

/**
 * Create a structured application error.
 */
export function createError(
  code: ErrorCodeType,
  message: string,
  cause?: unknown,
  context?: Record<string, unknown>
): AppError {
  return {
    code,
    message,
    cause,
    context,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Convert an unknown error to AppError.
 */
export function toAppError(error: unknown, defaultCode: ErrorCodeType = ErrorCode.UNKNOWN): AppError {
  if (isAppError(error)) {
    return error;
  }
  
  if (error instanceof Error) {
    return createError(defaultCode, error.message, error);
  }
  
  return createError(defaultCode, String(error));
}

/**
 * Type guard for AppError.
 */
export function isAppError(error: unknown): error is AppError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    'message' in error &&
    'timestamp' in error
  );
}

// ============================================================================
// Logger
// ============================================================================

/**
 * Log level for filtering output.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * Logger configuration.
 */
export interface LoggerConfig {
  /** Minimum log level to output (default: 'info') */
  level?: LogLevel;
  /** Prefix for all log messages */
  prefix?: string;
  /** Include timestamp in logs (default: true) */
  timestamp?: boolean;
  /** Output to console.error for errors (default: true) */
  useConsoleError?: boolean;
}

/**
 * Simple logger with structured output.
 */
export class Logger {
  private level: LogLevel;
  private prefix: string;
  private timestamp: boolean;
  private useConsoleError: boolean;

  constructor(config: LoggerConfig = {}) {
    this.level = config.level ?? 'info';
    this.prefix = config.prefix ?? '';
    this.timestamp = config.timestamp ?? true;
    this.useConsoleError = config.useConsoleError ?? true;
  }

  private formatMessage(level: LogLevel, message: string, data?: Record<string, unknown>): string {
    const parts: string[] = [];
    
    if (this.timestamp) {
      parts.push(new Date().toISOString());
    }
    
    parts.push(`[${level.toUpperCase()}]`);
    
    if (this.prefix) {
      parts.push(`[${this.prefix}]`);
    }
    
    parts.push(message);
    
    if (data && Object.keys(data).length > 0) {
      parts.push(JSON.stringify(data));
    }
    
    return parts.join(' ');
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] >= LOG_LEVELS[this.level];
  }

  debug(message: string, data?: Record<string, unknown>): void {
    if (this.shouldLog('debug')) {
      console.debug(this.formatMessage('debug', message, data));
    }
  }

  info(message: string, data?: Record<string, unknown>): void {
    if (this.shouldLog('info')) {
      console.info(this.formatMessage('info', message, data));
    }
  }

  warn(message: string, data?: Record<string, unknown>): void {
    if (this.shouldLog('warn')) {
      console.warn(this.formatMessage('warn', message, data));
    }
  }

  error(message: string, error?: unknown, data?: Record<string, unknown>): void {
    if (!this.shouldLog('error')) {
      return;
    }
    
    const errorData: Record<string, unknown> = { ...data };
    
    if (error !== undefined) {
      if (isAppError(error)) {
        errorData.errorCode = error.code;
        errorData.errorMessage = error.message;
        if (error.cause) {
          errorData.cause = String(error.cause);
        }
      } else if (error instanceof Error) {
        errorData.errorMessage = error.message;
        errorData.errorStack = error.stack;
      } else {
        errorData.error = String(error);
      }
    }
    
    const formatted = this.formatMessage('error', message, errorData);
    
    if (this.useConsoleError) {
      console.error(formatted);
    } else {
      console.log(formatted);
    }
  }

  /** Log an AppError with full context */
  logError(error: AppError, context?: Record<string, unknown>): void {
    this.error(error.message, error, {
      code: error.code,
      ...error.context,
      ...context,
    });
  }

  /** Set the log level */
  setLevel(level: LogLevel): void {
    this.level = level;
  }
}

// ============================================================================
// Module-level Loggers
// ============================================================================

/**
 * Create a logger for a specific module.
 */
export function createLogger(moduleName: string, config?: LoggerConfig): Logger {
  return new Logger({ ...config, prefix: moduleName });
}

// Pre-configured loggers for common modules
export const loggers = {
  transport: createLogger('transport'),
  taskBoard: createLogger('task-board'),
  observation: createLogger('observation'),
  messageManager: createLogger('message-manager'),
  agentRegistry: createLogger('agent-registry'),
  onboarding: createLogger('onboarding'),
  evolution: createLogger('evolution'),
  tomlParser: createLogger('toml-parser'),
  enforcement: createLogger('enforcement'),
  patternExport: createLogger('pattern-export'),
  oagBridge: createLogger('oag-bridge'),
  ofmsBridge: createLogger('ofms-bridge'),
  userKeywords: createLogger('user-keywords'),
  hooks: createLogger('hooks'),
};

// ============================================================================
// Try-Catch Helpers
// ============================================================================

/**
 * Wrap a function to return a Result instead of throwing.
 */
export function trySync<T>(fn: () => T, errorCode: ErrorCodeType = ErrorCode.UNKNOWN): Result<T> {
  try {
    return ok(fn());
  } catch (error) {
    return err(toAppError(error, errorCode));
  }
}

/**
 * Wrap an async function to return a Result instead of throwing.
 */
export async function tryAsync<T>(
  fn: () => Promise<T>,
  errorCode: ErrorCodeType = ErrorCode.UNKNOWN
): Promise<Result<T>> {
  try {
    return ok(await fn());
  } catch (error) {
    return err(toAppError(error, errorCode));
  }
}

/**
 * Execute a function and log any errors, returning a default value on failure.
 */
export function withDefault<T>(fn: () => T, defaultValue: T, logger: Logger, context?: string): T {
  try {
    return fn();
  } catch (error) {
    logger.error(context ?? 'Operation failed', error);
    return defaultValue;
  }
}

/**
 * Execute an async function and log any errors, returning a default value on failure.
 */
export async function withDefaultAsync<T>(
  fn: () => Promise<T>,
  defaultValue: T,
  logger: Logger,
  context?: string
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    logger.error(context ?? 'Operation failed', error);
    return defaultValue;
  }
}

/**
 * Safely parse JSON, returning null on failure with logging.
 */
export function safeJsonParse<T>(
  text: string,
  logger: Logger,
  context?: string
): T | null {
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    logger.error(context ?? 'JSON parse failed', error);
    return null;
  }
}
