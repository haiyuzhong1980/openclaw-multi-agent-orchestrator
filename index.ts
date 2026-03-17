import { join } from "node:path";
import { existsSync } from "node:fs";
import { Type } from "@sinclair/typebox";
import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createMultiAgentOrchestratorTool, MultiAgentOrchestratorSchema } from "./src/tool.ts";
import { buildOrchestratorPromptGuidance, buildDispatchGuidance } from "./src/prompt-guidance.ts";
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

  let intentRegistrySaveTimer: ReturnType<typeof setTimeout> | undefined;
  function scheduleIntentRegistrySave(): void {
    if (intentRegistrySaveTimer) clearTimeout(intentRegistrySaveTimer);
    intentRegistrySaveTimer = setTimeout(() => {
      if (existsSync(OFMS_SHARED_ROOT)) {
        saveIntentRegistry(OFMS_SHARED_ROOT, intentRegistry);
      }
    }, 1000);
  }

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

  // Wrap the raw JSON Schema in a TypeBox TSchema so the tool conforms to AnyAgentTool
  // without casting through unknown. Type.Unsafe preserves the JSON Schema wire format
  // while satisfying the AgentTool<TParameters extends TSchema> constraint.
  const typedTool: AnyAgentTool = {
    ...tool,
    parameters: Type.Unsafe(MultiAgentOrchestratorSchema),
  };
  api.registerTool(typedTool);

  if (pluginConfig.enabledPromptGuidance !== false) {
    api.on("before_prompt_build", async () => {
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

      // Inject dispatch guidance for active projects with pending tasks
      const activeProjects = getActiveProjects(board);
      if (activeProjects.length > 0) {
        const project = activeProjects[activeProjects.length - 1];
        const dispatchGuidance = buildDispatchGuidance(project);
        if (dispatchGuidance) {
          guidance += dispatchGuidance;
        }
      }

      return { appendSystemContext: guidance };
    });
  }

  api.on("message_received", async (event: Record<string, unknown>) => {
    const text = (event.content as string | undefined)?.trim();
    if (!text) return undefined;

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

    // Record the current classification
    const tier = inferExecutionComplexity(text, intentRegistry, userKeywords);
    recordClassification(intentRegistry, phrases, tier);
    lastClassification = { phrases, tier, timestamp: Date.now() };

    scheduleIntentRegistrySave();
    return undefined;
  });

  api.on("before_tool_call", async (event: Record<string, unknown>) => {
    const blockReason = event.blockReason as string | undefined;
    if (blockReason) {
      logEvent(auditLog, "tool_blocked", { toolName: event.toolName, reason: blockReason });
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
    description: "Configure your personal multi-agent preferences",
    handler: () => {
      return {
        text: [
          "**OMA 个性化设置**",
          "",
          "请告诉我你的使用习惯，我会记住这些关键词来更好地理解你的意图：",
          "",
          "**1. 你通常怎么表达"帮我做复杂任务"？** (会触发多 agent 编排)",
          "   例如: 全力推进、深度分析、全面审查...",
          "   用 `/mao-keyword delegation <你的短语>` 添加",
          "",
          "**2. 你通常怎么表达"做个有步骤的任务"？** (会要求任务看板)",
          "   例如: 按步骤来、出个报告、跑一遍流程...",
          "   用 `/mao-keyword tracked <你的短语>` 添加",
          "",
          "**3. 有什么词你不希望触发编排？** (会保持简单对话)",
          "   用 `/mao-keyword light <你的短语>` 添加",
          "",
          "当前已配置的自定义关键词:",
          `  delegation: ${userKeywords.delegation.length > 0 ? userKeywords.delegation.join(", ") : "(无)"}`,
          `  tracked: ${userKeywords.tracked.length > 0 ? userKeywords.tracked.join(", ") : "(无)"}`,
          `  light: ${userKeywords.light.length > 0 ? userKeywords.light.join(", ") : "(无)"}`,
        ].join("\n"),
      };
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
