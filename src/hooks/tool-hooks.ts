import { existsSync } from "node:fs";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { logEvent } from "../audit-log.ts";
import { getEnforcementBehavior } from "../enforcement-ladder.ts";
import { ALWAYS_ALLOWED_TOOLS } from "../spawn-tracker.ts";
import { updateObservationOutcome } from "../observation-engine.ts";
import type { PluginState } from "../plugin-state.ts";

export function createToolHooks(
  state: PluginState,
  api: Pick<OpenClawPluginApi, "logger">,
  sharedRoot: string,
  options?: { executionPolicy?: string; delegationStartGate?: string },
): {
  beforeToolCall: (event: Record<string, unknown>) => Promise<{ blockReason: string } | undefined>;
  afterToolCall: (event: Record<string, unknown>) => Promise<undefined>;
} {
  const executionPolicy = options?.executionPolicy;
  const delegationStartGate = options?.delegationStartGate;

  async function beforeToolCall(event: Record<string, unknown>): Promise<{ blockReason: string } | undefined> {
    const blockReason = event.blockReason as string | undefined;
    if (blockReason) {
      logEvent(state.auditLog, "tool_blocked", { toolName: event.toolName, reason: blockReason });
    }

    const toolName = event.toolName as string | undefined;
    const behavior = getEnforcementBehavior(state.enforcementState.currentLevel);

    // Level 3: hard block non-dispatch tools when delegation is pending
    if (behavior.blockNonDispatchTools && state.pendingDelegationRequest && toolName) {
      // Skip blocking if executionPolicy is "free" or delegationStartGate is "off"
      if (executionPolicy === "free" || delegationStartGate === "off") {
        return undefined;
      }

      if (!ALWAYS_ALLOWED_TOOLS.has(toolName)) {
        if (state.currentDelegationSpawnCount === 0) {
          logEvent(state.auditLog, "tool_blocked_l3", { toolName, reason: "delegation_required" });
          api.logger.info(`[OMA/L3] Blocked ${toolName} — delegation required, no agents spawned yet`);
          return {
            blockReason: `OMA enforcement level 3: 当前任务需要先派遣子 agent。请先调用 multi-agent-orchestrator action=orchestrate 创建任务，然后用 Agent tool 派遣子 agent。被拦截的工具: ${toolName}`,
          };
        }
      }
    }

    if (!behavior.blockNonDispatchTools) {
      // Level 0: silent
      if (behavior.logOnly) return undefined;
      // Level 1, 2: log but allow
      return undefined;
    }

    return undefined;
  }

  async function afterToolCall(event: Record<string, unknown>): Promise<undefined> {
    if (state.currentObservationId && existsSync(sharedRoot)) {
      const toolName = event.toolName as string | undefined;
      if (toolName) {
        updateObservationOutcome(sharedRoot, state.currentObservationId, {
          toolsCalled: [toolName],
          didSpawnSubagent: toolName === "sessions_spawn",
          spawnCount: toolName === "sessions_spawn" ? 1 : 0,
        });
      }
    }
    return undefined;
  }

  return { beforeToolCall, afterToolCall };
}
