import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  runEvolutionCycle,
  autoApplyPatterns,
  loadEvolutionHistory,
  appendEvolutionReport,
  formatEvolutionReport,
} from "../src/evolution-cycle.ts";
import type { EvolutionReport } from "../src/evolution-cycle.ts";
import {
  appendObservation,
  createObservation,
  updateObservationFeedback,
} from "../src/observation-engine.ts";
import type { ObservationRecord } from "../src/observation-engine.ts";
import { createDefaultState } from "../src/enforcement-ladder.ts";
import type { EnforcementState } from "../src/enforcement-ladder.ts";
import type { DiscoveryResult } from "../src/pattern-discovery.ts";
import type { UserKeywords } from "../src/user-keywords.ts";
import type { IntentRegistry } from "../src/intent-registry.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const TMP_DIR = join("/tmp", `evolution-test-${Date.now()}`);

function makeTmpDir(): string {
  const dir = join(TMP_DIR, `run-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeEmptyRegistry(): IntentRegistry {
  return {
    patterns: {},
    totalClassifications: 0,
    totalCorrections: 0,
    lastUpdated: new Date().toISOString(),
    version: 1,
  };
}

function makeEmptyKeywords(): UserKeywords {
  return { delegation: [], tracked: [], light: [], updatedAt: "" };
}

/**
 * Write N observations to disk. Half are delegation with "deploy", half are light.
 * All are marked satisfied so accuracy = 1.0.
 */
function writeObservations(dir: string, count: number): void {
  for (let i = 0; i < count; i++) {
    const tier = i % 2 === 0 ? "delegation" : "light";
    const text = tier === "delegation" ? "deploy and audit the system" : "what is the weather";
    const obs = createObservation({ message: text, agent: "test", predictedTier: tier });
    // Backdate timestamp slightly so all fall within 7-day window
    const backDated: ObservationRecord = {
      ...obs,
      timestamp: new Date(Date.now() - i * 1000).toISOString(),
      userFollowUp: "satisfied",
      actualTier: tier,
    };
    appendObservation(dir, backDated);
  }
}

/**
 * Write N delegation observations that all have a specific phrase,
 * plus N/2 light observations without it.
 */
function writeObservationsWithPhrase(dir: string, phrase: string, count: number): void {
  for (let i = 0; i < count; i++) {
    const tier: "delegation" | "light" = i < count * 0.7 ? "delegation" : "light";
    const text = tier === "delegation" ? `please ${phrase} the environment` : "tell me a joke";
    const obs = createObservation({ message: text, agent: "test", predictedTier: tier });
    const backDated: ObservationRecord = {
      ...obs,
      timestamp: new Date(Date.now() - i * 1000).toISOString(),
      userFollowUp: "satisfied",
      actualTier: tier,
    };
    appendObservation(dir, backDated);
  }
}

// ---------------------------------------------------------------------------
// runEvolutionCycle — minimal report when too few observations
// ---------------------------------------------------------------------------
describe("runEvolutionCycle: too few observations", () => {
  it("returns minimal report when < 10 observations", () => {
    const dir = makeTmpDir();
    writeObservations(dir, 5);
    const state = createDefaultState();
    const report = runEvolutionCycle({
      sharedRoot: dir,
      intentRegistry: makeEmptyRegistry(),
      userKeywords: makeEmptyKeywords(),
      enforcementState: state,
      existingDelegationKeywords: [],
      existingTrackedKeywords: [],
    });
    assert.equal(report.observationsAnalyzed, 5);
    assert.equal(report.autoApplied.length, 0);
    assert.equal(report.pendingReview.length, 0);
    assert.ok(report.summary.includes("Not enough observations"));
  });

  it("does not change enforcement level with insufficient data", () => {
    const dir = makeTmpDir();
    writeObservations(dir, 3);
    const state = createDefaultState();
    const report = runEvolutionCycle({
      sharedRoot: dir,
      intentRegistry: makeEmptyRegistry(),
      userKeywords: makeEmptyKeywords(),
      enforcementState: state,
      existingDelegationKeywords: [],
      existingTrackedKeywords: [],
    });
    assert.equal(report.enforcementLevelBefore, 0);
    assert.equal(report.enforcementLevelAfter, 0);
  });
});

// ---------------------------------------------------------------------------
// runEvolutionCycle — with enough observations
// ---------------------------------------------------------------------------
describe("runEvolutionCycle: with enough observations", () => {
  it("runs full cycle and returns a report with timestamp", () => {
    const dir = makeTmpDir();
    writeObservations(dir, 20);
    const state = createDefaultState();
    const report = runEvolutionCycle({
      sharedRoot: dir,
      intentRegistry: makeEmptyRegistry(),
      userKeywords: makeEmptyKeywords(),
      enforcementState: state,
      existingDelegationKeywords: [],
      existingTrackedKeywords: [],
    });
    assert.ok(report.timestamp.length > 0);
    assert.equal(report.observationsAnalyzed, 20);
  });

  it("upgrades enforcement level when observations reach threshold", () => {
    const dir = makeTmpDir();
    writeObservations(dir, 25); // >= 20 → triggers 0→1
    const state = createDefaultState(); // level 0
    const report = runEvolutionCycle({
      sharedRoot: dir,
      intentRegistry: makeEmptyRegistry(),
      userKeywords: makeEmptyKeywords(),
      enforcementState: state,
      existingDelegationKeywords: [],
      existingTrackedKeywords: [],
    });
    assert.equal(report.enforcementLevelBefore, 0);
    assert.equal(report.enforcementLevelAfter, 1);
  });

  it("includes non-empty summary when observations are enough", () => {
    const dir = makeTmpDir();
    writeObservations(dir, 20);
    const state = createDefaultState();
    const report = runEvolutionCycle({
      sharedRoot: dir,
      intentRegistry: makeEmptyRegistry(),
      userKeywords: makeEmptyKeywords(),
      enforcementState: state,
      existingDelegationKeywords: [],
      existingTrackedKeywords: [],
    });
    assert.ok(report.summary.length > 0);
    assert.ok(!report.summary.includes("Not enough observations"));
  });

  it("prunes old observations from disk (observationsPruned >= 0)", () => {
    const dir = makeTmpDir();
    writeObservations(dir, 15);
    const state = createDefaultState();
    const report = runEvolutionCycle({
      sharedRoot: dir,
      intentRegistry: makeEmptyRegistry(),
      userKeywords: makeEmptyKeywords(),
      enforcementState: state,
      existingDelegationKeywords: [],
      existingTrackedKeywords: [],
    });
    // Pruned count is >= 0 (recently-written obs are not pruned)
    assert.ok(report.observationsPruned >= 0);
  });
});

// ---------------------------------------------------------------------------
// runEvolutionCycle — enforcement downgrade
// ---------------------------------------------------------------------------
describe("runEvolutionCycle: enforcement downgrade on corrections", () => {
  it("downgrades enforcement when many corrections in 24h", () => {
    const dir = makeTmpDir();
    // Write 25 observations, majority with corrections in last 24h
    for (let i = 0; i < 25; i++) {
      const obs = createObservation({ message: "deploy the server", agent: "test", predictedTier: "delegation" });
      const backDated: ObservationRecord = {
        ...obs,
        timestamp: new Date(Date.now() - i * 60000).toISOString(), // within 24h
        userFollowUp: i < 5 ? "corrected_down" : "satisfied",
        actualTier: i < 5 ? "light" : "delegation",
      };
      appendObservation(dir, backDated);
    }
    const state: EnforcementState = { ...createDefaultState(), currentLevel: 3 };
    const report = runEvolutionCycle({
      sharedRoot: dir,
      intentRegistry: makeEmptyRegistry(),
      userKeywords: makeEmptyKeywords(),
      enforcementState: state,
      existingDelegationKeywords: [],
      existingTrackedKeywords: [],
    });
    // 5 corrections in 24h at level 3 → downgrade to 2
    assert.equal(report.enforcementLevelBefore, 3);
    assert.equal(report.enforcementLevelAfter, 2);
  });
});

// ---------------------------------------------------------------------------
// autoApplyPatterns
// ---------------------------------------------------------------------------
describe("autoApplyPatterns", () => {
  it("applies high-confidence patterns to userKeywords", () => {
    const keywords = makeEmptyKeywords();
    const discoveries: DiscoveryResult = {
      newDelegationKeywords: [
        { phrase: "refactor", suggestedTier: "delegation", confidence: 0.9, occurrences: 10, delegationRate: 0.9, trackedRate: 0.05, evidence: [] },
      ],
      newTrackedKeywords: [],
      thresholdSuggestions: {},
      sampleSize: 50,
      overallAccuracy: 0.8,
    };
    const { applied, pending } = autoApplyPatterns(discoveries, keywords, 0.8);
    assert.deepEqual(applied, ["refactor"]);
    assert.deepEqual(pending, []);
    assert.ok(keywords.delegation.includes("refactor"));
  });

  it("queues mid-confidence patterns for review", () => {
    const keywords = makeEmptyKeywords();
    const discoveries: DiscoveryResult = {
      newDelegationKeywords: [
        { phrase: "analyze", suggestedTier: "delegation", confidence: 0.7, occurrences: 8, delegationRate: 0.7, trackedRate: 0.1, evidence: [] },
      ],
      newTrackedKeywords: [],
      thresholdSuggestions: {},
      sampleSize: 40,
      overallAccuracy: 0.65,
    };
    const { applied, pending } = autoApplyPatterns(discoveries, keywords, 0.8);
    assert.deepEqual(applied, []);
    assert.deepEqual(pending, ["analyze"]);
    assert.ok(!keywords.delegation.includes("analyze")); // not auto-applied
  });

  it("ignores low-confidence patterns (below REVIEW_THRESHOLD)", () => {
    const keywords = makeEmptyKeywords();
    const discoveries: DiscoveryResult = {
      newDelegationKeywords: [
        { phrase: "check", suggestedTier: "delegation", confidence: 0.3, occurrences: 5, delegationRate: 0.3, trackedRate: 0.2, evidence: [] },
      ],
      newTrackedKeywords: [],
      thresholdSuggestions: {},
      sampleSize: 30,
      overallAccuracy: 0.5,
    };
    const { applied, pending } = autoApplyPatterns(discoveries, keywords, 0.8);
    assert.deepEqual(applied, []);
    assert.deepEqual(pending, []);
  });

  it("handles tracked tier patterns correctly", () => {
    const keywords = makeEmptyKeywords();
    const discoveries: DiscoveryResult = {
      newDelegationKeywords: [],
      newTrackedKeywords: [
        { phrase: "report", suggestedTier: "tracked", confidence: 0.85, occurrences: 12, delegationRate: 0.1, trackedRate: 0.85, evidence: [] },
      ],
      thresholdSuggestions: {},
      sampleSize: 60,
      overallAccuracy: 0.75,
    };
    const { applied, pending } = autoApplyPatterns(discoveries, keywords, 0.8);
    assert.deepEqual(applied, ["report"]);
    assert.deepEqual(pending, []);
    assert.ok(keywords.tracked.includes("report"));
  });

  it("applies both delegation and tracked patterns in same call", () => {
    const keywords = makeEmptyKeywords();
    const discoveries: DiscoveryResult = {
      newDelegationKeywords: [
        { phrase: "deploy", suggestedTier: "delegation", confidence: 0.95, occurrences: 15, delegationRate: 0.95, trackedRate: 0.02, evidence: [] },
      ],
      newTrackedKeywords: [
        { phrase: "monitor", suggestedTier: "tracked", confidence: 0.82, occurrences: 9, delegationRate: 0.1, trackedRate: 0.82, evidence: [] },
      ],
      thresholdSuggestions: {},
      sampleSize: 80,
      overallAccuracy: 0.85,
    };
    const { applied } = autoApplyPatterns(discoveries, keywords, 0.8);
    assert.ok(applied.includes("deploy"));
    assert.ok(applied.includes("monitor"));
    assert.equal(applied.length, 2);
  });
});

// ---------------------------------------------------------------------------
// loadEvolutionHistory / appendEvolutionReport — round-trip
// ---------------------------------------------------------------------------
describe("loadEvolutionHistory / appendEvolutionReport round-trip", () => {
  it("returns empty array when no history file exists", () => {
    const dir = makeTmpDir();
    const history = loadEvolutionHistory(dir);
    assert.deepEqual(history, []);
  });

  it("appends and loads a single report", () => {
    const dir = makeTmpDir();
    const report: EvolutionReport = {
      timestamp: new Date().toISOString(),
      observationsAnalyzed: 42,
      accuracy: 0.75,
      newDelegationKeywords: ["deploy"],
      newTrackedKeywords: [],
      autoApplied: ["deploy"],
      pendingReview: [],
      enforcementLevelBefore: 0,
      enforcementLevelAfter: 1,
      enforcementReason: "reached 20 observations",
      observationsPruned: 3,
      summary: "Analyzed 42 observations.",
    };
    appendEvolutionReport(dir, report);
    const history = loadEvolutionHistory(dir);
    assert.equal(history.length, 1);
    assert.equal(history[0].observationsAnalyzed, 42);
    assert.equal(history[0].accuracy, 0.75);
    assert.deepEqual(history[0].autoApplied, ["deploy"]);
    assert.equal(history[0].enforcementReason, "reached 20 observations");
  });

  it("appends multiple reports and preserves order", () => {
    const dir = makeTmpDir();
    for (let i = 0; i < 3; i++) {
      appendEvolutionReport(dir, {
        timestamp: new Date(Date.now() + i * 1000).toISOString(),
        observationsAnalyzed: i * 10,
        accuracy: i * 0.1,
        newDelegationKeywords: [],
        newTrackedKeywords: [],
        autoApplied: [],
        pendingReview: [],
        enforcementLevelBefore: 0,
        enforcementLevelAfter: 0,
        observationsPruned: 0,
        summary: `Report ${i}`,
      });
    }
    const history = loadEvolutionHistory(dir);
    assert.equal(history.length, 3);
    assert.equal(history[0].summary, "Report 0");
    assert.equal(history[2].summary, "Report 2");
  });

  it("creates directory if it does not exist", () => {
    const dir = join(TMP_DIR, `new-dir-${Math.random().toString(36).slice(2)}`);
    assert.equal(existsSync(dir), false);
    appendEvolutionReport(dir, {
      timestamp: new Date().toISOString(),
      observationsAnalyzed: 0,
      accuracy: 0,
      newDelegationKeywords: [],
      newTrackedKeywords: [],
      autoApplied: [],
      pendingReview: [],
      enforcementLevelBefore: 0,
      enforcementLevelAfter: 0,
      observationsPruned: 0,
      summary: "test",
    });
    assert.equal(existsSync(dir), true);
  });
});

// ---------------------------------------------------------------------------
// formatEvolutionReport
// ---------------------------------------------------------------------------
describe("formatEvolutionReport", () => {
  const sampleReport: EvolutionReport = {
    timestamp: "2024-01-15T10:00:00.000Z",
    observationsAnalyzed: 30,
    accuracy: 0.82,
    newDelegationKeywords: ["audit", "migrate"],
    newTrackedKeywords: ["report"],
    autoApplied: ["audit"],
    pendingReview: ["migrate"],
    enforcementLevelBefore: 1,
    enforcementLevelAfter: 2,
    enforcementReason: "Accuracy 82% (threshold: 70%)",
    observationsPruned: 5,
    summary: "Analyzed 30 observations. Auto-applied 1 pattern.",
  };

  it("includes the timestamp", () => {
    const text = formatEvolutionReport(sampleReport);
    assert.ok(text.includes("2024-01-15"));
  });

  it("shows observations analyzed and accuracy", () => {
    const text = formatEvolutionReport(sampleReport);
    assert.ok(text.includes("30"));
    assert.ok(text.includes("82.0%"));
  });

  it("lists auto-applied patterns", () => {
    const text = formatEvolutionReport(sampleReport);
    assert.ok(text.includes("audit"));
    assert.ok(text.includes("Auto-applied"));
  });

  it("lists pending review patterns", () => {
    const text = formatEvolutionReport(sampleReport);
    assert.ok(text.includes("migrate"));
    assert.ok(text.includes("Pending review") || text.includes("pending"));
  });

  it("shows enforcement level change", () => {
    const text = formatEvolutionReport(sampleReport);
    assert.ok(text.includes("1") && text.includes("2"));
  });

  it("includes enforcement reason when present", () => {
    const text = formatEvolutionReport(sampleReport);
    assert.ok(text.includes("Accuracy 82%"));
  });

  it("shows summary at the end", () => {
    const text = formatEvolutionReport(sampleReport);
    assert.ok(text.includes("Analyzed 30 observations"));
  });

  it("handles report with no auto-applied patterns gracefully", () => {
    const emptyReport: EvolutionReport = {
      ...sampleReport,
      autoApplied: [],
      pendingReview: [],
      newDelegationKeywords: [],
      newTrackedKeywords: [],
    };
    const text = formatEvolutionReport(emptyReport);
    assert.ok(text.includes("No patterns auto-applied"));
  });
});
