import { existsSync } from "node:fs";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { extractIntentPhrases, recordClassification, recordCorrection, recordConfirmation, detectCorrection } from "../intent-registry.ts";
import { inferExecutionComplexity } from "../execution-policy.ts";
import {
  createObservation,
  appendObservation,
  updateObservationFeedback,
  detectFeedbackSignal,
} from "../observation-engine.ts";
import {
  saveOnboardingState,
  processOnboardingResponse,
} from "../onboarding.ts";
import { saveUserKeywords } from "../user-keywords.ts";
import { saveEnforcementState } from "../enforcement-ladder.ts";
import type { PluginState } from "../plugin-state.ts";

export function createMessageHandler(
  state: PluginState,
  api: Pick<OpenClawPluginApi, "logger">,
  sharedRoot: string,
): (event: Record<string, unknown>) => Promise<undefined> {
  return async (event: Record<string, unknown>): Promise<undefined> => {
    const text = (event.content as string | undefined)?.trim();
    if (!text) return undefined;

    // EV5: Process onboarding response if onboarding not yet completed
    if (!state.onboardingState.completed && /^[1-3][a-e]/i.test(text)) {
      const result = processOnboardingResponse({
        response: text,
        onboardingState: state.onboardingState,
        userKeywords: state.userKeywords,
        enforcementState: state.enforcementState,
      });
      if (result.configured) {
        if (existsSync(sharedRoot)) {
          saveOnboardingState(sharedRoot, state.onboardingState);
          saveUserKeywords(sharedRoot, state.userKeywords);
          saveEnforcementState(sharedRoot, state.enforcementState);
        }
        api.logger.info(`[OMA] Onboarding complete: level=${result.initialLevel}, keywords=${result.keywordsAdded.length}`);
      }
    }

    // Extract phrases for intent learning
    const phrases = extractIntentPhrases(text);

    // Check if this is a correction of previous classification
    if (state.lastClassification) {
      const correction = detectCorrection(text, state.lastClassification.tier);
      if (correction.isCorrection && correction.actualTier) {
        recordCorrection(state.intentRegistry, state.lastClassification.phrases, state.lastClassification.tier, correction.actualTier);
        api.logger.info(`[OMA] Intent correction detected: ${state.lastClassification.tier} → ${correction.actualTier}`);
      }
    }

    // Check if this message is feedback on the previous observation
    if (state.currentObservationId && state.lastClassification && existsSync(sharedRoot)) {
      const feedback = detectFeedbackSignal(text, state.lastClassification.tier);
      updateObservationFeedback(sharedRoot, state.currentObservationId, {
        userFollowUp: feedback.type,
        actualTier: feedback.actualTier,
      });
      
      // Learn from confirmation: reinforce the correct classification
      if (feedback.type === "satisfied" && state.lastClassification) {
        recordConfirmation(state.intentRegistry, state.lastClassification.phrases, state.lastClassification.tier);
        api.logger.info(`[OMA] Intent confirmation learned: ${state.lastClassification.tier}`);
      }
    }

    // Record the current classification
    const tier = inferExecutionComplexity(text, state.intentRegistry, state.userKeywords);
    recordClassification(state.intentRegistry, phrases, tier);
    state.lastClassification = { phrases, tier, timestamp: Date.now() };

    // L1: 当检测到 delegation tier，记录请求以便 before_prompt_build 注入强制指令
    if (tier === "delegation") {
      state.pendingDelegationRequest = text;
      state.delegationInjectionCount = 0;
      state.currentDelegationSpawnCount = 0;
      state.softBlockWarningCount = 0;  // Reset L2 soft block counter for new delegation
      api.logger.info(`[OMA/L1] Delegation detected, will inject mandate on next prompt build`);
    } else {
      state.pendingDelegationRequest = null;
      state.delegationInjectionCount = 0;
      state.softBlockWarningCount = 0;  // Reset on non-delegation messages too
    }

    // Create new observation
    if (existsSync(sharedRoot)) {
      const obs = createObservation({
        message: text,
        agent: (event.channelId as string | undefined) ?? "unknown",
        predictedTier: tier,
      });
      appendObservation(sharedRoot, obs);
      state.currentObservationId = obs.id;
    }

    state.scheduleIntentRegistrySave();
    return undefined;
  };
}
