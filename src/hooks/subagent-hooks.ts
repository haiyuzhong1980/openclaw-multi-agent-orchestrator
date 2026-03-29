import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { logEvent } from "../audit-log.ts";
import { recordSpawn, recordCompletion } from "../spawn-tracker.ts";
import {
  getProject,
  updateTaskStatus,
  advanceProjectStatus,
} from "../task-board.ts";
import { processSubagentResult, isProjectReadyForReview } from "../result-collector.ts";
import { reviewProject, prepareRetries } from "../review-gate.ts";
import { generateProjectReport } from "../report-generator.ts";
import type { PluginState } from "../plugin-state.ts";
// M6: Message system
import { createAgentIdentity, sendMessage } from "../message-manager.ts";
import { MessageType } from "../types.ts";
// M7: Mailbox for receiving messages
import { createMailbox, type MailboxManager } from "../mailbox.ts";

const DEFAULT_TRACKED_TASK_ROOT = join(homedir(), ".openclaw", "orchestrator", "tasks");
const DEFAULT_SUBAGENT_RUNS_PATH = join(homedir(), ".openclaw", "subagents", "runs.json");

type SubagentHookOptions = {
  trackedTaskRoot?: string;
  subagentRunsPath?: string;
  now?: () => Date;
};

type TrackedWorkerStatus =
  | "running"
  | "completed"
  | "failed"
  | "error"
  | "killed"
  | "timeout"
  | "cancelled"
  | "canceled";

type TrackedTaskWorkerRecord = {
  id: string;
  label: string;
  status: TrackedWorkerStatus;
  run_id: string;
  session_key: string;
  child_session_key: string;
  agent_id: string;
  controller_session_key: string;
  controller_agent_id: string;
  requester_session_key: string;
  workspace_dir: string;
  created_at: string;
  started_at: string;
  task: string;
};

const TERMINAL_WORKER_STATUSES = new Set([
  "completed",
  "failed",
  "error",
  "killed",
  "timeout",
  "cancelled",
  "canceled",
]);

const STATUS_ALIAS_MAP = new Map<string, string>([
  ["state", "status"],
  ["step_title", "step_name"],
  ["task_id", "taskId"],
  ["current_step", "currentStep"],
  ["total_steps", "totalSteps"],
  ["phase_owner", "phaseOwner"],
  ["run_id", "runId"],
  ["child_session_key", "childSessionKey"],
  ["controller_session_key", "controllerSessionKey"],
  ["requester_session_key", "requesterSessionKey"],
]);

function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return undefined;
  }
}

function normalizeTaskStatus(status: unknown): Record<string, unknown> {
  if (!status || typeof status !== "object" || Array.isArray(status)) {
    return {};
  }
  const normalized: Record<string, unknown> = { ...(status as Record<string, unknown>) };
  if (typeof normalized.status === "string" && typeof normalized.state !== "string") {
    normalized.state = normalized.status;
  }
  if (typeof normalized.step_name === "string" && typeof normalized.step_title !== "string") {
    normalized.step_title = normalized.step_name;
  }
  for (const [canonical, legacy] of STATUS_ALIAS_MAP.entries()) {
    if (canonical in normalized || !(legacy in normalized)) {
      continue;
    }
    normalized[canonical] = normalized[legacy];
  }
  return normalized;
}

function applyStatusField(status: Record<string, unknown>, canonicalKey: string, value: unknown): void {
  status[canonicalKey] = value;
  const legacyKey = STATUS_ALIAS_MAP.get(canonicalKey);
  if (legacyKey) {
    status[legacyKey] = value;
  }
}

function isoFromEpochMs(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "";
  }
  return new Date(value).toISOString();
}

function extractAgentIdFromSessionKey(sessionKey: unknown): string {
  if (typeof sessionKey !== "string" || !sessionKey.trim()) {
    return "";
  }
  const [prefix, agentId] = sessionKey.trim().split(":");
  return prefix === "agent" && agentId ? agentId.trim() : "";
}

function extractTaskIdFromText(text: unknown): string {
  if (typeof text !== "string" || !text.trim()) {
    return "";
  }
  const match = text.match(/\bTASK-[A-Za-z0-9][A-Za-z0-9-]*\b/);
  return match?.[0] ?? "";
}

function readSubagentRunRecord(
  runsPath: string,
  event: Record<string, unknown>,
): Record<string, unknown> {
  const payload = readJsonFile(runsPath);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {};
  }
  const runs = (payload as { runs?: unknown }).runs;
  if (!runs || typeof runs !== "object" || Array.isArray(runs)) {
    return {};
  }
  const targetRunId = typeof event.runId === "string" ? event.runId.trim() : "";
  const targetSessionKey =
    typeof event.childSessionKey === "string" ? event.childSessionKey.trim() : "";
  for (const [runId, rawEntry] of Object.entries(runs as Record<string, unknown>)) {
    if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
      continue;
    }
    const entry = rawEntry as Record<string, unknown>;
    const entryRunId =
      typeof entry.runId === "string" && entry.runId.trim() ? entry.runId.trim() : runId.trim();
    const entrySessionKey =
      typeof entry.childSessionKey === "string" ? entry.childSessionKey.trim() : "";
    if ((targetRunId && entryRunId === targetRunId) || (targetSessionKey && entrySessionKey === targetSessionKey)) {
      return entry;
    }
  }
  return {};
}

function buildTrackedWorkerRecord(
  event: Record<string, unknown>,
  runRecord: Record<string, unknown>,
): TrackedTaskWorkerRecord | undefined {
  const childSessionKey =
    typeof event.childSessionKey === "string" ? event.childSessionKey.trim() : "";
  const runId =
    typeof event.runId === "string" ? event.runId.trim()
    : typeof runRecord.runId === "string" ? runRecord.runId.trim()
    : "";
  if (!childSessionKey || !runId) {
    return undefined;
  }
  const label =
    typeof event.label === "string" && event.label.trim() ? event.label.trim()
    : typeof runRecord.label === "string" ? runRecord.label.trim()
    : childSessionKey;
  const controllerSessionKey =
    typeof runRecord.controllerSessionKey === "string" && runRecord.controllerSessionKey.trim()
      ? runRecord.controllerSessionKey.trim()
      : typeof runRecord.requesterSessionKey === "string"
        ? runRecord.requesterSessionKey.trim()
        : "";
  const requesterSessionKey =
    typeof runRecord.requesterSessionKey === "string" ? runRecord.requesterSessionKey.trim() : "";
  const taskText = typeof runRecord.task === "string" ? runRecord.task : "";
  const workspaceDir = typeof runRecord.workspaceDir === "string" ? runRecord.workspaceDir : "";
  return {
    id: childSessionKey,
    label,
    status: "running",
    run_id: runId,
    session_key: childSessionKey,
    child_session_key: childSessionKey,
    agent_id: typeof event.agentId === "string" ? event.agentId : extractAgentIdFromSessionKey(childSessionKey),
    controller_session_key: controllerSessionKey,
    controller_agent_id: extractAgentIdFromSessionKey(controllerSessionKey),
    requester_session_key: requesterSessionKey,
    workspace_dir: workspaceDir,
    created_at: isoFromEpochMs(runRecord.createdAt),
    started_at:
      isoFromEpochMs(runRecord.startedAt)
      || isoFromEpochMs(runRecord.sessionStartedAt)
      || isoFromEpochMs(runRecord.acceptedAt),
    task: taskText,
  };
}

function mergeTrackedWorkers(
  existingWorkers: unknown,
  nextWorker: TrackedTaskWorkerRecord,
): TrackedTaskWorkerRecord[] {
  const merged = new Map<string, TrackedTaskWorkerRecord>();
  if (Array.isArray(existingWorkers)) {
    for (const worker of existingWorkers) {
      if (!worker || typeof worker !== "object" || Array.isArray(worker)) {
        continue;
      }
      const record = worker as Record<string, unknown>;
      const key =
        typeof record.child_session_key === "string" && record.child_session_key.trim()
          ? record.child_session_key.trim()
          : typeof record.childSessionKey === "string" && record.childSessionKey.trim()
            ? record.childSessionKey.trim()
            : typeof record.session_key === "string" && record.session_key.trim()
              ? record.session_key.trim()
              : typeof record.id === "string"
                ? record.id.trim()
                : "";
      if (!key) {
        continue;
      }
      merged.set(key, {
        id: key,
        label: typeof record.label === "string" ? record.label : key,
        status:
          typeof record.status === "string" && record.status.trim()
            ? record.status.trim().toLowerCase() as TrackedWorkerStatus
            : "running",
        run_id:
          typeof record.run_id === "string" && record.run_id.trim()
            ? record.run_id.trim()
            : typeof record.runId === "string"
              ? record.runId.trim()
              : "",
        session_key:
          typeof record.session_key === "string" && record.session_key.trim()
            ? record.session_key.trim()
            : key,
        child_session_key: key,
        agent_id:
          typeof record.agent_id === "string" && record.agent_id.trim()
            ? record.agent_id.trim()
            : typeof record.agentId === "string"
              ? record.agentId.trim()
              : extractAgentIdFromSessionKey(key),
        controller_session_key:
          typeof record.controller_session_key === "string" && record.controller_session_key.trim()
            ? record.controller_session_key.trim()
            : typeof record.controllerSessionKey === "string"
              ? record.controllerSessionKey.trim()
              : "",
        controller_agent_id:
          typeof record.controller_agent_id === "string" && record.controller_agent_id.trim()
            ? record.controller_agent_id.trim()
            : extractAgentIdFromSessionKey(
                typeof record.controller_session_key === "string"
                  ? record.controller_session_key
                  : record.controllerSessionKey,
              ),
        requester_session_key:
          typeof record.requester_session_key === "string" && record.requester_session_key.trim()
            ? record.requester_session_key.trim()
            : typeof record.requesterSessionKey === "string"
              ? record.requesterSessionKey.trim()
              : "",
        workspace_dir:
          typeof record.workspace_dir === "string" ? record.workspace_dir
          : typeof record.workspaceDir === "string" ? record.workspaceDir
          : "",
        created_at:
          typeof record.created_at === "string" ? record.created_at
          : typeof record.createdAt === "string" ? record.createdAt
          : "",
        started_at:
          typeof record.started_at === "string" ? record.started_at
          : typeof record.startedAt === "string" ? record.startedAt
          : "",
        task: typeof record.task === "string" ? record.task : "",
      });
    }
  }
  const existingWorker = merged.get(nextWorker.child_session_key);
  if (!existingWorker) {
    merged.set(nextWorker.child_session_key, nextWorker);
  } else {
    const preservedStatus =
      TERMINAL_WORKER_STATUSES.has(existingWorker.status) && nextWorker.status === "running"
        ? existingWorker.status
        : nextWorker.status;
    merged.set(nextWorker.child_session_key, {
      ...existingWorker,
      ...nextWorker,
      status: preservedStatus,
      label: nextWorker.label || existingWorker.label,
      run_id: nextWorker.run_id || existingWorker.run_id,
      session_key: nextWorker.session_key || existingWorker.session_key,
      child_session_key: nextWorker.child_session_key || existingWorker.child_session_key,
      agent_id: nextWorker.agent_id || existingWorker.agent_id,
      controller_session_key: nextWorker.controller_session_key || existingWorker.controller_session_key,
      controller_agent_id: nextWorker.controller_agent_id || existingWorker.controller_agent_id,
      requester_session_key: nextWorker.requester_session_key || existingWorker.requester_session_key,
      workspace_dir: nextWorker.workspace_dir || existingWorker.workspace_dir,
      created_at: nextWorker.created_at || existingWorker.created_at,
      started_at: nextWorker.started_at || existingWorker.started_at,
      task: nextWorker.task || existingWorker.task,
    });
  }
  return [...merged.values()].sort((left, right) => left.created_at.localeCompare(right.created_at));
}

function hasWorkerMatch(
  existingWorkers: unknown,
  candidate: TrackedTaskWorkerRecord,
): boolean {
  if (!Array.isArray(existingWorkers)) {
    return false;
  }
  return existingWorkers.some((worker) => {
    if (!worker || typeof worker !== "object" || Array.isArray(worker)) {
      return false;
    }
    const record = worker as Record<string, unknown>;
    const childSessionKey =
      typeof record.child_session_key === "string" && record.child_session_key.trim()
        ? record.child_session_key.trim()
        : typeof record.childSessionKey === "string" && record.childSessionKey.trim()
          ? record.childSessionKey.trim()
          : typeof record.session_key === "string" && record.session_key.trim()
            ? record.session_key.trim()
            : typeof record.id === "string" && record.id.trim()
              ? record.id.trim()
              : "";
    const runId =
      typeof record.run_id === "string" && record.run_id.trim()
        ? record.run_id.trim()
        : typeof record.runId === "string" && record.runId.trim()
          ? record.runId.trim()
          : "";
    return childSessionKey === candidate.child_session_key || (candidate.run_id && runId === candidate.run_id);
  });
}

function assignStatusField(
  status: Record<string, unknown>,
  canonicalKey: string,
  value: unknown,
): boolean {
  const legacyKey = STATUS_ALIAS_MAP.get(canonicalKey);
  const currentCanonical = status[canonicalKey];
  const currentLegacy = legacyKey ? status[legacyKey] : undefined;
  if (currentCanonical === value && (!legacyKey || currentLegacy === value)) {
    return false;
  }
  applyStatusField(status, canonicalKey, value);
  return true;
}

function syncTrackedTaskBus(
  event: Record<string, unknown>,
  options: SubagentHookOptions,
): void {
  const runsPath = options.subagentRunsPath ?? DEFAULT_SUBAGENT_RUNS_PATH;
  const runRecord = readSubagentRunRecord(runsPath, event);
  const taskText =
    typeof event.task === "string" && event.task.trim() ? event.task
    : typeof runRecord.task === "string" ? runRecord.task
    : typeof runRecord.label === "string" ? runRecord.label
    : "";
  const taskId = extractTaskIdFromText(taskText);
  if (!taskId) {
    return;
  }

  const trackedTaskRoot = options.trackedTaskRoot ?? DEFAULT_TRACKED_TASK_ROOT;
  const taskDir = join(trackedTaskRoot, taskId);
  const statusPath = join(taskDir, "status.json");
  if (!existsSync(statusPath)) {
    return;
  }

  const rawStatus = readJsonFile(statusPath);
  const status = normalizeTaskStatus(rawStatus);
  if (!Object.keys(status).length) {
    return;
  }

  const workerRecord = buildTrackedWorkerRecord(event, runRecord);
  if (!workerRecord) {
    return;
  }

  const hadWorkerMatch = hasWorkerMatch(status.workers, workerRecord);
  const mergedWorkers = mergeTrackedWorkers(status.workers, workerRecord);

  const now = (options.now?.() ?? new Date()).toISOString();
  const currentState = typeof status.state === "string" ? status.state.trim().toLowerCase() : "";
  const nextState = currentState && !["planning", "dispatching", "pending", "queued"].includes(currentState)
    ? currentState
    : "running";
  const controllerAgentId =
    workerRecord.controller_agent_id || extractAgentIdFromSessionKey(workerRecord.requester_session_key);
  const currentOwner = typeof status.owner === "string" ? status.owner.trim().toLowerCase() : "";
  const currentPhaseOwner =
    typeof status.phase_owner === "string" ? status.phase_owner.trim().toLowerCase() : "";
  let changed = false;

  changed = assignStatusField(status, "task_id", taskId) || changed;
  changed = assignStatusField(status, "state", nextState) || changed;
  changed = assignStatusField(status, "run_id", workerRecord.run_id) || changed;
  changed = assignStatusField(status, "child_session_key", workerRecord.child_session_key) || changed;
  changed = assignStatusField(status, "controller_session_key", workerRecord.controller_session_key) || changed;
  changed = assignStatusField(status, "requester_session_key", workerRecord.requester_session_key) || changed;
  if (JSON.stringify(status.workers ?? []) !== JSON.stringify(mergedWorkers)) {
    status.workers = mergedWorkers;
    changed = true;
  }
  if (status.blocked !== false) {
    status.blocked = false;
    changed = true;
  }
  if (controllerAgentId && ["", "subagent", "worker"].includes(currentOwner)) {
    if (status.owner !== controllerAgentId) {
      changed = true;
    }
    status.owner = controllerAgentId;
  }
  if (controllerAgentId && ["", "subagent", "worker"].includes(currentPhaseOwner)) {
    changed = assignStatusField(status, "phase_owner", controllerAgentId) || changed;
  }
  if (!changed) {
    return;
  }

  status.updated_at = now;
  status.last_update_at = now;
  status.heartbeat_at = now;

  mkdirSync(taskDir, { recursive: true });
  writeFileSync(statusPath, `${JSON.stringify(status, null, 2)}\n`, "utf-8");

  const eventsPath = join(taskDir, "events.jsonl");
  if (!existsSync(eventsPath)) {
    writeFileSync(eventsPath, "", "utf-8");
  }
  const eventPayload = {
    ts: now,
    agent: controllerAgentId || workerRecord.agent_id || "multi-agent-orchestrator",
    event: "worker_spawn_accepted",
    state: nextState,
    current_step: status.current_step ?? null,
    total_steps: status.total_steps ?? null,
    step_title: status.step_title ?? null,
    phase: status.phase ?? null,
    phase_owner: status.phase_owner ?? null,
    run_id: status.run_id ?? null,
    child_session_key: status.child_session_key ?? null,
    retry_count: status.retry_count ?? null,
    blocked: false,
    message: `Worker dispatch accepted for ${workerRecord.label}.`,
    worker_label: workerRecord.label,
    worker_agent_id: workerRecord.agent_id,
    controller_session_key: workerRecord.controller_session_key,
    requester_session_key: workerRecord.requester_session_key,
  };
  if (!hadWorkerMatch) {
    appendFileSync(eventsPath, `${JSON.stringify(eventPayload)}\n`, "utf-8");
  }
}

export function createSubagentHooks(
  state: PluginState,
  api: Pick<OpenClawPluginApi, "logger">,
  sharedRoot: string = "",
  options: SubagentHookOptions = {},
): {
  subagentSpawned: (event: Record<string, unknown>) => Promise<undefined>;
  subagentEnded: (event: Record<string, unknown>) => Promise<undefined>;
} {
  async function subagentSpawned(event: Record<string, unknown>): Promise<undefined> {
    const sessionKey = event.childSessionKey as string | undefined;
    const label = event.label as string | undefined;
    const agentId = event.agentId as string | undefined;

    logEvent(state.auditLog, "subagent_spawned", {
      sessionKey,
      agentId,
      label,
    });

    recordSpawn(state.spawnTracker, {
      sessionKey: sessionKey ?? `unknown-${Date.now()}`,
      agentId,
      label,
      task: event.task as string | undefined,
    });
    state.currentDelegationSpawnCount += 1;

    // M6: Create agent identity if this is a new agent
    if (sessionKey && agentId && !state.agentIdentity) {
      state.agentIdentity = createAgentIdentity({
        agentId: sessionKey,
        agentName: label ?? agentId,
        agentType: agentId,
        teamName: event.teamName as string | undefined,
        isLeader: event.isLeader as boolean | undefined,
      });
    }

    // M7-06: Auto-receive messages for the agent
    if (sharedRoot && state.agentIdentity) {
      try {
        const mailbox = createMailbox(state.agentIdentity, sharedRoot, { autoAck: false });

        // Check for urgent messages (task_blocked, shutdown_request)
        mailbox.hasUrgentMessages().then((hasUrgent) => {
          if (hasUrgent) {
            api.logger.warn(`[OMA] Agent ${state.agentIdentity?.agentId} has urgent messages!`);
          }
        });

        // Receive and log pending messages
        mailbox.receive().then((messages) => {
          if (messages.length > 0) {
            api.logger.info(`[OMA] Agent ${state.agentIdentity?.agentId} received ${messages.length} message(s)`);
            for (const msg of messages) {
              logEvent(state.auditLog, "message_received", {
                from: msg.from,
                type: msg.type,
                content: msg.content.slice(0, 100),
              });
            }
          }
        });
      } catch (err) {
        api.logger.warn(`[OMA] Failed to check mailbox: ${err}`);
      }
    }

    try {
      syncTrackedTaskBus(event, options);
    } catch (err) {
      api.logger.warn(`[OMA] Failed to sync tracked task bus on spawn: ${err}`);
    }

    // Find a pending task matching by label or trackId and mark dispatched
    if (sessionKey) {
      for (const project of state.board.projects) {
        if (project.status === "done" || project.status === "failed") continue;
        const task =
          project.tasks.find(
            (t) => t.status === "pending" && (label ? t.label === label || t.trackId === label : false),
          ) ?? project.tasks.find((t) => t.status === "pending");
        if (task) {
          const result = updateTaskStatus(task, "dispatched", { sessionKey }, state.board);
          if (!result.success) {
            api.logger.warn(`[OMA] Failed to dispatch task ${task.id}: ${result.error}`);
            if (result.blocked) {
              // Task is blocked by dependencies - log and skip
              logEvent(state.auditLog, "task_blocked", {
                taskId: task.id,
                reason: result.error,
              });
            }
          } else {
            advanceProjectStatus(project);
            state.scheduleBoardSave();
          }
          break;
        }
      }
    }

    return undefined;
  }

  async function subagentEnded(event: Record<string, unknown>): Promise<undefined> {
    const sessionKey = event.targetSessionKey as string | undefined;
    const outcome = event.outcome as string | undefined;

    logEvent(state.auditLog, "subagent_ended", { sessionKey, outcome });

    if (sessionKey) {
      const normalizedOutcome: "ok" | "error" | "timeout" | "killed" =
        outcome === "timeout" ? "timeout"
        : outcome === "killed" ? "killed"
        : outcome === "failed" || outcome === "error" ? "error"
        : "ok";
      recordCompletion(state.spawnTracker, { sessionKey, outcome: normalizedOutcome });
    }

    // E3: Update task board
    if (sessionKey) {
      const normalizedOutcome: "ok" | "error" | "timeout" | "killed" =
        outcome === "timeout" ? "timeout"
        : outcome === "killed" ? "killed"
        : outcome === "failed" || outcome === "error" ? "error"
        : "ok";

      const resultText = (event.resultText as string | undefined)
        ?? (event.output as string | undefined)
        ?? "";

      const result = processSubagentResult({
        board: state.board,
        sessionKey,
        outcome: normalizedOutcome,
        resultText,
      });

      if (result.updated) {
        api.logger.info(`[OMA] Task ${result.taskId} updated: ${outcome}`);

        // M6: Send task_completed message if we have identity and sharedRoot
        if (sharedRoot && state.agentIdentity && normalizedOutcome === "ok") {
          sendMessage(sharedRoot, {
            type: MessageType.task_completed,
            from: state.agentIdentity.agentId,
            to: null, // Broadcast to team
            content: `Task ${result.taskId} completed successfully`,
            metadata: {
              taskId: result.taskId,
              projectId: result.projectId,
              teamName: state.agentIdentity.teamName,
            },
          });
        }

        // E4: Auto-review when project is ready
        const project = getProject(state.board, result.projectId!);
        if (project && isProjectReadyForReview(project)) {
          const { reviews, needsRetry, allApproved } = reviewProject(project);

          api.logger.info(
            `[OMA] Project ${project.id} reviewed: ${reviews.filter((r) => r.approved).length} approved, ${needsRetry.length} need retry`,
          );

          if (needsRetry.length > 0) {
            prepareRetries(needsRetry);
            api.logger.info(`[OMA] ${needsRetry.length} tasks prepared for retry`);
          }

          if (allApproved) {
            project.status = "done";
            api.logger.info(`[OMA] Project ${project.id} DONE — all tasks approved`);
            // E6: Auto-log report when project completes
            const report = generateProjectReport(project);
            api.logger.info(`[OMA] Project report:\n${report}`);
          }

          advanceProjectStatus(project);
        }

        state.scheduleBoardSave();
      }
    }

    return undefined;
  }

  return { subagentSpawned, subagentEnded };
}
