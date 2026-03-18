export interface SpawnRecord {
  sessionKey: string;
  agentId?: string;
  label?: string;
  task?: string;
  spawnedAt: string;     // ISO8601
  completedAt?: string;
  outcome?: "ok" | "error" | "timeout" | "killed";
}

export interface SpawnTracker {
  spawns: Map<string, SpawnRecord>;   // sessionKey -> record
  totalSpawned: number;
  totalCompleted: number;
  policyCheckCount: number;           // how many times enforce was called
  lastPolicyCheck?: string;           // ISO8601
}

export function createSpawnTracker(): SpawnTracker {
  return {
    spawns: new Map(),
    totalSpawned: 0,
    totalCompleted: 0,
    policyCheckCount: 0,
    lastPolicyCheck: undefined,
  };
}

/**
 * Record a subagent spawn (called from subagent_spawned hook).
 */
export function recordSpawn(
  tracker: SpawnTracker,
  params: {
    sessionKey: string;
    agentId?: string;
    label?: string;
    task?: string;
  },
): void {
  const record: SpawnRecord = {
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    label: params.label,
    task: params.task,
    spawnedAt: new Date().toISOString(),
  };
  tracker.spawns.set(params.sessionKey, record);
  tracker.totalSpawned += 1;
}

/**
 * Record a subagent completion (called from subagent_ended hook).
 */
export function recordCompletion(
  tracker: SpawnTracker,
  params: {
    sessionKey: string;
    outcome: "ok" | "error" | "timeout" | "killed";
  },
): void {
  const record = tracker.spawns.get(params.sessionKey);
  if (record) {
    record.completedAt = new Date().toISOString();
    record.outcome = params.outcome;
  }
  tracker.totalCompleted += 1;
}

/**
 * Record that enforce_execution_policy was called.
 */
export function recordPolicyCheck(tracker: SpawnTracker): void {
  tracker.policyCheckCount += 1;
  tracker.lastPolicyCheck = new Date().toISOString();
}

/**
 * Get verified execution state based on actual hook events.
 * Replaces the self-reported boolean flags.
 */
export function getVerifiedState(tracker: SpawnTracker): {
  hasWorkerStart: boolean;      // at least one spawn recorded
  hasTrackedExecution: boolean; // at least one spawn is active (not completed)
  hasCompletedStep: boolean;    // at least one spawn completed with "ok"
  hasFinalMerge: boolean;       // all spawns completed
  activeSpawns: number;
  completedSpawns: number;
  totalSpawns: number;
} {
  const total = tracker.spawns.size;
  let completed = 0;
  let okCompleted = 0;

  for (const record of tracker.spawns.values()) {
    if (record.completedAt !== undefined) {
      completed += 1;
      if (record.outcome === "ok") {
        okCompleted += 1;
      }
    }
  }

  const active = total - completed;
  const hasWorkerStart = total > 0;
  const hasTrackedExecution = active > 0;
  const hasCompletedStep = okCompleted > 0;
  // hasFinalMerge: all spawns completed (at least one must exist)
  const hasFinalMerge = total > 0 && completed === total;

  return {
    hasWorkerStart,
    hasTrackedExecution,
    hasCompletedStep,
    hasFinalMerge,
    activeSpawns: active,
    completedSpawns: completed,
    totalSpawns: total,
  };
}

/**
 * Get list of tools that are always allowed (never blocked).
 */
export const ALWAYS_ALLOWED_TOOLS = new Set([
  "multi-agent-orchestrator",  // our own tool
  "sessions_spawn",            // spawning subagents
  "sessions_yield",            // yielding to subagents
  "subagents",                 // managing subagents
  "todowrite",                 // task planning
  "todoupdate",                // task updates
]);

/**
 * Check if the agent should be allowed to call a given tool.
 * In delegation-first/strict-orchestrated with required gate:
 * - Block all non-orchestration tools until first spawn confirmed
 * Returns null if allowed, or a block reason string if blocked.
 */
export function shouldBlockTool(
  tracker: SpawnTracker,
  toolName: string,
  policyMode: string,
  delegationStartGate: string,
): string | null {
  // Always allow orchestration-related tools
  if (ALWAYS_ALLOWED_TOOLS.has(toolName)) return null;

  // Only enforce in delegation-first and strict-orchestrated modes
  if (policyMode !== "delegation-first" && policyMode !== "strict-orchestrated") return null;

  // Only enforce when gate is "required"
  if (delegationStartGate !== "required") return null;

  // Check if any subagent has been spawned
  const state = getVerifiedState(tracker);
  if (state.hasWorkerStart) return null;  // At least one spawn — allow

  // Block! No subagent has been spawned yet
  return `执行策略 ${policyMode} 要求先派遣子 agent。请先调用 sessions_spawn 派出至少一个 worker，然后再执行 ${toolName}。`;
}

/**
 * Reset tracker (for new session/task).
 */
export function resetTracker(tracker: SpawnTracker): void {
  tracker.spawns.clear();
  tracker.totalSpawned = 0;
  tracker.totalCompleted = 0;
  tracker.policyCheckCount = 0;
  tracker.lastPolicyCheck = undefined;
}
