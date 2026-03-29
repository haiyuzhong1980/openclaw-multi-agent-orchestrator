import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  createEmptyRegistry,
  extractIntentPhrases,
  recordClassification,
  recordCorrection,
  recordConfirmation,
  checkLearnedPatterns,
  checkLearnedPatternsWithDetails,
  detectCorrection,
  decayPatterns,
  DEFAULT_CONFLICT_CONFIG,
  recordPredictionResult,
  getDynamicThreshold,
  adjustDynamicThreshold,
  getDynamicConflictConfig,
  DEFAULT_DYNAMIC_THRESHOLD_CONFIG,
} from "../src/intent-registry.ts";
import type { IntentRegistry, ConflictResolutionConfig } from "../src/intent-registry.ts";
import { CHINESE_STOP_CHARS } from "../src/constants.ts";

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

describe("recordConfirmation", () => {
  let registry: IntentRegistry;

  beforeEach(() => {
    registry = createEmptyRegistry();
    // Seed a pattern: "deploy" classified as delegation 3 times
    recordClassification(registry, ["deploy"], "delegation");
    recordClassification(registry, ["deploy"], "delegation");
    recordClassification(registry, ["deploy"], "delegation");
  });

  it("increments totalConfirmations", () => {
    recordConfirmation(registry, ["deploy"], "delegation");
    assert.equal(registry.totalConfirmations, 1);
  });

  it("increases confidence of confirmed tier", () => {
    const before = registry.patterns["deploy"].confidence.delegation;
    recordConfirmation(registry, ["deploy"], "delegation");
    const after = registry.patterns["deploy"].confidence.delegation;
    assert.ok(after >= before, `Expected confidence to increase or stay same, was ${before} now ${after}`);
  });

  it("increases tier count for confirmed tier", () => {
    const before = registry.patterns["deploy"].delegationCount;
    recordConfirmation(registry, ["deploy"], "delegation");
    assert.equal(registry.patterns["deploy"].delegationCount, before + 1);
  });

  it("increases occurrences count", () => {
    const before = registry.patterns["deploy"].occurrences;
    recordConfirmation(registry, ["deploy"], "delegation");
    assert.equal(registry.patterns["deploy"].occurrences, before + 1);
  });

  it("updates lastSeen timestamp", () => {
    const before = registry.patterns["deploy"].lastSeen;
    // Wait a tiny bit to ensure timestamp difference
    registry.patterns["deploy"].lastSeen = new Date(Date.now() - 1000).toISOString();
    recordConfirmation(registry, ["deploy"], "delegation");
    const after = new Date(registry.patterns["deploy"].lastSeen).getTime();
    const beforeTime = new Date(before).getTime();
    assert.ok(after >= beforeTime, "Expected lastSeen to be updated");
  });

  it("supports custom boost value", () => {
    const before = registry.patterns["deploy"].delegationCount;
    recordConfirmation(registry, ["deploy"], "delegation", { confirmationBoost: 3 });
    assert.equal(registry.patterns["deploy"].delegationCount, before + 3);
  });

  it("can be disabled via config", () => {
    const before = registry.patterns["deploy"].delegationCount;
    recordConfirmation(registry, ["deploy"], "delegation", { enableConfirmationLearning: false });
    assert.equal(registry.patterns["deploy"].delegationCount, before);
    // Should NOT increment totalConfirmations when disabled (early return)
    assert.equal(registry.totalConfirmations, 0);
  });

  it("skips phrases that don't exist in registry", () => {
    // Should not throw for unknown phrase
    assert.doesNotThrow(() => {
      recordConfirmation(registry, ["nonexistent"], "delegation");
    });
    assert.equal(registry.totalConfirmations, 1);
  });

  it("works for tracked tier", () => {
    recordClassification(registry, ["audit"], "tracked");
    const before = registry.patterns["audit"].trackedCount;
    recordConfirmation(registry, ["audit"], "tracked");
    assert.equal(registry.patterns["audit"].trackedCount, before + 1);
  });

  it("works for light tier", () => {
    recordClassification(registry, ["hello"], "light");
    const before = registry.patterns["hello"].lightCount;
    recordConfirmation(registry, ["hello"], "light");
    assert.equal(registry.patterns["hello"].lightCount, before + 1);
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

describe("Conflict Resolution", () => {
  let registry: IntentRegistry;

  beforeEach(() => {
    registry = createEmptyRegistry();
  });

  describe("checkLearnedPatternsWithDetails", () => {
    it("returns detailed result with matched patterns", () => {
      // Train "deploy" as delegation 3 times
      recordClassification(registry, ["deploy"], "delegation");
      recordClassification(registry, ["deploy"], "delegation");
      recordClassification(registry, ["deploy"], "delegation");

      const result = checkLearnedPatternsWithDetails("deploy system", registry);

      assert.equal(result.tier, "delegation");
      assert.ok(result.matchedPatterns.length > 0, "Should have matched patterns");
      assert.equal(result.resolution.hasConflict, false);
      assert.ok(result.resolution.reason.includes("Single match"), `Got: ${result.resolution.reason}`);
    });

    it("collects all matching patterns", () => {
      // Train multiple patterns
      for (let i = 0; i < 3; i++) {
        recordClassification(registry, ["deploy"], "delegation");
        recordClassification(registry, ["audit"], "tracked");
      }

      const result = checkLearnedPatternsWithDetails("deploy and audit the system", registry);

      assert.ok(result.matchedPatterns.length >= 2, `Expected at least 2 matches, got ${result.matchedPatterns.length}`);
      // Both patterns agree on different tiers, so there's a conflict
      assert.equal(result.resolution.hasConflict, true);
    });

    it("resolves conflict using weighted strategy by default", () => {
      // Train patterns with different occurrences
      for (let i = 0; i < 5; i++) {
        recordClassification(registry, ["deploy"], "delegation");
      }
      for (let i = 0; i < 3; i++) {
        recordClassification(registry, ["audit"], "tracked");
      }

      const result = checkLearnedPatternsWithDetails("deploy and audit the system", registry);

      assert.equal(result.resolution.strategy, "weighted");
      // "deploy" should win because it has more occurrences
      assert.equal(result.tier, "delegation");
    });

    it("supports voting strategy", () => {
      // Create patterns with different occurrence counts
      for (let i = 0; i < 3; i++) {
        recordClassification(registry, ["deploy"], "delegation");
      }
      for (let i = 0; i < 5; i++) {
        recordClassification(registry, ["audit"], "tracked");
      }

      const config: Partial<ConflictResolutionConfig> = { strategy: "voting" };
      const result = checkLearnedPatternsWithDetails("deploy and audit the system", registry, config);

      assert.equal(result.resolution.strategy, "voting");
      // "audit" should win because it has more occurrences (votes)
      assert.equal(result.tier, "tracked");
    });

    it("supports highest_confidence strategy", () => {
      // Create patterns with different confidence levels
      // "deploy" with higher confidence (4/4 = 1.0)
      for (let i = 0; i < 4; i++) {
        recordClassification(registry, ["deploy"], "delegation");
      }
      // "audit" with lower confidence (3/5 = 0.6)
      recordClassification(registry, ["audit"], "tracked");
      recordClassification(registry, ["audit"], "tracked");
      recordClassification(registry, ["audit"], "tracked");
      recordClassification(registry, ["audit"], "delegation"); // mixed
      recordClassification(registry, ["audit"], "delegation");

      const config: Partial<ConflictResolutionConfig> = { strategy: "highest_confidence" };
      const result = checkLearnedPatternsWithDetails("deploy and audit the system", registry, config);

      assert.equal(result.resolution.strategy, "highest_confidence");
      // "deploy" has higher confidence (1.0 vs 0.6)
      assert.equal(result.tier, "delegation");
    });

    it("supports first strategy (legacy behavior)", () => {
      // Train multiple patterns
      for (let i = 0; i < 3; i++) {
        recordClassification(registry, ["deploy"], "delegation");
        recordClassification(registry, ["audit"], "tracked");
      }

      const config: Partial<ConflictResolutionConfig> = { strategy: "first" };
      const result = checkLearnedPatternsWithDetails("deploy and audit the system", registry, config);

      assert.equal(result.resolution.strategy, "first");
      assert.ok(result.tier !== null, "Should return a tier");
    });

    it("returns no conflict when all patterns agree", () => {
      // Train multiple patterns all pointing to delegation
      for (let i = 0; i < 3; i++) {
        recordClassification(registry, ["deploy"], "delegation");
        recordClassification(registry, ["release"], "delegation");
        recordClassification(registry, ["ship"], "delegation");
      }

      const result = checkLearnedPatternsWithDetails("deploy and release and ship", registry);

      // All patterns agree on delegation, so no conflict
      assert.equal(result.resolution.hasConflict, false);
      assert.equal(result.tier, "delegation");
      assert.ok(result.resolution.reason.includes("agree"), `Got: ${result.resolution.reason}`);
    });

    it("respects custom minOccurrences config", () => {
      // Train with only 2 occurrences
      recordClassification(registry, ["deploy"], "delegation");
      recordClassification(registry, ["deploy"], "delegation");

      // Default minOccurrences is 3, so should return null
      const result1 = checkLearnedPatternsWithDetails("deploy system", registry);
      assert.equal(result1.tier, null);

      // With minOccurrences = 2, should match
      const config: Partial<ConflictResolutionConfig> = { minOccurrences: 2 };
      const result2 = checkLearnedPatternsWithDetails("deploy system", registry, config);
      assert.equal(result2.tier, "delegation");
    });

    it("respects custom confidenceThreshold config", () => {
      // Train with mixed signals (confidence will be ~0.67)
      recordClassification(registry, ["test"], "delegation");
      recordClassification(registry, ["test"], "delegation");
      recordClassification(registry, ["test"], "tracked"); // mixed

      // Default threshold is 0.7, so should return null
      const result1 = checkLearnedPatternsWithDetails("test system", registry);
      assert.equal(result1.tier, null);

      // With lower threshold, should match
      const config: Partial<ConflictResolutionConfig> = { confidenceThreshold: 0.6 };
      const result2 = checkLearnedPatternsWithDetails("test system", registry, config);
      assert.equal(result2.tier, "delegation");
    });
  });

  describe("DEFAULT_CONFLICT_CONFIG", () => {
    it("has expected default values", () => {
      assert.equal(DEFAULT_CONFLICT_CONFIG.strategy, "weighted");
      assert.equal(DEFAULT_CONFLICT_CONFIG.minOccurrences, 3);
      assert.equal(DEFAULT_CONFLICT_CONFIG.confidenceThreshold, 0.7);
      assert.ok(DEFAULT_CONFLICT_CONFIG.weightDecayFactor > 0 && DEFAULT_CONFLICT_CONFIG.weightDecayFactor <= 1);
    });
  });
});

// ============================================================================
// Dynamic Threshold Tests
// ============================================================================

describe("Dynamic Threshold Adjustment", () => {
  let registry: IntentRegistry;

  beforeEach(() => {
    registry = createEmptyRegistry();
  });

  describe("createEmptyRegistry", () => {
    it("initializes thresholdState with default values", () => {
      assert.ok(registry.thresholdState, "Should have thresholdState");
      assert.equal(registry.thresholdState!.currentThreshold, 0.7, "Should have base threshold 0.7");
      assert.equal(registry.thresholdState!.totalCorrect, 0);
      assert.equal(registry.thresholdState!.totalPredictions, 0);
    });
  });

  describe("recordPredictionResult", () => {
    it("records correct predictions", () => {
      recordPredictionResult(registry, true);
      assert.equal(registry.thresholdState!.totalPredictions, 1);
      assert.equal(registry.thresholdState!.totalCorrect, 1);
    });

    it("records incorrect predictions", () => {
      recordPredictionResult(registry, false);
      assert.equal(registry.thresholdState!.totalPredictions, 1);
      assert.equal(registry.thresholdState!.totalCorrect, 0);
    });

    it("initializes thresholdState if missing", () => {
      const registryNoState: IntentRegistry = {
        patterns: {},
        totalClassifications: 0,
        totalCorrections: 0,
        totalConfirmations: 0,
        lastUpdated: new Date().toISOString(),
        version: 1,
      };
      recordPredictionResult(registryNoState, true);
      assert.ok(registryNoState.thresholdState, "Should create thresholdState");
    });
  });

  describe("getDynamicThreshold", () => {
    it("returns base threshold when disabled", () => {
      const config = { ...DEFAULT_DYNAMIC_THRESHOLD_CONFIG, enabled: false };
      const threshold = getDynamicThreshold(registry, config);
      assert.equal(threshold, 0.7, "Should return base threshold when disabled");
    });

    it("returns current threshold from registry", () => {
      registry.thresholdState!.currentThreshold = 0.6;
      const threshold = getDynamicThreshold(registry);
      assert.equal(threshold, 0.6, "Should return registry's current threshold");
    });
  });

  describe("adjustDynamicThreshold", () => {
    it("returns null when not enough samples", () => {
      registry.thresholdState!.totalPredictions = 10;
      registry.thresholdState!.totalCorrect = 8;
      const result = adjustDynamicThreshold(registry);
      assert.equal(result, null, "Should return null with < 20 samples");
    });

    it("lowers threshold when accuracy is high", () => {
      registry.thresholdState!.totalPredictions = 30;
      registry.thresholdState!.totalCorrect = 28; // 93% accuracy
      registry.thresholdState!.currentThreshold = 0.7;
      
      const result = adjustDynamicThreshold(registry);
      assert.ok(result, "Should return adjustment result");
      assert.ok(result!.newThreshold < 0.7, "Should lower threshold");
      assert.ok(result!.reason.includes("lowering"), "Reason should mention lowering");
    });

    it("raises threshold when accuracy is low", () => {
      registry.thresholdState!.totalPredictions = 30;
      registry.thresholdState!.totalCorrect = 15; // 50% accuracy
      registry.thresholdState!.currentThreshold = 0.7;
      
      const result = adjustDynamicThreshold(registry);
      assert.ok(result, "Should return adjustment result");
      assert.ok(result!.newThreshold > 0.7, "Should raise threshold");
      assert.ok(result!.reason.includes("raising"), "Reason should mention raising");
    });

    it("respects minThreshold limit", () => {
      registry.thresholdState!.totalPredictions = 30;
      registry.thresholdState!.totalCorrect = 30; // 100% accuracy
      registry.thresholdState!.currentThreshold = 0.52;
      
      const result = adjustDynamicThreshold(registry);
      assert.ok(result!.newThreshold >= DEFAULT_DYNAMIC_THRESHOLD_CONFIG.minThreshold, 
        "Should not go below minThreshold");
    });

    it("respects maxThreshold limit", () => {
      registry.thresholdState!.totalPredictions = 30;
      registry.thresholdState!.totalCorrect = 5; // Very low accuracy
      registry.thresholdState!.currentThreshold = 0.88;
      
      const result = adjustDynamicThreshold(registry);
      assert.ok(result!.newThreshold <= DEFAULT_DYNAMIC_THRESHOLD_CONFIG.maxThreshold, 
        "Should not exceed maxThreshold");
    });

    it("records adjustment in history", () => {
      registry.thresholdState!.totalPredictions = 30;
      registry.thresholdState!.totalCorrect = 28;
      
      adjustDynamicThreshold(registry);
      assert.ok(registry.thresholdState!.accuracyHistory.length > 0, 
        "Should record in history");
    });
  });

  describe("getDynamicConflictConfig", () => {
    it("returns config with dynamic threshold", () => {
      registry.thresholdState!.currentThreshold = 0.65;
      
      const config = getDynamicConflictConfig(registry);
      assert.equal(config.confidenceThreshold, 0.65, "Should use dynamic threshold");
    });

    it("merges with base config", () => {
      registry.thresholdState!.currentThreshold = 0.6;
      
      const config = getDynamicConflictConfig(registry, { minOccurrences: 5 });
      assert.equal(config.minOccurrences, 5, "Should preserve other config values");
      assert.equal(config.confidenceThreshold, 0.6, "Should use dynamic threshold");
    });
  });
});

// ============================================================================
// Improved Chinese Phrase Extraction Tests
// ============================================================================

describe("Improved Chinese Phrase Extraction", () => {
  it("filters out blacklisted bigrams", () => {
    const phrases = extractIntentPhrases("这是一个测试");
    // "这是" and "一个" are blacklisted
    assert.ok(!phrases.includes("这是"), "Should filter out blacklisted bigram '这是'");
    assert.ok(!phrases.includes("一个"), "Should filter out blacklisted bigram '一个'");
  });

  it("filters out phrases containing stop characters", () => {
    const phrases = extractIntentPhrases("我的项目部署");
    // "我的" contains stop character "的"
    assert.ok(!phrases.includes("我的"), "Should filter out phrase with stop char");
  });

  it("extracts meaningful bigrams without stop chars", () => {
    const phrases = extractIntentPhrases("部署生产系统");
    // Should extract meaningful phrases like "部署", "生产", "系统", "部署生产", "生产系统"
    assert.ok(phrases.some(p => p.includes("部署")), "Should contain '部署'");
    assert.ok(phrases.some(p => p.includes("生产")), "Should contain '生产'");
    assert.ok(phrases.some(p => p.includes("系统")), "Should contain '系统'");
  });

  it("filters trigrams that start/end with stop chars", () => {
    const phrases = extractIntentPhrases("的是项目");
    // Trigram "的是项" starts with stop char, should be filtered
    const hasInvalidTrigram = phrases.some(p => p.length === 3 && CHINESE_STOP_CHARS.has(p[0]));
    assert.ok(!hasInvalidTrigram, "Should filter trigrams starting with stop char");
  });

  it("extracts multi-character words without stop chars at end", () => {
    const phrases = extractIntentPhrases("部署系统的");
    // Should not extract "系统的" because it ends with "的"
    const invalidPhrases = phrases.filter(p => p.endsWith("的") && p.length > 1);
    assert.equal(invalidPhrases.length, 0, "Should not extract phrases ending with stop char");
  });
});
