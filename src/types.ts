export type TrackInput = {
  trackId: string;
  label?: string;
  resultText: string;
  required?: boolean;
};

export type ExecutionPolicyMode =
  | "free"
  | "guided"
  | "tracked"
  | "delegation-first"
  | "strict-orchestrated";

export type DelegationStartGateMode = "off" | "advisory" | "required";

export type ExecutionGuardRequest = {
  request?: string;
  taskState?: string;
  hasTaskBus?: boolean;
  hasPlan?: boolean;
  hasCheckpoint?: boolean;
  hasWorkerStart?: boolean;
  hasTrackedExecution?: boolean;
  hasCompletedStep?: boolean;
  hasFinalMerge?: boolean;
  currentStep?: number;
  totalSteps?: number;
};

export type PlannedTrack = {
  trackId: string;
  label: string;
  goal: string;
  outputContract: string[];
  failureContract: string[];
  subagentPrompt: string;
};

export type CandidateItem = {
  title: string;
  url: string;
  raw: string;
  comments: number | null;
};

export type OrchestratorConfig = {
  maxItemsPerTrack?: number;
  executionPolicy?: ExecutionPolicyMode;
  delegationStartGate?: DelegationStartGateMode;
  logger?: (message: string) => void;
};
