import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadTopTopics, suggestTracksFromTopics, feedbackToOfms } from "../src/ofms-bridge.ts";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "ofms-bridge-test-"));
}

function writeRegistry(dir: string, topics: Record<string, unknown>): void {
  writeFileSync(join(dir, "topic_registry.json"), JSON.stringify({ topics }), "utf-8");
}

/** Build a topic entry that has a high importance score (recent, multiple days, multiple agents). */
function highImportanceTopic(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const today = new Date().toISOString().slice(0, 10);
  return {
    firstSeen: today,
    lastSeen: new Date().toISOString(),
    totalMentions: 20,
    dailyCounts: { [today]: 10, "2026-03-16": 10 },
    agents: ["agent1", "agent2", "agent3"],
    contexts: [],
    baseWeight: 2.0,
    ...overrides,
  };
}

/** Build a topic entry that will have near-zero importance (very old, single mention). */
function lowImportanceTopic(): Record<string, unknown> {
  return {
    firstSeen: "2020-01-01",
    lastSeen: "2020-01-01",
    totalMentions: 1,
    dailyCounts: { "2020-01-01": 1 },
    agents: ["agent1"],
    contexts: [],
    baseWeight: 1.0,
  };
}

// ─── loadTopTopics ───────────────────────────────────────────────────────────

describe("loadTopTopics", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = makeTempDir();
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty array when registry file does not exist", () => {
    const result = loadTopTopics(join(tmpDir, "nonexistent"));
    assert.deepEqual(result, []);
  });

  it("returns empty array when registry file has no topics", () => {
    const emptyDir = makeTempDir();
    try {
      writeRegistry(emptyDir, {});
      const result = loadTopTopics(emptyDir);
      assert.deepEqual(result, []);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it("returns empty array when file contains invalid JSON", () => {
    const badDir = makeTempDir();
    try {
      writeFileSync(join(badDir, "topic_registry.json"), "{ not valid json", "utf-8");
      const result = loadTopTopics(badDir);
      assert.deepEqual(result, []);
    } finally {
      rmSync(badDir, { recursive: true, force: true });
    }
  });

  it("returns topics sorted by importance descending", () => {
    const dir = makeTempDir();
    try {
      writeRegistry(dir, {
        hot: highImportanceTopic(),
        cold: lowImportanceTopic(),
      });
      const result = loadTopTopics(dir);
      assert.ok(result.length >= 2);
      assert.ok(result[0].importance >= result[1].importance);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("respects limit parameter", () => {
    const dir = makeTempDir();
    try {
      writeRegistry(dir, {
        a: highImportanceTopic(),
        b: highImportanceTopic(),
        c: highImportanceTopic(),
        d: highImportanceTopic(),
        e: highImportanceTopic(),
      });
      const result = loadTopTopics(dir, 3);
      assert.equal(result.length, 3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("defaults to limit of 20", () => {
    const dir = makeTempDir();
    try {
      const topics: Record<string, unknown> = {};
      for (let i = 0; i < 25; i++) {
        topics[`topic${i}`] = highImportanceTopic();
      }
      writeRegistry(dir, topics);
      const result = loadTopTopics(dir);
      assert.ok(result.length <= 20);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("result entries have required TopicHeat fields", () => {
    const dir = makeTempDir();
    try {
      writeRegistry(dir, { alpha: highImportanceTopic() });
      const result = loadTopTopics(dir);
      assert.ok(result.length > 0);
      const entry = result[0];
      assert.equal(typeof entry.topic, "string");
      assert.equal(typeof entry.importance, "number");
      assert.equal(typeof entry.totalMentions, "number");
      assert.equal(typeof entry.uniqueAgents, "number");
      assert.equal(typeof entry.lastSeen, "string");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loads topics from real topic_registry.json when it exists", () => {
    const realPath = join(process.env.HOME ?? "", ".openclaw/shared-memory");
    if (!existsSync(join(realPath, "topic_registry.json"))) {
      // Skip gracefully if real file not available in test environment
      return;
    }
    const result = loadTopTopics(realPath);
    assert.ok(Array.isArray(result));
    // The real registry has topics with numeric keys (e.g. "2604", "2607")
    for (const entry of result) {
      assert.equal(typeof entry.topic, "string");
      assert.equal(typeof entry.importance, "number");
    }
  });
});

// ─── suggestTracksFromTopics ─────────────────────────────────────────────────

describe("suggestTracksFromTopics", () => {
  it("returns empty array for missing registry", () => {
    const result = suggestTracksFromTopics(join(tmpdir(), "does-not-exist-" + Date.now()));
    assert.deepEqual(result, []);
  });

  it("returns empty array when all topics have low importance", () => {
    const dir = makeTempDir();
    try {
      writeRegistry(dir, { cold: lowImportanceTopic() });
      // Default threshold is 3.0; low topic importance is near 0
      const result = suggestTracksFromTopics(dir);
      assert.deepEqual(result, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns suggestions for high-importance topics", () => {
    const dir = makeTempDir();
    try {
      writeRegistry(dir, { ai: highImportanceTopic() });
      const result = suggestTracksFromTopics(dir);
      assert.ok(result.length > 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("suggestion has required fields", () => {
    const dir = makeTempDir();
    try {
      writeRegistry(dir, { typescript: highImportanceTopic() });
      const result = suggestTracksFromTopics(dir);
      assert.ok(result.length > 0);
      const s = result[0];
      assert.equal(typeof s.topic, "string");
      assert.equal(typeof s.importance, "number");
      assert.ok(s.suggestedTrackId.startsWith("topic-"));
      assert.ok(s.suggestedGoal.includes(s.topic));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("respects custom threshold — filters out topics below it", () => {
    const dir = makeTempDir();
    try {
      writeRegistry(dir, {
        hot: highImportanceTopic(),
        cold: lowImportanceTopic(),
      });
      // Use a very high threshold to ensure only the hot topic passes
      const resultHigh = suggestTracksFromTopics(dir, 999);
      assert.deepEqual(resultHigh, []);

      // Use threshold of 0 to ensure hot topic passes
      const resultLow = suggestTracksFromTopics(dir, 0);
      assert.ok(resultLow.length > 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── feedbackToOfms ──────────────────────────────────────────────────────────

describe("feedbackToOfms", () => {
  it("returns 0 when validatedItems is empty", () => {
    const dir = makeTempDir();
    try {
      const count = feedbackToOfms({
        sharedRoot: dir,
        agent: "test-agent",
        validatedItems: [],
      });
      assert.equal(count, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates queue/pending directory if it does not exist", () => {
    const dir = makeTempDir();
    try {
      feedbackToOfms({
        sharedRoot: dir,
        agent: "test-agent",
        validatedItems: [
          { title: "Test Issue Alpha", url: "https://github.com/foo/bar/issues/1", trackLabel: "Issues" },
        ],
      });
      assert.ok(existsSync(join(dir, "queue", "pending")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes a candidate file to queue/pending", () => {
    const dir = makeTempDir();
    try {
      const count = feedbackToOfms({
        sharedRoot: dir,
        agent: "test-agent",
        validatedItems: [
          { title: "Regression fix", url: "https://github.com/foo/bar/issues/42", trackLabel: "Issues" },
        ],
        request: "查 issues",
      });
      assert.equal(count, 1);
      const pendingDir = join(dir, "queue", "pending");
      const files = readdirSync(pendingDir);
      assert.equal(files.length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("candidate file contains expected OFMS frontmatter fields", () => {
    const dir = makeTempDir();
    try {
      feedbackToOfms({
        sharedRoot: dir,
        agent: "orch-agent",
        validatedItems: [
          { title: "Cool Feature", url: "https://github.com/a/b/issues/7", trackLabel: "Issues" },
        ],
        request: "test request",
      });
      const pendingDir = join(dir, "queue", "pending");
      const files = readdirSync(pendingDir);
      const content = readFileSync(join(pendingDir, files[0]), "utf-8");
      assert.ok(content.includes("agent: orch-agent"));
      assert.ok(content.includes("category: validated_research"));
      assert.ok(content.includes("priority: medium"));
      assert.ok(content.includes("source: multi-agent-orchestrator"));
      assert.ok(content.includes("# Shared Memory Candidate"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not write the same file twice (deduplication by hash)", () => {
    const dir = makeTempDir();
    try {
      const item = { title: "Dup Issue", url: "https://github.com/foo/bar/issues/99", trackLabel: "Issues" };
      const count1 = feedbackToOfms({ sharedRoot: dir, agent: "a", validatedItems: [item] });
      const count2 = feedbackToOfms({ sharedRoot: dir, agent: "a", validatedItems: [item] });
      assert.equal(count1, 1);
      assert.equal(count2, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("respects max 5 items per call", () => {
    const dir = makeTempDir();
    try {
      const items = Array.from({ length: 10 }, (_, i) => ({
        title: `Issue ${i}`,
        url: `https://github.com/foo/bar/issues/${i + 100}`,
        trackLabel: "Issues",
      }));
      const count = feedbackToOfms({ sharedRoot: dir, agent: "a", validatedItems: items });
      assert.equal(count, 5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips items with candidateText shorter than 20 chars", () => {
    const dir = makeTempDir();
    try {
      // "[T] x — y" is very short
      const count = feedbackToOfms({
        sharedRoot: dir,
        agent: "a",
        validatedItems: [{ title: "x", url: "y", trackLabel: "T" }],
      });
      assert.equal(count, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("includes request in Why section when provided", () => {
    const dir = makeTempDir();
    try {
      feedbackToOfms({
        sharedRoot: dir,
        agent: "a",
        validatedItems: [
          { title: "Some Result Title", url: "https://github.com/foo/bar/issues/55", trackLabel: "Issues" },
        ],
        request: "find top issues in openclaw",
      });
      const pendingDir = join(dir, "queue", "pending");
      const files = readdirSync(pendingDir);
      const content = readFileSync(join(pendingDir, files[0]), "utf-8");
      assert.ok(content.includes("find top issues in openclaw"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
