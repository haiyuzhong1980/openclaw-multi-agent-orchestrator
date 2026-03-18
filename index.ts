import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createMultiAgentOrchestratorTool, MultiAgentOrchestratorSchema } from "./src/tool.ts";
import { buildOrchestratorPromptGuidance, buildDispatchGuidance, buildDelegationMandate } from "./src/prompt-guidance.ts";
import { loadAgentRegistry, searchAgents, getAgentsByCategory } from "./src/agent-registry.ts";
import { listTemplates, findTemplate } from "./src/track-templates.ts";
import { createAuditLog, logEvent, formatAuditReport } from "./src/audit-log.ts";
import { createSessionState, getMissingTracks } from "./src/session-state.ts";
import {
  loadBoard,
  saveBoard,
  getActiveProjects,
  getProject,
  updateTaskStatus,
  advanceProjectStatus,
  formatBoardDisplay,
} from "./src/task-board.ts";
import type { TaskBoard } from "./src/task-board.ts";
import { processSubagentResult, isProjectReadyForReview } from "./src/result-collector.ts";
import { reviewProject, prepareRetries } from "./src/review-gate.ts";
import { checkAndResume, buildResumePrompt } from "./src/session-resume.ts";
import { generateProjectReport } from "./src/report-generator.ts";
import { loadUserKeywords, saveUserKeywords, addUserKeyword } from "./src/user-keywords.ts";
import type { UserKeywords } from "./src/user-keywords.ts";
import {
  loadIntentRegistry,
  saveIntentRegistry,
  extractIntentPhrases,
  recordClassification,
  recordCorrection,
  detectCorrection,
} from "./src/intent-registry.ts";
import type { IntentRegistry } from "./src/intent-registry.ts";
import { inferExecutionComplexity } from "./src/execution-policy.ts";
import {
  createObservation,
  appendObservation,
  updateObservationOutcome,
  updateObservationFeedback,
  detectFeedbackSignal,
  flushBuffer,
  loadRecentObservations,
  computeStats,
} from "./src/observation-engine.ts";
import { discoverPatterns, formatDiscoveryReport } from "./src/pattern-discovery.ts";
import {
  loadEnforcementState,
  saveEnforcementState,
  getEnforcementBehavior,
  evaluateAndAdjust,
  formatEnforcementStatus,
  createDefaultState,
} from "./src/enforcement-ladder.ts";
import {
  runEvolutionCycle,
  appendEvolutionReport,
  loadEvolutionHistory,
  formatEvolutionReport,
} from "./src/evolution-cycle.ts";
import {
  loadOnboardingState,
  saveOnboardingState,
  needsOnboarding,
  generateWelcomeMessage,
  processOnboardingResponse,
} from "./src/onboarding.ts";
import type { OnboardingState } from "./src/onboarding.ts";
import {
  exportPatterns,
  importPatterns,
  serializeExport,
  parseImport,
} from "./src/pattern-export.ts";

const OFMS_SHARED_ROOT =
  process.env.OFMS_SHARED_ROOT ?? join(process.env.HOME ?? "", ".openclaw/shared-memory");

type PluginConfig = {
  enabledPromptGuidance?: boolean;
  maxItemsPerTrack?: number;
  executionPolicy?: "free" | "guided" | "tracked" | "delegation-first" | "strict-orchestrated";
  delegationStartGate?: "off" | "advisory" | "required";
};

export default function register(api: OpenClawPluginApi) {
  const pluginConfig = (api.pluginConfig ?? {}) as PluginConfig;
  const executionPolicy =
    typeof pluginConfig.executionPolicy === "string" ? pluginConfig.executionPolicy : "delegation-first";
  const delegationStartGate =
    pluginConfig.delegationStartGate === "off" ||
    pluginConfig.delegationStartGate === "advisory" ||
    pluginConfig.delegationStartGate === "required"
      ? pluginConfig.delegationStartGate
      : "required";

  const auditLog = createAuditLog(200);
  const sessionState = createSessionState();

  // Load task board from shared memory root
  const board: TaskBoard = existsSync(OFMS_SHARED_ROOT) ? loadBoard(OFMS_SHARED_ROOT) : { projects: [], version: 1 };

  // Session resume: track whether we have injected the resume prompt yet
  let resumeInjected = false;

  // Debounced board save
  let boardSaveTimer: ReturnType<typeof setTimeout> | undefined;
  function scheduleBoardSave(): void {
    if (boardSaveTimer) clearTimeout(boardSaveTimer);
    boardSaveTimer = setTimeout(() => {
      if (existsSync(OFMS_SHARED_ROOT)) {
        saveBoard(OFMS_SHARED_ROOT, board);
      }
    }, 500);
  }

  // Self-evolving intent detection state
  const userKeywords: UserKeywords = existsSync(OFMS_SHARED_ROOT)
    ? loadUserKeywords(OFMS_SHARED_ROOT)
    : { delegation: [], tracked: [], light: [], updatedAt: "" };

  const intentRegistry: IntentRegistry = existsSync(OFMS_SHARED_ROOT)
    ? loadIntentRegistry(OFMS_SHARED_ROOT)
    : { patterns: {}, totalClassifications: 0, totalCorrections: 0, lastUpdated: new Date().toISOString(), version: 1 };

  let lastClassification: { phrases: string[]; tier: "light" | "tracked" | "delegation"; timestamp: number } | null = null;
  let currentObservationId: string | null = null;

  // L1: 自动编排 — 当检测到 delegation tier 时，记录请求，在下次 prompt build 时注入强制指令
  let pendingDelegationRequest: string | null = null;

  let intentRegistrySaveTimer: ReturnType<typeof setTimeout> | undefined;
  function scheduleIntentRegistrySave(): void {
    if (intentRegistrySaveTimer) clearTimeout(intentRegistrySaveTimer);
    intentRegistrySaveTimer = setTimeout(() => {
      if (existsSync(OFMS_SHARED_ROOT)) {
        saveIntentRegistry(OFMS_SHARED_ROOT, intentRegistry);
      }
    }, 1000);
  }

  // EV3: Progressive enforcement ladder state
  let enforcementState = loadEnforcementState(OFMS_SHARED_ROOT);

  // EV5: Onboarding state
  let onboardingState: OnboardingState = existsSync(OFMS_SHARED_ROOT)
    ? loadOnboardingState(OFMS_SHARED_ROOT)
    : { completed: false, userProfile: { customPhrases: [] } };
  let onboardingMessageSent = false;

  const tool = createMultiAgentOrchestratorTool({
    executionPolicy,
    delegationStartGate,
    maxItemsPerTrack:
      typeof pluginConfig.maxItemsPerTrack === "number" ? pluginConfig.maxItemsPerTrack : 8,
    logger: (message) => api.logger.info(`[multi-agent-orchestrator] ${message}`),
    sessionState,
    auditLog,
    sharedRoot: OFMS_SHARED_ROOT,
    board,
  });

  const typedTool: AnyAgentTool = {
    ...tool,
    parameters: MultiAgentOrchestratorSchema as AnyAgentTool["parameters"],
  };
  api.registerTool(typedTool);

  if (pluginConfig.enabledPromptGuidance !== false) {
    api.on("before_prompt_build", async () => {
      // EV5: Onboarding — show welcome on first call for new users
      if (needsOnboarding(onboardingState) && !onboardingMessageSent) {
        onboardingMessageSent = true;
        return { prependSystemContext: generateWelcomeMessage(onboardingState) };
      }

      const behavior = getEnforcementBehavior(enforcementState.currentLevel);

      // Level 0: silent — no guidance injection
      if (!behavior.injectGuidance) return undefined;

      let guidance = buildOrchestratorPromptGuidance(executionPolicy);
      if (existsSync(OFMS_SHARED_ROOT)) {
        guidance +=
          `\n\nOFMS shared memory is available at ${OFMS_SHARED_ROOT}. Pass ofmsSharedRoot="${OFMS_SHARED_ROOT}" to multi-agent-orchestrator for topic-aware planning and result feedback.`;
      }

      // E5: Inject resume context on first prompt build after startup
      if (!resumeInjected) {
        resumeInjected = true;
        const resumeResult = checkAndResume(board);
        const resumePrompt = buildResumePrompt(resumeResult);
        if (resumePrompt) {
          guidance += `\n\n${resumePrompt}`;
          api.logger.info(`[OMA] Session resume: ${resumeResult.actions.length} pending actions detected`);
        }
      }

      // Inject dispatch guidance for active projects with pending tasks (Level 2+)
      if (behavior.injectDispatchPlan) {
        const activeProjects = getActiveProjects(board);
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
      if (pendingDelegationRequest) {
        const agentNames = (() => {
          try {
            const registry = loadAgentRegistry();
            return registry.agents.map((a) => `${a.name} (${a.category}): ${a.description?.slice(0, 60) ?? ""}`);
          } catch {
            return undefined;
          }
        })();
        guidance += buildDelegationMandate(pendingDelegationRequest, agentNames);
        api.logger.info(`[OMA/L1] Delegation mandate injected for: ${pendingDelegationRequest.slice(0, 80)}`);
        // 不清空 pendingDelegationRequest — 让它在整个对话轮次中保持，直到下一条消息覆盖
      }

      return { appendSystemContext: guidance };
    });
  }

  api.on("message_received", async (event: Record<string, unknown>) => {
    const text = (event.content as string | undefined)?.trim();
    if (!text) return undefined;

    // EV5: Process onboarding response if onboarding not yet completed
    if (!onboardingState.completed && /^[1-3][a-e]/i.test(text)) {
      const result = processOnboardingResponse({
        response: text,
        onboardingState,
        userKeywords,
        enforcementState,
      });
      if (result.configured) {
        if (existsSync(OFMS_SHARED_ROOT)) {
          saveOnboardingState(OFMS_SHARED_ROOT, onboardingState);
          saveUserKeywords(OFMS_SHARED_ROOT, userKeywords);
          saveEnforcementState(OFMS_SHARED_ROOT, enforcementState);
        }
        api.logger.info(`[OMA] Onboarding complete: level=${result.initialLevel}, keywords=${result.keywordsAdded.length}`);
      }
    }

    // Extract phrases for intent learning
    const phrases = extractIntentPhrases(text);

    // Check if this is a correction of previous classification
    if (lastClassification) {
      const correction = detectCorrection(text, lastClassification.tier);
      if (correction.isCorrection && correction.actualTier) {
        recordCorrection(intentRegistry, lastClassification.phrases, lastClassification.tier, correction.actualTier);
        api.logger.info(`[OMA] Intent correction detected: ${lastClassification.tier} → ${correction.actualTier}`);
      }
    }

    // Check if this message is feedback on the previous observation
    if (currentObservationId && lastClassification && existsSync(OFMS_SHARED_ROOT)) {
      const feedback = detectFeedbackSignal(text, lastClassification.tier);
      updateObservationFeedback(OFMS_SHARED_ROOT, currentObservationId, {
        userFollowUp: feedback.type,
        actualTier: feedback.actualTier,
      });
    }

    // Record the current classification
    const tier = inferExecutionComplexity(text, intentRegistry, userKeywords);
    recordClassification(intentRegistry, phrases, tier);
    lastClassification = { phrases, tier, timestamp: Date.now() };

    // L1: 当检测到 delegation tier，记录请求以便 before_prompt_build 注入强制指令
    if (tier === "delegation") {
      pendingDelegationRequest = text;
      api.logger.info(`[OMA/L1] Delegation detected, will inject mandate on next prompt build`);
    } else {
      pendingDelegationRequest = null;
    }

    // Create new observation
    if (existsSync(OFMS_SHARED_ROOT)) {
      const obs = createObservation({
        message: text,
        agent: (event.channelId as string | undefined) ?? "unknown",
        predictedTier: tier,
      });
      appendObservation(OFMS_SHARED_ROOT, obs);
      currentObservationId = obs.id;
    }

    scheduleIntentRegistrySave();
    return undefined;
  });

  api.on("before_tool_call", async (event: Record<string, unknown>) => {
    const blockReason = event.blockReason as string | undefined;
    if (blockReason) {
      logEvent(auditLog, "tool_blocked", { toolName: event.toolName, reason: blockReason });
    }

    const behavior = getEnforcementBehavior(enforcementState.currentLevel);
    if (!behavior.blockNonDispatchTools) {
      // Level 0, 1, 2: don't block, just log
      if (behavior.logOnly) return undefined; // Level 0: silent
      // Level 1, 2: log but allow
      return undefined;
    }
    // Level 3: existing hard block logic is handled by the tool itself via blockReason above

    return undefined;
  });

  api.on("after_tool_call", async (event: Record<string, unknown>) => {
    if (currentObservationId && existsSync(OFMS_SHARED_ROOT)) {
      const toolName = event.toolName as string | undefined;
      if (toolName) {
        updateObservationOutcome(OFMS_SHARED_ROOT, currentObservationId, {
          toolsCalled: [toolName],
          didSpawnSubagent: toolName === "sessions_spawn",
          spawnCount: toolName === "sessions_spawn" ? 1 : 0,
        });
      }
    }
    return undefined;
  });

  api.on("subagent_spawned", async (event: Record<string, unknown>) => {
    const sessionKey = event.childSessionKey as string | undefined;
    const label = event.label as string | undefined;

    logEvent(auditLog, "subagent_spawned", {
      sessionKey,
      agentId: event.agentId,
      label,
    });

    // Find a pending task matching by label or trackId and mark dispatched
    if (sessionKey) {
      for (const project of board.projects) {
        if (project.status === "done" || project.status === "failed") continue;
        const task = project.tasks.find(
          (t) => t.status === "pending" && (label ? t.label === label || t.trackId === label : false),
        ) ?? project.tasks.find((t) => t.status === "pending");
        if (task) {
          updateTaskStatus(task, "dispatched", { sessionKey });
          advanceProjectStatus(project);
          scheduleBoardSave();
          break;
        }
      }
    }

    return undefined;
  });

  api.on("subagent_ended", async (event: Record<string, unknown>) => {
    const sessionKey = event.targetSessionKey as string | undefined;
    const outcome = event.outcome as string | undefined;

    logEvent(auditLog, "subagent_ended", { sessionKey, outcome });

    // E3: Update task board
    if (sessionKey) {
      const normalizedOutcome = (outcome === "failed" || outcome === "timeout" || outcome === "killed")
        ? (outcome as "error" | "timeout" | "killed")
        : "ok";

      const result = processSubagentResult({
        board,
        sessionKey,
        outcome: normalizedOutcome,
      });

      if (result.updated) {
        api.logger.info(`[OMA] Task ${result.taskId} updated: ${outcome}`);

        // E4: Auto-review when project is ready
        const project = getProject(board, result.projectId!);
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

        scheduleBoardSave();
      }
    }

    return undefined;
  });

  const AGENT_REGISTRY_PATH =
    process.env.AGENCY_AGENTS_PATH ?? join(process.env.HOME ?? "", "Documents/agency-agents-backup");

  api.registerCommand({
    name: "mao-agents",
    description: "List available agents from the agent library. Optionally search by keyword.",
    acceptsArgs: true,
    handler: (ctx) => {
      const registry = loadAgentRegistry(AGENT_REGISTRY_PATH);
      if (registry.agents.length === 0) {
        return { text: `No agents found at ${AGENT_REGISTRY_PATH}` };
      }
      const query = (ctx.args ?? "").trim();
      if (query) {
        const matches = searchAgents(registry, query);
        const lines = matches
          .slice(0, 20)
          .map(
            (a) =>
              `${a.emoji ?? "🤖"} **${a.name}** (${a.category}) — ${a.description || a.vibe || ""}`,
          );
        return { text: lines.length > 0 ? lines.join("\n") : "No matching agents found." };
      }
      const lines = registry.categories.map((cat) => {
        const count = getAgentsByCategory(registry, cat).length;
        return `**${cat}** — ${count} agents`;
      });
      return {
        text: `${registry.agents.length} agents in ${registry.categories.length} categories:\n\n${lines.join("\n")}`,
      };
    },
  });

  api.registerCommand({
    name: "mao-agent",
    description: "Show details of a specific agent by name or keyword.",
    acceptsArgs: true,
    handler: (ctx) => {
      const query = (ctx.args ?? "").trim();
      if (!query) return { text: "Usage: /mao-agent <agent name>" };
      const registry = loadAgentRegistry(AGENT_REGISTRY_PATH);
      const matches = searchAgents(registry, query);
      if (matches.length === 0) return { text: `No agent matching "${query}" found.` };
      const agent = matches[0];
      return {
        text: [
          `${agent.emoji ?? "🤖"} **${agent.name}**`,
          `Category: ${agent.category}`,
          agent.description ? `Description: ${agent.description}` : "",
          agent.vibe ? `Vibe: ${agent.vibe}` : "",
          agent.tools ? `Tools: ${agent.tools.join(", ")}` : "",
          agent.identity ? `\n**Identity:**\n${agent.identity.slice(0, 300)}` : "",
          agent.coreMission ? `\n**Mission:**\n${agent.coreMission.slice(0, 300)}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      };
    },
  });

  api.registerCommand({
    name: "mao-templates",
    description: "List available track templates. Optionally filter by category.",
    acceptsArgs: true,
    handler: (ctx) => {
      const category = (ctx.args ?? "").trim() || undefined;
      const templates = listTemplates(category);
      if (templates.length === 0) return { text: "No templates found." };
      const lines = templates.map((t) => `**${t.id}** (${t.category}) — ${t.description}`);
      return { text: lines.join("\n") };
    },
  });

  api.registerCommand({
    name: "mao-template",
    description: "Show details for a specific track template by ID or keyword.",
    acceptsArgs: true,
    handler: (ctx) => {
      const query = (ctx.args ?? "").trim();
      if (!query) return { text: "Usage: /mao-template <template id or keyword>" };
      const template = findTemplate(query);
      if (!template) return { text: `No template matching "${query}" found.` };
      return {
        text: [
          `**${template.id}** (${template.category})`,
          `Name: ${template.name}`,
          `Description: ${template.description}`,
          `Default goal: ${template.defaultGoal}`,
          `Output contract:\n${template.outputContract.map((c) => `- ${c}`).join("\n")}`,
          `Failure contract:\n${template.failureContract.map((c) => `- ${c}`).join("\n")}`,
        ].join("\n"),
      };
    },
  });

  api.registerCommand({
    name: "mao-audit",
    description: "Show recent orchestration audit log",
    handler: () => {
      const report = formatAuditReport(auditLog, 30);
      return { text: report || "No audit events recorded." };
    },
  });

  api.registerCommand({
    name: "mao-state",
    description: "Show current orchestration session state",
    handler: () => {
      const missing = getMissingTracks(sessionState);
      return {
        text: JSON.stringify(
          {
            plannedTracks: sessionState.plannedTracks,
            missingTracks: missing,
            enforcementCount: sessionState.enforcementHistory.length,
            totalToolCalls: sessionState.totalToolCalls,
          },
          null,
          2,
        ),
      };
    },
  });

  api.registerCommand({
    name: "mao-board",
    description: "Show all projects and tasks on the orchestration task board",
    handler: () => {
      const display = formatBoardDisplay(board);
      return { text: display };
    },
  });

  api.registerCommand({
    name: "mao-project",
    description: "Show details for a specific project by ID",
    acceptsArgs: true,
    handler: (ctx) => {
      const projectId = (ctx.args ?? "").trim();
      if (!projectId) return { text: "Usage: /mao-project <project-id>" };
      const project = getProject(board, projectId);
      if (!project) return { text: `No project found with ID "${projectId}"` };
      const lines = [
        `**${project.name}** (${project.status})`,
        `ID: ${project.id}`,
        `Request: ${project.request}`,
        `Created: ${project.createdAt}`,
        `Updated: ${project.updatedAt}`,
        "",
        `Tasks (${project.tasks.length}):`,
        ...project.tasks.map((t) => {
          const parts = [`  ${t.id}: ${t.label} — ${t.status}`];
          if (t.agentType) parts.push(`(agent: ${t.agentType})`);
          if (t.sessionKey) parts.push(`[session: ${t.sessionKey}]`);
          if (t.retryCount > 0) parts.push(`[retry: ${t.retryCount}/${t.maxRetry}]`);
          if (t.failureReason) parts.push(`\n    Failure: ${t.failureReason}`);
          return parts.join(" ");
        }),
      ];
      return { text: lines.join("\n") };
    },
  });

  api.registerCommand({
    name: "mao-review",
    description: "Review results of the current active project",
    handler: () => {
      const active = getActiveProjects(board);
      if (active.length === 0) return { text: "No active projects." };
      const project = active[0];
      const { reviews, needsRetry, allApproved } = reviewProject(project);
      scheduleBoardSave();
      return {
        text: JSON.stringify(
          {
            projectId: project.id,
            status: project.status,
            reviews: reviews.map((r) => ({
              taskId: r.taskId,
              approved: r.approved,
              status: r.status,
              reason: r.reason,
            })),
            needsRetry: needsRetry.map((t) => t.id),
            allApproved,
          },
          null,
          2,
        ),
      };
    },
  });

  api.registerCommand({
    name: "mao-resume",
    description: "Check for interrupted work and show resume actions",
    handler: () => {
      const resumeResult = checkAndResume(board);
      if (!resumeResult.resumed) {
        return { text: "No interrupted work detected. All projects are complete or idle." };
      }
      const lines = [
        `Checked ${resumeResult.projectsChecked} active project(s):`,
        ...resumeResult.actions.map((a) => `- ${a}`),
      ];
      if (resumeResult.tasksNeedingRetry > 0) {
        lines.push(`\nSuggestion: retry ${resumeResult.tasksNeedingRetry} failed task(s) via sessions_spawn.`);
      }
      if (resumeResult.tasksReadyForReview > 0) {
        lines.push(`\nSuggestion: review ${resumeResult.tasksReadyForReview} completed task(s) via /mao-review.`);
      }
      if (resumeResult.tasksStillRunning > 0) {
        lines.push(`\nSuggestion: ${resumeResult.tasksStillRunning} task(s) may still be running — wait for completion.`);
      }
      return { text: lines.join("\n") };
    },
  });

  api.registerCommand({
    name: "mao-report",
    description: "Generate a completion report for a project. Usage: /mao-report [projectId]",
    acceptsArgs: true,
    handler: (ctx) => {
      const projectId = (ctx.args ?? "").trim();
      let project;
      if (projectId) {
        project = getProject(board, projectId);
        if (!project) return { text: `No project found with ID "${projectId}"` };
      } else {
        // Default to the most recent project
        if (board.projects.length === 0) return { text: "No projects on the board." };
        project = board.projects[board.projects.length - 1];
      }
      const report = generateProjectReport(project);
      return { text: report };
    },
  });

  api.registerCommand({
    name: "maotest",
    description: "Run a deterministic self-test for the multi-agent orchestrator plugin.",
    handler: async () => {
      const plan = await tool.execute("maotest-plan", {
        action: "plan_tracks",
        request:
          "真实执行一个多 agent 调研：一个子 agent 查 openclaw 最近 7 天评论最多的 issues，一个子 agent 查最近 7 天评论最多的 discussions，最后主 agent 汇总。",
      });
      const merged = await tool.execute("maotest-merge", {
        action: "validate_and_merge",
        tracks: [
          {
            trackId: "issues-track",
            label: "Issues",
            resultText:
              "- Tool exec failure triggers gateway restart loop https://github.com/openclaw/openclaw/issues/101",
          },
          {
            trackId: "discussions-track",
            label: "Discussions",
            resultText:
              "Page not found\nEXTERNAL_UNTRUSTED_CONTENT\n- Good discussion https://github.com/openclaw/openclaw/discussions/22",
          },
        ],
      });

      const policy = await tool.execute("maotest-policy", {
        action: "enforce_execution_policy",
        request: "真实执行一个多 agent 调研，按步骤汇报并派出子 agent。",
        hasTaskBus: true,
        hasPlan: true,
        hasCheckpoint: true,
        hasWorkerStart: false,
        hasTrackedExecution: false,
        currentStep: 1,
        totalSteps: 3,
      });

      const planText = String(plan.content?.[0]?.text ?? "").trim();
      const mergedText = String(merged.content?.[0]?.text ?? "").trim();
      const policyText = String(policy.content?.[0]?.text ?? "").trim();
      return {
        text: ["[maotest] plan", planText, "", "[maotest] merge", mergedText, "", "[maotest] policy", policyText].join("\n"),
      };
    },
  });

  api.registerCommand({
    name: "mao-setup",
    description: "Configure OMA preferences (re-run onboarding)",
    handler: () => {
      onboardingState.completed = false;
      if (existsSync(OFMS_SHARED_ROOT)) {
        saveOnboardingState(OFMS_SHARED_ROOT, onboardingState);
      }
      onboardingMessageSent = false;
      return { text: generateWelcomeMessage(onboardingState) };
    },
  });

  api.registerCommand({
    name: "mao-keyword",
    description: "Add a custom keyword. Usage: /mao-keyword <delegation|tracked|light> <phrase>",
    acceptsArgs: true,
    handler: (ctx) => {
      const args = (ctx.args ?? "").trim();
      const spaceIdx = args.indexOf(" ");
      if (spaceIdx < 0) return { text: "用法: /mao-keyword <delegation|tracked|light> <短语>" };
      const tier = args.slice(0, spaceIdx) as "delegation" | "tracked" | "light";
      const phrase = args.slice(spaceIdx + 1).trim();
      if (!["delegation", "tracked", "light"].includes(tier)) {
        return { text: "无效等级。使用: delegation, tracked, 或 light" };
      }
      addUserKeyword(userKeywords, tier, phrase);
      if (existsSync(OFMS_SHARED_ROOT)) {
        saveUserKeywords(OFMS_SHARED_ROOT, userKeywords);
      }
      return { text: `已添加 "${phrase}" 到 ${tier} 级别。` };
    },
  });

  api.registerCommand({
    name: "mao-learned",
    description: "Show what OMA has learned about your intent patterns",
    handler: () => {
      const patterns = Object.values(intentRegistry.patterns)
        .filter((p) => p.occurrences >= 2)
        .sort((a, b) => b.occurrences - a.occurrences)
        .slice(0, 20);

      if (patterns.length === 0) return { text: "还没有学到足够的模式。多用几次就会开始学习。" };

      const lines = patterns.map((p) => {
        const topTier =
          p.confidence.delegation > p.confidence.tracked && p.confidence.delegation > p.confidence.light
            ? "delegation"
            : p.confidence.tracked > p.confidence.light
              ? "tracked"
              : "light";
        const topConf = Math.max(p.confidence.delegation, p.confidence.tracked, p.confidence.light);
        return `"${p.phrase}" → ${topTier} (${(topConf * 100).toFixed(0)}%, seen ${p.occurrences}x)`;
      });

      return {
        text: [
          `OMA 已学习 ${Object.keys(intentRegistry.patterns).length} 个模式，${intentRegistry.totalCorrections} 次纠正`,
          "",
          ...lines,
        ].join("\n"),
      };
    },
  });

  api.registerCommand({
    name: "mao-observations",
    description: "Show observation statistics and learning progress",
    handler: () => {
      const recent = loadRecentObservations(OFMS_SHARED_ROOT, 24 * 7); // last 7 days
      const stats = computeStats(recent);
      return {
        text: JSON.stringify(
          {
            totalObservations: stats.totalObservations,
            last24h: stats.last24h,
            last7d: stats.last7d,
            accuracy: `${(stats.accuracy * 100).toFixed(1)}%`,
            correctionRate: `${(stats.correctionRate * 100).toFixed(1)}%`,
            tierDistribution: stats.tierDistribution,
          },
          null,
          2,
        ),
      };
    },
  });

  api.registerCommand({
    name: "mao-discover",
    description: "Run pattern discovery on recent observations",
    handler: () => {
      const observations = loadRecentObservations(OFMS_SHARED_ROOT, 24 * 30); // last 30 days
      if (observations.length < 10) {
        return {
          text: `Not enough observations yet (${observations.length}/10). Keep using OMA and patterns will emerge.`,
        };
      }
      const result = discoverPatterns(
        observations,
        [], // TODO: pass current delegation keywords
        [], // TODO: pass current tracked keywords
      );
      return { text: formatDiscoveryReport(result) };
    },
  });

  api.registerCommand({
    name: "mao-level",
    description: "Show current enforcement level and upgrade/downgrade progress",
    handler: () => {
      const stats = computeStats(loadRecentObservations(OFMS_SHARED_ROOT, 24 * 7));
      return { text: formatEnforcementStatus(enforcementState, stats) };
    },
  });

  api.registerCommand({
    name: "mao-reset",
    description: "Reset OMA to Level 0 (restart observation phase)",
    handler: () => {
      enforcementState = createDefaultState();
      saveEnforcementState(OFMS_SHARED_ROOT, enforcementState);
      return { text: "OMA reset to Level 0. Observation phase restarted." };
    },
  });

  api.registerCommand({
    name: "mao-export",
    description: "Export learned patterns to a shareable file",
    handler: () => {
      const exported = exportPatterns({
        intentRegistry,
        userKeywords,
        enforcementState,
        observations: loadRecentObservations(OFMS_SHARED_ROOT, 24 * 30),
      });
      const json = serializeExport(exported);
      const filePath = join(OFMS_SHARED_ROOT, `oma-patterns-export-${new Date().toISOString().slice(0, 10)}.json`);
      writeFileSync(filePath, json, "utf-8");
      return {
        text: `Patterns exported to: ${filePath}\nPatterns: ${Object.keys(exported.intentPatterns).length}, Keywords: ${exported.userKeywords.delegation.length + exported.userKeywords.tracked.length}`,
      };
    },
  });

  api.registerCommand({
    name: "mao-import",
    description: "Import patterns from a shared file. Usage: /mao-import <filepath>",
    acceptsArgs: true,
    handler: (ctx) => {
      const filePath = (ctx.args ?? "").trim();
      if (!filePath) return { text: "Usage: /mao-import <filepath>" };
      try {
        const json = readFileSync(filePath, "utf-8");
        const exported = parseImport(json);
        if (!exported) return { text: "Invalid export file format." };
        const result = importPatterns({ exported, intentRegistry, userKeywords });
        if (existsSync(OFMS_SHARED_ROOT)) {
          saveIntentRegistry(OFMS_SHARED_ROOT, intentRegistry);
          saveUserKeywords(OFMS_SHARED_ROOT, userKeywords);
        }
        return { text: `Imported ${result.patternsImported} patterns and ${result.keywordsImported} keywords.` };
      } catch (e) {
        return { text: `Import failed: ${String(e)}` };
      }
    },
  });


  api.registerCommand({
    name: "mao-evolve",
    description: "Manually trigger an evolution cycle",
    handler: () => {
      const report = runEvolutionCycle({
        sharedRoot: OFMS_SHARED_ROOT,
        intentRegistry,
        userKeywords,
        enforcementState,
        existingDelegationKeywords: [],
        existingTrackedKeywords: [],
      });
      saveUserKeywords(OFMS_SHARED_ROOT, userKeywords);
      saveIntentRegistry(OFMS_SHARED_ROOT, intentRegistry);
      saveEnforcementState(OFMS_SHARED_ROOT, enforcementState);
      appendEvolutionReport(OFMS_SHARED_ROOT, report);
      return { text: formatEvolutionReport(report) };
    },
  });

  api.registerCommand({
    name: "mao-evolution-history",
    description: "Show past evolution reports",
    handler: () => {
      const history = loadEvolutionHistory(OFMS_SHARED_ROOT);
      if (history.length === 0) return { text: "No evolution cycles have run yet." };
      const recent = history.slice(-5);
      return { text: recent.map((r) => formatEvolutionReport(r)).join("\n---\n") };
    },
  });

  // EV4: Periodic evolution cycle — once per 24 hours
  let lastEvolutionDate = "";
  const evolutionTimer = setInterval(() => {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== lastEvolutionDate) {
      const report = runEvolutionCycle({
        sharedRoot: OFMS_SHARED_ROOT,
        intentRegistry,
        userKeywords,
        enforcementState,
        existingDelegationKeywords: [],
        existingTrackedKeywords: [],
      });
      lastEvolutionDate = today;
      if (report.autoApplied.length > 0 || report.enforcementLevelBefore !== report.enforcementLevelAfter) {
        api.logger.info(`[OMA Evolution] ${report.summary}`);
        saveUserKeywords(OFMS_SHARED_ROOT, userKeywords);
        saveEnforcementState(OFMS_SHARED_ROOT, enforcementState);
        appendEvolutionReport(OFMS_SHARED_ROOT, report);
      }
    }
  }, 60 * 60 * 1000); // check every hour
  evolutionTimer.unref?.(); // don't block process exit

  // Flush observation buffer on service stop
  process.on("exit", () => {
    flushBuffer(OFMS_SHARED_ROOT);
    saveEnforcementState(OFMS_SHARED_ROOT, enforcementState);
  });

  api.registerCli(
    ({ program }) => {
      program
        .command("mao-selftest")
        .description("Run the multi-agent orchestrator plugin self-test")
        .action(async () => {
          const plan = await tool.execute("cli-plan", {
            action: "plan_tracks",
            request:
              "真实执行一个多 agent 调研：一个子 agent 查 openclaw 最近 7 天评论最多的 issues，一个子 agent 查最近 7 天评论最多的 discussions，最后主 agent 汇总。",
          });
          const merged = await tool.execute("cli-merge", {
            action: "validate_and_merge",
            tracks: [
              {
                trackId: "issues-track",
                label: "Issues",
                resultText:
                  "- Tool exec failure triggers gateway restart loop https://github.com/openclaw/openclaw/issues/101",
              },
              {
                trackId: "discussions-track",
                label: "Discussions",
                resultText:
                  "Page not found\nEXTERNAL_UNTRUSTED_CONTENT\n- Good discussion https://github.com/openclaw/openclaw/discussions/22",
              },
            ],
          });
          const policy = await tool.execute("cli-policy", {
            action: "enforce_execution_policy",
            request: "真实执行一个多 agent 调研，按步骤汇报并派出子 agent。",
            hasTaskBus: true,
            hasPlan: true,
            hasCheckpoint: true,
            hasWorkerStart: false,
            hasTrackedExecution: false,
            currentStep: 1,
            totalSteps: 3,
          });

          process.stdout.write(`${String(plan.content?.[0]?.text ?? "").trim()}\n\n`);
          process.stdout.write(`${String(merged.content?.[0]?.text ?? "").trim()}\n`);
          process.stdout.write(`\n\n${String(policy.content?.[0]?.text ?? "").trim()}\n`);
        });
    },
    { commands: ["mao-selftest"] },
  );
}
