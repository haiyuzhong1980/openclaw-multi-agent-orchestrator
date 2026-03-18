import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadRecentObservations, computeStats, pruneObservations } from "./observation-engine.ts";
import type { ObservationStats } from "./observation-engine.ts";
import { discoverPatterns } from "./pattern-discovery.ts";
import type { DiscoveryResult } from "./pattern-discovery.ts";
import { evaluateAndAdjust } from "./enforcement-ladder.ts";
import type { EnforcementState } from "./enforcement-ladder.ts";
import type { IntentRegistry } from "./intent-registry.ts";
import { addUserKeyword, pruneSubstringKeywords } from "./user-keywords.ts";
import type { UserKeywords } from "./user-keywords.ts";

export interface EvolutionReport {
  timestamp: string;
  observationsAnalyzed: number;
  accuracy: number;

  // Pattern discoveries
  newDelegationKeywords: string[];
  newTrackedKeywords: string[];
  autoApplied: string[];       // high-confidence patterns auto-added
  pendingReview: string[];     // low-confidence patterns queued

  // Enforcement changes
  enforcementLevelBefore: number;
  enforcementLevelAfter: number;
  enforcementReason?: string;

  // Maintenance
  observationsPruned: number;

  // Summary
  summary: string;
}

const EVOLUTION_LOG_FILE = "evolution-history.json";
const AUTO_APPLY_THRESHOLD = 0.8;  // confidence >= 0.8 → auto-apply
const REVIEW_THRESHOLD = 0.6;      // 0.6–0.8 → queue for review
const MIN_OBSERVATIONS_FOR_EVOLUTION = 10;
const OBSERVATION_WINDOW_HOURS = 24 * 7; // last 7 days

/**
 * Run one complete evolution cycle.
 */
export function runEvolutionCycle(params: {
  sharedRoot: string;
  intentRegistry: IntentRegistry;
  userKeywords: UserKeywords;
  enforcementState: EnforcementState;
  existingDelegationKeywords: string[];
  existingTrackedKeywords: string[];
}): EvolutionReport {
  const { sharedRoot, userKeywords, enforcementState, existingDelegationKeywords, existingTrackedKeywords } = params;
  const timestamp = new Date(Date.now()).toISOString();

  // Step 1: Load last 7 days of observations
  const observations = loadRecentObservations(sharedRoot, OBSERVATION_WINDOW_HOURS);

  // Step 2: If < 10 observations → return minimal report (not enough data)
  if (observations.length < MIN_OBSERVATIONS_FOR_EVOLUTION) {
    return {
      timestamp,
      observationsAnalyzed: observations.length,
      accuracy: 0,
      newDelegationKeywords: [],
      newTrackedKeywords: [],
      autoApplied: [],
      pendingReview: [],
      enforcementLevelBefore: enforcementState.currentLevel,
      enforcementLevelAfter: enforcementState.currentLevel,
      observationsPruned: 0,
      summary: `Not enough observations (${observations.length}/${MIN_OBSERVATIONS_FOR_EVOLUTION}) — skipping evolution.`,
    };
  }

  // Step 3: Compute stats
  const stats: ObservationStats = computeStats(observations);

  // Step 4: Run pattern discovery
  const discoveries: DiscoveryResult = discoverPatterns(
    observations,
    existingDelegationKeywords,
    existingTrackedKeywords,
  );

  // Step 5 & 6: Auto-apply high-confidence patterns, queue mid-confidence
  const { applied, pending } = autoApplyPatterns(discoveries, userKeywords, AUTO_APPLY_THRESHOLD);

  // Step 5.5: Prune substring keywords to control bloat
  pruneSubstringKeywords(userKeywords);

  // Step 7: Evaluate enforcement level
  const recentCorrections24h = observations.filter(
    (o) => {
      const ageMs = Date.now() - new Date(o.timestamp).getTime();
      const within24h = ageMs <= 24 * 60 * 60 * 1000;
      return within24h && (o.userFollowUp === "corrected_up" || o.userFollowUp === "corrected_down");
    },
  ).length;

  const enforcementLevelBefore = enforcementState.currentLevel;
  const enforcementResult = evaluateAndAdjust(enforcementState, stats, recentCorrections24h);
  const enforcementLevelAfter = enforcementState.currentLevel;

  // Step 8: Prune old observations (> 30 days)
  const observationsPruned = pruneObservations(sharedRoot);

  // Step 9: Build and return report
  const newDelegationKeywords = discoveries.newDelegationKeywords.map((p) => p.phrase);
  const newTrackedKeywords = discoveries.newTrackedKeywords.map((p) => p.phrase);

  const summaryParts: string[] = [
    `Analyzed ${observations.length} observations (accuracy: ${(stats.accuracy * 100).toFixed(1)}%).`,
  ];
  if (applied.length > 0) {
    summaryParts.push(`Auto-applied ${applied.length} high-confidence pattern(s).`);
  }
  if (pending.length > 0) {
    summaryParts.push(`${pending.length} pattern(s) queued for review.`);
  }
  if (enforcementResult.changed) {
    summaryParts.push(`Enforcement level: ${enforcementLevelBefore} → ${enforcementLevelAfter}.`);
  }
  if (observationsPruned > 0) {
    summaryParts.push(`Pruned ${observationsPruned} old observation(s).`);
  }

  return {
    timestamp,
    observationsAnalyzed: observations.length,
    accuracy: stats.accuracy,
    newDelegationKeywords,
    newTrackedKeywords,
    autoApplied: applied,
    pendingReview: pending,
    enforcementLevelBefore,
    enforcementLevelAfter,
    enforcementReason: enforcementResult.changed ? enforcementResult.reason : undefined,
    observationsPruned,
    summary: summaryParts.join(" "),
  };
}

/**
 * Auto-apply high-confidence discovered patterns to the keyword library.
 */
export function autoApplyPatterns(
  discoveries: DiscoveryResult,
  userKeywords: UserKeywords,
  threshold = AUTO_APPLY_THRESHOLD,
): { applied: string[]; pending: string[] } {
  const applied: string[] = [];
  const pending: string[] = [];

  const allPatterns = [
    ...discoveries.newDelegationKeywords,
    ...discoveries.newTrackedKeywords,
  ];

  for (const pattern of allPatterns) {
    if (pattern.confidence >= threshold) {
      addUserKeyword(userKeywords, pattern.suggestedTier, pattern.phrase);
      applied.push(pattern.phrase);
    } else if (pattern.confidence >= REVIEW_THRESHOLD) {
      pending.push(pattern.phrase);
    }
    // Below REVIEW_THRESHOLD: silently ignored
  }

  return { applied, pending };
}

/**
 * Load evolution history (past reports).
 */
export function loadEvolutionHistory(sharedRoot: string): EvolutionReport[] {
  const filePath = join(sharedRoot, EVOLUTION_LOG_FILE);
  if (!existsSync(filePath)) return [];
  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as EvolutionReport[];
  } catch {
    return [];
  }
}

/**
 * Save a new evolution report to history.
 */
export function appendEvolutionReport(sharedRoot: string, report: EvolutionReport): void {
  if (!existsSync(sharedRoot)) {
    mkdirSync(sharedRoot, { recursive: true });
  }
  const history = loadEvolutionHistory(sharedRoot);
  history.push(report);
  const filePath = join(sharedRoot, EVOLUTION_LOG_FILE);
  writeFileSync(filePath, JSON.stringify(history, null, 2), "utf-8");
}

/**
 * Format an evolution report as readable text.
 */
export function formatEvolutionReport(report: EvolutionReport): string {
  const lines: string[] = [
    `Evolution Cycle Report`,
    `======================`,
    `Timestamp: ${report.timestamp}`,
    `Observations analyzed: ${report.observationsAnalyzed}`,
    `Accuracy: ${(report.accuracy * 100).toFixed(1)}%`,
    "",
  ];

  if (report.autoApplied.length > 0) {
    lines.push(`Auto-applied patterns (${report.autoApplied.length}):`);
    for (const phrase of report.autoApplied) {
      lines.push(`  + "${phrase}"`);
    }
    lines.push("");
  } else {
    lines.push("No patterns auto-applied.");
    lines.push("");
  }

  if (report.pendingReview.length > 0) {
    lines.push(`Pending review (${report.pendingReview.length}):`);
    for (const phrase of report.pendingReview) {
      lines.push(`  ? "${phrase}"`);
    }
    lines.push("");
  }

  if (report.newDelegationKeywords.length > 0) {
    lines.push(`New delegation keywords discovered: ${report.newDelegationKeywords.join(", ")}`);
  }
  if (report.newTrackedKeywords.length > 0) {
    lines.push(`New tracked keywords discovered: ${report.newTrackedKeywords.join(", ")}`);
  }

  lines.push("");
  lines.push(`Enforcement level: ${report.enforcementLevelBefore} → ${report.enforcementLevelAfter}`);
  if (report.enforcementReason) {
    lines.push(`  Reason: ${report.enforcementReason}`);
  }

  if (report.observationsPruned > 0) {
    lines.push(`Observations pruned: ${report.observationsPruned}`);
  }

  lines.push("");
  lines.push(`Summary: ${report.summary}`);

  return lines.join("\n");
}
