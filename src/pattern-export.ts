import type { IntentRegistry } from "./intent-registry.ts";
import type { UserKeywords } from "./user-keywords.ts";
import type { EnforcementState } from "./enforcement-ladder.ts";
import type { ObservationRecord } from "./observation-engine.ts";
import { computeStats } from "./observation-engine.ts";
import { addUserKeyword } from "./user-keywords.ts";

export interface ExportedPatterns {
  version: number;
  exportedAt: string;
  source: string; // plugin instance identifier

  intentPatterns: Record<
    string,
    { confidence: { delegation: number; tracked: number; light: number }; occurrences: number }
  >;
  userKeywords: { delegation: string[]; tracked: string[]; light: string[] };
  discoveredPatterns: string[];

  stats: {
    totalObservations: number;
    accuracy: number;
    enforcementLevel: number;
  };
}

/**
 * Export current learned patterns to a portable format.
 */
export function exportPatterns(params: {
  intentRegistry: IntentRegistry;
  userKeywords: UserKeywords;
  enforcementState: EnforcementState;
  observations: ObservationRecord[];
}): ExportedPatterns {
  const { intentRegistry, userKeywords, enforcementState, observations } = params;
  const stats = computeStats(observations);

  const intentPatterns: ExportedPatterns["intentPatterns"] = {};
  for (const [phrase, pattern] of Object.entries(intentRegistry.patterns)) {
    intentPatterns[phrase] = {
      confidence: { ...pattern.confidence },
      occurrences: pattern.occurrences,
    };
  }

  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    source: `oma-${Date.now()}`,
    intentPatterns,
    userKeywords: {
      delegation: [...userKeywords.delegation],
      tracked: [...userKeywords.tracked],
      light: [...userKeywords.light],
    },
    discoveredPatterns: [],
    stats: {
      totalObservations: stats.totalObservations,
      accuracy: stats.accuracy,
      enforcementLevel: enforcementState.currentLevel,
    },
  };
}

/**
 * Import patterns from an export file.
 * Merges with existing patterns (doesn't overwrite).
 */
export function importPatterns(params: {
  exported: ExportedPatterns;
  intentRegistry: IntentRegistry;
  userKeywords: UserKeywords;
}): { patternsImported: number; keywordsImported: number } {
  const { exported, intentRegistry, userKeywords } = params;
  let patternsImported = 0;
  let keywordsImported = 0;

  // Merge intent patterns — only add phrases not already present
  for (const [phrase, data] of Object.entries(exported.intentPatterns)) {
    if (!intentRegistry.patterns[phrase]) {
      intentRegistry.patterns[phrase] = {
        phrase,
        occurrences: data.occurrences,
        delegationCount: Math.round(data.confidence.delegation * data.occurrences),
        trackedCount: Math.round(data.confidence.tracked * data.occurrences),
        lightCount: Math.round(data.confidence.light * data.occurrences),
        lastSeen: exported.exportedAt,
        confidence: { ...data.confidence },
      };
      patternsImported++;
    }
  }

  // Merge user keywords — avoid duplicates
  for (const phrase of exported.userKeywords.delegation) {
    const before = userKeywords.delegation.length;
    addUserKeyword(userKeywords, "delegation", phrase);
    if (userKeywords.delegation.length > before) keywordsImported++;
  }
  for (const phrase of exported.userKeywords.tracked) {
    const before = userKeywords.tracked.length;
    addUserKeyword(userKeywords, "tracked", phrase);
    if (userKeywords.tracked.length > before) keywordsImported++;
  }
  for (const phrase of exported.userKeywords.light) {
    const before = userKeywords.light.length;
    addUserKeyword(userKeywords, "light", phrase);
    if (userKeywords.light.length > before) keywordsImported++;
  }

  return { patternsImported, keywordsImported };
}

/**
 * Serialize patterns to JSON string.
 */
export function serializeExport(patterns: ExportedPatterns): string {
  return JSON.stringify(patterns, null, 2);
}

/**
 * Parse patterns from JSON string.
 */
export function parseImport(json: string): ExportedPatterns | null {
  try {
    const parsed = JSON.parse(json) as ExportedPatterns;
    if (
      typeof parsed.version !== "number" ||
      typeof parsed.exportedAt !== "string" ||
      typeof parsed.intentPatterns !== "object" ||
      parsed.intentPatterns === null
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
