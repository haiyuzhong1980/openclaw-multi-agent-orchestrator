import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ObservationStats } from "./observation-engine.js";
import { loggers } from "./errors.ts";

export type EnforcementLevel = 0 | 1 | 2 | 3;

export interface EnforcementState {
  currentLevel: EnforcementLevel;
  levelHistory: Array<{ level: EnforcementLevel; timestamp: string; reason: string }>;
  lastUpgrade: string | null;
  lastDowngrade: string | null;
  lastLevelChange: string | null;  // timestamp of any level change (for cooldown)
  consecutiveDowngradeDays: number; // days in a row exceeding downgrade threshold
  observationCount: number;      // total observations since install
  correctionCount: number;       // total corrections received
  consecutiveAccurateDays: number;
  installedAt: string;
  version: number;
}

export interface EnforcementBehavior {
  injectGuidance: boolean;       // inject orchestration guidance into prompt
  injectDispatchPlan: boolean;   // inject specific dispatch plan for pending tasks
  blockNonDispatchTools: boolean; // hard-block tools until subagent spawned
  softBlockNonDispatchTools: boolean; // L2: warn first call, block second call
  logOnly: boolean;              // only log, don't enforce
  advisoryMessage: string | null; // soft suggestion text (Level 1)
}

const STATE_FILE = "enforcement-state.json";

// Upgrade thresholds
const LEVEL_0_TO_1_MIN_OBSERVATIONS = 20;
const LEVEL_1_TO_2_MIN_ACCURACY = 0.75;   // was 0.70 — raise bar slightly
const LEVEL_2_TO_3_MIN_ACCURACY = 0.85;
const LEVEL_2_TO_3_MIN_ACCURATE_DAYS = 5; // was 3 — require longer track record

// Downgrade thresholds
const LEVEL_3_DOWNGRADE_CORRECTIONS_24H = 5;  // was 3 — less sensitive
const LEVEL_2_DOWNGRADE_CONSECUTIVE_ERRORS = 5;

// Cooldown & buffer
const LEVEL_CHANGE_COOLDOWN_DAYS = 3;        // no level change within 3 days of last change
const DOWNGRADE_BUFFER_DAYS = 2;             // must exceed threshold 2 consecutive days to downgrade

/**
 * Create a fresh enforcement state at Level 0.
 */
/**
 * Default starting level — L2 (Guided) so new installs get real dispatch plan injection.
 * Previously L0 (silent), which meant zero enforcement for weeks.
 */
export const DEFAULT_STARTING_LEVEL: EnforcementLevel = 2;

export function createDefaultState(): EnforcementState {
  return {
    currentLevel: DEFAULT_STARTING_LEVEL,
    levelHistory: [{ level: DEFAULT_STARTING_LEVEL, timestamp: new Date(Date.now()).toISOString(), reason: "default install at L2" }],
    lastUpgrade: null,
    lastDowngrade: null,
    lastLevelChange: null,
    consecutiveDowngradeDays: 0,
    observationCount: 0,
    correctionCount: 0,
    consecutiveAccurateDays: 0,
    installedAt: new Date(Date.now()).toISOString(),
    version: 1,
  };
}

/**
 * Load enforcement state from disk, or return default state if not found.
 */
export function loadEnforcementState(sharedRoot: string): EnforcementState {
  const filePath = join(sharedRoot, STATE_FILE);
  if (!existsSync(filePath)) {
    return createDefaultState();
  }
  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as EnforcementState;
    // Validate required fields
    if (
      typeof parsed.currentLevel !== "number" ||
      !Array.isArray(parsed.levelHistory)
    ) {
      return createDefaultState();
    }
    return parsed;
  } catch (error) {
    loggers.enforcement.error(`Failed to load enforcement state`, error, { path: filePath });
    return createDefaultState();
  }
}

/**
 * Save enforcement state to disk.
 */
export function saveEnforcementState(sharedRoot: string, state: EnforcementState): void {
  if (!existsSync(sharedRoot)) {
    mkdirSync(sharedRoot, { recursive: true });
  }
  const filePath = join(sharedRoot, STATE_FILE);
  writeFileSync(filePath, JSON.stringify(state, null, 2), "utf-8");
}

/**
 * Get the behavioral configuration for a given enforcement level.
 */
export function getEnforcementBehavior(level: EnforcementLevel): EnforcementBehavior {
  switch (level) {
    case 0: return {
      injectGuidance: false,
      injectDispatchPlan: false,
      blockNonDispatchTools: false,
      softBlockNonDispatchTools: false,
      logOnly: true,
      advisoryMessage: null,
    };
    case 1: return {
      injectGuidance: true,
      injectDispatchPlan: false,
      blockNonDispatchTools: false,
      softBlockNonDispatchTools: false,
      logOnly: false,
      advisoryMessage: "💡 OMA 建议：这个任务可能适合派遣子 agent 执行。可以调用 sessions_spawn 派工。",
    };
    case 2: return {
      injectGuidance: true,
      injectDispatchPlan: true,
      blockNonDispatchTools: false,
      softBlockNonDispatchTools: true,  // L2: warn first call, block second
      logOnly: false,
      advisoryMessage: null,
    };
    case 3: return {
      injectGuidance: true,
      injectDispatchPlan: true,
      blockNonDispatchTools: true,
      softBlockNonDispatchTools: false, // L3 uses hard block, no need for soft
      logOnly: false,
      advisoryMessage: null,
    };
  }
}

/**
 * Check if the enforcement level should be upgraded based on stats.
 */
export function shouldUpgrade(
  state: EnforcementState,
  stats: ObservationStats,
): { upgrade: boolean; newLevel?: EnforcementLevel; reason?: string } {
  if (state.currentLevel === 0 && stats.totalObservations >= LEVEL_0_TO_1_MIN_OBSERVATIONS) {
    return {
      upgrade: true,
      newLevel: 1,
      reason: `Collected ${stats.totalObservations} observations (threshold: ${LEVEL_0_TO_1_MIN_OBSERVATIONS})`,
    };
  }
  if (state.currentLevel === 1 && stats.accuracy >= LEVEL_1_TO_2_MIN_ACCURACY) {
    return {
      upgrade: true,
      newLevel: 2,
      reason: `Accuracy ${(stats.accuracy * 100).toFixed(0)}% (threshold: ${LEVEL_1_TO_2_MIN_ACCURACY * 100}%)`,
    };
  }
  if (
    state.currentLevel === 2 &&
    stats.accuracy >= LEVEL_2_TO_3_MIN_ACCURACY &&
    state.consecutiveAccurateDays >= LEVEL_2_TO_3_MIN_ACCURATE_DAYS
  ) {
    return {
      upgrade: true,
      newLevel: 3,
      reason: `Accuracy ${(stats.accuracy * 100).toFixed(0)}% for ${state.consecutiveAccurateDays} consecutive days`,
    };
  }
  return { upgrade: false };
}

/**
 * Check if the enforcement level should be downgraded.
 */
export function shouldDowngrade(
  state: EnforcementState,
  recentCorrections24h: number,
  recentConsecutiveErrors: number,
): { downgrade: boolean; newLevel?: EnforcementLevel; reason?: string } {
  if (state.currentLevel === 3 && recentCorrections24h >= LEVEL_3_DOWNGRADE_CORRECTIONS_24H) {
    return {
      downgrade: true,
      newLevel: 2,
      reason: `${recentCorrections24h} corrections in 24h (threshold: ${LEVEL_3_DOWNGRADE_CORRECTIONS_24H})`,
    };
  }
  if (state.currentLevel === 2 && recentConsecutiveErrors >= LEVEL_2_DOWNGRADE_CONSECUTIVE_ERRORS) {
    return {
      downgrade: true,
      newLevel: 1,
      reason: `${recentConsecutiveErrors} consecutive errors`,
    };
  }
  return { downgrade: false };
}

/**
 * Apply an upgrade or downgrade to the state (mutates in-place).
 */
/**
 * Check if we're within the cooldown period after last level change.
 */
export function isInCooldown(state: EnforcementState): boolean {
  if (!state.lastLevelChange) return false;
  const elapsed = Date.now() - new Date(state.lastLevelChange).getTime();
  const cooldownMs = LEVEL_CHANGE_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
  return elapsed < cooldownMs;
}

export function applyLevelChange(
  state: EnforcementState,
  newLevel: EnforcementLevel,
  reason: string,
): void {
  const now = new Date(Date.now()).toISOString();
  const oldLevel = state.currentLevel;
  state.levelHistory.push({ level: newLevel, timestamp: now, reason });
  state.currentLevel = newLevel;
  state.lastLevelChange = now;
  state.consecutiveDowngradeDays = 0; // reset buffer on any change

  if (newLevel > oldLevel) {
    state.lastUpgrade = now;
  } else {
    state.lastDowngrade = now;
  }
}

/**
 * Evaluate and auto-adjust the enforcement level.
 * Called periodically (e.g., daily or after each observation batch).
 */
export function evaluateAndAdjust(
  state: EnforcementState,
  stats: ObservationStats,
  recentCorrections24h: number,
): {
  changed: boolean;
  oldLevel: EnforcementLevel;
  newLevel: EnforcementLevel;
  reason?: string;
} {
  const oldLevel = state.currentLevel;

  // Cooldown: skip evaluation if we changed level recently
  if (isInCooldown(state)) {
    // Still track downgrade pressure even during cooldown
    const recentConsecutiveErrors = recentCorrections24h;
    const downgradeResult = shouldDowngrade(state, recentCorrections24h, recentConsecutiveErrors);
    if (downgradeResult.downgrade) {
      state.consecutiveDowngradeDays++;
    } else {
      state.consecutiveDowngradeDays = 0;
    }
    return { changed: false, oldLevel, newLevel: oldLevel };
  }

  // Check downgrade first (degradation takes priority)
  const recentConsecutiveErrors = recentCorrections24h;
  const downgradeResult = shouldDowngrade(state, recentCorrections24h, recentConsecutiveErrors);
  if (downgradeResult.downgrade && downgradeResult.newLevel !== undefined) {
    // Buffer: require consecutive days exceeding threshold before actually downgrading
    state.consecutiveDowngradeDays++;
    if (state.consecutiveDowngradeDays >= DOWNGRADE_BUFFER_DAYS) {
      applyLevelChange(state, downgradeResult.newLevel, downgradeResult.reason ?? "downgrade");
      return {
        changed: true,
        oldLevel,
        newLevel: downgradeResult.newLevel,
        reason: `${downgradeResult.reason} (${state.consecutiveDowngradeDays} consecutive days)`,
      };
    }
    // Not enough consecutive days yet — hold level
    return { changed: false, oldLevel, newLevel: oldLevel };
  } else {
    // No downgrade pressure — reset counter
    state.consecutiveDowngradeDays = 0;
  }

  // Check upgrade
  const upgradeResult = shouldUpgrade(state, stats);
  if (upgradeResult.upgrade && upgradeResult.newLevel !== undefined) {
    applyLevelChange(state, upgradeResult.newLevel, upgradeResult.reason ?? "upgrade");
    return {
      changed: true,
      oldLevel,
      newLevel: upgradeResult.newLevel,
      reason: upgradeResult.reason,
    };
  }

  return { changed: false, oldLevel, newLevel: oldLevel };
}

/**
 * Format the current enforcement status for display.
 */
export function formatEnforcementStatus(
  state: EnforcementState,
  stats?: ObservationStats,
): string {
  const levelLabels: Record<EnforcementLevel, string> = {
    0: "Level 0 — Observation Only (silent)",
    1: "Level 1 — Advisory (soft suggestions)",
    2: "Level 2 — Guided (dispatch plan injected)",
    3: "Level 3 — Full Enforcement (hard block)",
  };

  const lines = [
    `OMA Enforcement Status`,
    `  Current: ${levelLabels[state.currentLevel]}`,
    `  Installed: ${state.installedAt}`,
    `  Observations: ${state.observationCount}`,
    `  Corrections: ${state.correctionCount}`,
    `  Consecutive accurate days: ${state.consecutiveAccurateDays}`,
    `  Last upgrade: ${state.lastUpgrade ?? "never"}`,
    `  Last downgrade: ${state.lastDowngrade ?? "never"}`,
    `  Level history entries: ${state.levelHistory.length}`,
  ];

  if (stats) {
    lines.push("");
    lines.push("Observation Stats (last 7 days):");
    lines.push(`  Total observations: ${stats.totalObservations}`);
    lines.push(`  Accuracy: ${(stats.accuracy * 100).toFixed(1)}%`);
    lines.push(`  Correction rate: ${(stats.correctionRate * 100).toFixed(1)}%`);

    // Show upgrade/downgrade progress hints
    if (state.currentLevel === 0) {
      const needed = Math.max(0, LEVEL_0_TO_1_MIN_OBSERVATIONS - stats.totalObservations);
      lines.push(`  To Level 1: ${needed > 0 ? `${needed} more observations needed` : "ready to upgrade"}`);
    } else if (state.currentLevel === 1) {
      const pct = (stats.accuracy * 100).toFixed(1);
      lines.push(`  To Level 2: accuracy ${pct}% (need ${LEVEL_1_TO_2_MIN_ACCURACY * 100}%)`);
    } else if (state.currentLevel === 2) {
      const pct = (stats.accuracy * 100).toFixed(1);
      lines.push(
        `  To Level 3: accuracy ${pct}% (need ${LEVEL_2_TO_3_MIN_ACCURACY * 100}%) ` +
        `+ ${state.consecutiveAccurateDays}/${LEVEL_2_TO_3_MIN_ACCURATE_DAYS} accurate days`,
      );
    }
  }

  if (state.levelHistory.length > 0) {
    lines.push("");
    lines.push("Recent level changes:");
    const recent = state.levelHistory.slice(-5);
    for (const entry of recent) {
      lines.push(`  [${entry.timestamp.slice(0, 10)}] → Level ${entry.level}: ${entry.reason}`);
    }
  }

  return lines.join("\n");
}
