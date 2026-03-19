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

export function createSubagentHooks(
  state: PluginState,
  api: Pick<OpenClawPluginApi, "logger">,
): {
  subagentSpawned: (event: Record<string, unknown>) => Promise<undefined>;
  subagentEnded: (event: Record<string, unknown>) => Promise<undefined>;
} {
  async function subagentSpawned(event: Record<string, unknown>): Promise<undefined> {
    const sessionKey = event.childSessionKey as string | undefined;
    const label = event.label as string | undefined;

    logEvent(state.auditLog, "subagent_spawned", {
      sessionKey,
      agentId: event.agentId,
      label,
    });

    recordSpawn(state.spawnTracker, {
      sessionKey: sessionKey ?? `unknown-${Date.now()}`,
      agentId: event.agentId as string | undefined,
      label,
      task: event.task as string | undefined,
    });
    state.currentDelegationSpawnCount += 1;

    // Find a pending task matching by label or trackId and mark dispatched
    if (sessionKey) {
      for (const project of state.board.projects) {
        if (project.status === "done" || project.status === "failed") continue;
        const task =
          project.tasks.find(
            (t) => t.status === "pending" && (label ? t.label === label || t.trackId === label : false),
          ) ?? project.tasks.find((t) => t.status === "pending");
        if (task) {
          updateTaskStatus(task, "dispatched", { sessionKey });
          advanceProjectStatus(project);
          state.scheduleBoardSave();
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

      const result = processSubagentResult({
        board: state.board,
        sessionKey,
        outcome: normalizedOutcome,
      });

      if (result.updated) {
        api.logger.info(`[OMA] Task ${result.taskId} updated: ${outcome}`);

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
