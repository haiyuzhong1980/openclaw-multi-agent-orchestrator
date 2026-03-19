import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createEmptyBoard,
  createProject,
  addTask,
  updateTaskStatus,
  advanceProjectStatus,
  advanceStage,
  getStageAgentTypes,
  isStageComplete,
  formatSprintBoard,
} from "../src/task-board.ts";
import type { SprintStage } from "../src/task-board.ts";

// ── advanceStage ───────────────────────────────────────────────────────────

describe("advanceStage", () => {
  it("advances from plan to build", () => {
    const board = createEmptyBoard();
    const project = createProject(board, { name: "T", request: "r" });
    assert.equal(project.currentStage, "plan");
    const next = advanceStage(project);
    assert.equal(next, "build");
    assert.equal(project.currentStage, "build");
  });

  it("advances through all stages in order", () => {
    const board = createEmptyBoard();
    const project = createProject(board, { name: "T", request: "r" });
    const expected: SprintStage[] = ["build", "review", "test", "ship"];
    for (const stage of expected) {
      const next = advanceStage(project);
      assert.equal(next, stage);
    }
    assert.equal(project.currentStage, "ship");
  });

  it("returns null when already at ship (last stage)", () => {
    const board = createEmptyBoard();
    const project = createProject(board, { name: "T", request: "r" });
    project.currentStage = "ship";
    const next = advanceStage(project);
    assert.equal(next, null);
    assert.equal(project.currentStage, "ship");
  });

  it("records new stage in stageHistory", () => {
    const board = createEmptyBoard();
    const project = createProject(board, { name: "T", request: "r" });
    advanceStage(project);
    const historyEntry = project.stageHistory.find((h) => h.stage === "build");
    assert.ok(historyEntry !== undefined);
    assert.ok(typeof historyEntry.enteredAt === "string");
  });

  it("closes out the current stage entry in history when advancing", () => {
    const board = createEmptyBoard();
    const project = createProject(board, { name: "T", request: "r" });
    // Seed an open entry for 'plan' stage
    project.stageHistory.push({ stage: "plan", enteredAt: new Date().toISOString(), taskIds: [] });
    advanceStage(project);
    const planEntry = project.stageHistory.find((h) => h.stage === "plan");
    assert.ok(planEntry?.completedAt !== undefined);
  });

  it("treats missing currentStage as plan (backward compat)", () => {
    const board = createEmptyBoard();
    const project = createProject(board, { name: "T", request: "r" });
    // @ts-ignore – simulate legacy project without currentStage
    delete project.currentStage;
    const next = advanceStage(project);
    assert.equal(next, "build");
  });
});

// ── getStageAgentTypes ────────────────────────────────────────────────────

describe("getStageAgentTypes", () => {
  it("plan stage returns planner, architect, analyst", () => {
    const types = getStageAgentTypes("plan");
    assert.deepEqual(types, ["planner", "architect", "analyst"]);
  });

  it("build stage returns executor, coder", () => {
    const types = getStageAgentTypes("build");
    assert.deepEqual(types, ["executor", "coder"]);
  });

  it("review stage returns code-reviewer, security-reviewer", () => {
    const types = getStageAgentTypes("review");
    assert.deepEqual(types, ["code-reviewer", "security-reviewer"]);
  });

  it("test stage returns tdd-guide, test-engineer, qa-tester", () => {
    const types = getStageAgentTypes("test");
    assert.deepEqual(types, ["tdd-guide", "test-engineer", "qa-tester"]);
  });

  it("ship stage returns git-master, doc-updater", () => {
    const types = getStageAgentTypes("ship");
    assert.deepEqual(types, ["git-master", "doc-updater"]);
  });

  it("returns an array (not empty) for every valid stage", () => {
    const stages: SprintStage[] = ["plan", "build", "review", "test", "ship"];
    for (const stage of stages) {
      const types = getStageAgentTypes(stage);
      assert.ok(Array.isArray(types));
      assert.ok(types.length > 0, `Expected agents for stage: ${stage}`);
    }
  });
});

// ── isStageComplete ───────────────────────────────────────────────────────

describe("isStageComplete", () => {
  it("returns false when there are no tasks in the current stage", () => {
    const board = createEmptyBoard();
    const project = createProject(board, { name: "T", request: "r" });
    assert.equal(isStageComplete(project), false);
  });

  it("returns false when stage tasks are still pending", () => {
    const board = createEmptyBoard();
    const project = createProject(board, { name: "T", request: "r" });
    const task = addTask(project, { trackId: "t", label: "L" });
    task.stage = "plan";
    assert.equal(isStageComplete(project), false);
  });

  it("returns true when all stage tasks are completed", () => {
    const board = createEmptyBoard();
    const project = createProject(board, { name: "T", request: "r" });
    const t1 = addTask(project, { trackId: "a", label: "A" });
    const t2 = addTask(project, { trackId: "b", label: "B" });
    t1.stage = "plan";
    t2.stage = "plan";
    updateTaskStatus(t1, "completed");
    updateTaskStatus(t2, "completed");
    assert.equal(isStageComplete(project), true);
  });

  it("returns true when all stage tasks are approved", () => {
    const board = createEmptyBoard();
    const project = createProject(board, { name: "T", request: "r" });
    const task = addTask(project, { trackId: "t", label: "L" });
    task.stage = "plan";
    updateTaskStatus(task, "approved");
    assert.equal(isStageComplete(project), true);
  });

  it("returns true when all stage tasks are failed", () => {
    const board = createEmptyBoard();
    const project = createProject(board, { name: "T", request: "r" });
    const task = addTask(project, { trackId: "t", label: "L" });
    task.stage = "plan";
    updateTaskStatus(task, "failed");
    assert.equal(isStageComplete(project), true);
  });

  it("returns false when at least one stage task is still pending", () => {
    const board = createEmptyBoard();
    const project = createProject(board, { name: "T", request: "r" });
    const t1 = addTask(project, { trackId: "a", label: "A" });
    const t2 = addTask(project, { trackId: "b", label: "B" });
    t1.stage = "plan";
    t2.stage = "plan";
    updateTaskStatus(t1, "completed");
    // t2 remains pending
    assert.equal(isStageComplete(project), false);
  });

  it("ignores tasks from other stages when checking completion", () => {
    const board = createEmptyBoard();
    const project = createProject(board, { name: "T", request: "r" });
    const t1 = addTask(project, { trackId: "a", label: "A" });
    const t2 = addTask(project, { trackId: "b", label: "B" });
    t1.stage = "plan";
    t2.stage = "build"; // different stage, still pending
    updateTaskStatus(t1, "completed");
    // currentStage is "plan", t2 is in build — should not affect plan completion
    assert.equal(isStageComplete(project), true);
  });

  it("uses plan as default stage for backward compat", () => {
    const board = createEmptyBoard();
    const project = createProject(board, { name: "T", request: "r" });
    // @ts-ignore
    delete project.currentStage;
    const task = addTask(project, { trackId: "t", label: "L" });
    task.stage = "plan";
    updateTaskStatus(task, "completed");
    assert.equal(isStageComplete(project), true);
  });
});

// ── formatSprintBoard ─────────────────────────────────────────────────────

describe("formatSprintBoard", () => {
  it("contains project name", () => {
    const board = createEmptyBoard();
    const project = createProject(board, { name: "My Sprint", request: "r" });
    const output = formatSprintBoard(project);
    assert.ok(output.includes("My Sprint"));
  });

  it("shows the current stage", () => {
    const board = createEmptyBoard();
    const project = createProject(board, { name: "T", request: "r" });
    project.currentStage = "build";
    const output = formatSprintBoard(project);
    assert.ok(output.includes("[build]") || output.includes("Build"));
  });

  it("marks current stage with [>]", () => {
    const board = createEmptyBoard();
    const project = createProject(board, { name: "T", request: "r" });
    project.currentStage = "plan";
    const output = formatSprintBoard(project);
    assert.ok(output.includes("[>]"));
  });

  it("marks completed stage with [x]", () => {
    const board = createEmptyBoard();
    const project = createProject(board, { name: "T", request: "r" });
    project.stageHistory.push({
      stage: "plan",
      enteredAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      taskIds: [],
    });
    project.currentStage = "build";
    const output = formatSprintBoard(project);
    assert.ok(output.includes("[x]"));
  });

  it("marks future stages with [ ]", () => {
    const board = createEmptyBoard();
    const project = createProject(board, { name: "T", request: "r" });
    project.currentStage = "plan";
    const output = formatSprintBoard(project);
    // Multiple future stages should show as unchecked
    const uncheckedCount = (output.match(/\[ \]/g) ?? []).length;
    assert.ok(uncheckedCount >= 4, `Expected at least 4 unchecked stages, got ${uncheckedCount}`);
  });

  it("shows all five stages in the board", () => {
    const board = createEmptyBoard();
    const project = createProject(board, { name: "T", request: "r" });
    const output = formatSprintBoard(project);
    for (const label of ["Plan", "Build", "Review", "Test", "Ship"]) {
      assert.ok(output.includes(label), `Missing stage label: ${label}`);
    }
  });

  it("shows stage tasks when they exist", () => {
    const board = createEmptyBoard();
    const project = createProject(board, { name: "T", request: "r" });
    const task = addTask(project, { trackId: "t", label: "Architecture Design" });
    task.stage = "plan";
    const output = formatSprintBoard(project);
    assert.ok(output.includes("Architecture Design"));
  });

  it("shows no-tasks message when current stage has no tasks", () => {
    const board = createEmptyBoard();
    const project = createProject(board, { name: "T", request: "r" });
    const output = formatSprintBoard(project);
    assert.ok(output.includes("No tasks assigned to"));
  });

  it("does not show tasks from other stages", () => {
    const board = createEmptyBoard();
    const project = createProject(board, { name: "T", request: "r" });
    const task = addTask(project, { trackId: "t", label: "Build Step" });
    task.stage = "build";
    project.currentStage = "plan";
    const output = formatSprintBoard(project);
    assert.ok(!output.includes("Build Step"));
  });
});

// ── advanceProjectStatus with stage integration ────────────────────────────

describe("advanceProjectStatus with sprint stage", () => {
  it("advances stage when all stage tasks approved and next stage exists", () => {
    const board = createEmptyBoard();
    const project = createProject(board, { name: "T", request: "r" });
    const t1 = addTask(project, { trackId: "a", label: "A" });
    const t2 = addTask(project, { trackId: "b", label: "B" });
    // Assign tasks to the current stage so stage completion logic fires
    t1.stage = "plan";
    t2.stage = "plan";
    updateTaskStatus(t1, "approved");
    updateTaskStatus(t2, "approved");
    advanceProjectStatus(project);
    // Should have moved to 'build', not 'done'
    assert.equal(project.currentStage, "build");
    assert.notEqual(project.status, "done");
  });

  it("marks project done when all stage tasks approved and at ship (last) stage", () => {
    const board = createEmptyBoard();
    const project = createProject(board, { name: "T", request: "r" });
    project.currentStage = "ship";
    const t1 = addTask(project, { trackId: "a", label: "A" });
    t1.stage = "ship";
    updateTaskStatus(t1, "approved");
    advanceProjectStatus(project);
    assert.equal(project.status, "done");
    assert.equal(project.currentStage, "ship");
  });
});

// ── createProject initializes sprint fields ────────────────────────────────

describe("createProject sprint fields", () => {
  it("initializes currentStage to plan", () => {
    const board = createEmptyBoard();
    const project = createProject(board, { name: "T", request: "r" });
    assert.equal(project.currentStage, "plan");
  });

  it("initializes stageHistory as empty array", () => {
    const board = createEmptyBoard();
    const project = createProject(board, { name: "T", request: "r" });
    assert.deepEqual(project.stageHistory, []);
  });
});

// ── Task stage field ───────────────────────────────────────────────────────

describe("Task stage field", () => {
  it("stage is undefined by default", () => {
    const board = createEmptyBoard();
    const project = createProject(board, { name: "T", request: "r" });
    const task = addTask(project, { trackId: "t", label: "L" });
    assert.equal(task.stage, undefined);
  });

  it("stage can be set on a task", () => {
    const board = createEmptyBoard();
    const project = createProject(board, { name: "T", request: "r" });
    const task = addTask(project, { trackId: "t", label: "L" });
    task.stage = "build";
    assert.equal(task.stage, "build");
  });
});
