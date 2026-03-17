import type { TrackInput, ExecutionPolicyMode, DelegationStartGateMode, ExecutionGuardRequest } from "./types.ts";
import { buildExecutionPolicyReport } from "./execution-policy.ts";
import { inferResearchTracks, inferRecentWindowDays, buildPlanningReport } from "./track-planner.ts";
import { planTracksWithAgents } from "./agent-registry.ts";
import { planCustomTracks } from "./track-templates.ts";
import { classifyTrack, dedupeItems } from "./candidate-extractor.ts";
import { buildHumanReport } from "./report-builder.ts";
import { suggestTracksFromTopics, feedbackToOfms } from "./ofms-bridge.ts";

export { MultiAgentOrchestratorSchema } from "./schema.ts";
import { MultiAgentOrchestratorSchema } from "./schema.ts";

export function createMultiAgentOrchestratorTool(params?: {
  maxItemsPerTrack?: number;
  executionPolicy?: ExecutionPolicyMode;
  delegationStartGate?: DelegationStartGateMode;
  logger?: (message: string) => void;
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
        return {
          content: [{ type: "text", text: report }],
          details,
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
      const report = buildHumanReport({
        request: typeof rawParams.request === "string" ? rawParams.request : undefined,
        tracks: classified,
        deduped,
        duplicates,
      });
      log?.(
        `[tool] action=validate_and_merge tracks=${classified.length} kept=${deduped.length} duplicates=${duplicates}`,
      );

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
