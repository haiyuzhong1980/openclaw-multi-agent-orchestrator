import { existsSync } from "node:fs";
import { createSpawnTracker } from "./spawn-tracker.ts";
import type { SpawnTracker } from "./spawn-tracker.ts";
import { loadBoard, saveBoard } from "./task-board.ts";
import type { TaskBoard } from "./task-board.ts";
import { loadUserKeywords, saveUserKeywords } from "./user-keywords.ts";
import type { UserKeywords } from "./user-keywords.ts";
import {
  loadIntentRegistry,
  saveIntentRegistry,
} from "./intent-registry.ts";
import type { IntentRegistry } from "./intent-registry.ts";
import { loadEnforcementState } from "./enforcement-ladder.ts";
import type { EnforcementState } from "./enforcement-ladder.ts";
import { loadOnboardingState } from "./onboarding.ts";
import type { OnboardingState } from "./onboarding.ts";
import { createAuditLog } from "./audit-log.ts";
import type { AuditLog } from "./audit-log.ts";
import { createSessionState } from "./session-state.ts";
import type { OrchestratorSessionState } from "./session-state.ts";

export type { SpawnTracker, TaskBoard, UserKeywords, IntentRegistry, EnforcementState, OnboardingState, OrchestratorSessionState };

export interface PluginState {
  board: TaskBoard;
  userKeywords: UserKeywords;
  intentRegistry: IntentRegistry;
  enforcementState: EnforcementState;
  onboardingState: OnboardingState;
  spawnTracker: SpawnTracker;
  auditLog: AuditLog;
  sessionState: OrchestratorSessionState;
  resumeInjected: boolean;
  onboardingMessageSent: boolean;
  lastClassification: { phrases: string[]; tier: "light" | "tracked" | "delegation"; timestamp: number } | null;
  currentObservationId: string | null;
  pendingDelegationRequest: string | null;
  delegationInjectionCount: number;
  currentDelegationSpawnCount: number;
  scheduleBoardSave: () => void;
  scheduleIntentRegistrySave: () => void;
}

export function createPluginState(sharedRoot: string): PluginState {
  const board: TaskBoard = existsSync(sharedRoot)
    ? loadBoard(sharedRoot)
    : { projects: [], version: 1 };

  const userKeywords: UserKeywords = existsSync(sharedRoot)
    ? loadUserKeywords(sharedRoot)
    : { delegation: [], tracked: [], light: [], updatedAt: "" };

  const intentRegistry: IntentRegistry = existsSync(sharedRoot)
    ? loadIntentRegistry(sharedRoot)
    : {
        patterns: {},
        totalClassifications: 0,
        totalCorrections: 0,
        lastUpdated: new Date().toISOString(),
        version: 1,
      };

  const enforcementState: EnforcementState = loadEnforcementState(sharedRoot);

  const onboardingState: OnboardingState = existsSync(sharedRoot)
    ? loadOnboardingState(sharedRoot)
    : { completed: false, userProfile: { customPhrases: [] } };

  const spawnTracker: SpawnTracker = createSpawnTracker();
  const auditLog: AuditLog = createAuditLog(200);
  const sessionState: OrchestratorSessionState = createSessionState();

  let boardSaveTimer: ReturnType<typeof setTimeout> | undefined;
  let intentRegistrySaveTimer: ReturnType<typeof setTimeout> | undefined;

  function scheduleBoardSave(): void {
    if (boardSaveTimer) clearTimeout(boardSaveTimer);
    boardSaveTimer = setTimeout(() => {
      if (existsSync(sharedRoot)) {
        saveBoard(sharedRoot, board);
      }
    }, 500);
  }

  function scheduleIntentRegistrySave(): void {
    if (intentRegistrySaveTimer) clearTimeout(intentRegistrySaveTimer);
    intentRegistrySaveTimer = setTimeout(() => {
      if (existsSync(sharedRoot)) {
        saveIntentRegistry(sharedRoot, intentRegistry);
      }
    }, 1000);
  }

  return {
    board,
    userKeywords,
    intentRegistry,
    enforcementState,
    onboardingState,
    spawnTracker,
    auditLog,
    sessionState,
    resumeInjected: false,
    onboardingMessageSent: false,
    lastClassification: null,
    currentObservationId: null,
    pendingDelegationRequest: null,
    delegationInjectionCount: 0,
    currentDelegationSpawnCount: 0,
    scheduleBoardSave,
    scheduleIntentRegistrySave,
  };
}
