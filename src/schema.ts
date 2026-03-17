export const MultiAgentOrchestratorSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: {
      type: "string",
      enum: ["plan_tracks", "validate_and_merge", "enforce_execution_policy", "orchestrate", "evolve"],
      description: "Operation to perform.",
    },
    request: {
      type: "string",
      description: "Original user request.",
    },
    tracks: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          trackId: { type: "string", description: "Stable track id, e.g. issues-track." },
          label: { type: "string", description: "Human-readable track label." },
          resultText: { type: "string", description: "Raw child-agent result text." },
          required: { type: "boolean", description: "Whether this track is required." },
          contentType: {
            type: "string",
            enum: ["github-url", "text-analysis", "structured-data"],
            description: "Content type of track results. Determines validation strategy.",
          },
        },
        required: ["trackId", "resultText"],
      },
    },
    taskState: { type: "string", description: "Current orchestrator task state, if any." },
    hasTaskBus: { type: "boolean", description: "Whether a tracked task bus already exists." },
    hasPlan: { type: "boolean", description: "Whether an explicit step plan has been created." },
    hasCheckpoint: {
      type: "boolean",
      description: "Whether the user already received a kickoff or checkpoint update.",
    },
    hasWorkerStart: {
      type: "boolean",
      description: "Whether a real worker/subagent spawn already happened.",
    },
    hasTrackedExecution: {
      type: "boolean",
      description: "Whether a tracked execution already started.",
    },
    hasCompletedStep: {
      type: "boolean",
      description: "Whether the current step already has a completed result.",
    },
    hasFinalMerge: {
      type: "boolean",
      description: "Whether final merge/acceptance already happened.",
    },
    currentStep: { type: "integer", minimum: 0, description: "Current step number." },
    totalSteps: { type: "integer", minimum: 0, description: "Total step count." },
    agentType: {
      type: "string",
      description: "Agent name or keyword to search for in the agent registry (used with plan_tracks).",
    },
    agentCategory: {
      type: "string",
      description: "Agent category to pick from in the agent registry (used with plan_tracks).",
    },
    agentRegistryPath: {
      type: "string",
      description: "Path to the agent library root directory (used with plan_tracks when agentType or agentCategory is set).",
    },
    templateIds: {
      type: "array",
      items: { type: "string" },
      description:
        "Track template IDs to use (e.g., 'security-audit', 'competitive-analysis'). Use /mao-templates to see available templates.",
    },
    customTracks: {
      type: "array",
      description: "Custom track definitions to use instead of keyword inference (used with plan_tracks).",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          trackId: { type: "string", description: "Stable track identifier." },
          label: { type: "string", description: "Human-readable track label." },
          goal: { type: "string", description: "Track goal description." },
        },
        required: ["trackId", "label", "goal"],
      },
    },
    ofmsSharedRoot: {
      type: "string",
      description:
        "Path to OFMS shared memory root. When provided, enables topic-driven planning and result feedback.",
    },
  },
  required: ["action"],
} as const;
