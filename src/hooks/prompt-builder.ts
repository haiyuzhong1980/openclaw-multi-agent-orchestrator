import { existsSync } from "node:fs";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { buildOrchestratorPromptGuidance, buildDispatchGuidance, buildDelegationMandate } from "../prompt-guidance.ts";
import { loadAgentRegistry } from "../agent-registry.ts";
import { getActiveProjects } from "../task-board.ts";
import { getEnforcementBehavior } from "../enforcement-ladder.ts";
import { checkAndResume, buildResumePrompt } from "../session-resume.ts";
import { needsOnboarding, generateWelcomeMessage } from "../onboarding.ts";
import type { PluginState } from "../plugin-state.ts";

export function createPromptBuilder(
  state: PluginState,
  config: { executionPolicy: string; agentRegistryPath: string },
  api: Pick<OpenClawPluginApi, "logger">,
  sharedRoot: string,
): () => Promise<{ prependSystemContext: string } | { appendSystemContext: string } | undefined> {
  return async (): Promise<{ prependSystemContext: string } | { appendSystemContext: string } | undefined> => {
    // EV5: Onboarding — show welcome on first call for new users
    if (needsOnboarding(state.onboardingState) && !state.onboardingMessageSent) {
      state.onboardingMessageSent = true;
      return { prependSystemContext: generateWelcomeMessage(state.onboardingState) };
    }

    const behavior = getEnforcementBehavior(state.enforcementState.currentLevel);

    // Level 0: silent — no guidance injection
    if (!behavior.injectGuidance) return undefined;

    let guidance = buildOrchestratorPromptGuidance(config.executionPolicy);
    if (existsSync(sharedRoot)) {
      guidance +=
        `\n\nOFMS shared memory is available at ${sharedRoot}. Pass ofmsSharedRoot="${sharedRoot}" to multi-agent-orchestrator for topic-aware planning and result feedback.`;
    }

    // E5: Inject resume context on first prompt build after startup
    if (!state.resumeInjected) {
      state.resumeInjected = true;
      const resumeResult = checkAndResume(state.board);
      const resumePrompt = buildResumePrompt(resumeResult);
      if (resumePrompt) {
        guidance += `\n\n${resumePrompt}`;
        api.logger.info(`[OMA] Session resume: ${resumeResult.actions.length} pending actions detected`);
      }
    }

    // Inject dispatch guidance for active projects with pending tasks (Level 2+)
    if (behavior.injectDispatchPlan) {
      const activeProjects = getActiveProjects(state.board);
      if (activeProjects.length > 0) {
        const project = activeProjects[activeProjects.length - 1];
        const dispatchGuidance = buildDispatchGuidance(project);
        if (dispatchGuidance) {
          guidance += dispatchGuidance;
        }
      }
    }

    // Level 1 soft advisory message
    if (behavior.advisoryMessage) {
      guidance += "\n" + behavior.advisoryMessage;
    }

    // L1: 当检测到 delegation tier 时，注入强制编排指令
    if (state.pendingDelegationRequest) {
      state.delegationInjectionCount++;
      const agentNames = (() => {
        try {
          const registry = loadAgentRegistry(config.agentRegistryPath);
          return registry.agents.map((a) => `${a.name} (${a.category}): ${a.description?.slice(0, 60) ?? ""}`);
        } catch {
          return undefined;
        }
      })();
      guidance += buildDelegationMandate(state.pendingDelegationRequest, agentNames);
      // 只在第一次注入时打日志，避免重复日志噪音
      if (state.delegationInjectionCount === 1) {
        api.logger.info(`[OMA/L1] Delegation mandate injected for: ${state.pendingDelegationRequest.slice(0, 80)}`);
      }
      // 不清空 pendingDelegationRequest — 让它在整个对话轮次中保持，直到下一条消息覆盖
    }

    return { appendSystemContext: guidance };
  };
}
