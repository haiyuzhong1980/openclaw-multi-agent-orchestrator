import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  generateObservationId,
  detectLanguage,
  countActionVerbs,
  hasNumberedList,
  createObservation,
  appendObservation,
  loadRecentObservations,
  detectFeedbackSignal,
  computeStats,
  pruneObservations,
  updateObservationOutcome,
  updateObservationFeedback,
  flushBuffer,
  getBufferedObservation,
} from "../src/observation-engine.ts";
import type { ObservationRecord } from "../src/observation-engine.ts";

// Use a temp directory for all disk I/O tests
const TMP_DIR = join("/tmp", `obs-test-${Date.now()}`);

function makeTmpDir(): string {
  const dir = join(TMP_DIR, `run-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// detectLanguage
// ---------------------------------------------------------------------------
describe("detectLanguage", () => {
  it("Chinese text returns zh", () => {
    assert.equal(detectLanguage("请帮我部署这个系统到生产环境"), "zh");
  });

  it("English text returns en", () => {
    assert.equal(detectLanguage("please deploy this system to production"), "en");
  });

  it("mixed text returns mixed", () => {
    // CJK: 10 chars (你好世界这是混合文本), Latin: 10 chars (helloworld) → ratio ~50/50
    assert.equal(detectLanguage("你好世界这是混合文本helloworld"), "mixed");
  });

  it("empty string returns en", () => {
    assert.equal(detectLanguage(""), "en");
  });

  it("text with only symbols returns en", () => {
    // No CJK or Latin chars → total == 0 → fallback en
    assert.equal(detectLanguage("123 !@# 456"), "en");
  });
});

// ---------------------------------------------------------------------------
// countActionVerbs
// ---------------------------------------------------------------------------
describe("countActionVerbs", () => {
  it("text with 3 distinct verbs returns 3", () => {
    const count = countActionVerbs("请帮我审计、评测和审查整个系统");
    assert.equal(count, 3);
  });

  it("text with 0 verbs returns 0", () => {
    const count = countActionVerbs("你好，今天天气很好");
    assert.equal(count, 0);
  });

  it("repeated verb only counted once (unique set)", () => {
    const count = countActionVerbs("audit audit audit");
    assert.equal(count, 1);
  });

  it("English verbs are counted", () => {
    const count = countActionVerbs("please audit, review and test the system");
    assert.equal(count, 3);
  });

  it("returns 0 for empty string", () => {
    assert.equal(countActionVerbs(""), 0);
  });
});

// ---------------------------------------------------------------------------
// hasNumberedList
// ---------------------------------------------------------------------------
describe("hasNumberedList", () => {
  it("numbered list with 3 items returns true", () => {
    assert.equal(hasNumberedList("1. first\n2. second\n3. third"), true);
  });

  it("plain text returns false", () => {
    assert.equal(hasNumberedList("please do this thing for me"), false);
  });

  it("list with only 2 items returns false", () => {
    assert.equal(hasNumberedList("1. first\n2. second"), false);
  });

  it("numbered list using Chinese punctuation returns true", () => {
    assert.equal(hasNumberedList("1、first\n2、second\n3、third"), true);
  });

  it("list with 4 items returns true", () => {
    assert.equal(hasNumberedList("1. a\n2. b\n3. c\n4. d"), true);
  });
});

// ---------------------------------------------------------------------------
// createObservation
// ---------------------------------------------------------------------------
describe("createObservation", () => {
  it("creates observation with correct fields", () => {
    const obs = createObservation({
      message: "please deploy the system",
      agent: "main-agent",
      predictedTier: "tracked",
    });
    assert.equal(obs.agent, "main-agent");
    assert.equal(obs.predictedTier, "tracked");
    assert.equal(obs.messageText, "please deploy the system");
    assert.equal(obs.messageLength, "please deploy the system".length);
    assert.equal(obs.toolsCalled.length, 0);
    assert.equal(obs.didSpawnSubagent, false);
    assert.equal(obs.spawnCount, 0);
    assert.equal(obs.userFollowUp, null);
    assert.equal(obs.actualTier, null);
    assert.ok(obs.id.startsWith("obs-"));
    assert.ok(obs.timestamp);
  });

  it("truncates message text to 200 chars", () => {
    const long = "x".repeat(300);
    const obs = createObservation({ message: long, agent: "a", predictedTier: "light" });
    assert.equal(obs.messageText.length, 200);
    assert.equal(obs.messageLength, 300);
  });

  it("detects language in observation", () => {
    const obs = createObservation({ message: "部署系统", agent: "a", predictedTier: "tracked" });
    assert.equal(obs.language, "zh");
  });

  it("detects numbered list in observation", () => {
    const obs = createObservation({
      message: "1. step one\n2. step two\n3. step three",
      agent: "a",
      predictedTier: "delegation",
    });
    assert.equal(obs.hasNumberedList, true);
  });

  it("counts action verbs in observation", () => {
    const obs = createObservation({
      message: "audit and review the code",
      agent: "a",
      predictedTier: "tracked",
    });
    assert.ok(obs.actionVerbCount >= 2);
  });
});

// ---------------------------------------------------------------------------
// appendObservation + loadRecentObservations (round-trip)
// ---------------------------------------------------------------------------
describe("appendObservation and loadRecentObservations", () => {
  it("round-trip: appended record can be loaded back", () => {
    const dir = makeTmpDir();
    const obs = createObservation({ message: "deploy now", agent: "main", predictedTier: "tracked" });
    appendObservation(dir, obs);
    const loaded = loadRecentObservations(dir, 1);
    assert.ok(loaded.length >= 1);
    const found = loaded.find((r) => r.id === obs.id);
    assert.ok(found, "Appended observation not found in loaded results");
    assert.equal(found?.messageText, "deploy now");
    assert.equal(found?.predictedTier, "tracked");
  });

  it("loadRecentObservations returns empty array for nonexistent dir", () => {
    const result = loadRecentObservations("/tmp/nonexistent-dir-xyz-999", 24);
    assert.deepEqual(result, []);
  });

  it("loadRecentObservations filters by hours", () => {
    const dir = makeTmpDir();
    // Write a record with an old timestamp manually
    const old: ObservationRecord = {
      id: "obs-old-0001",
      timestamp: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(), // 48h ago
      agent: "main",
      messageText: "old message",
      messageLength: 11,
      language: "en",
      hasNumberedList: false,
      actionVerbCount: 0,
      predictedTier: "light",
      toolsCalled: [],
      didSpawnSubagent: false,
      spawnCount: 0,
      userFollowUp: null,
      actualTier: null,
    };
    const recent = createObservation({ message: "recent message", agent: "main", predictedTier: "tracked" });
    appendObservation(dir, old);
    appendObservation(dir, recent);

    const loaded = loadRecentObservations(dir, 24); // only last 24h
    const ids = loaded.map((r) => r.id);
    assert.ok(!ids.includes("obs-old-0001"), "Old record should have been filtered");
    assert.ok(ids.includes(recent.id), "Recent record should be present");
  });
});

// ---------------------------------------------------------------------------
// detectFeedbackSignal
// ---------------------------------------------------------------------------
describe("detectFeedbackSignal", () => {
  it("ok after tracked → satisfied", () => {
    const result = detectFeedbackSignal("ok", "tracked");
    assert.equal(result.type, "satisfied");
  });

  it("好 after tracked → satisfied", () => {
    const result = detectFeedbackSignal("好", "tracked");
    assert.equal(result.type, "satisfied");
  });

  it("应该派agent after light → corrected_up, actualTier=delegation", () => {
    const result = detectFeedbackSignal("你应该派agent来做这个", "light");
    assert.equal(result.type, "corrected_up");
    assert.equal(result.actualTier, "delegation");
  });

  it("不用这么复杂 after delegation → corrected_down, actualTier=light", () => {
    const result = detectFeedbackSignal("不用这么复杂，直接做就好", "delegation");
    assert.equal(result.type, "corrected_down");
    assert.equal(result.actualTier, "light");
  });

  it("帮我做另一个任务 → continued", () => {
    const result = detectFeedbackSignal("帮我做另一个任务", "tracked");
    assert.equal(result.type, "continued");
    assert.equal(result.actualTier, undefined);
  });

  it("too simple triggers corrected_up", () => {
    const result = detectFeedbackSignal("that was too simple for this", "light");
    assert.equal(result.type, "corrected_up");
    assert.equal(result.actualTier, "delegation");
  });

  it("too complex triggers corrected_down", () => {
    const result = detectFeedbackSignal("too complex, just do it directly", "delegation");
    assert.equal(result.type, "corrected_down");
    assert.equal(result.actualTier, "light");
  });

  it("great after delegation → satisfied", () => {
    const result = detectFeedbackSignal("great", "delegation");
    assert.equal(result.type, "satisfied");
  });

  it("no need for agent → corrected_down", () => {
    const result = detectFeedbackSignal("no need for any agent here", "delegation");
    assert.equal(result.type, "corrected_down");
    assert.equal(result.actualTier, "light");
  });
});

// ---------------------------------------------------------------------------
// computeStats
// ---------------------------------------------------------------------------
describe("computeStats", () => {
  it("correct tier distribution", () => {
    const now = new Date().toISOString();
    const records: ObservationRecord[] = [
      { ...makeBase("1", now), predictedTier: "light" },
      { ...makeBase("2", now), predictedTier: "tracked" },
      { ...makeBase("3", now), predictedTier: "tracked" },
      { ...makeBase("4", now), predictedTier: "delegation" },
    ];
    const stats = computeStats(records);
    assert.equal(stats.totalObservations, 4);
    assert.equal(stats.tierDistribution.light, 1);
    assert.equal(stats.tierDistribution.tracked, 2);
    assert.equal(stats.tierDistribution.delegation, 1);
  });

  it("correct accuracy calculation", () => {
    const now = new Date().toISOString();
    // 2 satisfied + 2 corrected → accuracy = 2/4 = 0.5
    const records: ObservationRecord[] = [
      { ...makeBase("1", now), predictedTier: "tracked", userFollowUp: "satisfied" },
      { ...makeBase("2", now), predictedTier: "tracked", userFollowUp: "satisfied" },
      { ...makeBase("3", now), predictedTier: "light", userFollowUp: "corrected_up", actualTier: "delegation" },
      { ...makeBase("4", now), predictedTier: "delegation", userFollowUp: "corrected_down", actualTier: "light" },
    ];
    const stats = computeStats(records);
    assert.equal(stats.accuracy, 0.5);
  });

  it("correctionRate is proportion of corrected messages", () => {
    const now = new Date().toISOString();
    const records: ObservationRecord[] = [
      { ...makeBase("1", now), predictedTier: "tracked", userFollowUp: "satisfied" },
      { ...makeBase("2", now), predictedTier: "light", userFollowUp: "corrected_up", actualTier: "delegation" },
      { ...makeBase("3", now), predictedTier: "tracked", userFollowUp: "continued" },
      { ...makeBase("4", now), predictedTier: "tracked", userFollowUp: null },
    ];
    const stats = computeStats(records);
    // 1 correction out of 4 total
    assert.equal(stats.correctionRate, 0.25);
  });

  it("last24h and last7d counts are correct", () => {
    const now = new Date().toISOString();
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const records: ObservationRecord[] = [
      { ...makeBase("1", now), predictedTier: "tracked" },
      { ...makeBase("2", twoDaysAgo), predictedTier: "tracked" },
      { ...makeBase("3", tenDaysAgo), predictedTier: "light" },
    ];
    const stats = computeStats(records);
    assert.equal(stats.last24h, 1);
    assert.equal(stats.last7d, 2);
  });

  it("returns 0 accuracy and 0 correctionRate for empty observations", () => {
    const stats = computeStats([]);
    assert.equal(stats.totalObservations, 0);
    assert.equal(stats.accuracy, 0);
    assert.equal(stats.correctionRate, 0);
  });

  it("topMispredictions lists corrected predictions", () => {
    const now = new Date().toISOString();
    const records: ObservationRecord[] = [
      {
        ...makeBase("1", now),
        messageText: "do something simple",
        predictedTier: "delegation",
        userFollowUp: "corrected_down",
        actualTier: "light",
      },
    ];
    const stats = computeStats(records);
    assert.equal(stats.topMispredictions.length, 1);
    assert.equal(stats.topMispredictions[0].predicted, "delegation");
    assert.equal(stats.topMispredictions[0].actual, "light");
  });
});

// ---------------------------------------------------------------------------
// pruneObservations
// ---------------------------------------------------------------------------
describe("pruneObservations", () => {
  it("removes old records and returns count", () => {
    const dir = makeTmpDir();
    // Write 1 old and 1 recent record
    const old: ObservationRecord = {
      ...makeBase("old-1", new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString()),
      predictedTier: "light",
    };
    const recent = createObservation({ message: "recent", agent: "a", predictedTier: "tracked" });
    appendObservation(dir, old);
    appendObservation(dir, recent);

    const pruned = pruneObservations(dir, 30);
    assert.equal(pruned, 1);

    // The file should only contain the recent record
    const remaining = loadRecentObservations(dir, 24 * 365);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].id, recent.id);
  });

  it("returns 0 when no old records", () => {
    const dir = makeTmpDir();
    const recent = createObservation({ message: "hello", agent: "a", predictedTier: "light" });
    appendObservation(dir, recent);
    const pruned = pruneObservations(dir, 30);
    assert.equal(pruned, 0);
  });

  it("returns 0 when file does not exist", () => {
    const pruned = pruneObservations("/tmp/nonexistent-obs-dir-xyz", 30);
    assert.equal(pruned, 0);
  });
});

// ---------------------------------------------------------------------------
// updateObservationOutcome
// ---------------------------------------------------------------------------
describe("updateObservationOutcome", () => {
  it("updates tool calls in buffer", () => {
    const dir = makeTmpDir();
    const obs = createObservation({ message: "deploy", agent: "main", predictedTier: "tracked" });
    appendObservation(dir, obs);

    updateObservationOutcome(dir, obs.id, {
      toolsCalled: ["sessions_spawn"],
      didSpawnSubagent: true,
      spawnCount: 1,
    });

    const buffered = getBufferedObservation(obs.id);
    assert.ok(buffered, "Record should be in buffer");
    assert.ok(buffered?.toolsCalled.includes("sessions_spawn"));
    assert.equal(buffered?.didSpawnSubagent, true);
    assert.equal(buffered?.spawnCount, 1);
  });

  it("accumulates multiple tool call updates", () => {
    const dir = makeTmpDir();
    const obs = createObservation({ message: "audit and review", agent: "main", predictedTier: "tracked" });
    appendObservation(dir, obs);

    updateObservationOutcome(dir, obs.id, { toolsCalled: ["tool_a"] });
    updateObservationOutcome(dir, obs.id, { toolsCalled: ["tool_b"] });

    const buffered = getBufferedObservation(obs.id);
    assert.ok(buffered?.toolsCalled.includes("tool_a"));
    assert.ok(buffered?.toolsCalled.includes("tool_b"));
  });

  it("does nothing for unknown observation id", () => {
    const dir = makeTmpDir();
    // Should not throw
    assert.doesNotThrow(() => {
      updateObservationOutcome(dir, "obs-nonexistent-9999", { toolsCalled: ["x"] });
    });
  });
});

// ---------------------------------------------------------------------------
// flushBuffer
// ---------------------------------------------------------------------------
describe("flushBuffer", () => {
  it("writes buffered record updates to disk", () => {
    const dir = makeTmpDir();
    const obs = createObservation({ message: "test flush", agent: "main", predictedTier: "tracked" });
    appendObservation(dir, obs);

    // Mark as dirty via outcome update
    updateObservationOutcome(dir, obs.id, {
      toolsCalled: ["some_tool"],
      didSpawnSubagent: false,
    });

    flushBuffer(dir);

    // Read raw file and verify updated record is there
    const filePath = join(dir, "observation-log.jsonl");
    const raw = readFileSync(filePath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim());
    const found = lines
      .map((l) => {
        try { return JSON.parse(l) as ObservationRecord; } catch { return null; }
      })
      .find((r) => r?.id === obs.id);

    assert.ok(found, "Flushed record should appear in file");
    assert.ok(found?.toolsCalled.includes("some_tool"), "Tool call should have been persisted");
  });
});

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------
function makeBase(id: string, timestamp: string): ObservationRecord {
  return {
    id,
    timestamp,
    agent: "main",
    messageText: "test message",
    messageLength: 12,
    language: "en",
    hasNumberedList: false,
    actionVerbCount: 0,
    predictedTier: "tracked",
    toolsCalled: [],
    didSpawnSubagent: false,
    spawnCount: 0,
    userFollowUp: null,
    actualTier: null,
  };
}
