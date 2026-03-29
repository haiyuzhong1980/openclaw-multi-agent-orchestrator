import { readFileSync, existsSync } from "node:fs";
import { loggers } from "./errors.ts";

// ─── OAG Event → OMA Observation ─────────────────────────────────────────────

export interface OagEvent {
  type: 'channel_restart' | 'delivery_failure' | 'rate_limit' | 'anomaly_detected' | 'prediction_alert';
  channel?: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  message: string;
  timestamp: string;
  rootCause?: string;
}

/**
 * Convert an OAG channel health event into an OMA observation record fields.
 * Pure function — no side effects, no I/O.
 */
export function oagEventToObservation(
  event: OagEvent,
): { predictedTier: 'light' | 'tracked' | 'delegation'; message: string; agent: string } {
  let predictedTier: 'light' | 'tracked' | 'delegation';

  if (event.severity === 'critical' || event.severity === 'high') {
    predictedTier = 'delegation';
  } else if (event.severity === 'medium') {
    predictedTier = 'tracked';
  } else {
    predictedTier = 'light';
  }

  const channelPart = event.channel ? ` [channel: ${event.channel}]` : '';
  const rootCausePart = event.rootCause ? ` Root cause: ${event.rootCause}.` : '';
  const message = `OAG ${event.type}${channelPart}: ${event.message}.${rootCausePart}`;

  return {
    predictedTier,
    message,
    agent: 'oag-bridge',
  };
}

// ─── OMA Task Failure → OAG Root Cause ───────────────────────────────────────

export interface TaskFailureReport {
  taskId: string;
  projectId: string;
  error: string;
  agentType?: string;
  duration: number;
}

/**
 * Generate an OAG-compatible root cause classification from an OMA task failure.
 * Pure function — no side effects, no I/O.
 */
export function taskFailureToRootCause(
  report: TaskFailureReport,
): { category: string; confidence: number; suggestion: string } {
  const err = report.error.toLowerCase();

  if (err.includes('rate_limit') || err.includes('rate limit')) {
    return { category: 'rate_limit', confidence: 0.9, suggestion: '降低并发或切换模型' };
  }

  if (err.includes('timeout')) {
    return { category: 'network', confidence: 0.7, suggestion: '检查网络或增加超时' };
  }

  if (err.includes('auth')) {
    return { category: 'auth_failure', confidence: 0.9, suggestion: '检查 API key' };
  }

  return { category: 'internal', confidence: 0.3, suggestion: '需要人工诊断' };
}

// ─── OAG Prediction Alert → OMA Scheduling Hint ──────────────────────────────

export interface PredictionAlert {
  metric: string;
  currentValue: number;
  predictedValue: number;
  breachThreshold: number;
  timeToBreachMinutes: number;
}

/**
 * Generate a scheduling degradation hint from an OAG prediction alert.
 * Pure function — no side effects, no I/O.
 */
export function predictionToSchedulingHint(
  alert: PredictionAlert,
): { action: 'reduce_concurrency' | 'switch_model' | 'defer_tasks' | 'none'; reason: string } {
  const { metric, currentValue, predictedValue, breachThreshold, timeToBreachMinutes } = alert;

  // Already past or at threshold — immediate action needed
  if (currentValue >= breachThreshold) {
    if (metric.toLowerCase().includes('rate') || metric.toLowerCase().includes('quota')) {
      return {
        action: 'switch_model',
        reason: `${metric} already at or above threshold (${currentValue} >= ${breachThreshold}). Switch model to avoid rate limit.`,
      };
    }
    return {
      action: 'reduce_concurrency',
      reason: `${metric} already at or above threshold (${currentValue} >= ${breachThreshold}). Reduce concurrency immediately.`,
    };
  }

  // Breach is imminent (within 5 minutes) — defer tasks
  if (timeToBreachMinutes <= 5) {
    return {
      action: 'defer_tasks',
      reason: `${metric} predicted to breach threshold in ${timeToBreachMinutes} min (${predictedValue} vs ${breachThreshold}). Defer non-critical tasks.`,
    };
  }

  // Breach is near-term (within 30 minutes) — reduce concurrency
  if (timeToBreachMinutes <= 30) {
    return {
      action: 'reduce_concurrency',
      reason: `${metric} predicted to reach ${predictedValue} within ${timeToBreachMinutes} min (threshold: ${breachThreshold}). Reduce concurrency proactively.`,
    };
  }

  // Sufficient time before breach — no action needed yet
  return {
    action: 'none',
    reason: `${metric} is within normal range. Predicted breach in ${timeToBreachMinutes} min — no action required yet.`,
  };
}

// ─── Unified OAG Config Adapter ───────────────────────────────────────────────

/**
 * Load OAG-related config from openclaw.json, unifying plugin and core namespaces.
 * Pure function with respect to external state — reads config file once.
 */
export function loadUnifiedOagConfig(configPath: string): {
  pluginConfig: Record<string, unknown>;
  coreConfig: Record<string, unknown>;
  merged: Record<string, unknown>;
} {
  const empty = { pluginConfig: {}, coreConfig: {}, merged: {} };

  if (!existsSync(configPath)) return empty;

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch (error) {
    loggers.oagBridge.error(`Failed to load OAG config`, error, { path: configPath });
    return empty;
  }

  if (typeof raw !== 'object' || raw === null) return empty;

  const config = raw as Record<string, unknown>;

  // Plugin namespace: config.plugins?.["multi-agent-orchestrator"]?.oag  or  config.oag
  const pluginsSection = typeof config['plugins'] === 'object' && config['plugins'] !== null
    ? (config['plugins'] as Record<string, unknown>)
    : {};
  const pluginSection = typeof pluginsSection['multi-agent-orchestrator'] === 'object'
    && pluginsSection['multi-agent-orchestrator'] !== null
    ? (pluginsSection['multi-agent-orchestrator'] as Record<string, unknown>)
    : {};
  const pluginOag = typeof pluginSection['oag'] === 'object' && pluginSection['oag'] !== null
    ? (pluginSection['oag'] as Record<string, unknown>)
    : {};

  // Top-level plugin-side oag key (fallback)
  const topLevelOag = typeof config['oag'] === 'object' && config['oag'] !== null
    ? (config['oag'] as Record<string, unknown>)
    : {};

  const pluginConfig: Record<string, unknown> = { ...topLevelOag, ...pluginOag };

  // Core namespace: config.core?.oag  or  config.gateway?.oag
  const coreSection = typeof config['core'] === 'object' && config['core'] !== null
    ? (config['core'] as Record<string, unknown>)
    : {};
  const gatewaySection = typeof config['gateway'] === 'object' && config['gateway'] !== null
    ? (config['gateway'] as Record<string, unknown>)
    : {};

  const coreOag = typeof coreSection['oag'] === 'object' && coreSection['oag'] !== null
    ? (coreSection['oag'] as Record<string, unknown>)
    : {};
  const gatewayOag = typeof gatewaySection['oag'] === 'object' && gatewaySection['oag'] !== null
    ? (gatewaySection['oag'] as Record<string, unknown>)
    : {};

  const coreConfig: Record<string, unknown> = { ...gatewayOag, ...coreOag };

  // Merge: plugin takes precedence over core for same keys
  const merged: Record<string, unknown> = { ...coreConfig, ...pluginConfig };

  return { pluginConfig, coreConfig, merged };
}
