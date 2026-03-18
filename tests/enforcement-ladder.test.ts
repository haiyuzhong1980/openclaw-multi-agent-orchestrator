import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createDefaultState,
  loadEnforcementState,
  saveEnforcementState,
  getEnforcementBehavior,
  shouldUpgrade,
  shouldDowngrade,
  applyLevelChange,
  evaluateAndAdjust,
  formatEnforcementStatus,
} from "../src/enforcement-ladder.ts";
import type { EnforcementState } from "../src/enforcement-ladder.ts";
import type { ObservationStats } from "../src/observation-engine.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const TMP_DIR = join("/tmp", `enforcement-test-${Date.now()}`);

function makeTmpDir(): string {
  const dir = join(TMP_DIR, `run-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeStats(overrides: Partial<ObservationStats> = {}): ObservationStats {
  return {
    totalObservations: 0,
    last24h: 0,
    last7d: 0,
    tierDistribution: { light: 0, tracked: 0, delegation: 0 },
    accuracy: 0,
    correctionRate: 0,
    topMispredictions: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// createDefaultState
// ---------------------------------------------------------------------------
describe("createDefaultState", () => {
  it("starts at level 0", () => {
    const state = createDefaultState();
    assert.equal(state.currentLevel, 0);
  });

  it("has empty level history", () => {
    const state = createDefaultState();
    assert.deepEqual(state.levelHistory, []);
  });

  it("lastUpgrade and lastDowngrade are null", () => {
    const state = createDefaultState();
    assert.equal(state.lastUpgrade, null);
    assert.equal(state.lastDowngrade, null);
  });

  it("observationCount and correctionCount start at 0", () => {
    const state = createDefaultState();
    assert.equal(state.observationCount, 0);
    assert.equal(state.correctionCount, 0);
  });

  it("version is 1", () => {
    const state = createDefaultState();
    assert.equal(state.version, 1);
  });
});

// ---------------------------------------------------------------------------
// getEnforcementBehavior
// ---------------------------------------------------------------------------
describe("getEnforcementBehavior", () => {
  it("Level 0 → logOnly=true, no injection, no block", () => {
    const b = getEnforcementBehavior(0);
    assert.equal(b.logOnly, true);
    assert.equal(b.injectGuidance, false);
    assert.equal(b.injectDispatchPlan, false);
    assert.equal(b.blockNonDispatchTools, false);
    assert.equal(b.advisoryMessage, null);
  });

  it("Level 1 → injectGuidance=true, advisory message, no block", () => {
    const b = getEnforcementBehavior(1);
    assert.equal(b.injectGuidance, true);
    assert.equal(b.injectDispatchPlan, false);
    assert.equal(b.blockNonDispatchTools, false);
    assert.equal(b.logOnly, false);
    assert.ok(typeof b.advisoryMessage === "string" && b.advisoryMessage.length > 0);
  });

  it("Level 2 → injectGuidance=true, injectDispatchPlan=true, no block", () => {
    const b = getEnforcementBehavior(2);
    assert.equal(b.injectGuidance, true);
    assert.equal(b.injectDispatchPlan, true);
    assert.equal(b.blockNonDispatchTools, false);
    assert.equal(b.logOnly, false);
    assert.equal(b.advisoryMessage, null);
  });

  it("Level 3 → all injection flags true + blockNonDispatchTools=true", () => {
    const b = getEnforcementBehavior(3);
    assert.equal(b.injectGuidance, true);
    assert.equal(b.injectDispatchPlan, true);
    assert.equal(b.blockNonDispatchTools, true);
    assert.equal(b.logOnly, false);
    assert.equal(b.advisoryMessage, null);
  });
});

// ---------------------------------------------------------------------------
// shouldUpgrade
// ---------------------------------------------------------------------------
describe("shouldUpgrade", () => {
  it("0→1 when observations reach 20", () => {
    const state = createDefaultState(); // level 0
    const stats = makeStats({ totalObservations: 20 });
    const result = shouldUpgrade(state, stats);
    assert.equal(result.upgrade, true);
    assert.equal(result.newLevel, 1);
  });

  it("0→1 not triggered below 20 observations", () => {
    const state = createDefaultState(); // level 0
    const stats = makeStats({ totalObservations: 19 });
    const result = shouldUpgrade(state, stats);
    assert.equal(result.upgrade, false);
  });

  it("1→2 when accuracy reaches 75%", () => {
    const state: EnforcementState = { ...createDefaultState(), currentLevel: 1 };
    const stats = makeStats({ totalObservations: 50, accuracy: 0.75 });
    const result = shouldUpgrade(state, stats);
    assert.equal(result.upgrade, true);
    assert.equal(result.newLevel, 2);
  });

  it("1→2 not triggered below 75% accuracy", () => {
    const state: EnforcementState = { ...createDefaultState(), currentLevel: 1 };
    const stats = makeStats({ totalObservations: 50, accuracy: 0.74 });
    const result = shouldUpgrade(state, stats);
    assert.equal(result.upgrade, false);
  });

  it("2→3 when accuracy ≥ 85% and 5 consecutive accurate days", () => {
    const state: EnforcementState = {
      ...createDefaultState(),
      currentLevel: 2,
      consecutiveAccurateDays: 5,
    };
    const stats = makeStats({ totalObservations: 100, accuracy: 0.85 });
    const result = shouldUpgrade(state, stats);
    assert.equal(result.upgrade, true);
    assert.equal(result.newLevel, 3);
  });

  it("2→3 not triggered when accuracy is high but days < 5", () => {
    const state: EnforcementState = {
      ...createDefaultState(),
      currentLevel: 2,
      consecutiveAccurateDays: 4,
    };
    const stats = makeStats({ totalObservations: 100, accuracy: 0.90 });
    const result = shouldUpgrade(state, stats);
    assert.equal(result.upgrade, false);
  });

  it("2→3 not triggered when days >= 3 but accuracy < 85%", () => {
    const state: EnforcementState = {
      ...createDefaultState(),
      currentLevel: 2,
      consecutiveAccurateDays: 5,
    };
    const stats = makeStats({ totalObservations: 100, accuracy: 0.84 });
    const result = shouldUpgrade(state, stats);
    assert.equal(result.upgrade, false);
  });

  it("returns no upgrade for level 3 (already at max)", () => {
    const state: EnforcementState = {
      ...createDefaultState(),
      currentLevel: 3,
      consecutiveAccurateDays: 10,
    };
    const stats = makeStats({ totalObservations: 200, accuracy: 0.99 });
    const result = shouldUpgrade(state, stats);
    assert.equal(result.upgrade, false);
  });
});

// ---------------------------------------------------------------------------
// shouldDowngrade
// ---------------------------------------------------------------------------
describe("shouldDowngrade", () => {
  it("Level 3 downgrades to 2 when 5+ corrections in 24h", () => {
    const state: EnforcementState = { ...createDefaultState(), currentLevel: 3 };
    const result = shouldDowngrade(state, 5, 0);
    assert.equal(result.downgrade, true);
    assert.equal(result.newLevel, 2);
  });

  it("Level 3 does not downgrade with only 4 corrections in 24h", () => {
    const state: EnforcementState = { ...createDefaultState(), currentLevel: 3 };
    const result = shouldDowngrade(state, 4, 0);
    assert.equal(result.downgrade, false);
  });

  it("Level 2 downgrades to 1 when 5+ consecutive errors", () => {
    const state: EnforcementState = { ...createDefaultState(), currentLevel: 2 };
    const result = shouldDowngrade(state, 0, 5);
    assert.equal(result.downgrade, true);
    assert.equal(result.newLevel, 1);
  });

  it("Level 2 does not downgrade with only 4 consecutive errors", () => {
    const state: EnforcementState = { ...createDefaultState(), currentLevel: 2 };
    const result = shouldDowngrade(state, 0, 4);
    assert.equal(result.downgrade, false);
  });

  it("Level 1 never downgrades below 1 (returns no downgrade)", () => {
    const state: EnforcementState = { ...createDefaultState(), currentLevel: 1 };
    // Even with many corrections, Level 1 should not downgrade via shouldDowngrade
    const result = shouldDowngrade(state, 100, 100);
    assert.equal(result.downgrade, false);
  });

  it("Level 0 never downgrades (returns no downgrade)", () => {
    const state = createDefaultState(); // level 0
    const result = shouldDowngrade(state, 100, 100);
    assert.equal(result.downgrade, false);
  });
});

// ---------------------------------------------------------------------------
// applyLevelChange
// ---------------------------------------------------------------------------
describe("applyLevelChange", () => {
  it("updates currentLevel and adds to history", () => {
    const state = createDefaultState();
    applyLevelChange(state, 1, "reached 20 observations");
    assert.equal(state.currentLevel, 1);
    assert.equal(state.levelHistory.length, 1);
    assert.equal(state.levelHistory[0].level, 1);
    assert.equal(state.levelHistory[0].reason, "reached 20 observations");
    assert.ok(state.levelHistory[0].timestamp);
  });

  it("sets lastUpgrade on upgrade", () => {
    const state = createDefaultState(); // level 0
    applyLevelChange(state, 1, "upgrade test");
    assert.ok(state.lastUpgrade !== null);
    assert.equal(state.lastDowngrade, null);
  });

  it("sets lastDowngrade on downgrade", () => {
    const state: EnforcementState = { ...createDefaultState(), currentLevel: 3 };
    applyLevelChange(state, 2, "downgrade test");
    assert.equal(state.currentLevel, 2);
    assert.ok(state.lastDowngrade !== null);
  });

  it("accumulates multiple history entries", () => {
    const state = createDefaultState();
    applyLevelChange(state, 1, "first");
    applyLevelChange(state, 2, "second");
    applyLevelChange(state, 1, "third");
    assert.equal(state.levelHistory.length, 3);
    assert.equal(state.currentLevel, 1);
  });
});

// ---------------------------------------------------------------------------
// evaluateAndAdjust
// ---------------------------------------------------------------------------
describe("evaluateAndAdjust", () => {
  it("upgrades when ready — full cycle", () => {
    const state = createDefaultState(); // level 0
    const stats = makeStats({ totalObservations: 25, accuracy: 0 });
    const result = evaluateAndAdjust(state, stats, 0);
    assert.equal(result.changed, true);
    assert.equal(result.oldLevel, 0);
    assert.equal(result.newLevel, 1);
    assert.equal(state.currentLevel, 1);
  });

  it("downgrades when errors exceed buffer — full cycle", () => {
    const state: EnforcementState = { ...createDefaultState(), currentLevel: 3 };
    const stats = makeStats({ totalObservations: 50, accuracy: 0.5 });
    // Day 1: 5 corrections → buffer day 1, no change yet
    const r1 = evaluateAndAdjust(state, stats, 5);
    assert.equal(r1.changed, false);
    assert.equal(state.consecutiveDowngradeDays, 1);
    // Day 2: 5 corrections again → buffer day 2, now downgrade
    const r2 = evaluateAndAdjust(state, stats, 5);
    assert.equal(r2.changed, true);
    assert.equal(r2.oldLevel, 3);
    assert.equal(r2.newLevel, 2);
  });

  it("no change when stable", () => {
    const state: EnforcementState = { ...createDefaultState(), currentLevel: 1 };
    // Accuracy 60% (below 75% threshold) → no upgrade
    const stats = makeStats({ totalObservations: 30, accuracy: 0.60 });
    const result = evaluateAndAdjust(state, stats, 0);
    assert.equal(result.changed, false);
    assert.equal(result.oldLevel, 1);
    assert.equal(result.newLevel, 1);
  });

  it("downgrade buffered: single bad day does not downgrade", () => {
    const state: EnforcementState = {
      ...createDefaultState(),
      currentLevel: 2,
      consecutiveAccurateDays: 5,
    };
    const stats = makeStats({ totalObservations: 100, accuracy: 0.90 });
    // Single day of 5 corrections — buffered, should NOT change
    const result = evaluateAndAdjust(state, stats, 5);
    assert.equal(result.changed, false);
    assert.equal(state.consecutiveDowngradeDays, 1);
  });
});

// ---------------------------------------------------------------------------
// loadEnforcementState / saveEnforcementState — round-trip
// ---------------------------------------------------------------------------
describe("loadEnforcementState / saveEnforcementState", () => {
  it("round-trip: saved state can be loaded back", () => {
    const dir = makeTmpDir();
    const state = createDefaultState();
    applyLevelChange(state, 1, "test save");
    state.observationCount = 42;
    state.correctionCount = 7;

    saveEnforcementState(dir, state);
    const loaded = loadEnforcementState(dir);

    assert.equal(loaded.currentLevel, 1);
    assert.equal(loaded.observationCount, 42);
    assert.equal(loaded.correctionCount, 7);
    assert.equal(loaded.levelHistory.length, 1);
    assert.equal(loaded.levelHistory[0].reason, "test save");
  });

  it("returns default state when file does not exist", () => {
    const loaded = loadEnforcementState("/tmp/nonexistent-enforcement-dir-xyz-999");
    assert.equal(loaded.currentLevel, 0);
    assert.deepEqual(loaded.levelHistory, []);
  });

  it("returns default state when file is malformed JSON", () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, "enforcement-state.json"), "not valid json", "utf-8");
    const loaded = loadEnforcementState(dir);
    assert.equal(loaded.currentLevel, 0);
  });

  it("creates directory if it does not exist when saving", () => {
    const dir = join(TMP_DIR, `new-dir-${Math.random().toString(36).slice(2)}`);
    assert.equal(existsSync(dir), false);
    const state = createDefaultState();
    saveEnforcementState(dir, state);
    assert.equal(existsSync(dir), true);
  });
});

// ---------------------------------------------------------------------------
// formatEnforcementStatus
// ---------------------------------------------------------------------------
describe("formatEnforcementStatus", () => {
  it("returns readable output with level info", () => {
    const state = createDefaultState();
    const text = formatEnforcementStatus(state);
    assert.ok(text.includes("Level 0"));
    assert.ok(text.includes("OMA Enforcement Status"));
  });

  it("includes stats when provided", () => {
    const state = createDefaultState();
    const stats = makeStats({ totalObservations: 15, accuracy: 0.6, correctionRate: 0.1 });
    const text = formatEnforcementStatus(state, stats);
    assert.ok(text.includes("15"));
    assert.ok(text.includes("60.0%"));
  });

  it("shows level history when present", () => {
    const state = createDefaultState();
    applyLevelChange(state, 1, "test history entry");
    const text = formatEnforcementStatus(state);
    assert.ok(text.includes("test history entry"));
  });

  it("shows upgrade progress hint for level 0", () => {
    const state = createDefaultState(); // level 0
    const stats = makeStats({ totalObservations: 5 });
    const text = formatEnforcementStatus(state, stats);
    assert.ok(text.includes("To Level 1"));
  });

  it("shows downgrade never happened when no history", () => {
    const state = createDefaultState();
    const text = formatEnforcementStatus(state);
    assert.ok(text.includes("never"));
  });
});
