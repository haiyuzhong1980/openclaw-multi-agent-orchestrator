import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  calculateWtfLikelihood,
  shouldStopAndAsk,
  shouldForceStop,
  buildStopPrompt,
  updateWtfState,
} from "../src/wtf-likelihood.ts";
import type { WtfState } from "../src/wtf-likelihood.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeState(overrides: Partial<WtfState> = {}): WtfState {
  return {
    revertCount: 0,
    largeFixCount: 0,
    totalFixCount: 0,
    touchedUnrelatedFiles: false,
    allRemainingLow: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// calculateWtfLikelihood — scoring rules
// ---------------------------------------------------------------------------
describe("calculateWtfLikelihood — starting point", () => {
  it("returns 0 for a clean state", () => {
    assert.equal(calculateWtfLikelihood(makeState()), 0);
  });
});

describe("calculateWtfLikelihood — revert scoring", () => {
  it("adds 15% per revert", () => {
    assert.equal(calculateWtfLikelihood(makeState({ revertCount: 1 })), 15);
  });

  it("adds 30% for two reverts", () => {
    assert.equal(calculateWtfLikelihood(makeState({ revertCount: 2 })), 30);
  });

  it("adds 0% for zero reverts", () => {
    assert.equal(calculateWtfLikelihood(makeState({ revertCount: 0 })), 0);
  });
});

describe("calculateWtfLikelihood — large fix scoring", () => {
  it("adds 5% per large fix", () => {
    assert.equal(calculateWtfLikelihood(makeState({ largeFixCount: 1 })), 5);
  });

  it("adds 15% for three large fixes", () => {
    assert.equal(calculateWtfLikelihood(makeState({ largeFixCount: 3 })), 15);
  });
});

describe("calculateWtfLikelihood — extra fix scoring (>15 fixes)", () => {
  it("no extra score at exactly 15 total fixes", () => {
    assert.equal(calculateWtfLikelihood(makeState({ totalFixCount: 15 })), 0);
  });

  it("adds 1% for each fix beyond 15", () => {
    assert.equal(calculateWtfLikelihood(makeState({ totalFixCount: 16 })), 1);
    assert.equal(calculateWtfLikelihood(makeState({ totalFixCount: 20 })), 5);
    assert.equal(calculateWtfLikelihood(makeState({ totalFixCount: 25 })), 10);
  });

  it("no extra score below 15 total fixes", () => {
    assert.equal(calculateWtfLikelihood(makeState({ totalFixCount: 10 })), 0);
  });
});

describe("calculateWtfLikelihood — allRemainingLow", () => {
  it("adds 10% when all remaining are Low", () => {
    assert.equal(calculateWtfLikelihood(makeState({ allRemainingLow: true })), 10);
  });

  it("adds 0% when not all remaining are Low", () => {
    assert.equal(calculateWtfLikelihood(makeState({ allRemainingLow: false })), 0);
  });
});

describe("calculateWtfLikelihood — touchedUnrelatedFiles", () => {
  it("adds 20% for touching unrelated files", () => {
    assert.equal(calculateWtfLikelihood(makeState({ touchedUnrelatedFiles: true })), 20);
  });

  it("adds 0% when no unrelated files touched", () => {
    assert.equal(calculateWtfLikelihood(makeState({ touchedUnrelatedFiles: false })), 0);
  });
});

describe("calculateWtfLikelihood — combined scoring", () => {
  it("combines all signals correctly", () => {
    const state = makeState({
      revertCount: 1,          // +15
      largeFixCount: 2,        // +10
      totalFixCount: 17,       // +2 (2 beyond threshold of 15)
      touchedUnrelatedFiles: true, // +20
      allRemainingLow: true,   // +10
    });
    // 15 + 10 + 2 + 20 + 10 = 57
    assert.equal(calculateWtfLikelihood(state), 57);
  });
});

// ---------------------------------------------------------------------------
// shouldStopAndAsk — 20% threshold
// ---------------------------------------------------------------------------
describe("shouldStopAndAsk", () => {
  it("returns false at exactly 20%", () => {
    assert.equal(shouldStopAndAsk(20), false);
  });

  it("returns true above 20%", () => {
    assert.equal(shouldStopAndAsk(21), true);
  });

  it("returns false at 0%", () => {
    assert.equal(shouldStopAndAsk(0), false);
  });

  it("returns true at 100%", () => {
    assert.equal(shouldStopAndAsk(100), true);
  });

  it("triggers when revert alone pushes above threshold", () => {
    const state = makeState({ revertCount: 2 }); // 30%
    const likelihood = calculateWtfLikelihood(state);
    assert.equal(shouldStopAndAsk(likelihood), true);
  });

  it("does not trigger on single large fix alone (5%)", () => {
    const state = makeState({ largeFixCount: 1 }); // 5%
    const likelihood = calculateWtfLikelihood(state);
    assert.equal(shouldStopAndAsk(likelihood), false);
  });
});

// ---------------------------------------------------------------------------
// shouldForceStop — 50 fix hard limit
// ---------------------------------------------------------------------------
describe("shouldForceStop", () => {
  it("returns false below 50 fixes", () => {
    assert.equal(shouldForceStop(makeState({ totalFixCount: 49 })), false);
  });

  it("returns true at exactly 50 fixes", () => {
    assert.equal(shouldForceStop(makeState({ totalFixCount: 50 })), true);
  });

  it("returns true above 50 fixes", () => {
    assert.equal(shouldForceStop(makeState({ totalFixCount: 100 })), true);
  });

  it("respects custom maxFixes parameter", () => {
    assert.equal(shouldForceStop(makeState({ totalFixCount: 10 }), 10), true);
    assert.equal(shouldForceStop(makeState({ totalFixCount: 9 }), 10), false);
  });

  it("defaults to 50 when maxFixes is undefined", () => {
    assert.equal(shouldForceStop(makeState({ totalFixCount: 50 }), undefined), true);
  });
});

// ---------------------------------------------------------------------------
// buildStopPrompt
// ---------------------------------------------------------------------------
describe("buildStopPrompt", () => {
  it("includes WTF-likelihood percentage", () => {
    const text = buildStopPrompt(makeState(), 25);
    assert.ok(text.includes("WTF-likelihood: 25%"));
  });

  it("shows current fix counts", () => {
    const state = makeState({ totalFixCount: 10, revertCount: 2, largeFixCount: 1 });
    const text = buildStopPrompt(state, 40);
    assert.ok(text.includes("10"));
    assert.ok(text.includes("2"));
    assert.ok(text.includes("1"));
  });

  it("mentions hard-limit when at 50 fixes", () => {
    const state = makeState({ totalFixCount: 50 });
    const text = buildStopPrompt(state, 0);
    assert.ok(text.includes("硬限制") || text.includes("强制停止"));
  });

  it("asks for user confirmation when below hard limit", () => {
    const state = makeState({ totalFixCount: 5 });
    const text = buildStopPrompt(state, 25);
    assert.ok(text.includes("继续") || text.includes("人工"));
  });
});

// ---------------------------------------------------------------------------
// updateWtfState — immutability and event handling
// ---------------------------------------------------------------------------
describe("updateWtfState — immutability", () => {
  it("returns a new object on every call", () => {
    const original = makeState();
    const updated = updateWtfState(original, { type: "fix" });
    assert.notEqual(original, updated, "should return a different object reference");
  });

  it("does not mutate the original state", () => {
    const original = makeState({ totalFixCount: 5 });
    const originalCount = original.totalFixCount;
    updateWtfState(original, { type: "fix" });
    assert.equal(original.totalFixCount, originalCount, "original should be unchanged");
  });

  it("chaining returns independent objects", () => {
    const s0 = makeState();
    const s1 = updateWtfState(s0, { type: "fix" });
    const s2 = updateWtfState(s1, { type: "revert" });
    assert.notEqual(s0, s1);
    assert.notEqual(s1, s2);
    assert.notEqual(s0, s2);
  });
});

describe("updateWtfState — revert event", () => {
  it("increments revertCount by 1", () => {
    const state = updateWtfState(makeState({ revertCount: 2 }), { type: "revert" });
    assert.equal(state.revertCount, 3);
  });

  it("does not change other fields", () => {
    const original = makeState({ totalFixCount: 7, largeFixCount: 1 });
    const updated = updateWtfState(original, { type: "revert" });
    assert.equal(updated.totalFixCount, 7);
    assert.equal(updated.largeFixCount, 1);
  });
});

describe("updateWtfState — fix event", () => {
  it("increments totalFixCount by 1", () => {
    const state = updateWtfState(makeState({ totalFixCount: 3 }), { type: "fix" });
    assert.equal(state.totalFixCount, 4);
  });

  it("does not change largeFixCount", () => {
    const state = updateWtfState(makeState({ largeFixCount: 2 }), { type: "fix" });
    assert.equal(state.largeFixCount, 2);
  });
});

describe("updateWtfState — large_fix event", () => {
  it("increments both totalFixCount and largeFixCount", () => {
    const original = makeState({ totalFixCount: 5, largeFixCount: 1 });
    const updated = updateWtfState(original, { type: "large_fix" });
    assert.equal(updated.totalFixCount, 6);
    assert.equal(updated.largeFixCount, 2);
  });
});

describe("updateWtfState — unrelated_touch event", () => {
  it("sets touchedUnrelatedFiles to true", () => {
    const state = updateWtfState(makeState(), { type: "unrelated_touch" });
    assert.equal(state.touchedUnrelatedFiles, true);
  });

  it("does not change other fields", () => {
    const original = makeState({ revertCount: 3, totalFixCount: 10 });
    const updated = updateWtfState(original, { type: "unrelated_touch" });
    assert.equal(updated.revertCount, 3);
    assert.equal(updated.totalFixCount, 10);
  });
});

// ---------------------------------------------------------------------------
// Boundary values
// ---------------------------------------------------------------------------
describe("boundary — 0% likelihood", () => {
  it("clean state produces exactly 0%", () => {
    assert.equal(calculateWtfLikelihood(makeState()), 0);
    assert.equal(shouldStopAndAsk(0), false);
    assert.equal(shouldForceStop(makeState()), false);
  });
});

describe("boundary — exactly 20% likelihood", () => {
  it("one revert + allRemainingLow = 25%, triggers stop", () => {
    // 15 + 10 = 25 > 20
    const state = makeState({ revertCount: 1, allRemainingLow: true });
    const likelihood = calculateWtfLikelihood(state);
    assert.equal(likelihood, 25);
    assert.equal(shouldStopAndAsk(likelihood), true);
  });

  it("single unrelated touch = 20%, does not trigger (threshold is exclusive)", () => {
    const state = makeState({ touchedUnrelatedFiles: true });
    const likelihood = calculateWtfLikelihood(state);
    assert.equal(likelihood, 20);
    assert.equal(shouldStopAndAsk(likelihood), false);
  });
});

describe("boundary — exactly 50 fixes", () => {
  it("49 fixes: no force stop", () => {
    assert.equal(shouldForceStop(makeState({ totalFixCount: 49 })), false);
  });

  it("50 fixes: force stop triggered", () => {
    assert.equal(shouldForceStop(makeState({ totalFixCount: 50 })), true);
  });

  it("50 fixes also generates 35 extra points (50-15=35)", () => {
    const likelihood = calculateWtfLikelihood(makeState({ totalFixCount: 50 }));
    assert.equal(likelihood, 35);
    assert.equal(shouldStopAndAsk(likelihood), true);
  });
});
