import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  createEmptyRegistry,
  extractIntentPhrases,
  recordClassification,
  recordCorrection,
  checkLearnedPatterns,
  detectCorrection,
  decayPatterns,
} from "../src/intent-registry.ts";
import type { IntentRegistry } from "../src/intent-registry.ts";

describe("extractIntentPhrases", () => {
  it("extracts meaningful phrases from Chinese text", () => {
    const phrases = extractIntentPhrases("部署系统到生产环境");
    assert.ok(phrases.length > 0);
    // Should find multi-char Chinese phrases
    const hasMultiChar = phrases.some((p) => p.length >= 2);
    assert.ok(hasMultiChar, `Expected multi-char phrases, got: ${phrases.join(", ")}`);
  });

  it("extracts words from English text", () => {
    const phrases = extractIntentPhrases("deploy the system to production environment");
    assert.ok(phrases.includes("deploy"), `Expected "deploy", got: ${phrases.join(", ")}`);
    assert.ok(phrases.includes("system"), `Expected "system", got: ${phrases.join(", ")}`);
    assert.ok(phrases.includes("production"), `Expected "production", got: ${phrases.join(", ")}`);
  });

  it("excludes English stop words", () => {
    const phrases = extractIntentPhrases("deploy the system");
    assert.ok(!phrases.includes("the"), `Should not include "the", got: ${phrases.join(", ")}`);
  });

  it("returns empty array for empty text", () => {
    const phrases = extractIntentPhrases("");
    assert.equal(phrases.length, 0);
  });

  it("returns max 10 phrases", () => {
    const longText = "deploy install configure audit review test build analyze optimize refactor migrate upgrade verify research investigate";
    const phrases = extractIntentPhrases(longText);
    assert.ok(phrases.length <= 10, `Expected <= 10, got ${phrases.length}`);
  });

  it("deduplicates phrases", () => {
    const phrases = extractIntentPhrases("deploy deploy deploy");
    const unique = [...new Set(phrases)];
    assert.equal(phrases.length, unique.length);
  });

  it("extracts bigrams from English text", () => {
    const phrases = extractIntentPhrases("deploy system production");
    // Should have at least some bigrams
    const hasBigram = phrases.some((p) => p.includes(" "));
    assert.ok(hasBigram, `Expected at least one bigram, got: ${phrases.join(", ")}`);
  });

  it("extracts Chinese character ngrams", () => {
    const phrases = extractIntentPhrases("审计系统安全");
    assert.ok(phrases.length > 0);
    // Should have at least 2-char sequences
    const has2Char = phrases.some((p) => /[\u4e00-\u9fff]{2}/.test(p));
    assert.ok(has2Char, `Expected Chinese 2-char phrases, got: ${phrases.join(", ")}`);
  });
});

describe("recordClassification", () => {
  let registry: IntentRegistry;

  beforeEach(() => {
    registry = createEmptyRegistry();
  });

  it("increments totalClassifications", () => {
    recordClassification(registry, ["deploy"], "delegation");
    assert.equal(registry.totalClassifications, 1);
  });

  it("creates new pattern entry for new phrase", () => {
    recordClassification(registry, ["deploy"], "delegation");
    assert.ok(registry.patterns["deploy"]);
    assert.equal(registry.patterns["deploy"].occurrences, 1);
    assert.equal(registry.patterns["deploy"].delegationCount, 1);
  });

  it("updates existing pattern entry", () => {
    recordClassification(registry, ["deploy"], "delegation");
    recordClassification(registry, ["deploy"], "delegation");
    assert.equal(registry.patterns["deploy"].occurrences, 2);
    assert.equal(registry.patterns["deploy"].delegationCount, 2);
  });

  it("increments tracked count for tracked tier", () => {
    recordClassification(registry, ["deploy"], "tracked");
    assert.equal(registry.patterns["deploy"].trackedCount, 1);
    assert.equal(registry.patterns["deploy"].delegationCount, 0);
  });

  it("increments light count for light tier", () => {
    recordClassification(registry, ["hello"], "light");
    assert.equal(registry.patterns["hello"].lightCount, 1);
    assert.equal(registry.patterns["hello"].delegationCount, 0);
  });

  it("recalculates confidence after recording", () => {
    recordClassification(registry, ["deploy"], "delegation");
    assert.equal(registry.patterns["deploy"].confidence.delegation, 1);
    assert.equal(registry.patterns["deploy"].confidence.tracked, 0);
  });

  it("confidence updates correctly with mixed classifications", () => {
    recordClassification(registry, ["test"], "delegation");
    recordClassification(registry, ["test"], "tracked");
    const pattern = registry.patterns["test"];
    assert.equal(pattern.occurrences, 2);
    assert.equal(pattern.confidence.delegation, 0.5);
    assert.equal(pattern.confidence.tracked, 0.5);
  });

  it("handles empty phrases array", () => {
    recordClassification(registry, [], "delegation");
    assert.equal(registry.totalClassifications, 1);
    assert.equal(Object.keys(registry.patterns).length, 0);
  });

  it("skips empty string phrases", () => {
    recordClassification(registry, ["", "deploy"], "delegation");
    assert.ok(!registry.patterns[""]);
    assert.ok(registry.patterns["deploy"]);
  });
});

describe("recordCorrection", () => {
  let registry: IntentRegistry;

  beforeEach(() => {
    registry = createEmptyRegistry();
    // Seed a pattern: "deploy" classified as light 3 times
    recordClassification(registry, ["deploy"], "light");
    recordClassification(registry, ["deploy"], "light");
    recordClassification(registry, ["deploy"], "light");
  });

  it("increments totalCorrections", () => {
    recordCorrection(registry, ["deploy"], "light", "delegation");
    assert.equal(registry.totalCorrections, 1);
  });

  it("shifts confidence toward actual tier after correction", () => {
    const before = registry.patterns["deploy"].confidence.delegation;
    recordCorrection(registry, ["deploy"], "light", "delegation");
    const after = registry.patterns["deploy"].confidence.delegation;
    assert.ok(after > before, `Expected delegation confidence to increase, was ${before} now ${after}`);
  });

  it("decrements predicted tier count", () => {
    const beforeLight = registry.patterns["deploy"].lightCount;
    recordCorrection(registry, ["deploy"], "light", "delegation");
    assert.equal(registry.patterns["deploy"].lightCount, beforeLight - 1);
  });

  it("increments actual tier count", () => {
    const beforeDelegation = registry.patterns["deploy"].delegationCount;
    recordCorrection(registry, ["deploy"], "light", "delegation");
    assert.equal(registry.patterns["deploy"].delegationCount, beforeDelegation + 1);
  });

  it("clamps counts to 0 (no negative counts)", () => {
    // Pattern has 0 delegation count; correcting from delegation should clamp to 0
    recordCorrection(registry, ["deploy"], "delegation", "light");
    assert.ok(registry.patterns["deploy"].delegationCount >= 0);
  });

  it("skips phrases that don't exist in registry", () => {
    // Should not throw for unknown phrase
    assert.doesNotThrow(() => {
      recordCorrection(registry, ["nonexistent"], "light", "delegation");
    });
    assert.equal(registry.totalCorrections, 1);
  });
});

describe("checkLearnedPatterns", () => {
  let registry: IntentRegistry;

  beforeEach(() => {
    registry = createEmptyRegistry();
  });

  it("returns null for empty registry", () => {
    const result = checkLearnedPatterns("deploy system", registry);
    assert.equal(result, null);
  });

  it("returns delegation when confidence > 0.7 and occurrences >= 3", () => {
    // Train "deploy" as delegation 3 times
    recordClassification(registry, ["deploy"], "delegation");
    recordClassification(registry, ["deploy"], "delegation");
    recordClassification(registry, ["deploy"], "delegation");
    const result = checkLearnedPatterns("deploy system", registry);
    assert.equal(result, "delegation");
  });

  it("returns tracked when confidence > 0.7 and occurrences >= 3", () => {
    recordClassification(registry, ["audit"], "tracked");
    recordClassification(registry, ["audit"], "tracked");
    recordClassification(registry, ["audit"], "tracked");
    const result = checkLearnedPatterns("audit security", registry);
    assert.equal(result, "tracked");
  });

  it("returns null when occurrences < 3 even with high confidence", () => {
    recordClassification(registry, ["deploy"], "delegation");
    recordClassification(registry, ["deploy"], "delegation");
    // Only 2 occurrences
    const result = checkLearnedPatterns("deploy system", registry);
    assert.equal(result, null);
  });

  it("returns null when confidence <= 0.7", () => {
    // Train with mixed signals so confidence is low
    recordClassification(registry, ["test"], "delegation");
    recordClassification(registry, ["test"], "tracked");
    recordClassification(registry, ["test"], "light");
    const result = checkLearnedPatterns("test the system", registry);
    assert.equal(result, null);
  });

  it("returns light when light confidence > 0.7 and occurrences >= 3", () => {
    recordClassification(registry, ["hello"], "light");
    recordClassification(registry, ["hello"], "light");
    recordClassification(registry, ["hello"], "light");
    const result = checkLearnedPatterns("hello world how are you", registry);
    assert.equal(result, "light");
  });
});

describe("detectCorrection", () => {
  it("detects escalation signal: 应该派 agent", () => {
    const result = detectCorrection("你应该派agent去做这个", "light");
    assert.equal(result.isCorrection, true);
    assert.equal(result.actualTier, "delegation");
  });

  it("detects escalation signal: 不要自己做", () => {
    const result = detectCorrection("不要自己做，让agent来", "tracked");
    assert.equal(result.isCorrection, true);
    assert.equal(result.actualTier, "delegation");
  });

  it("detects escalation signal: 派出去", () => {
    const result = detectCorrection("这个任务应该派出去", "light");
    assert.equal(result.isCorrection, true);
    assert.equal(result.actualTier, "delegation");
  });

  it("detects de-escalation signal: 不用这么复杂", () => {
    const result = detectCorrection("不用这么复杂，直接告诉我", "delegation");
    assert.equal(result.isCorrection, true);
    assert.equal(result.actualTier, "light");
  });

  it("detects de-escalation signal: 直接做就好", () => {
    const result = detectCorrection("直接做就好，不用派agent", "tracked");
    assert.equal(result.isCorrection, true);
    assert.equal(result.actualTier, "light");
  });

  it("detects de-escalation signal: 太重了", () => {
    const result = detectCorrection("太重了，简单来", "delegation");
    assert.equal(result.isCorrection, true);
    assert.equal(result.actualTier, "light");
  });

  it("returns no correction for normal message", () => {
    const result = detectCorrection("帮我分析一下这个项目", "light");
    assert.equal(result.isCorrection, false);
    assert.equal(result.actualTier, undefined);
  });

  it("returns no correction when already at correct tier (escalation + delegation)", () => {
    // User says "应该派agent" but previous tier was already delegation
    const result = detectCorrection("你应该派agent去做这个", "delegation");
    assert.equal(result.isCorrection, false);
  });

  it("returns no correction when already at correct tier (de-escalation + light)", () => {
    // User says "直接做就好" but previous tier was already light
    const result = detectCorrection("直接做就好", "light");
    assert.equal(result.isCorrection, false);
  });
});

describe("decayPatterns", () => {
  it("returns count of decayed patterns", () => {
    const registry = createEmptyRegistry();
    // Create a pattern with old lastSeen date
    registry.patterns["oldphrase"] = {
      phrase: "oldphrase",
      occurrences: 10,
      delegationCount: 10,
      trackedCount: 0,
      lightCount: 0,
      lastSeen: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(), // 10 days ago
      confidence: { delegation: 1, tracked: 0, light: 0 },
    };
    const decayed = decayPatterns(registry);
    assert.equal(decayed, 1);
  });

  it("reduces confidence of old patterns", () => {
    const registry = createEmptyRegistry();
    registry.patterns["oldphrase"] = {
      phrase: "oldphrase",
      occurrences: 10,
      delegationCount: 10,
      trackedCount: 0,
      lightCount: 0,
      lastSeen: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
      confidence: { delegation: 1, tracked: 0, light: 0 },
    };
    decayPatterns(registry, 0.5);
    const p = registry.patterns["oldphrase"];
    assert.ok(p.delegationCount < 10, `Expected reduced count, got ${p.delegationCount}`);
  });

  it("does not decay recent patterns", () => {
    const registry = createEmptyRegistry();
    registry.patterns["newphrase"] = {
      phrase: "newphrase",
      occurrences: 10,
      delegationCount: 10,
      trackedCount: 0,
      lightCount: 0,
      lastSeen: new Date().toISOString(), // now
      confidence: { delegation: 1, tracked: 0, light: 0 },
    };
    const decayed = decayPatterns(registry);
    assert.equal(decayed, 0);
    assert.equal(registry.patterns["newphrase"].delegationCount, 10);
  });

  it("returns 0 for empty registry", () => {
    const registry = createEmptyRegistry();
    const decayed = decayPatterns(registry);
    assert.equal(decayed, 0);
  });
});
