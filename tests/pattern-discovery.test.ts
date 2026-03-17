import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractSignificantTokens,
  computeTokenSignificance,
  discoverPatterns,
  analyzeStructuralCorrelations,
  filterNewPatterns,
  formatDiscoveryReport,
} from "../src/pattern-discovery.ts";
import type { DiscoveredPattern, DiscoveryResult } from "../src/pattern-discovery.ts";
import { generateObservationId } from "../src/observation-engine.ts";
import type { ObservationRecord } from "../src/observation-engine.ts";

// ---------------------------------------------------------------------------
// Helper factory
// ---------------------------------------------------------------------------
function makeObs(
  text: string,
  predicted: string,
  actual?: string,
  tools?: string[],
): ObservationRecord {
  return {
    id: generateObservationId(),
    timestamp: new Date().toISOString(),
    agent: "test",
    messageText: text,
    messageLength: text.length,
    language: "zh",
    hasNumberedList: false,
    actionVerbCount: 0,
    predictedTier: predicted as "light" | "tracked" | "delegation",
    toolsCalled: tools ?? [],
    didSpawnSubagent: tools?.includes("sessions_spawn") ?? false,
    spawnCount: 0,
    userFollowUp: actual ? (actual !== predicted ? "corrected_up" : "satisfied") : null,
    actualTier: (actual ?? null) as "light" | "tracked" | "delegation" | null,
  };
}

// ---------------------------------------------------------------------------
// extractSignificantTokens
// ---------------------------------------------------------------------------
describe("extractSignificantTokens", () => {
  it("Chinese text produces meaningful tokens", () => {
    const tokens = extractSignificantTokens("请帮我部署系统到生产环境");
    assert.ok(tokens.length > 0, "Should produce tokens from Chinese text");
    // Should include meaningful Chinese substrings, not single stop chars
    const hasStop = tokens.some((t) => ["的", "了", "你"].includes(t));
    assert.ok(!hasStop, `Should not include stop characters, got: ${tokens.join(", ")}`);
  });

  it("English text produces meaningful tokens", () => {
    const tokens = extractSignificantTokens("please deploy the system to production");
    assert.ok(tokens.length > 0, "Should produce tokens from English text");
    assert.ok(tokens.includes("deploy"), "Should include 'deploy'");
    assert.ok(tokens.includes("system"), "Should include 'system'");
    assert.ok(tokens.includes("production"), "Should include 'production'");
  });

  it("filters English stop words", () => {
    const tokens = extractSignificantTokens("the cat is in the hat");
    const stopWords = ["the", "is", "in", "a", "an"];
    for (const sw of stopWords) {
      assert.ok(!tokens.includes(sw), `Should filter stop word: ${sw}`);
    }
  });

  it("generates bigrams from English tokens", () => {
    const tokens = extractSignificantTokens("deploy system now");
    // "deploy system" and "system now" should appear as bigrams
    assert.ok(tokens.includes("deploy system"), "Should include bigram 'deploy system'");
  });

  it("returns at most 30 tokens", () => {
    const longText = "audit review test deploy analyze research develop implement optimize fix refactor build evaluate investigate design verify configure install upgrade publish sync scan backup restore migrate plan schedule track monitor report generate create update delete manage organize archive export import transform validate process execute launch initialize setup configure maintain document test debug release";
    const tokens = extractSignificantTokens(longText);
    assert.ok(tokens.length <= 30, `Should return at most 30 tokens, got ${tokens.length}`);
  });

  it("returns unique tokens only", () => {
    const tokens = extractSignificantTokens("deploy deploy deploy system system");
    const unique = new Set(tokens);
    assert.equal(tokens.length, unique.size, "Tokens should be unique");
  });
});

// ---------------------------------------------------------------------------
// computeTokenSignificance
// ---------------------------------------------------------------------------
describe("computeTokenSignificance", () => {
  it("delegation-heavy token gets high significance", () => {
    // "orchestrate" appears 5x in delegation, 0x in light
    const obs: ObservationRecord[] = [
      ...Array.from({ length: 5 }, () => makeObs("orchestrate multi agent tasks", "delegation")),
      ...Array.from({ length: 3 }, () => makeObs("hello how are you", "light")),
    ];
    const sig = computeTokenSignificance(obs);
    const entry = sig.get("orchestrate");
    assert.ok(entry !== undefined, "Should have entry for 'orchestrate'");
    assert.ok(entry!.significance > 2.0, `Significance should be high, got ${entry!.significance}`);
    assert.equal(entry!.delegationFreq, 5);
    assert.equal(entry!.lightFreq, 0);
  });

  it("light-only token gets low significance", () => {
    const obs: ObservationRecord[] = [
      ...Array.from({ length: 5 }, () => makeObs("hello good morning", "light")),
      ...Array.from({ length: 3 }, () => makeObs("deploy audit review system", "delegation")),
    ];
    const sig = computeTokenSignificance(obs);
    const entry = sig.get("morning");
    assert.ok(entry !== undefined, "Should have entry for 'morning'");
    // morning appears only in light, not delegation → low significance
    assert.ok(entry!.significance < 1.0, `Significance should be low, got ${entry!.significance}`);
    assert.equal(entry!.lightFreq, 5);
    assert.equal(entry!.delegationFreq, 0);
  });

  it("evenly distributed token gets mid significance (~1.0)", () => {
    // "review" appears equally in delegation and light
    const obs: ObservationRecord[] = [
      ...Array.from({ length: 4 }, () => makeObs("review the code", "delegation")),
      ...Array.from({ length: 4 }, () => makeObs("review the docs", "light")),
    ];
    const sig = computeTokenSignificance(obs);
    const entry = sig.get("review");
    assert.ok(entry !== undefined, "Should have entry for 'review'");
    // significance = (4/4) / (4/4 + 0.01) ≈ 1 / 1.01 ≈ 0.99
    assert.ok(entry!.significance > 0.5 && entry!.significance < 1.5,
      `Significance should be near 1.0, got ${entry!.significance}`);
  });

  it("tracked-only token has correct frequency counts", () => {
    const obs: ObservationRecord[] = [
      ...Array.from({ length: 3 }, () => makeObs("configure server settings", "tracked")),
      ...Array.from({ length: 2 }, () => makeObs("hello world", "light")),
    ];
    const sig = computeTokenSignificance(obs);
    const entry = sig.get("configure");
    assert.ok(entry !== undefined, "Should have entry for 'configure'");
    assert.equal(entry!.trackedFreq, 3);
    assert.equal(entry!.lightFreq, 0);
    assert.equal(entry!.delegationFreq, 0);
  });
});

// ---------------------------------------------------------------------------
// discoverPatterns
// ---------------------------------------------------------------------------
describe("discoverPatterns", () => {
  it("with enough data discovers new delegation keywords", () => {
    // "orchestrate" appears heavily in delegation, not in light
    const obs: ObservationRecord[] = [
      ...Array.from({ length: 8 }, () => makeObs("orchestrate multi agent workflow", "delegation")),
      ...Array.from({ length: 5 }, () => makeObs("what time is it today", "light")),
      ...Array.from({ length: 2 }, () => makeObs("configure the server", "tracked")),
    ];
    const result = discoverPatterns(obs, [], []);
    assert.ok(result.sampleSize === 15, "Should record correct sample size");
    assert.ok(result.newDelegationKeywords.length > 0, "Should discover delegation keywords");
    const found = result.newDelegationKeywords.find((p) => p.phrase === "orchestrate");
    assert.ok(found !== undefined, "Should discover 'orchestrate' as delegation keyword");
  });

  it("too few observations returns empty result", () => {
    const obs: ObservationRecord[] = [
      makeObs("deploy the system", "delegation"),
      makeObs("hello world", "light"),
    ];
    const result = discoverPatterns(obs, [], []);
    assert.equal(result.newDelegationKeywords.length, 0);
    assert.equal(result.newTrackedKeywords.length, 0);
    assert.equal(result.sampleSize, 2);
  });

  it("excludes existing delegation keywords", () => {
    const obs: ObservationRecord[] = [
      ...Array.from({ length: 8 }, () => makeObs("orchestrate multi agent workflow", "delegation")),
      ...Array.from({ length: 5 }, () => makeObs("hello world how are you today", "light")),
      ...Array.from({ length: 2 }, () => makeObs("configure settings", "tracked")),
    ];
    const result = discoverPatterns(obs, ["orchestrate"], []);
    const found = result.newDelegationKeywords.find((p) => p.phrase === "orchestrate");
    assert.ok(found === undefined, "Should not rediscover existing delegation keyword 'orchestrate'");
  });

  it("excludes existing tracked keywords", () => {
    const obs: ObservationRecord[] = [
      ...Array.from({ length: 5 }, () => makeObs("configure server endpoint now", "tracked")),
      ...Array.from({ length: 5 }, () => makeObs("hello world how are you", "light")),
      ...Array.from({ length: 5 }, () => makeObs("deploy audit review check", "delegation")),
    ];
    const result = discoverPatterns(obs, [], ["configure"]);
    const found = result.newTrackedKeywords.find((p) => p.phrase === "configure");
    assert.ok(found === undefined, "Should not rediscover existing tracked keyword 'configure'");
  });

  it("respects minOccurrences threshold", () => {
    // "rareword" appears only twice — below default threshold of 3
    const obs: ObservationRecord[] = [
      ...Array.from({ length: 2 }, () => makeObs("rareword in delegation message", "delegation")),
      ...Array.from({ length: 10 }, () => makeObs("common message hello world", "light")),
    ];
    const result = discoverPatterns(obs, [], [], 3);
    const found = result.newDelegationKeywords.find((p) => p.phrase === "rareword");
    assert.ok(found === undefined, `Should not discover 'rareword' with only 2 occurrences (min=3)`);
  });

  it("respects minConfidence threshold", () => {
    // With very high minConfidence, most tokens should be filtered out
    const obs: ObservationRecord[] = [
      ...Array.from({ length: 5 }, () => makeObs("deploy system infrastructure", "delegation")),
      ...Array.from({ length: 3 }, () => makeObs("deploy simple task", "light")),
      ...Array.from({ length: 5 }, () => makeObs("random filler message for size", "tracked")),
    ];
    // With minConfidence=0.99, very few tokens should qualify
    const result = discoverPatterns(obs, [], [], 3, 0.99);
    // All confidence values should be >= 0.99 for any discovered patterns
    for (const p of result.newDelegationKeywords) {
      assert.ok(p.confidence >= 0.99, `Confidence should be >= 0.99, got ${p.confidence} for '${p.phrase}'`);
    }
  });

  it("results are sorted by confidence descending", () => {
    const obs: ObservationRecord[] = [
      ...Array.from({ length: 10 }, () => makeObs("orchestrate agent workflow pipeline", "delegation")),
      ...Array.from({ length: 3 }, () => makeObs("pipeline in tracking mode", "tracked")),
      ...Array.from({ length: 5 }, () => makeObs("just a light message ok", "light")),
    ];
    const result = discoverPatterns(obs, [], []);
    const confidences = result.newDelegationKeywords.map((p) => p.confidence);
    for (let i = 1; i < confidences.length; i++) {
      assert.ok(
        confidences[i - 1] >= confidences[i],
        `Results should be sorted by confidence desc: ${confidences.join(", ")}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// analyzeStructuralCorrelations
// ---------------------------------------------------------------------------
describe("analyzeStructuralCorrelations", () => {
  it("computes correct average lengths per tier", () => {
    const obs: ObservationRecord[] = [
      { ...makeObs("hi", "light"), messageLength: 2 },
      { ...makeObs("hello there", "light"), messageLength: 11 },
      { ...makeObs("deploy the server configuration", "tracked"), messageLength: 30 },
      { ...makeObs("deploy the server configuration now fully", "tracked"), messageLength: 40 },
      { ...makeObs("orchestrate full multi agent workflow deploy audit review analyze", "delegation"), messageLength: 60 },
      { ...makeObs("orchestrate all agents deploy audit review analyze configure build", "delegation"), messageLength: 80 },
    ];
    const corr = analyzeStructuralCorrelations(obs);
    assert.equal(corr.lengthCorrelation.avgLightLength, 6.5);
    assert.equal(corr.lengthCorrelation.avgTrackedLength, 35);
    assert.equal(corr.lengthCorrelation.avgDelegationLength, 70);
  });

  it("computes correct average verb counts per tier", () => {
    const obs: ObservationRecord[] = [
      { ...makeObs("hi", "light"), actionVerbCount: 0 },
      { ...makeObs("review code", "tracked"), actionVerbCount: 1 },
      { ...makeObs("review and deploy", "tracked"), actionVerbCount: 2 },
      { ...makeObs("deploy audit review analyze configure", "delegation"), actionVerbCount: 5 },
      { ...makeObs("audit review test deploy", "delegation"), actionVerbCount: 4 },
    ];
    const corr = analyzeStructuralCorrelations(obs);
    assert.equal(corr.verbCorrelation.avgLightVerbs, 0);
    assert.equal(corr.verbCorrelation.avgTrackedVerbs, 1.5);
    assert.equal(corr.verbCorrelation.avgDelegationVerbs, 4.5);
  });

  it("computes listDelegationRate correctly", () => {
    const obs: ObservationRecord[] = [
      { ...makeObs("1. a\n2. b\n3. c", "delegation"), hasNumberedList: true },
      { ...makeObs("1. x\n2. y\n3. z", "delegation"), hasNumberedList: true },
      { ...makeObs("1. p\n2. q\n3. r", "tracked"), hasNumberedList: true },
      { ...makeObs("simple message", "light"), hasNumberedList: false },
      { ...makeObs("another message", "light"), hasNumberedList: false },
    ];
    const corr = analyzeStructuralCorrelations(obs);
    // 3 messages with list, 2 are delegation → listDelegationRate = 2/3
    assert.ok(
      Math.abs(corr.listCorrelation.listDelegationRate - 2 / 3) < 0.001,
      `listDelegationRate should be ~0.667, got ${corr.listCorrelation.listDelegationRate}`,
    );
    // 2 messages without list, both light → noListDelegationRate = 0
    assert.equal(corr.listCorrelation.noListDelegationRate, 0);
  });

  it("handles empty observations gracefully", () => {
    const corr = analyzeStructuralCorrelations([]);
    assert.equal(corr.lengthCorrelation.avgLightLength, 0);
    assert.equal(corr.lengthCorrelation.avgTrackedLength, 0);
    assert.equal(corr.lengthCorrelation.avgDelegationLength, 0);
    assert.equal(corr.listCorrelation.listDelegationRate, 0);
    assert.equal(corr.listCorrelation.noListDelegationRate, 0);
  });
});

// ---------------------------------------------------------------------------
// filterNewPatterns
// ---------------------------------------------------------------------------
describe("filterNewPatterns", () => {
  it("removes patterns already in existing keyword list", () => {
    const discoveries: DiscoveredPattern[] = [
      { phrase: "deploy", suggestedTier: "delegation", confidence: 0.9, occurrences: 5, delegationRate: 0.9, trackedRate: 0.1, evidence: [] },
      { phrase: "orchestrate", suggestedTier: "delegation", confidence: 0.8, occurrences: 4, delegationRate: 0.8, trackedRate: 0.2, evidence: [] },
      { phrase: "newword", suggestedTier: "delegation", confidence: 0.7, occurrences: 3, delegationRate: 0.7, trackedRate: 0.3, evidence: [] },
    ];
    const filtered = filterNewPatterns(discoveries, ["deploy", "orchestrate"]);
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].phrase, "newword");
  });

  it("is case-insensitive when filtering", () => {
    const discoveries: DiscoveredPattern[] = [
      { phrase: "Deploy", suggestedTier: "delegation", confidence: 0.9, occurrences: 5, delegationRate: 0.9, trackedRate: 0.1, evidence: [] },
    ];
    const filtered = filterNewPatterns(discoveries, ["deploy"]);
    assert.equal(filtered.length, 0, "Should filter case-insensitively");
  });

  it("returns all patterns when existingKeywords is empty", () => {
    const discoveries: DiscoveredPattern[] = [
      { phrase: "deploy", suggestedTier: "delegation", confidence: 0.9, occurrences: 5, delegationRate: 0.9, trackedRate: 0.1, evidence: [] },
      { phrase: "audit", suggestedTier: "delegation", confidence: 0.8, occurrences: 4, delegationRate: 0.8, trackedRate: 0.2, evidence: [] },
    ];
    const filtered = filterNewPatterns(discoveries, []);
    assert.equal(filtered.length, 2);
  });

  it("returns empty array when all patterns are filtered", () => {
    const discoveries: DiscoveredPattern[] = [
      { phrase: "deploy", suggestedTier: "delegation", confidence: 0.9, occurrences: 5, delegationRate: 0.9, trackedRate: 0.1, evidence: [] },
    ];
    const filtered = filterNewPatterns(discoveries, ["deploy"]);
    assert.equal(filtered.length, 0);
  });
});

// ---------------------------------------------------------------------------
// formatDiscoveryReport
// ---------------------------------------------------------------------------
describe("formatDiscoveryReport", () => {
  it("produces readable text with delegation keywords", () => {
    const result: DiscoveryResult = {
      newDelegationKeywords: [
        { phrase: "orchestrate", suggestedTier: "delegation", confidence: 0.85, occurrences: 8, delegationRate: 0.85, trackedRate: 0.15, evidence: ["orchestrate all agents"] },
      ],
      newTrackedKeywords: [],
      thresholdSuggestions: {},
      sampleSize: 50,
      overallAccuracy: 0.75,
    };
    const report = formatDiscoveryReport(result);
    assert.ok(report.includes("Pattern Discovery"), "Should include report title");
    assert.ok(report.includes("50"), "Should include sample size");
    assert.ok(report.includes("orchestrate"), "Should include discovered keyword");
    assert.ok(report.includes("75.0%"), "Should include accuracy percentage");
  });

  it("produces readable text with no keywords discovered", () => {
    const result: DiscoveryResult = {
      newDelegationKeywords: [],
      newTrackedKeywords: [],
      thresholdSuggestions: {},
      sampleSize: 10,
      overallAccuracy: 0,
    };
    const report = formatDiscoveryReport(result);
    assert.ok(report.includes("No new delegation keywords"), "Should mention no delegation keywords");
    assert.ok(report.includes("No new tracked keywords"), "Should mention no tracked keywords");
  });

  it("includes threshold suggestions when present", () => {
    const result: DiscoveryResult = {
      newDelegationKeywords: [],
      newTrackedKeywords: [],
      thresholdSuggestions: {
        minLengthForTracked: 30,
        minVerbsForDelegation: 3,
        defaultTierShouldBe: "tracked",
      },
      sampleSize: 100,
      overallAccuracy: 0.8,
    };
    const report = formatDiscoveryReport(result);
    assert.ok(report.includes("30"), "Should include minLengthForTracked");
    assert.ok(report.includes("3"), "Should include minVerbsForDelegation");
    assert.ok(report.includes("tracked"), "Should include defaultTierShouldBe");
  });

  it("includes both delegation and tracked sections", () => {
    const result: DiscoveryResult = {
      newDelegationKeywords: [
        { phrase: "delegate", suggestedTier: "delegation", confidence: 0.9, occurrences: 5, delegationRate: 0.9, trackedRate: 0.1, evidence: [] },
      ],
      newTrackedKeywords: [
        { phrase: "configure", suggestedTier: "tracked", confidence: 0.75, occurrences: 4, delegationRate: 0.1, trackedRate: 0.75, evidence: [] },
      ],
      thresholdSuggestions: {},
      sampleSize: 30,
      overallAccuracy: 0.6,
    };
    const report = formatDiscoveryReport(result);
    assert.ok(report.includes("delegate"), "Should include delegation keyword");
    assert.ok(report.includes("configure"), "Should include tracked keyword");
  });
});
