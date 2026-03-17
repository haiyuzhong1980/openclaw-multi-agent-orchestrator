import type { TrackInput, ExecutionPolicyMode, DelegationStartGateMode, ExecutionGuardRequest } from "./types.ts";
import { buildExecutionPolicyReport } from "./execution-policy.ts";
import { inferResearchTracks, inferRecentWindowDays, buildPlanningReport } from "./track-planner.ts";
import { planTracksWithAgents } from "./agent-registry.ts";
import { planCustomTracks } from "./track-templates.ts";
import { classifyTrack, dedupeItems } from "./candidate-extractor.ts";
import { buildHumanReport } from "./report-builder.ts";
import { suggestTracksFromTopics, feedbackToOfms } from "./ofms-bridge.ts";
import type { OrchestratorSessionState } from "./session-state.ts";
import { recordPlan, recordEnforcement, recordTrackResult, getMissingTracks, getUnplannedTracks, recordToolCall } from "./session-state.ts";
import type { AuditLog } from "./audit-log.ts";
import { logEvent } from "./audit-log.ts";
import type { TaskBoard } from "./task-board.ts";
import { loadBoard, saveBoard, createProject, addTask } from "./task-board.ts";
import { buildDispatchGuidance } from "./prompt-guidance.ts";
import { runEvolutionCycle, appendEvolutionReport, formatEvolutionReport } from "./evolution-cycle.ts";
import type { EvolutionReport } from "./evolution-cycle.ts";
import { saveUserKeywords } from "./user-keywords.ts";
import type { UserKeywords } from "./user-keywords.ts";
import { saveIntentRegistry } from "./intent-registry.ts";
import type { IntentRegistry } from "./intent-registry.ts";
import { saveEnforcementState } from "./enforcement-ladder.ts";
import type { EnforcementState } from "./enforcement-ladder.ts";

export { MultiAgentOrchestratorSchema } from "./schema.ts";
import { MultiAgentOrchestratorSchema } from "./schema.ts";

export function createMultiAgentOrchestratorTool(params?: {
  maxItemsPerTrack?: number;
  executionPolicy?: ExecutionPolicyMode;
  delegationStartGate?: DelegationStartGateMode;
  logger?: (message: string) => void;
  sessionState?: OrchestratorSessionState;
  auditLog?: AuditLog;
  sharedRoot?: string;
  board?: TaskBoard;
  // EV4: evolution cycle state
  intentRegistry?: IntentRegistry;
  userKeywords?: UserKeywords;
  enforcementState?: EnforcementState;
  existingDelegationKeywords?: string[];
  existingTrackedKeywords?: string[];
}) {
  const maxItemsPerTrack = Math.max(1, Math.min(20, params?.maxItemsPerTrack ?? 8));
  const executionPolicy: ExecutionPolicyMode = params?.executionPolicy ?? "guided";
  const delegationStartGate: DelegationStartGateMode = params?.delegationStartGate ?? "required";
  const log = params?.logger;

  return {
    name: "multi-agent-orchestrator",
    label: "Multi-Agent Orchestrator",
    description:
      "Plan multi-agent research tracks, then validate raw subagent outputs, drop dirty data deterministically, dedupe GitHub items, and format a final report.",
    parameters: MultiAgentOrchestratorSchema,
    async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
      const action = typeof rawParams.action === "string" ? rawParams.action : "";
      log?.(`[tool] action=${action || "unknown"}`);

      if (action === "plan_tracks") {
        const request = typeof rawParams.request === "string" ? rawParams.request : undefined;
        const agentType = typeof rawParams.agentType === "string" ? rawParams.agentType : undefined;
        const agentCategory = typeof rawParams.agentCategory === "string" ? rawParams.agentCategory : undefined;
        const agentRegistryPath = typeof rawParams.agentRegistryPath === "string" ? rawParams.agentRegistryPath : undefined;
        const rawCustomTracks = Array.isArray(rawParams.customTracks) ? rawParams.customTracks : undefined;
        const customTracks = rawCustomTracks?.map((t: Record<string, unknown>) => ({
          trackId: String(t.trackId ?? ""),
          label: String(t.label ?? ""),
          goal: String(t.goal ?? ""),
        }));
        const templateIds = Array.isArray(rawParams.templateIds)
          ? (rawParams.templateIds as unknown[]).map(String)
          : undefined;

        let tracks;
        if (templateIds || (customTracks && !agentType && !agentCategory)) {
          const templateTracks = planCustomTracks({ templateIds, customTracks, request });
          if (templateTracks.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: "No tracks could be planned from the given input. Try specifying templateIds or customTracks.",
                },
              ],
            };
          }
          tracks = templateTracks;
        } else {
          const agentTracks = planTracksWithAgents({ request, agentType, agentCategory, agentRegistryPath, customTracks });
          tracks = agentTracks ?? inferResearchTracks(request);
        }
        let report = buildPlanningReport(request, tracks);
        log?.(`[tool] action=plan_tracks tracks=${tracks.length}`);

        if (params?.sessionState) {
          recordPlan(params.sessionState, tracks.map((t) => ({
            trackId: t.trackId,
            label: t.label,
            contentType: (t as Record<string, unknown>).contentType as string | undefined,
          })));
        }
        log?.(`[audit] plan_created tracks=${tracks.length}`);
        if (params?.auditLog) {
          logEvent(params.auditLog, "plan_created", { trackCount: tracks.length, trackIds: tracks.map((t) => t.trackId) });
        }

        // Add OFMS topic suggestions to the report if available
        const sharedRoot = typeof rawParams.ofmsSharedRoot === "string" ? rawParams.ofmsSharedRoot : undefined;
        if (sharedRoot) {
          const suggestions = suggestTracksFromTopics(sharedRoot);
          if (suggestions.length > 0) {
            report +=
              "\n\nOFMS 话题建议\n" +
              suggestions
                .map((s) => `- ${s.topic} (importance: ${s.importance.toFixed(1)}) → ${s.suggestedGoal}`)
                .join("\n");
          }
        }

        return {
          content: [{ type: "text", text: report }],
          details: {
            windowDays: inferRecentWindowDays(request),
            tracks,
          },
        };
      }

      if (action === "enforce_execution_policy") {
        const state: ExecutionGuardRequest = {
          request: typeof rawParams.request === "string" ? rawParams.request : undefined,
          taskState: typeof rawParams.taskState === "string" ? rawParams.taskState : undefined,
          hasTaskBus: Boolean(rawParams.hasTaskBus),
          hasPlan: Boolean(rawParams.hasPlan),
          hasCheckpoint: Boolean(rawParams.hasCheckpoint),
          hasWorkerStart: Boolean(rawParams.hasWorkerStart),
          hasTrackedExecution: Boolean(rawParams.hasTrackedExecution),
          hasCompletedStep: Boolean(rawParams.hasCompletedStep),
          hasFinalMerge: Boolean(rawParams.hasFinalMerge),
          currentStep: typeof rawParams.currentStep === "number" ? rawParams.currentStep : 0,
          totalSteps: typeof rawParams.totalSteps === "number" ? rawParams.totalSteps : 0,
        };
        const { report, details } = buildExecutionPolicyReport({
          mode: executionPolicy,
          delegationStartGate,
          request: state.request,
          state,
        });
        log?.(
          `[tool] action=enforce_execution_policy policy=${executionPolicy} violations=${details.violations.length}`,
        );
        if (params?.sessionState) {
          recordEnforcement(params.sessionState, details.violations, executionPolicy);
          recordToolCall(params.sessionState);
        }
        if (params?.auditLog) {
          logEvent(params.auditLog, "policy_check", { mode: executionPolicy, violations: details.violations, verified: !!state });
        }
        return {
          content: [{ type: "text", text: report }],
          details,
        };
      }

      if (action === "orchestrate") {
        const request = typeof rawParams.request === "string" ? rawParams.request : "";
        if (!request) {
          throw new Error("request is required for orchestrate action");
        }

        // Resolve the task board — prefer injected board (testing), then file-based
        const sharedRoot =
          typeof rawParams.ofmsSharedRoot === "string"
            ? rawParams.ofmsSharedRoot
            : (params?.sharedRoot ?? "");
        const board: TaskBoard = params?.board ?? (sharedRoot ? loadBoard(sharedRoot) : { projects: [], version: 1 });

        // Plan tracks using existing logic
        const agentType = typeof rawParams.agentType === "string" ? rawParams.agentType : undefined;
        const agentCategory =
          typeof rawParams.agentCategory === "string" ? rawParams.agentCategory : undefined;
        const agentRegistryPath =
          typeof rawParams.agentRegistryPath === "string" ? rawParams.agentRegistryPath : undefined;
        const rawCustomTracks = Array.isArray(rawParams.customTracks) ? rawParams.customTracks : undefined;
        const customTracks = rawCustomTracks?.map((t: Record<string, unknown>) => ({
          trackId: String(t.trackId ?? ""),
          label: String(t.label ?? ""),
          goal: String(t.goal ?? ""),
        }));
        const templateIds = Array.isArray(rawParams.templateIds)
          ? (rawParams.templateIds as unknown[]).map(String)
          : undefined;

        let tracks;
        if (templateIds || (customTracks && !agentType && !agentCategory)) {
          tracks = planCustomTracks({ templateIds, customTracks, request });
          if (tracks.length === 0) {
            throw new Error(
              "No tracks could be planned from the given input. Try specifying templateIds or customTracks.",
            );
          }
        } else {
          const agentTracks = planTracksWithAgents({
            request,
            agentType,
            agentCategory,
            agentRegistryPath,
            customTracks,
          });
          tracks = agentTracks ?? inferResearchTracks(request);
        }

        // Create project and tasks on the board
        const project = createProject(board, { name: request.slice(0, 50), request });
        for (const track of tracks) {
          addTask(project, {
            trackId: track.trackId,
            label: track.label,
            agentType: track.agentType as string | undefined,
            contentType: track.contentType,
            subagentPrompt: track.subagentPrompt,
          });
        }

        // Persist if we have a shared root
        if (sharedRoot) {
          saveBoard(sharedRoot, board);
        }

        const guidance = buildDispatchGuidance(project);
        log?.(`[tool] action=orchestrate projectId=${project.id} tasks=${project.tasks.length}`);
        if (params?.auditLog) {
          logEvent(params.auditLog, "plan_created", {
            projectId: project.id,
            trackCount: project.tasks.length,
            trackIds: project.tasks.map((t) => t.trackId),
          });
        }

        return {
          content: [{ type: "text", text: guidance }],
          details: {
            projectId: project.id,
            tasks: project.tasks.map((t) => ({ id: t.id, label: t.label, trackId: t.trackId })),
          },
        };
      }

      if (action === "evolve") {
        const sharedRoot =
          typeof rawParams.ofmsSharedRoot === "string"
            ? rawParams.ofmsSharedRoot
            : (params?.sharedRoot ?? "");

        if (!sharedRoot) {
          return {
            content: [{ type: "text", text: "evolve requires sharedRoot or ofmsSharedRoot." }],
          };
        }

        const intentRegistry = params?.intentRegistry ?? {
          patterns: {},
          totalClassifications: 0,
          totalCorrections: 0,
          lastUpdated: new Date().toISOString(),
          version: 1,
        };
        const userKeywords = params?.userKeywords ?? { delegation: [], tracked: [], light: [], updatedAt: "" };
        const enforcementState = params?.enforcementState ?? {
          currentLevel: 0 as const,
          levelHistory: [],
          lastUpgrade: null,
          lastDowngrade: null,
          observationCount: 0,
          correctionCount: 0,
          consecutiveAccurateDays: 0,
          installedAt: new Date().toISOString(),
          version: 1,
        };

        const report = runEvolutionCycle({
          sharedRoot,
          intentRegistry,
          userKeywords,
          enforcementState,
          existingDelegationKeywords: params?.existingDelegationKeywords ?? [],
          existingTrackedKeywords: params?.existingTrackedKeywords ?? [],
        });

        // Persist updated state
        saveUserKeywords(sharedRoot, userKeywords);
        saveIntentRegistry(sharedRoot, intentRegistry);
        saveEnforcementState(sharedRoot, enforcementState);
        appendEvolutionReport(sharedRoot, report);

        log?.(`[tool] action=evolve applied=${report.autoApplied.length} pending=${report.pendingReview.length}`);

        return {
          content: [{ type: "text", text: formatEvolutionReport(report) }],
          details: report,
        };
      }

      if (action !== "validate_and_merge") {
        throw new Error("Unsupported action");
      }

      const rawTracks = Array.isArray(rawParams.tracks) ? rawParams.tracks : [];
      if (rawTracks.length === 0) {
        throw new Error("tracks required");
      }

      // Runtime validation: ensure each track has required fields
      for (const track of rawTracks) {
        if (typeof track.trackId !== "string" || !track.trackId) {
          throw new Error("Each track must have a trackId");
        }
        if (typeof track.resultText !== "string") {
          throw new Error(`Track "${track.trackId}" is missing resultText`);
        }
      }

      const tracks = rawTracks as TrackInput[];
      const classified = tracks.map((track) => classifyTrack(track, maxItemsPerTrack));
      const { deduped, duplicates } = dedupeItems(classified);
      let report = buildHumanReport({
        request: typeof rawParams.request === "string" ? rawParams.request : undefined,
        tracks: classified,
        deduped,
        duplicates,
      });
      log?.(
        `[tool] action=validate_and_merge tracks=${classified.length} kept=${deduped.length} duplicates=${duplicates}`,
      );

      if (params?.sessionState) {
        for (const track of classified) {
          recordTrackResult(params.sessionState, track.trackId, track.status);
        }

        const missing = getMissingTracks(params.sessionState);
        const unplanned = getUnplannedTracks(params.sessionState, classified.map((t) => t.trackId));

        if (missing.length > 0) {
          report += `\n\n⚠️ 未提交的 track: ${missing.join(", ")}`;
        }
        if (unplanned.length > 0) {
          report += `\n\n⚠️ 计划外的 track: ${unplanned.join(", ")}`;
        }
      }
      if (params?.auditLog) {
        logEvent(params.auditLog, "merge_completed", { trackCount: classified.length, kept: deduped.length, duplicates });
      }

      if (typeof rawParams.ofmsSharedRoot === "string" && deduped.length > 0) {
        const feedbackCount = feedbackToOfms({
          sharedRoot: rawParams.ofmsSharedRoot,
          agent: "multi-agent-orchestrator",
          validatedItems: deduped.map((item) => ({
            title: item.title,
            url: item.url,
            trackLabel: item.label,
          })),
          request: typeof rawParams.request === "string" ? rawParams.request : undefined,
        });
        log?.(`[tool] OFMS feedback: ${feedbackCount} candidates enqueued`);
      }

      return {
        content: [{ type: "text", text: report }],
        details: {
          tracks: classified.map((track) => ({
            trackId: track.trackId,
            label: track.label,
            status: track.status,
            keptItems: track.items.length,
            dirtyReasons: track.dirtyReasons,
          })),
          finalItems: deduped,
          duplicatesRemoved: duplicates,
          statusCounts: {
            ok: classified.filter((track) => track.status === "ok").length,
            partial: classified.filter((track) => track.status === "partial").length,
            failed: classified.filter((track) => track.status === "failed").length,
          },
        },
      };
    },
  };
}
