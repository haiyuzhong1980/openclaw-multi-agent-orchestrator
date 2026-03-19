import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";

export type ProjectStatus = "pending" | "planning" | "dispatching" | "running" | "reviewing" | "done" | "failed";
export type TaskStatus = "pending" | "dispatched" | "running" | "completed" | "failed" | "approved" | "rejected";
export type SprintStage = "plan" | "build" | "review" | "test" | "ship";

export interface Task {
  id: string;
  trackId: string;
  label: string;
  agentType?: string;
  contentType?: string;
  status: TaskStatus;
  sessionKey?: string;
  subagentPrompt?: string;
  dispatchedAt?: string;
  completedAt?: string;
  resultText?: string;
  resultSummary?: string;
  reviewStatus?: "pending" | "approved" | "rejected";
  reviewReason?: string;
  retryCount: number;
  maxRetry: number;
  failureReason?: string;
  stage?: SprintStage;
}

export interface Project {
  id: string;
  name: string;
  status: ProjectStatus;
  request: string;
  createdAt: string;
  updatedAt: string;
  tasks: Task[];
  currentStage: SprintStage;
  stageHistory: Array<{
    stage: SprintStage;
    enteredAt: string;
    completedAt?: string;
    taskIds: string[];
  }>;
}

export interface TaskBoard {
  projects: Project[];
  version: number;
}

const BOARD_FILE = "task-board.json";

export function createEmptyBoard(): TaskBoard {
  return { projects: [], version: 1 };
}

export function loadBoard(sharedRoot: string): TaskBoard {
  const filePath = join(sharedRoot, BOARD_FILE);
  if (!existsSync(filePath)) {
    return createEmptyBoard();
  }
  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as TaskBoard;
    return parsed;
  } catch {
    return createEmptyBoard();
  }
}

export function saveBoard(sharedRoot: string, board: TaskBoard): void {
  if (!existsSync(sharedRoot)) {
    mkdirSync(sharedRoot, { recursive: true });
  }
  const filePath = join(sharedRoot, BOARD_FILE);
  const tmpPath = filePath + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(board, null, 2), "utf-8");
  renameSync(tmpPath, filePath);
}

export function generateTaskId(): string {
  const hex = Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0");
  return `task-${hex}`;
}

export function generateProjectId(): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const hex = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, "0");
  return `proj-${date}-${hex}`;
}

export function createProject(
  board: TaskBoard,
  params: { name: string; request: string },
): Project {
  const now = new Date().toISOString();
  const project: Project = {
    id: generateProjectId(),
    name: params.name,
    status: "pending",
    request: params.request,
    createdAt: now,
    updatedAt: now,
    tasks: [],
    currentStage: "plan",
    stageHistory: [],
  };
  board.projects.push(project);
  return project;
}

export function addTask(
  project: Project,
  params: {
    trackId: string;
    label: string;
    agentType?: string;
    contentType?: string;
    subagentPrompt?: string;
    maxRetry?: number;
  },
): Task {
  const task: Task = {
    id: generateTaskId(),
    trackId: params.trackId,
    label: params.label,
    agentType: params.agentType,
    contentType: params.contentType,
    status: "pending",
    subagentPrompt: params.subagentPrompt,
    retryCount: 0,
    maxRetry: params.maxRetry ?? 2,
  };
  project.tasks.push(task);
  return task;
}

export function updateTaskStatus(
  task: Task,
  status: TaskStatus,
  extra?: {
    sessionKey?: string;
    resultText?: string;
    resultSummary?: string;
    failureReason?: string;
    reviewStatus?: "pending" | "approved" | "rejected";
    reviewReason?: string;
  },
): void {
  task.status = status;
  if (extra?.sessionKey !== undefined) task.sessionKey = extra.sessionKey;
  if (extra?.resultText !== undefined) task.resultText = extra.resultText;
  if (extra?.resultSummary !== undefined) task.resultSummary = extra.resultSummary;
  if (extra?.failureReason !== undefined) task.failureReason = extra.failureReason;
  if (extra?.reviewStatus !== undefined) task.reviewStatus = extra.reviewStatus;
  if (extra?.reviewReason !== undefined) task.reviewReason = extra.reviewReason;

  const now = new Date().toISOString();
  if (status === "dispatched") {
    task.dispatchedAt = now;
  }
  if (status === "completed" || status === "failed") {
    task.completedAt = now;
  }
}

const SPRINT_STAGE_ORDER: SprintStage[] = ["plan", "build", "review", "test", "ship"];

export function advanceProjectStatus(project: Project): void {
  const tasks = project.tasks;
  if (tasks.length === 0) {
    project.status = "pending";
    project.updatedAt = new Date().toISOString();
    return;
  }

  const allApproved = tasks.every((t) => t.status === "approved");
  if (allApproved) {
    // If tasks have stage assignments, check whether the current sprint stage is complete
    // and advance to the next stage. Only mark "done" when at the last stage (or no stage tags).
    const hasStageAssignments = tasks.some((t) => t.stage !== undefined);
    if (hasStageAssignments && isStageComplete(project)) {
      const nextStage = advanceStage(project);
      if (nextStage === null) {
        project.status = "done";
      }
    } else if (!hasStageAssignments) {
      project.status = "done";
    }
    project.updatedAt = new Date().toISOString();
    return;
  }

  const anyActive = tasks.some((t) => t.status === "dispatched" || t.status === "running");
  if (anyActive) {
    project.status = "running";
    project.updatedAt = new Date().toISOString();
    return;
  }

  const allDone = tasks.every(
    (t) => t.status === "completed" || t.status === "failed" || t.status === "approved" || t.status === "rejected",
  );
  if (allDone) {
    // Check if any task is rejected with no more retries
    const exhausted = tasks.some(
      (t) => (t.status === "failed" || t.status === "rejected") && t.retryCount >= t.maxRetry,
    );
    if (exhausted) {
      project.status = "failed";
    } else {
      project.status = "reviewing";
    }
    project.updatedAt = new Date().toISOString();
    return;
  }

  // Some tasks still pending
  const anyPending = tasks.some((t) => t.status === "pending");
  if (anyPending) {
    project.status = "pending";
    project.updatedAt = new Date().toISOString();
  }
}

export function getProject(board: TaskBoard, projectId: string): Project | undefined {
  return board.projects.find((p) => p.id === projectId);
}

export function getActiveProjects(board: TaskBoard): Project[] {
  return board.projects.filter(
    (p) => p.status !== "done" && p.status !== "failed",
  );
}

export function getProjectSummary(project: Project): {
  total: number;
  pending: number;
  dispatched: number;
  running: number;
  completed: number;
  failed: number;
  approved: number;
  rejected: number;
} {
  const tasks = project.tasks;
  return {
    total: tasks.length,
    pending: tasks.filter((t) => t.status === "pending").length,
    dispatched: tasks.filter((t) => t.status === "dispatched").length,
    running: tasks.filter((t) => t.status === "running").length,
    completed: tasks.filter((t) => t.status === "completed").length,
    failed: tasks.filter((t) => t.status === "failed").length,
    approved: tasks.filter((t) => t.status === "approved").length,
    rejected: tasks.filter((t) => t.status === "rejected").length,
  };
}

export function getRetryableTasks(project: Project): Task[] {
  return project.tasks.filter(
    (t) => t.status === "failed" && t.retryCount < t.maxRetry,
  );
}

export function getPendingTasks(project: Project): Task[] {
  return project.tasks.filter((t) => t.status === "pending");
}

const STAGE_AGENT_TYPES: Record<SprintStage, string[]> = {
  plan: ["planner", "architect", "analyst"],
  build: ["executor", "coder"],
  review: ["code-reviewer", "security-reviewer"],
  test: ["tdd-guide", "test-engineer", "qa-tester"],
  ship: ["git-master", "doc-updater"],
};

export function advanceStage(project: Project): SprintStage | null {
  const currentStage = project.currentStage ?? "plan";
  const currentIndex = SPRINT_STAGE_ORDER.indexOf(currentStage);
  const nextIndex = currentIndex + 1;

  if (nextIndex >= SPRINT_STAGE_ORDER.length) {
    return null;
  }

  const now = new Date().toISOString();
  const currentStageTasks = project.tasks
    .filter((t) => t.stage === currentStage)
    .map((t) => t.id);

  // Close out the current stage in history
  const existingEntry = project.stageHistory.find((h) => h.stage === currentStage && !h.completedAt);
  if (existingEntry) {
    existingEntry.completedAt = now;
  }

  const nextStage = SPRINT_STAGE_ORDER[nextIndex];
  project.stageHistory.push({
    stage: nextStage,
    enteredAt: now,
    taskIds: currentStageTasks,
  });
  project.currentStage = nextStage;
  project.updatedAt = now;
  return nextStage;
}

export function getStageAgentTypes(stage: SprintStage): string[] {
  return STAGE_AGENT_TYPES[stage];
}

export function isStageComplete(project: Project): boolean {
  const currentStage = project.currentStage ?? "plan";
  const stageTasks = project.tasks.filter((t) => t.stage === currentStage);
  if (stageTasks.length === 0) {
    return false;
  }
  return stageTasks.every(
    (t) => t.status === "completed" || t.status === "approved" || t.status === "failed",
  );
}

const STAGE_LABELS: Record<SprintStage, string> = {
  plan: "Plan",
  build: "Build",
  review: "Review",
  test: "Test",
  ship: "Ship",
};

export function formatSprintBoard(project: Project): string {
  const currentStage = project.currentStage ?? "plan";
  const lines: string[] = [];

  lines.push(`Sprint: ${project.name}`);
  lines.push(`Stage: ${STAGE_LABELS[currentStage]} [${currentStage}]`);
  lines.push("");

  for (const stage of SPRINT_STAGE_ORDER) {
    const isActive = stage === currentStage;
    const historyEntry = project.stageHistory.find((h) => h.stage === stage);
    const isDone = historyEntry?.completedAt !== undefined;
    const marker = isDone ? "[x]" : isActive ? "[>]" : "[ ]";
    lines.push(`  ${marker} ${STAGE_LABELS[stage]}`);
  }

  lines.push("");

  const stageTasks = project.tasks.filter((t) => t.stage === currentStage);
  if (stageTasks.length > 0) {
    lines.push(`Tasks in ${STAGE_LABELS[currentStage]}:`);
    for (const task of stageTasks) {
      const icon = STATUS_ICONS[task.status] ?? "⬜";
      lines.push(`  - ${task.label}   ${icon} ${task.status}`);
    }
  } else {
    lines.push(`No tasks assigned to ${STAGE_LABELS[currentStage]} stage.`);
  }

  return lines.join("\n");
}

const STATUS_ICONS: Record<TaskStatus, string> = {
  pending: "⬜",
  dispatched: "🔵",
  running: "🟡",
  completed: "✅",
  failed: "🔴",
  approved: "🟢",
  rejected: "❌",
};

export function formatBoardDisplay(board: TaskBoard): string {
  if (board.projects.length === 0) {
    return "No projects on the board.";
  }
  const lines: string[] = [];
  for (const project of board.projects) {
    lines.push(`📋 Project: ${project.name} (${project.status})`);
    lines.push(`   ID: ${project.id}`);
    const tasks = project.tasks;
    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      const isLast = i === tasks.length - 1;
      const connector = isLast ? "└─" : "├─";
      const icon = STATUS_ICONS[task.status] ?? "⬜";
      let line = `  ${connector} ${task.id}: ${task.label}   ${icon} ${task.status}`;
      if (task.status === "failed" && task.retryCount > 0) {
        line += ` (retry ${task.retryCount}/${task.maxRetry})`;
      }
      lines.push(line);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
