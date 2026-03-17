import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  exportPatterns,
  importPatterns,
  serializeExport,
  parseImport,
} from "../src/pattern-export.ts";
import type { ExportedPatterns } from "../src/pattern-export.ts";
import { createEmptyRegistry } from "../src/intent-registry.ts";
import type { IntentRegistry, IntentPattern } from "../src/intent-registry.ts";
import { createDefaultState } from "../src/enforcement-ladder.ts";
import type { UserKeywords } from "../src/user-keywords.ts";

function makeKeywords(overrides: Partial<UserKeywords> = {}): UserKeywords {
  return { delegation: [], tracked: [], light: [], updatedAt: "", ...overrides };
}

function makeRegistryWithPattern(phrase: string): IntentRegistry {
  const registry = createEmptyRegistry();
  const pattern: IntentPattern = {
    phrase,
    occurrences: 5,
    delegationCount: 4,
    trackedCount: 1,
    lightCount: 0,
    lastSeen: new Date().toISOString(),
    confidence: { delegation: 0.8, tracked: 0.2, light: 0 },
  };
  registry.patterns[phrase] = pattern;
  return registry;
}

describe("exportPatterns", () => {
  it("exports correct version and structure", () => {
    const registry = createEmptyRegistry();
    const keywords = makeKeywords();
    const enforcement = createDefaultState();
    const exported = exportPatterns({
      intentRegistry: registry,
      userKeywords: keywords,
      enforcementState: enforcement,
      observations: [],
    });
    assert.equal(exported.version, 1);
    assert.ok(typeof exported.exportedAt === "string");
    assert.ok(typeof exported.source === "string");
    assert.ok(typeof exported.intentPatterns === "object");
    assert.ok(Array.isArray(exported.userKeywords.delegation));
    assert.ok(Array.isArray(exported.userKeywords.tracked));
    assert.ok(Array.isArray(exported.userKeywords.light));
    assert.ok(typeof exported.stats === "object");
  });

  it("includes intent patterns from registry", () => {
    const registry = makeRegistryWithPattern("全力推进");
    const exported = exportPatterns({
      intentRegistry: registry,
      userKeywords: makeKeywords(),
      enforcementState: createDefaultState(),
      observations: [],
    });
    assert.ok("全力推进" in exported.intentPatterns);
    assert.equal(exported.intentPatterns["全力推进"].occurrences, 5);
    assert.equal(exported.intentPatterns["全力推进"].confidence.delegation, 0.8);
  });

  it("includes user keywords", () => {
    const keywords = makeKeywords({ delegation: ["全力推进"], tracked: ["出报告"] });
    const exported = exportPatterns({
      intentRegistry: createEmptyRegistry(),
      userKeywords: keywords,
      enforcementState: createDefaultState(),
      observations: [],
    });
    assert.deepEqual(exported.userKeywords.delegation, ["全力推进"]);
    assert.deepEqual(exported.userKeywords.tracked, ["出报告"]);
  });

  it("includes enforcement level in stats", () => {
    const enforcement = createDefaultState();
    enforcement.currentLevel = 2;
    const exported = exportPatterns({
      intentRegistry: createEmptyRegistry(),
      userKeywords: makeKeywords(),
      enforcementState: enforcement,
      observations: [],
    });
    assert.equal(exported.stats.enforcementLevel, 2);
  });
});

describe("serializeExport / parseImport round-trip", () => {
  it("round-trip preserves all fields", () => {
    const registry = makeRegistryWithPattern("审计");
    const keywords = makeKeywords({ delegation: ["全力推进"], tracked: ["出报告"] });
    const enforcement = createDefaultState();
    const exported = exportPatterns({
      intentRegistry: registry,
      userKeywords: keywords,
      enforcementState: enforcement,
      observations: [],
    });

    const json = serializeExport(exported);
    const parsed = parseImport(json);

    assert.ok(parsed !== null);
    assert.equal(parsed!.version, exported.version);
    assert.equal(parsed!.exportedAt, exported.exportedAt);
    assert.deepEqual(parsed!.userKeywords, exported.userKeywords);
    assert.ok("审计" in parsed!.intentPatterns);
  });

  it("serializeExport produces valid JSON", () => {
    const exported = exportPatterns({
      intentRegistry: createEmptyRegistry(),
      userKeywords: makeKeywords(),
      enforcementState: createDefaultState(),
      observations: [],
    });
    const json = serializeExport(exported);
    assert.doesNotThrow(() => JSON.parse(json));
  });
});

describe("parseImport", () => {
  it("returns null for invalid JSON", () => {
    const result = parseImport("not valid json {{");
    assert.equal(result, null);
  });

  it("returns null when version field is missing", () => {
    const obj = { exportedAt: "2024-01-01", intentPatterns: {} };
    const result = parseImport(JSON.stringify(obj));
    assert.equal(result, null);
  });

  it("returns null when intentPatterns is not an object", () => {
    const obj: Partial<ExportedPatterns> = {
      version: 1,
      exportedAt: "2024-01-01",
      intentPatterns: "invalid" as unknown as ExportedPatterns["intentPatterns"],
    };
    const result = parseImport(JSON.stringify(obj));
    assert.equal(result, null);
  });

  it("returns valid ExportedPatterns for correct JSON", () => {
    const exported = exportPatterns({
      intentRegistry: createEmptyRegistry(),
      userKeywords: makeKeywords(),
      enforcementState: createDefaultState(),
      observations: [],
    });
    const parsed = parseImport(serializeExport(exported));
    assert.ok(parsed !== null);
    assert.equal(parsed!.version, 1);
  });
});

describe("importPatterns", () => {
  it("adds new patterns that are not already present", () => {
    const sourceRegistry = makeRegistryWithPattern("全力推进");
    const exported = exportPatterns({
      intentRegistry: sourceRegistry,
      userKeywords: makeKeywords(),
      enforcementState: createDefaultState(),
      observations: [],
    });

    const targetRegistry = createEmptyRegistry();
    const targetKeywords = makeKeywords();
    const result = importPatterns({ exported, intentRegistry: targetRegistry, userKeywords: targetKeywords });

    assert.equal(result.patternsImported, 1);
    assert.ok("全力推进" in targetRegistry.patterns);
  });

  it("does not overwrite existing patterns", () => {
    const sourceRegistry = makeRegistryWithPattern("全力推进");
    const exported = exportPatterns({
      intentRegistry: sourceRegistry,
      userKeywords: makeKeywords(),
      enforcementState: createDefaultState(),
      observations: [],
    });

    // Target already has the pattern with different stats
    const targetRegistry = makeRegistryWithPattern("全力推进");
    targetRegistry.patterns["全力推进"].occurrences = 99;

    importPatterns({ exported, intentRegistry: targetRegistry, userKeywords: makeKeywords() });

    assert.equal(targetRegistry.patterns["全力推进"].occurrences, 99); // not overwritten
  });

  it("imports user keywords and avoids duplicates", () => {
    const exported = exportPatterns({
      intentRegistry: createEmptyRegistry(),
      userKeywords: makeKeywords({ delegation: ["全力推进", "全面分析"] }),
      enforcementState: createDefaultState(),
      observations: [],
    });

    const targetKeywords = makeKeywords({ delegation: ["全力推进"] }); // already has one
    const result = importPatterns({
      exported,
      intentRegistry: createEmptyRegistry(),
      userKeywords: targetKeywords,
    });

    // Only "全面分析" is new
    assert.equal(result.keywordsImported, 1);
    assert.equal(targetKeywords.delegation.length, 2);
  });

  it("imports keywords across all tiers", () => {
    const exported = exportPatterns({
      intentRegistry: createEmptyRegistry(),
      userKeywords: makeKeywords({ delegation: ["d1"], tracked: ["t1"], light: ["l1"] }),
      enforcementState: createDefaultState(),
      observations: [],
    });

    const targetKeywords = makeKeywords();
    const result = importPatterns({
      exported,
      intentRegistry: createEmptyRegistry(),
      userKeywords: targetKeywords,
    });

    assert.equal(result.keywordsImported, 3);
    assert.ok(targetKeywords.delegation.includes("d1"));
    assert.ok(targetKeywords.tracked.includes("t1"));
    assert.ok(targetKeywords.light.includes("l1"));
  });

  it("returns zero counts when nothing is new", () => {
    const registry = makeRegistryWithPattern("全力推进");
    const exported = exportPatterns({
      intentRegistry: registry,
      userKeywords: makeKeywords({ delegation: ["全力推进"] }),
      enforcementState: createDefaultState(),
      observations: [],
    });

    // Import into a target that already has everything
    const targetRegistry = makeRegistryWithPattern("全力推进");
    const targetKeywords = makeKeywords({ delegation: ["全力推进"] });
    const result = importPatterns({ exported, intentRegistry: targetRegistry, userKeywords: targetKeywords });

    assert.equal(result.patternsImported, 0);
    assert.equal(result.keywordsImported, 0);
  });
});
