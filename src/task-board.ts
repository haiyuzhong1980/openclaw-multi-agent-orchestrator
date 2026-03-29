import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { loggers, ErrorCode, createError } from "./errors.ts";

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
  // M5: Task dependency chain
  blockedBy: string[];  // Task IDs that must complete before this task can start
  blocks: string[];     // Task IDs that are blocked by this task
  // M5: Task locking
  lockedBy?: string;    // Agent ID that currently holds the lock
  lockedAt?: string;    // Timestamp when the lock was acquired
  // CAS (Compare-And-Swap) lock version for atomic lock acquisition
  // Incremented on each successful lock acquisition, used to detect concurrent modifications
  lockVersion?: number; // Lock version for CAS-based atomic operations
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
const BOARD_BACKUP_FILE = "task-board.json.bak";

export function createEmptyBoard(): TaskBoard {
  return { projects: [], version: 1 };
}

/**
 * Result of loadBoardWithRecovery operation.
 * Contains the loaded board, plus error info if recovery was needed.
 */
export interface LoadBoardResult {
  board: TaskBoard;
  error?: string;
  recovered?: boolean;
  backupPath?: string;
}

/**
 * Create a backup of the board file before a potentially destructive operation.
 * Returns the backup file path, or undefined if backup failed.
 */
function createBackup(sharedRoot: string): string | undefined {
  const filePath = join(sharedRoot, BOARD_FILE);
  const backupPath = join(sharedRoot, BOARD_BACKUP_FILE);
  
  if (!existsSync(filePath)) {
    return undefined;
  }
  
  try {
    // Copy to backup with timestamp suffix for uniqueness
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const timestampedBackup = `${backupPath}.${timestamp}`;
    const raw = readFileSync(filePath, "utf-8");
    writeFileSync(timestampedBackup, raw, "utf-8");
    return timestampedBackup;
  } catch (error) {
    // Backup failed - log but don't throw
    loggers.taskBoard.error(`Failed to create backup of ${filePath}`, error, { code: ErrorCode.BACKUP_FAILED });
    return undefined;
  }
}

/**
 * Load board with data protection and recovery support.
 * 
 * On parse failure:
 * 1. Backs up the corrupted file with timestamp
 * 2. Returns empty board with error info
 * 3. Sets recovered=true if a backup exists and was used
 * 
 * @param sharedRoot - Directory containing the board file
 * @returns LoadBoardResult with board and error info
 */
export function loadBoardWithRecovery(sharedRoot: string): LoadBoardResult {
  const filePath = join(sharedRoot, BOARD_FILE);
  const backupPath = join(sharedRoot, BOARD_BACKUP_FILE);
  
  if (!existsSync(filePath)) {
    return { board: createEmptyBoard() };
  }
  
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[task-board] Failed to read board file: ${errorMsg}`);
    return { 
      board: createEmptyBoard(), 
      error: `Failed to read board file: ${errorMsg}` 
    };
  }
  
  try {
    const parsed = JSON.parse(raw) as TaskBoard;
    // Migrate old board data that may lack sprint pipeline fields
    for (const project of parsed.projects) {
      if (!project.currentStage) project.currentStage = "plan";
      if (!project.stageHistory) project.stageHistory = [];
      // M5: Migrate tasks that lack dependency/lock fields
      for (const task of project.tasks) {
        if (!task.blockedBy) task.blockedBy = [];
        if (!task.blocks) task.blocks = [];
        // lockedBy and lockedAt are optional, no migration needed
        // lockVersion defaults to 0 when not present (backward compatible)
        if (task.lockVersion === undefined) task.lockVersion = 0;
      }
    }
    return { board: parsed };
  } catch (parseErr) {
    const errorMsg = parseErr instanceof Error ? parseErr.message : String(parseErr);
    console.error(`[task-board] JSON parse failed, creating backup: ${errorMsg}`);
    
    // Create backup of corrupted file
    const backupFilePath = createBackup(sharedRoot);
    
    // Try to load from the most recent backup
    if (existsSync(backupPath)) {
      try {
        const backupRaw = readFileSync(backupPath, "utf-8");
        const backupParsed = JSON.parse(backupRaw) as TaskBoard;
        console.warn(`[task-board] Recovered from backup: ${backupPath}`);
        return {
          board: backupParsed,
          error: `JSON parse failed: ${errorMsg}. Recovered from backup.`,
          recovered: true,
          backupPath: backupFilePath,
        };
      } catch (backupError) {
        // Backup also failed to parse
        loggers.taskBoard.error(`Backup file also corrupted`, backupError, { path: backupPath });
      }
    }
    
    return {
      board: createEmptyBoard(),
      error: `JSON parse failed: ${errorMsg}. No valid backup available.`,
      recovered: false,
      backupPath: backupFilePath,
    };
  }
}

/**
 * Load the task board from disk.
 * This is a convenience wrapper that returns just the board for backward compatibility.
 * For error handling and recovery info, use loadBoardWithRecovery() instead.
 */
export function loadBoard(sharedRoot: string): TaskBoard {
  const result = loadBoardWithRecovery(sharedRoot);
  return result.board;
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

/**
 * Result of saveBoardWithVersionCheck operation.
 */
export interface SaveBoardResult {
  success: boolean;
  conflict: boolean;
  currentVersion?: number;
  expectedVersion?: number;
}

/**
 * Save board with optimistic locking using version check.
 * This prevents data loss when multiple processes try to modify the board concurrently.
 *
 * Algorithm:
 * 1. Read the current board from disk
 * 2. If current version != expected version, return conflict
 * 3. Increment version and save atomically
 *
 * @param sharedRoot - The directory containing the board file
 * @param board - The modified board to save
 * @param expectedVersion - The version the board had when loaded
 * @returns SaveBoardResult indicating success or conflict
 */
export function saveBoardWithVersionCheck(
  sharedRoot: string,
  board: TaskBoard,
  expectedVersion: number,
): SaveBoardResult {
  // Read current board from disk
  const currentBoard = loadBoard(sharedRoot);

  // Check for version conflict
  if (currentBoard.version !== expectedVersion) {
    return {
      success: false,
      conflict: true,
      currentVersion: currentBoard.version,
      expectedVersion,
    };
  }

  // Increment version and save
  board.version = expectedVersion + 1;
  saveBoard(sharedRoot, board);

  return {
    success: true,
    conflict: false,
    currentVersion: board.version,
    expectedVersion,
  };
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
    blockedBy?: string[];
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
    blockedBy: params.blockedBy ?? [],
    blocks: [],
  };
  project.tasks.push(task);
  return task;
}

/**
 * Result of updateTaskStatus operation.
 */
export interface UpdateTaskStatusResult {
  success: boolean;
  error?: string;
  blocked?: boolean;
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
  board?: TaskBoard,
): UpdateTaskStatusResult {
  // M5-08: Check dependencies before dispatching
  if (status === "dispatched" && board) {
    if (isTaskBlocked(board, task)) {
      // Cannot dispatch a blocked task - return error
      const blockingTasks = task.blockedBy
        .map((id) => findTaskById(board, id))
        .filter((t) => t && t.status !== "completed" && t.status !== "approved");
      const blockingIds = blockingTasks.map((t) => t?.id).filter(Boolean).join(", ");
      const errorMsg = `Task ${task.id} is blocked by incomplete dependencies: ${blockingIds}`;
      console.error(`[task-board] ${errorMsg}`);
      return { success: false, blocked: true, error: errorMsg };
    }
  }

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

  // M5-09: Auto-unblock downstream tasks when this task completes/approves
  if (board && (status === "completed" || status === "approved")) {
    const downstreamTasks = getDownstreamTasks(board, task.id);
    for (const downstreamTask of downstreamTasks) {
      // Check if all dependencies are now satisfied
      if (!isTaskBlocked(board, downstreamTask)) {
        // The task is now ready - this could trigger a notification
        // or auto-dispatch if configured
      }
    }
  }

  return { success: true };
}

const SPRINT_STAGE_ORDER: SprintStage[] = ["plan", "build", "review", "test", "ship"];

// ============================================================================
// ProjectStatus State Machine Definition
// ============================================================================

/**
 * Valid state transitions for ProjectStatus.
 * Each key maps to an array of valid next states.
 * 
 * State flow:
 * pending -> planning (project initialized, planning phase starts)
 * planning -> dispatching (planning complete, ready to dispatch tasks)
 * dispatching -> running (tasks dispatched, execution begins)
 * running -> running (tasks in progress, can stay in running)
 * running -> reviewing (all tasks done, awaiting review)
 * running -> failed (critical failure during execution)
 * reviewing -> done (all tasks approved)
 * reviewing -> failed (tasks rejected and retries exhausted)
 * failed -> dispatching (can retry from dispatching)
 * done -> done (terminal state)
 */
export const VALID_PROJECT_TRANSITIONS: Record<ProjectStatus, ProjectStatus[]> = {
  pending: ["planning"],
  planning: ["dispatching", "failed"],
  dispatching: ["running", "planning", "failed"],
  running: ["running", "reviewing", "failed"],
  reviewing: ["done", "failed", "dispatching"],
  done: [],
  failed: ["dispatching", "planning"],
};

/**
 * Error class for invalid state transitions.
 */
export class InvalidStateTransitionError extends Error {
  public readonly from: ProjectStatus;
  public readonly to: ProjectStatus;

  constructor(from: ProjectStatus, to: ProjectStatus, message?: string) {
    super(message ?? `Invalid transition from '${from}' to '${to}'`);
    this.name = "InvalidStateTransitionError";
    this.from = from;
    this.to = to;
  }
}

/**
 * Check if a state transition is valid according to the state machine.
 */
export function isValidTransition(from: ProjectStatus, to: ProjectStatus): boolean {
  const validTargets = VALID_PROJECT_TRANSITIONS[from];
  return validTargets.includes(to);
}

/**
 * Get valid next states for a given status.
 */
export function getValidNextStates(status: ProjectStatus): ProjectStatus[] {
  return [...VALID_PROJECT_TRANSITIONS[status]];
}

/**
 * Attempt to transition project status with validation.
 * Throws InvalidStateTransitionError if transition is invalid.
 */
export function transitionProjectStatus(
  project: Project,
  newStatus: ProjectStatus,
  options?: { force?: boolean },
): { success: boolean; previousStatus: ProjectStatus } {
  const previousStatus = project.status;
  
  // Allow same-status transitions (no-op)
  if (previousStatus === newStatus) {
    return { success: true, previousStatus };
  }
  
  // Validate transition unless force is enabled
  if (!options?.force && !isValidTransition(previousStatus, newStatus)) {
    throw new InvalidStateTransitionError(previousStatus, newStatus);
  }
  
  project.status = newStatus;
  project.updatedAt = new Date().toISOString();
  
  return { success: true, previousStatus };
}

/**
 * Determine the appropriate project status based on task states.
 * This is the core logic that computes what status the project should have.
 */
export function computeProjectStatus(project: Project): ProjectStatus {
  const tasks = project.tasks;
  const hasStageAssignments = tasks.some((t) => t.stage !== undefined);
  const currentStage = project.currentStage ?? "plan";
  const currentStageIndex = SPRINT_STAGE_ORDER.indexOf(currentStage);
  const isLastStage = currentStageIndex >= SPRINT_STAGE_ORDER.length - 1;
  
  // No tasks means still pending
  if (tasks.length === 0) {
    return "pending";
  }
  
  // All approved = done (after all stages complete)
  const allApproved = tasks.every((t) => t.status === "approved");
  if (allApproved) {
    if (!hasStageAssignments) {
      return "done";
    }

    if (isLastStage) {
      return "done";
    }

    return currentStage === "plan" ? "planning" : "dispatching";
  }
  
  // Any active tasks = running
  const anyActive = tasks.some((t) => t.status === "dispatched" || t.status === "running");
  if (anyActive) {
    return "running";
  }
  
  // Check terminal states
  const allDone = tasks.every(
    (t) => t.status === "completed" || t.status === "failed" || t.status === "approved" || t.status === "rejected",
  );
  
  if (allDone) {
    // Check if any task is rejected with no more retries
    const exhausted = tasks.some(
      (t) => (t.status === "failed" || t.status === "rejected") && t.retryCount >= t.maxRetry,
    );
    if (exhausted) {
      return "failed";
    }
    
    // Has completed tasks awaiting review
    const hasCompletedTasks = tasks.some(
      (t) => t.status === "completed" || t.status === "rejected",
    );
    if (hasCompletedTasks) {
      return "reviewing";
    }
    
  }
  
  // Check for dispatching state (some dispatched, none running)
  const anyDispatched = tasks.some((t) => t.status === "dispatched");
  const noneRunning = !tasks.some((t) => t.status === "running");
  if (anyDispatched && noneRunning) {
    return "dispatching";
  }
  
  // Some tasks still pending - determine if planning or dispatching
  const anyPending = tasks.some((t) => t.status === "pending");
  if (anyPending) {
    // If we have any tasks with blockedBy dependencies that aren't satisfied,
    // or we're in the plan stage, we're planning
    const currentStage = project.currentStage ?? "plan";
    if (currentStage === "plan" && !tasks.some((t) => t.status !== "pending")) {
      return "planning";
    }
    
    // If no tasks dispatched yet and we're past planning
    const noneDispatched = !tasks.some((t) => t.status === "dispatched");
    if (noneDispatched && currentStage !== "plan") {
      return "dispatching";
    }
    
    return "pending";
  }
  
  // Default to current status if we can't determine
  return project.status;
}

export function advanceProjectStatus(project: Project): void {
  const currentStage = project.currentStage ?? "plan";
  const currentStageTasks = project.tasks.filter((task) => task.stage === currentStage);
  const shouldAdvanceStage =
    currentStageTasks.length > 0 &&
    currentStageTasks.every((task) => task.status === "approved") &&
    SPRINT_STAGE_ORDER.indexOf(currentStage) < SPRINT_STAGE_ORDER.length - 1;

  if (shouldAdvanceStage) {
    advanceStage(project);
  }

  const newStatus = computeProjectStatus(project);
  
  // Only update if status actually changed
  if (project.status !== newStatus) {
    try {
      transitionProjectStatus(project, newStatus);
    } catch (error) {
      if (error instanceof InvalidStateTransitionError) {
        // Log the invalid transition but still update to computed status
        // This handles edge cases where the computed state should override
        console.warn(
          `Project ${project.id}: Override transition from '${error.from}' to '${error.to}'`,
        );
        project.status = newStatus;
        project.updatedAt = new Date().toISOString();
      } else {
        throw error;
      }
    }
  } else {
    // Still update timestamp
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

// ============================================================================
// M5: Task Dependency Chain Functions
// ============================================================================

/**
 * Check if a task is blocked by incomplete dependencies.
 * Returns true if any task in blockedBy is not completed/approved.
 */
export function isTaskBlocked(board: TaskBoard, task: Task): boolean {
  if (task.blockedBy.length === 0) {
    return false;
  }

  // Find all tasks that this task is waiting on
  for (const blockingTaskId of task.blockedBy) {
    const blockingTask = findTaskById(board, blockingTaskId);
    if (blockingTask && blockingTask.status !== "completed" && blockingTask.status !== "approved") {
      return true;
    }
  }

  return false;
}

/**
 * Find a task by ID across all projects.
 */
export function findTaskById(board: TaskBoard, taskId: string): Task | undefined {
  for (const project of board.projects) {
    const task = project.tasks.find((t) => t.id === taskId);
    if (task) return task;
  }
  return undefined;
}

/**
 * Find a task by label within a project.
 */
export function findTaskByLabel(project: Project, label: string): Task | undefined {
  return project.tasks.find((t) => t.label === label);
}

/**
 * Attempt to acquire a lock on a task for an agent using CAS (Compare-And-Swap).
 * 
 * CAS Mechanism:
 * 1. Read current lockVersion
 * 2. Perform check-then-acquire atomically by version comparison
 * 3. Only succeed if version hasn't changed (no concurrent modification)
 * 
 * Returns:
 * - { success: true } if lock acquired
 * - { success: false, reason: string } if failed
 * 
 * @param sharedRoot - Root directory for board file (required for file-based CAS)
 * @param taskId - Task ID to lock
 * @param agentId - Agent ID requesting the lock
 * @param expectedVersion - Expected lock version for CAS (optional, uses current if not provided)
 */
export function acquireTaskLock(
  sharedRoot: string,
  taskId: string,
  agentId: string,
  expectedVersion?: number
): { success: boolean; reason?: string; currentVersion?: number } {
  // Load fresh board state for atomic operation
  const board = loadBoard(sharedRoot);
  const task = findTaskById(board, taskId);
  
  if (!task) {
    return { success: false, reason: "Task not found" };
  }

  const currentVersion = task.lockVersion ?? 0;

  // CAS Check: If expectedVersion provided, verify it matches current version
  // This detects if another process modified the lock between read and write
  if (expectedVersion !== undefined && expectedVersion !== currentVersion) {
    return { 
      success: false, 
      reason: "Lock version mismatch - concurrent modification detected",
      currentVersion 
    };
  }

  // Already locked by same agent - allow re-entry (idempotent)
  if (task.lockedBy === agentId) {
    // Increment version even for re-entry to maintain consistency
    task.lockVersion = currentVersion + 1;
    task.lockedAt = new Date().toISOString();
    saveBoard(sharedRoot, board);
    return { success: true, currentVersion: task.lockVersion };
  }

  // Locked by different agent - deny
  if (task.lockedBy && task.lockedBy !== agentId) {
    return { 
      success: false, 
      reason: `Task already locked by ${task.lockedBy}`,
      currentVersion 
    };
  }

  // Not locked - acquire atomically
  // CAS: Increment version to invalidate any stale expected versions from other processes
  task.lockedBy = agentId;
  task.lockedAt = new Date().toISOString();
  task.lockVersion = currentVersion + 1;
  
  // Persist the change
  saveBoard(sharedRoot, board);
  
  return { success: true, currentVersion: task.lockVersion };
}

/**
 * Release a task lock with holder validation.
 * 
 * Security: Only the agent that holds the lock can release it.
 * This prevents accidental or malicious release by other agents.
 * 
 * @param sharedRoot - Root directory for board file
 * @param taskId - Task ID to unlock
 * @param agentId - Agent ID releasing the lock (must match lock holder)
 * @returns true if lock released, false if not held by this agent or task not found
 */
export function releaseTaskLock(
  sharedRoot: string,
  taskId: string,
  agentId: string
): boolean {
  // Load fresh board state for atomic operation
  const board = loadBoard(sharedRoot);
  const task = findTaskById(board, taskId);
  
  if (!task) {
    return false;
  }

  // Security check: Only the lock holder can release
  if (task.lockedBy && task.lockedBy !== agentId) {
    // Lock held by different agent - cannot release
    return false;
  }

  // Not locked or locked by this agent - release it
  task.lockedBy = undefined;
  task.lockedAt = undefined;
  // Increment version on release to invalidate any pending CAS operations
  task.lockVersion = (task.lockVersion ?? 0) + 1;
  
  saveBoard(sharedRoot, board);
  return true;
}

/**
 * Legacy acquireTaskLock for backward compatibility.
 * Uses in-memory board without file persistence.
 * @deprecated Use the file-based acquireTaskLock for proper CAS support
 */
export function acquireTaskLockInMemory(board: TaskBoard, taskId: string, agentId: string): boolean {
  const task = findTaskById(board, taskId);
  if (!task) {
    return false;
  }

  // Already locked by same agent - allow re-entry
  if (task.lockedBy === agentId) {
    return true;
  }

  // Locked by different agent - deny
  if (task.lockedBy && task.lockedBy !== agentId) {
    return false;
  }

  // Not locked - acquire (still has race condition, use file-based version for production)
  task.lockedBy = agentId;
  task.lockedAt = new Date().toISOString();
  task.lockVersion = (task.lockVersion ?? 0) + 1;
  return true;
}

/**
 * Legacy releaseTaskLock for backward compatibility.
 * @deprecated Use the file-based releaseTaskLock for proper holder validation
 */
export function releaseTaskLockInMemory(board: TaskBoard, taskId: string): void {
  const task = findTaskById(board, taskId);
  if (task) {
    task.lockedBy = undefined;
    task.lockedAt = undefined;
    task.lockVersion = (task.lockVersion ?? 0) + 1;
  }
}

/**
 * Get all downstream tasks that depend on this task.
 */
export function getDownstreamTasks(board: TaskBoard, taskId: string): Task[] {
  const downstream: Task[] = [];
  for (const project of board.projects) {
    for (const task of project.tasks) {
      if (task.blockedBy.includes(taskId)) {
        downstream.push(task);
      }
    }
  }
  return downstream;
}

/**
 * Detect if adding a dependency would create a cycle.
 * Returns the cycle path if detected, null otherwise.
 */
export function detectDependencyCycle(board: TaskBoard, taskId: string, newDependencyId?: string): string[] | null {
  const visited = new Set<string>();
  const path: string[] = [];

  function dfs(currentId: string): string[] | null {
    if (visited.has(currentId)) {
      // Found a cycle - return the cycle path
      const cycleStart = path.indexOf(currentId);
      if (cycleStart >= 0) {
        return path.slice(cycleStart);
      }
      return null;
    }

    const task = findTaskById(board, currentId);
    if (!task) return null;

    visited.add(currentId);
    path.push(currentId);

    // Check all dependencies (including the new one being added)
    const deps = [...task.blockedBy];
    if (newDependencyId && currentId === taskId) {
      deps.push(newDependencyId);
    }

    for (const depId of deps) {
      const cycle = dfs(depId);
      if (cycle) return cycle;
    }

    path.pop();
    return null;
  }

  return dfs(taskId);
}

/**
 * Add a dependency: task A blocks task B.
 * Automatically updates both tasks' blockedBy and blocks arrays.
 * Returns true if successful, false if would create cycle.
 */
export function addTaskDependency(
  board: TaskBoard,
  blockingTaskId: string,
  blockedTaskId: string,
): { success: boolean; error?: string } {
  const blockingTask = findTaskById(board, blockingTaskId);
  const blockedTask = findTaskById(board, blockedTaskId);

  if (!blockingTask || !blockedTask) {
    return { success: false, error: "Task not found" };
  }

  // Check for existing dependency
  if (blockedTask.blockedBy.includes(blockingTaskId)) {
    return { success: false, error: "Dependency already exists" };
  }

  // Check for cycle
  const cycle = detectDependencyCycle(board, blockedTaskId, blockingTaskId);
  if (cycle) {
    return { success: false, error: `Would create cycle: ${cycle.join(" → ")}` };
  }

  // Add dependency
  blockedTask.blockedBy.push(blockingTaskId);
  blockingTask.blocks.push(blockedTaskId);

  return { success: true };
}

/**
 * Remove a dependency between tasks.
 */
export function removeTaskDependency(board: TaskBoard, blockingTaskId: string, blockedTaskId: string): void {
  const blockingTask = findTaskById(board, blockingTaskId);
  const blockedTask = findTaskById(board, blockedTaskId);

  if (blockingTask) {
    blockingTask.blocks = blockingTask.blocks.filter((id) => id !== blockedTaskId);
  }

  if (blockedTask) {
    blockedTask.blockedBy = blockedTask.blockedBy.filter((id) => id !== blockingTaskId);
  }
}

/**
 * Get all tasks that are ready to be dispatched (not blocked, not locked, pending status).
 */
export function getReadyTasks(project: Project, board: TaskBoard): Task[] {
  return project.tasks.filter((task) => {
    if (task.status !== "pending") return false;
    if (task.lockedBy) return false;
    if (isTaskBlocked(board, task)) return false;
    return true;
  });
}
