import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  createSpawnTracker,
  recordSpawn,
  recordCompletion,
  recordPolicyCheck,
  getVerifiedState,
  shouldBlockTool,
  resetTracker,
  ALWAYS_ALLOWED_TOOLS,
} from "../src/spawn-tracker.ts";
import type { SpawnTracker } from "../src/spawn-tracker.ts";

describe("createSpawnTracker", () => {
  it("returns empty tracker with default values", () => {
    const tracker = createSpawnTracker();
    assert.equal(tracker.totalSpawned, 0);
    assert.equal(tracker.totalCompleted, 0);
    assert.equal(tracker.policyCheckCount, 0);
    assert.equal(tracker.lastPolicyCheck, undefined);
    assert.equal(tracker.spawns.size, 0);
  });
});

describe("recordSpawn", () => {
  let tracker: SpawnTracker;

  beforeEach(() => {
    tracker = createSpawnTracker();
  });

  it("adds entry to spawns Map", () => {
    recordSpawn(tracker, { sessionKey: "key-1" });
    assert.equal(tracker.spawns.size, 1);
    assert.ok(tracker.spawns.has("key-1"));
  });

  it("increments totalSpawned", () => {
    recordSpawn(tracker, { sessionKey: "key-1" });
    assert.equal(tracker.totalSpawned, 1);
    recordSpawn(tracker, { sessionKey: "key-2" });
    assert.equal(tracker.totalSpawned, 2);
  });

  it("records timestamp in ISO8601 format", () => {
    recordSpawn(tracker, { sessionKey: "key-1" });
    const record = tracker.spawns.get("key-1");
    assert.ok(record);
    // Validate ISO8601 format: should parse without NaN
    assert.ok(!Number.isNaN(Date.parse(record.spawnedAt)));
  });

  it("stores agentId, label, and task if provided", () => {
    recordSpawn(tracker, {
      sessionKey: "key-1",
      agentId: "agent-42",
      label: "worker-a",
      task: "do something",
    });
    const record = tracker.spawns.get("key-1");
    assert.equal(record?.agentId, "agent-42");
    assert.equal(record?.label, "worker-a");
    assert.equal(record?.task, "do something");
  });
});

describe("recordCompletion", () => {
  let tracker: SpawnTracker;

  beforeEach(() => {
    tracker = createSpawnTracker();
    recordSpawn(tracker, { sessionKey: "key-1" });
  });

  it("updates spawn record with outcome", () => {
    recordCompletion(tracker, { sessionKey: "key-1", outcome: "ok" });
    const record = tracker.spawns.get("key-1");
    assert.equal(record?.outcome, "ok");
  });

  it("sets completedAt on the spawn record", () => {
    recordCompletion(tracker, { sessionKey: "key-1", outcome: "ok" });
    const record = tracker.spawns.get("key-1");
    assert.ok(record?.completedAt);
    assert.ok(!Number.isNaN(Date.parse(record.completedAt)));
  });

  it("increments totalCompleted", () => {
    recordCompletion(tracker, { sessionKey: "key-1", outcome: "ok" });
    assert.equal(tracker.totalCompleted, 1);
  });
});

describe("recordPolicyCheck", () => {
  it("increments policyCheckCount", () => {
    const tracker = createSpawnTracker();
    assert.equal(tracker.policyCheckCount, 0);
    recordPolicyCheck(tracker);
    assert.equal(tracker.policyCheckCount, 1);
    recordPolicyCheck(tracker);
    assert.equal(tracker.policyCheckCount, 2);
  });

  it("sets lastPolicyCheck to ISO8601 timestamp", () => {
    const tracker = createSpawnTracker();
    recordPolicyCheck(tracker);
    assert.ok(tracker.lastPolicyCheck);
    assert.ok(!Number.isNaN(Date.parse(tracker.lastPolicyCheck)));
  });
});

describe("getVerifiedState", () => {
  it("no spawns → hasWorkerStart false", () => {
    const tracker = createSpawnTracker();
    const state = getVerifiedState(tracker);
    assert.equal(state.hasWorkerStart, false);
  });

  it("one spawn → hasWorkerStart true", () => {
    const tracker = createSpawnTracker();
    recordSpawn(tracker, { sessionKey: "key-1" });
    const state = getVerifiedState(tracker);
    assert.equal(state.hasWorkerStart, true);
  });

  it("active spawn (not completed) → hasTrackedExecution true", () => {
    const tracker = createSpawnTracker();
    recordSpawn(tracker, { sessionKey: "key-1" });
    const state = getVerifiedState(tracker);
    assert.equal(state.hasTrackedExecution, true);
  });

  it("completed spawn → hasCompletedStep true when outcome is ok", () => {
    const tracker = createSpawnTracker();
    recordSpawn(tracker, { sessionKey: "key-1" });
    recordCompletion(tracker, { sessionKey: "key-1", outcome: "ok" });
    const state = getVerifiedState(tracker);
    assert.equal(state.hasCompletedStep, true);
  });

  it("error-completed spawn → hasCompletedStep false", () => {
    const tracker = createSpawnTracker();
    recordSpawn(tracker, { sessionKey: "key-1" });
    recordCompletion(tracker, { sessionKey: "key-1", outcome: "error" });
    const state = getVerifiedState(tracker);
    assert.equal(state.hasCompletedStep, false);
  });

  it("all spawns completed → hasFinalMerge true", () => {
    const tracker = createSpawnTracker();
    recordSpawn(tracker, { sessionKey: "key-1" });
    recordSpawn(tracker, { sessionKey: "key-2" });
    recordCompletion(tracker, { sessionKey: "key-1", outcome: "ok" });
    recordCompletion(tracker, { sessionKey: "key-2", outcome: "ok" });
    const state = getVerifiedState(tracker);
    assert.equal(state.hasFinalMerge, true);
  });

  it("no spawns → hasFinalMerge false", () => {
    const tracker = createSpawnTracker();
    const state = getVerifiedState(tracker);
    assert.equal(state.hasFinalMerge, false);
  });

  it("mixed active/completed → correct counts", () => {
    const tracker = createSpawnTracker();
    recordSpawn(tracker, { sessionKey: "key-1" });
    recordSpawn(tracker, { sessionKey: "key-2" });
    recordSpawn(tracker, { sessionKey: "key-3" });
    recordCompletion(tracker, { sessionKey: "key-1", outcome: "ok" });
    const state = getVerifiedState(tracker);
    assert.equal(state.totalSpawns, 3);
    assert.equal(state.activeSpawns, 2);
    assert.equal(state.completedSpawns, 1);
    assert.equal(state.hasTrackedExecution, true);
    assert.equal(state.hasFinalMerge, false);
  });
});

describe("shouldBlockTool", () => {
  let tracker: SpawnTracker;

  beforeEach(() => {
    tracker = createSpawnTracker();
  });

  it('"free" mode → never blocks', () => {
    const result = shouldBlockTool(tracker, "web_search", "free", "required");
    assert.equal(result, null);
  });

  it('"guided" mode → never blocks', () => {
    const result = shouldBlockTool(tracker, "read_file", "guided", "required");
    assert.equal(result, null);
  });

  it('"delegation-first" + "required" + no spawns → blocks non-orchestration tools', () => {
    const result = shouldBlockTool(tracker, "web_search", "delegation-first", "required");
    assert.ok(typeof result === "string");
    assert.ok(result.length > 0);
  });

  it('"delegation-first" + "required" + has spawn → allows everything', () => {
    recordSpawn(tracker, { sessionKey: "key-1" });
    const result = shouldBlockTool(tracker, "web_search", "delegation-first", "required");
    assert.equal(result, null);
  });

  it('"delegation-first" + "advisory" → never blocks', () => {
    const result = shouldBlockTool(tracker, "web_search", "delegation-first", "advisory");
    assert.equal(result, null);
  });

  it('"strict-orchestrated" + "required" + no spawns → blocks', () => {
    const result = shouldBlockTool(tracker, "read_file", "strict-orchestrated", "required");
    assert.ok(typeof result === "string");
  });

  it('"strict-orchestrated" + "off" → never blocks', () => {
    const result = shouldBlockTool(tracker, "web_search", "strict-orchestrated", "off");
    assert.equal(result, null);
  });

  it('always allows "multi-agent-orchestrator" tool', () => {
    const result = shouldBlockTool(tracker, "multi-agent-orchestrator", "delegation-first", "required");
    assert.equal(result, null);
  });

  it('always allows "sessions_spawn" tool', () => {
    const result = shouldBlockTool(tracker, "sessions_spawn", "delegation-first", "required");
    assert.equal(result, null);
  });

  it('always allows "sessions_yield" tool', () => {
    const result = shouldBlockTool(tracker, "sessions_yield", "delegation-first", "required");
    assert.equal(result, null);
  });

  it('blocks "web_search" when no spawn in delegation-first + required', () => {
    const result = shouldBlockTool(tracker, "web_search", "delegation-first", "required");
    assert.ok(result !== null);
    assert.ok(result.includes("web_search"));
  });

  it('blocks "read_file" when no spawn in delegation-first + required', () => {
    const result = shouldBlockTool(tracker, "read_file", "delegation-first", "required");
    assert.ok(result !== null);
    assert.ok(result.includes("read_file"));
  });
});

describe("resetTracker", () => {
  it("clears all state", () => {
    const tracker = createSpawnTracker();
    recordSpawn(tracker, { sessionKey: "key-1" });
    recordCompletion(tracker, { sessionKey: "key-1", outcome: "ok" });
    recordPolicyCheck(tracker);

    resetTracker(tracker);

    assert.equal(tracker.spawns.size, 0);
    assert.equal(tracker.totalSpawned, 0);
    assert.equal(tracker.totalCompleted, 0);
    assert.equal(tracker.policyCheckCount, 0);
    assert.equal(tracker.lastPolicyCheck, undefined);
  });
});

describe("ALWAYS_ALLOWED_TOOLS", () => {
  it("contains expected orchestration tools", () => {
    assert.ok(ALWAYS_ALLOWED_TOOLS.has("multi-agent-orchestrator"));
    assert.ok(ALWAYS_ALLOWED_TOOLS.has("sessions_spawn"));
    assert.ok(ALWAYS_ALLOWED_TOOLS.has("sessions_yield"));
    assert.ok(ALWAYS_ALLOWED_TOOLS.has("subagents"));
    assert.ok(ALWAYS_ALLOWED_TOOLS.has("todowrite"));
    assert.ok(ALWAYS_ALLOWED_TOOLS.has("todoupdate"));
  });
});
