import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAuditLog } from "../src/audit-log.ts";
import { createSubagentHooks } from "../src/hooks/subagent-hooks.ts";
import { createSpawnTracker } from "../src/spawn-tracker.ts";
import { addTask, createEmptyBoard, createProject } from "../src/task-board.ts";
import type { PluginState } from "../src/plugin-state.ts";

describe("createSubagentHooks", () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "oma-subagent-hooks-"));
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("syncs accepted worker metadata into the canonical tracked task bus", async () => {
    const trackedTaskRoot = join(tempRoot, "tasks");
    const runsPath = join(tempRoot, "runs.json");
    const taskId = "TASK-20260323-demo-review";
    const taskDir = join(trackedTaskRoot, taskId);
    const statusPath = join(taskDir, "status.json");
    const eventsPath = join(taskDir, "events.jsonl");
    const now = new Date("2026-03-23T09:13:16.000+08:00");

    mkdirSync(taskDir, { recursive: true });
    writeFileSync(
      statusPath,
      `${JSON.stringify(
        {
          taskId,
          status: "running",
          currentStep: 1,
          totalSteps: 4,
          phaseOwner: "subagent",
          owner: "subagent",
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    writeFileSync(
      runsPath,
      `${JSON.stringify(
        {
          runs: {
            "run-1": {
              runId: "run-1",
              childSessionKey: "agent:builder:subagent:child",
              controllerSessionKey: "agent:builder:telegram:builder:direct:8732133578",
              requesterSessionKey: "agent:builder:telegram:builder:direct:8732133578",
              label: "research",
              task: `Write findings to /Users/henry/.openclaw/orchestrator/tasks/${taskId}/worker-dispatch.md`,
              workspaceDir: "/tmp/workspace-builder",
              createdAt: now.getTime(),
              startedAt: now.getTime(),
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );

    const board = createEmptyBoard();
    const project = createProject(board, { name: "Demo", request: "review current progress" });
    const task = addTask(project, { trackId: "research-track", label: "research" });
    const state = {
      board,
      spawnTracker: createSpawnTracker(),
      auditLog: createAuditLog(20),
      agentIdentity: null,
      currentDelegationSpawnCount: 0,
      scheduleBoardSave: () => {},
    } as unknown as PluginState;
    const api = {
      logger: {
        info: () => {},
        warn: () => {},
      },
    };

    const hooks = createSubagentHooks(state, api, "", {
      trackedTaskRoot,
      subagentRunsPath: runsPath,
      now: () => now,
    });

    await hooks.subagentSpawned({
      runId: "run-1",
      childSessionKey: "agent:builder:subagent:child",
      agentId: "builder",
      label: "research",
      mode: "run",
      threadRequested: false,
    });

    const updatedStatus = JSON.parse(readFileSync(statusPath, "utf-8")) as Record<string, unknown>;
    assert.equal(updatedStatus.task_id, taskId);
    assert.equal(updatedStatus.taskId, taskId);
    assert.equal(updatedStatus.run_id, "run-1");
    assert.equal(updatedStatus.runId, "run-1");
    assert.equal(updatedStatus.child_session_key, "agent:builder:subagent:child");
    assert.equal(updatedStatus.childSessionKey, "agent:builder:subagent:child");
    assert.equal(updatedStatus.phase_owner, "builder");
    assert.equal(updatedStatus.phaseOwner, "builder");
    assert.equal(updatedStatus.owner, "builder");
    assert.equal(updatedStatus.controller_session_key, "agent:builder:telegram:builder:direct:8732133578");
    assert.equal(updatedStatus.requester_session_key, "agent:builder:telegram:builder:direct:8732133578");
    assert.ok(Array.isArray(updatedStatus.workers));
    assert.equal((updatedStatus.workers as unknown[]).length, 1);
    assert.ok(existsSync(eventsPath));

    const eventLines = readFileSync(eventsPath, "utf-8").trim().split("\n");
    assert.equal(eventLines.length, 1);
    const event = JSON.parse(eventLines[0]) as Record<string, unknown>;
    assert.equal(event.event, "worker_spawn_accepted");
    assert.equal(event.run_id, "run-1");
    assert.equal(event.child_session_key, "agent:builder:subagent:child");
    assert.equal(task.status, "dispatched");
    assert.equal(task.sessionKey, "agent:builder:subagent:child");
    assert.equal(state.currentDelegationSpawnCount, 1);
  });

  it("preserves terminal worker states when a new worker spawn is merged", async () => {
    const trackedTaskRoot = join(tempRoot, "tasks");
    const runsPath = join(tempRoot, "runs.json");
    const taskId = "TASK-20260323-demo-preserve";
    const taskDir = join(trackedTaskRoot, taskId);
    const statusPath = join(taskDir, "status.json");
    const now = new Date("2026-03-23T10:00:00.000+08:00");

    mkdirSync(taskDir, { recursive: true });
    writeFileSync(
      statusPath,
      `${JSON.stringify(
        {
          taskId,
          status: "running",
          workers: [
            {
              id: "agent:ops:subagent:done",
              child_session_key: "agent:ops:subagent:done",
              status: "completed",
              run_id: "run-done",
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    writeFileSync(
      runsPath,
      `${JSON.stringify(
        {
          runs: {
            "run-new": {
              runId: "run-new",
              childSessionKey: "agent:builder:subagent:new",
              controllerSessionKey: "agent:builder:telegram:builder:direct:8732133578",
              requesterSessionKey: "agent:builder:telegram:builder:direct:8732133578",
              label: "new-worker",
              task: `Write findings to /Users/henry/.openclaw/orchestrator/tasks/${taskId}/worker-dispatch.md`,
              createdAt: now.getTime(),
              startedAt: now.getTime(),
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );

    const state = {
      board: createEmptyBoard(),
      spawnTracker: createSpawnTracker(),
      auditLog: createAuditLog(20),
      agentIdentity: null,
      currentDelegationSpawnCount: 0,
      scheduleBoardSave: () => {},
    } as unknown as PluginState;
    const api = {
      logger: {
        info: () => {},
        warn: () => {},
      },
    };

    const hooks = createSubagentHooks(state, api, "", {
      trackedTaskRoot,
      subagentRunsPath: runsPath,
      now: () => now,
    });

    await hooks.subagentSpawned({
      runId: "run-new",
      childSessionKey: "agent:builder:subagent:new",
      agentId: "builder",
      label: "new-worker",
    });

    const updatedStatus = JSON.parse(readFileSync(statusPath, "utf-8")) as Record<string, unknown>;
    const workers = updatedStatus.workers as Array<Record<string, unknown>>;
    assert.equal(workers.length, 2);
    assert.equal(workers[0].status, "completed");
    assert.equal(workers[1].status, "running");
  });

  it("does not append duplicate worker_spawn_accepted events for the same worker replay", async () => {
    const trackedTaskRoot = join(tempRoot, "tasks");
    const runsPath = join(tempRoot, "runs.json");
    const taskId = "TASK-20260323-demo-idempotent";
    const taskDir = join(trackedTaskRoot, taskId);
    const statusPath = join(taskDir, "status.json");
    const eventsPath = join(taskDir, "events.jsonl");
    const firstNow = new Date("2026-03-23T09:13:16.000+08:00");
    const secondNow = new Date("2026-03-23T09:15:16.000+08:00");

    mkdirSync(taskDir, { recursive: true });
    writeFileSync(
      statusPath,
      `${JSON.stringify({ taskId, status: "running" }, null, 2)}\n`,
      "utf-8",
    );
    writeFileSync(
      runsPath,
      `${JSON.stringify(
        {
          runs: {
            "run-1": {
              runId: "run-1",
              childSessionKey: "agent:builder:subagent:child",
              controllerSessionKey: "agent:builder:telegram:builder:direct:8732133578",
              requesterSessionKey: "agent:builder:telegram:builder:direct:8732133578",
              label: "research",
              task: `Write findings to /Users/henry/.openclaw/orchestrator/tasks/${taskId}/worker-dispatch.md`,
              createdAt: firstNow.getTime(),
              startedAt: firstNow.getTime(),
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );

    const board = createEmptyBoard();
    const project = createProject(board, { name: "Demo", request: "review current progress" });
    addTask(project, { trackId: "research-track", label: "research" });
    const state = {
      board,
      spawnTracker: createSpawnTracker(),
      auditLog: createAuditLog(20),
      agentIdentity: null,
      currentDelegationSpawnCount: 0,
      scheduleBoardSave: () => {},
    } as unknown as PluginState;
    const api = {
      logger: {
        info: () => {},
        warn: () => {},
      },
    };

    const firstHooks = createSubagentHooks(state, api, "", {
      trackedTaskRoot,
      subagentRunsPath: runsPath,
      now: () => firstNow,
    });
    await firstHooks.subagentSpawned({
      runId: "run-1",
      childSessionKey: "agent:builder:subagent:child",
      agentId: "builder",
      label: "research",
    });

    const firstStatus = JSON.parse(readFileSync(statusPath, "utf-8")) as Record<string, unknown>;
    assert.equal(firstStatus.updated_at, firstNow.toISOString());

    const secondHooks = createSubagentHooks(state, api, "", {
      trackedTaskRoot,
      subagentRunsPath: runsPath,
      now: () => secondNow,
    });
    await secondHooks.subagentSpawned({
      runId: "run-1",
      childSessionKey: "agent:builder:subagent:child",
      agentId: "builder",
      label: "research",
    });

    const finalStatus = JSON.parse(readFileSync(statusPath, "utf-8")) as Record<string, unknown>;
    const eventLines = readFileSync(eventsPath, "utf-8").trim().split("\n");
    assert.equal(finalStatus.updated_at, firstNow.toISOString());
    assert.equal(eventLines.length, 1);
  });
});
