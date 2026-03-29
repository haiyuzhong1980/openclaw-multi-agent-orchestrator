import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createMultiAgentOrchestratorTool, MultiAgentOrchestratorSchema } from "./src/tool.ts";
import { loadAgentRegistry, searchAgents, getAgentsByCategory } from "./src/agent-registry.ts";
import { listTemplates, findTemplate } from "./src/track-templates.ts";
import { formatAuditReport } from "./src/audit-log.ts";
import { getMissingTracks } from "./src/session-state.ts";
import {
  getActiveProjects,
  getProject,
  formatBoardDisplay,
  findTaskById,
  isTaskBlocked,
  getDownstreamTasks,
  addTaskDependency,
  removeTaskDependency,
  saveBoard,
} from "./src/task-board.ts";
import { reviewProject } from "./src/review-gate.ts";
import { checkAndResume } from "./src/session-resume.ts";
import { generateProjectReport } from "./src/report-generator.ts";
// M6: Message system
import {
  sendMessage,
  getPendingMessages,
  markMessageProcessed,
  formatMessages,
  getMessageHistory,
  formatMessageHistory,
} from "./src/message-manager.ts";
import { MessageType } from "./src/types.ts";
// M8: TOML templates
import {
  parseTomlTemplate,
  loadTomlTemplates,
  validateTomlTemplate,
  formatTomlTemplate,
} from "./src/toml-parser.ts";
import { addUserKeyword, saveUserKeywords } from "./src/user-keywords.ts";
import {
  saveIntentRegistry,
} from "./src/intent-registry.ts";
import {
  computeStats,
  loadRecentObservations,
  flushBuffer,
} from "./src/observation-engine.ts";
import { discoverPatterns, formatDiscoveryReport } from "./src/pattern-discovery.ts";
import {
  saveEnforcementState,
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
  saveOnboardingState,
  needsOnboarding,
  generateWelcomeMessage,
} from "./src/onboarding.ts";
import {
  exportPatterns,
  importPatterns,
  serializeExport,
  parseImport,
} from "./src/pattern-export.ts";
import { createPluginState } from "./src/plugin-state.ts";
import { createMessageHandler } from "./src/hooks/message-handler.ts";
import { createPromptBuilder } from "./src/hooks/prompt-builder.ts";
import { createToolHooks } from "./src/hooks/tool-hooks.ts";
import { createSubagentHooks } from "./src/hooks/subagent-hooks.ts";
import {
  oagEventToObservation,
  type OagEvent,
} from "./src/oag-bridge.ts";
import { appendObservation } from "./src/observation-engine.ts";

const OFMS_SHARED_ROOT =
  process.env.OFMS_SHARED_ROOT ?? join(process.env.HOME ?? "", ".openclaw/shared-memory");

type PluginConfig = {
  enabledPromptGuidance?: boolean;
  maxItemsPerTrack?: number;
  executionPolicy?: "free" | "guided" | "tracked" | "delegation-first" | "strict-orchestrated";
  delegationStartGate?: "off" | "advisory" | "required";
  /** Manual override: force enforcement level (0-3). Skips natural progression. */
  enforcementLevel?: 0 | 1 | 2 | 3;
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

  const AGENT_REGISTRY_PATH =
    process.env.AGENCY_AGENTS_PATH ?? join(process.env.HOME ?? "", "Documents/agency-agents-backup");

  // Initialize all plugin state
  const state = createPluginState(OFMS_SHARED_ROOT);

  // Manual enforcement level override — skip natural progression
  if (typeof pluginConfig.enforcementLevel === "number" && [0, 1, 2, 3].includes(pluginConfig.enforcementLevel)) {
    const overrideLevel = pluginConfig.enforcementLevel as 0 | 1 | 2 | 3;
    if (state.enforcementState.currentLevel !== overrideLevel) {
      state.enforcementState.currentLevel = overrideLevel;
      state.enforcementState.levelHistory.push({
        level: overrideLevel,
        timestamp: new Date().toISOString(),
        reason: `manual override via pluginConfig.enforcementLevel=${overrideLevel}`,
      });
      api.logger.info(`[OMA] Enforcement level manually set to L${overrideLevel}`);
    }
  }

  const tool = createMultiAgentOrchestratorTool({
    executionPolicy,
    delegationStartGate,
    maxItemsPerTrack:
      typeof pluginConfig.maxItemsPerTrack === "number" ? pluginConfig.maxItemsPerTrack : 8,
    logger: (message) => api.logger.info(`[multi-agent-orchestrator] ${message}`),
    sessionState: state.sessionState,
    auditLog: state.auditLog,
    sharedRoot: OFMS_SHARED_ROOT,
    board: state.board,
  });

  const typedTool: AnyAgentTool = {
    ...tool,
    parameters: MultiAgentOrchestratorSchema as AnyAgentTool["parameters"],
  };
  api.registerTool(typedTool);

  // Register hooks
  if (pluginConfig.enabledPromptGuidance !== false) {
    const promptBuilder = createPromptBuilder(
      state,
      { executionPolicy, agentRegistryPath: AGENT_REGISTRY_PATH },
      api,
      OFMS_SHARED_ROOT,
    );
    api.on("before_prompt_build", promptBuilder);
  }

  const messageHandler = createMessageHandler(state, api, OFMS_SHARED_ROOT);
  api.on("message_received", messageHandler);

  const toolHooks = createToolHooks(state, api, OFMS_SHARED_ROOT, { executionPolicy, delegationStartGate });
  api.on("before_tool_call", toolHooks.beforeToolCall);
  api.on("after_tool_call", toolHooks.afterToolCall);

  const subagentHooks = createSubagentHooks(state, api);
  api.on("subagent_spawned", subagentHooks.subagentSpawned);
  api.on("subagent_ended", subagentHooks.subagentEnded);

  // OAG-OMA Bridge: Subscribe to OAG events and translate to OMA observations
  // This wiring enables OAG channel health events to trigger OMA agent dispatch
  const unsubscribeOag = api.onOagEvent?.((event: { type: string; timestamp: number; data?: unknown }) => {
    if (event.type === "anomaly_detected" || event.type === "channel_state_changed") {
      try {
        const oagEvent = event.data as OagEvent;
        const obs = oagEventToObservation(oagEvent);
        appendObservation(OFMS_SHARED_ROOT, {
          id: `oag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          timestamp: new Date().toISOString(),
          agent: obs.agent,
          messageText: obs.message,
          messageLength: obs.message.length,
          language: "en",
          hasNumberedList: false,
          actionVerbCount: 0,
          predictedTier: obs.predictedTier,
          toolsCalled: [],
          didSpawnSubagent: false,
          spawnCount: 0,
          userFollowUp: null,
          actualTier: null,
        });
        api.logger.info(`[OMA] OAG event translated to observation: ${event.type} → ${obs.predictedTier}`);
      } catch (err) {
        api.logger.warn(`[OMA] Failed to translate OAG event: ${String(err)}`);
      }
    }
  });
  if (unsubscribeOag) {
    api.logger.info("[OMA] OAG event bridge wired successfully");
  }

  // Register commands
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

  // M8: TOML template commands
  api.registerCommand({
    name: "mao-toml-templates",
    description: "List TOML templates from ~/.openclaw/templates/",
    handler: () => {
      const templatesDir = join(state.sharedRoot, "..", "templates");
      const templates = loadTomlTemplates(templatesDir);

      if (templates.length === 0) {
        return {
          text: [
            "No TOML templates found.",
            `Expected directory: ${templatesDir}`,
            "",
            "Create a template file like this:",
            "  ~/.openclaw/templates/my-template.toml",
          ].join("\n"),
        };
      }

      const lines = templates.map((t) => `**${t.id}** — ${t.name}`);
      return { text: `Found ${templates.length} TOML template(s):\n\n` + lines.join("\n") };
    },
  });

  api.registerCommand({
    name: "mao-toml-template",
    description: "Show details for a TOML template",
    acceptsArgs: true,
    handler: (ctx) => {
      const id = (ctx.args ?? "").trim();
      if (!id) return { text: "Usage: /mao-toml-template <template-id>" };

      const templatesDir = join(state.sharedRoot, "..", "templates");
      const templates = loadTomlTemplates(templatesDir);
      const template = templates.find((t) => t.id === id);

      if (!template) {
        return { text: `TOML template "${id}" not found.` };
      }

      const errors = validateTomlTemplate(template);
      const errorText = errors.length > 0 ? `\n\n⚠️ **Validation errors:**\n${errors.map((e) => `- ${e}`).join("\n")}` : "";

      return { text: formatTomlTemplate(template) + errorText };
    },
  });

  api.registerCommand({
    name: "mao-toml-validate",
    description: "Validate a TOML template file",
    acceptsArgs: true,
    handler: (ctx) => {
      const filePath = (ctx.args ?? "").trim();
      if (!filePath) return { text: "Usage: /mao-toml-validate <path-to-toml-file>" };

      const content = existsSync(filePath) ? readFileSync(filePath, "utf-8") : null;
      if (!content) {
        return { text: `File not found: ${filePath}` };
      }

      const template = parseTomlTemplate(content);
      if (!template) {
        return { text: `Failed to parse TOML template from ${filePath}` };
      }

      const errors = validateTomlTemplate(template);

      if (errors.length === 0) {
        return { text: `✅ Template "${template.id}" is valid!\n\n${formatTomlTemplate(template)}` };
      }

      return {
        text: [
          `❌ Template "${template.id}" has ${errors.length} error(s):`,
          "",
          ...errors.map((e) => `- ${e}`),
        ].join("\n"),
      };
    },
  });

  // M8-06: Interactive TOML template creator
  api.registerCommand({
    name: "mao-template-create",
    description: "Create a new TOML template interactively. Usage: /mao-template-create <template-id>",
    acceptsArgs: true,
    handler: (ctx) => {
      const templateId = (ctx.args ?? "").trim();
      if (!templateId) {
        return {
          text: [
            "Usage: /mao-template-create <template-id>",
            "",
            "This command creates a basic TOML template file in ~/.openclaw/templates/",
            "You can then edit it to customize agents and tasks.",
          ].join("\n"),
        };
      }

      const templatesDir = join(homedir(), ".openclaw", "templates");
      if (!existsSync(templatesDir)) {
        mkdirSync(templatesDir, { recursive: true });
      }

      const filePath = join(templatesDir, `${templateId}.toml`);
      if (existsSync(filePath)) {
        return { text: `Template "${templateId}" already exists at ${filePath}` };
      }

      // Create a basic template structure
      const content = `# ${templateId} Template
# Created by /mao-template-create on ${new Date().toISOString().split("T")[0]}

[template]
id = "${templateId}"
name = "${templateId.charAt(0).toUpperCase() + templateId.slice(1).replace(/-/g, " ")}"
description = "Description of what this template does"

[template.leader]
name = "lead-agent"
type = "planner"
task = """
Main task description for the leader agent.
"""

[[template.agents]]
name = "worker-1"
type = "executor"
task = "Task description for worker-1."

[[template.tasks]]
subject = "Main task"
owner = "lead-agent"
`;

      writeFileSync(filePath, content, "utf-8");
      return {
        text: [
          `✅ Created template "${templateId}" at ${filePath}`,
          "",
          "Edit the file to customize:",
          "- Add more agents in [[template.agents]] sections",
          "- Define tasks in [[template.tasks]] sections",
          "- Use blockedBy for task dependencies",
          "",
          "Validate with: /mao-toml-validate ${filePath}",
        ].join("\n"),
      };
    },
  });

  api.registerCommand({
    name: "mao-audit",
    description: "Show recent orchestration audit log",
    handler: () => {
      const report = formatAuditReport(state.auditLog, 30);
      return { text: report || "No audit events recorded." };
    },
  });

  api.registerCommand({
    name: "mao-state",
    description: "Show current orchestration session state",
    handler: () => {
      const missing = getMissingTracks(state.sessionState);
      return {
        text: JSON.stringify(
          {
            plannedTracks: state.sessionState.plannedTracks,
            missingTracks: missing,
            enforcementCount: state.sessionState.enforcementHistory.length,
            totalToolCalls: state.sessionState.totalToolCalls,
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
      const display = formatBoardDisplay(state.board);
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
      const project = getProject(state.board, projectId);
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

  // M5-10: Show task dependencies
  api.registerCommand({
    name: "mao-task-dependencies",
    description: "Show dependencies and blockers for a task",
    acceptsArgs: true,
    handler: (ctx) => {
      const taskId = (ctx.args ?? "").trim();
      if (!taskId) return { text: "Usage: /mao-task-dependencies <task-id>" };
      const task = findTaskById(state.board, taskId);
      if (!task) return { text: `No task found with ID "${taskId}"` };

      const lines = [
        `**Task: ${task.label}** (${task.id})`,
        `Status: ${task.status}`,
      ];

      // Dependencies (tasks this task waits for)
      if (task.blockedBy.length > 0) {
        lines.push("", "**Blocked by:**");
        for (const depId of task.blockedBy) {
          const depTask = findTaskById(state.board, depId);
          if (depTask) {
            const status = depTask.status;
            const isComplete = status === "completed" || status === "approved";
            lines.push(`  ${isComplete ? "✅" : "⏳"} ${depId}: ${depTask.label} (${status})`);
          } else {
            lines.push(`  ❓ ${depId}: (not found)`);
          }
        }
        const blocked = isTaskBlocked(state.board, task);
        lines.push(``, blocked ? "⚠️ This task is BLOCKED" : "✅ All dependencies satisfied");
      } else {
        lines.push("", "**Blocked by:** (none)");
      }

      // Blocking (tasks waiting for this task)
      const downstream = getDownstreamTasks(state.board, taskId);
      if (downstream.length > 0) {
        lines.push("", "**Blocks:**");
        for (const t of downstream) {
          lines.push(`  - ${t.id}: ${t.label} (${t.status})`);
        }
      } else {
        lines.push("", "**Blocks:** (none)");
      }

      // Lock status
      if (task.lockedBy) {
        lines.push("", `🔒 **Locked by:** ${task.lockedBy} (since ${task.lockedAt})`);
      }

      return { text: lines.join("\n") };
    },
  });

  // M5-11: Add/remove task dependency
  api.registerCommand({
    name: "mao-task-dep",
    description: "Add or remove a task dependency. Usage: /mao-task-dep <taskId> --needs <otherTaskId> | --unblock <otherTaskId>",
    acceptsArgs: true,
    handler: (ctx) => {
      const args = (ctx.args ?? "").trim();
      if (!args) {
        return {
          text: [
            "Usage:",
            "  /mao-task-dep <taskId> --needs <otherTaskId>  # Add dependency",
            "  /mao-task-dep <taskId> --unblock <otherTaskId>  # Remove dependency",
          ].join("\n"),
        };
      }

      const needsMatch = args.match(/^(\S+)\s+--needs\s+(\S+)$/);
      const unblockMatch = args.match(/^(\S+)\s+--unblock\s+(\S+)$/);

      if (needsMatch) {
        const [, blockedTaskId, blockingTaskId] = needsMatch;
        const result = addTaskDependency(state.board, blockingTaskId, blockedTaskId);
        if (result.success) {
          saveBoard(state.sharedRoot, state.board);
          return { text: `✅ Added dependency: ${blockingTaskId} → ${blockedTaskId}` };
        }
        return { text: `❌ Failed: ${result.error}` };
      }

      if (unblockMatch) {
        const [, blockedTaskId, blockingTaskId] = unblockMatch;
        removeTaskDependency(state.board, blockingTaskId, blockedTaskId);
        saveBoard(state.sharedRoot, state.board);
        return { text: `✅ Removed dependency: ${blockingTaskId} → ${blockedTaskId}` };
      }

      return { text: "Invalid syntax. Use --needs or --unblock." };
    },
  });

  // M6-08: Send message to another agent
  api.registerCommand({
    name: "mao-inbox-send",
    description: "Send a message to another agent. Usage: /mao-inbox-send <toAgent> <message>",
    acceptsArgs: true,
    handler: (ctx) => {
      const args = (ctx.args ?? "").trim();
      const match = args.match(/^(\S+)\s+(.+)$/s);
      if (!match) {
        return { text: "Usage: /mao-inbox-send <toAgent> <message>" };
      }
      const [, toAgent, content] = match;

      if (!state.agentIdentity) {
        return { text: "No agent identity set. This command is only available to spawned agents." };
      }

      const msg = sendMessage(state.sharedRoot, {
        type: MessageType.message,
        from: state.agentIdentity.agentId,
        to: toAgent,
        content,
        metadata: {
          teamName: state.agentIdentity.teamName,
        },
      });

      return { text: `✅ Message sent to ${toAgent} (ID: ${msg.id})` };
    },
  });

  // M6-09: Check inbox for pending messages
  api.registerCommand({
    name: "mao-inbox",
    description: "Check pending messages in your inbox",
    handler: () => {
      if (!state.agentIdentity) {
        return { text: "No agent identity set. This command is only available to spawned agents." };
      }

      const messages = getPendingMessages(
        state.sharedRoot,
        state.agentIdentity.teamName,
        state.agentIdentity.agentId,
      );

      return { text: formatMessages(messages) };
    },
  });

  // Mark a message as processed
  api.registerCommand({
    name: "mao-inbox-done",
    description: "Mark a message as processed. Usage: /mao-inbox-done <messageId>",
    acceptsArgs: true,
    handler: (ctx) => {
      const messageId = (ctx.args ?? "").trim();
      if (!messageId) {
        return { text: "Usage: /mao-inbox-done <messageId>" };
      }

      if (!state.agentIdentity) {
        return { text: "No agent identity set." };
      }

      const success = markMessageProcessed(
        state.sharedRoot,
        state.agentIdentity.teamName,
        state.agentIdentity.agentId,
        messageId,
      );

      return { text: success ? `✅ Message ${messageId} marked as processed` : `❌ Message ${messageId} not found` };
    },
  });

  // M7-09: View message history (processed messages)
  api.registerCommand({
    name: "mao-inbox-history",
    description: "View processed message history. Usage: /mao-inbox-history [limit]",
    acceptsArgs: true,
    handler: (ctx) => {
      if (!state.agentIdentity) {
        return { text: "No agent identity set. This command is only available to spawned agents." };
      }

      const limitArg = (ctx.args ?? "").trim();
      const limit = limitArg ? parseInt(limitArg, 10) : 20;

      if (isNaN(limit) || limit < 1 || limit > 100) {
        return { text: "Limit must be a number between 1 and 100." };
      }

      const messages = getMessageHistory(
        state.sharedRoot,
        state.agentIdentity.teamName,
        state.agentIdentity.agentId,
        limit,
      );

      return { text: formatMessageHistory(messages) };
    },
  });

  api.registerCommand({
    name: "mao-review",
    description: "Review results of the current active project",
    handler: () => {
      const active = getActiveProjects(state.board);
      if (active.length === 0) return { text: "No active projects." };
      const project = active[0];
      const { reviews, needsRetry, allApproved } = reviewProject(project);
      state.scheduleBoardSave();
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
      const resumeResult = checkAndResume(state.board);
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
        project = getProject(state.board, projectId);
        if (!project) return { text: `No project found with ID "${projectId}"` };
      } else {
        // Default to the most recent project
        if (state.board.projects.length === 0) return { text: "No projects on the board." };
        project = state.board.projects[state.board.projects.length - 1];
      }
      const report = generateProjectReport(project);
      return { text: report };
    },
  });

  api.registerCommand({
    name: "mao-setup",
    description: "Configure OMA preferences (re-run onboarding)",
    handler: () => {
      state.onboardingState.completed = false;
      if (existsSync(OFMS_SHARED_ROOT)) {
        saveOnboardingState(OFMS_SHARED_ROOT, state.onboardingState);
      }
      state.onboardingMessageSent = false;
      return { text: generateWelcomeMessage(state.onboardingState) };
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
      addUserKeyword(state.userKeywords, tier, phrase);
      if (existsSync(OFMS_SHARED_ROOT)) {
        saveUserKeywords(OFMS_SHARED_ROOT, state.userKeywords);
      }
      return { text: `已添加 "${phrase}" 到 ${tier} 级别。` };
    },
  });

  api.registerCommand({
    name: "mao-learned",
    description: "Show what OMA has learned about your intent patterns",
    handler: () => {
      const patterns = Object.values(state.intentRegistry.patterns)
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
          `OMA 已学习 ${Object.keys(state.intentRegistry.patterns).length} 个模式，${state.intentRegistry.totalCorrections} 次纠正`,
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
        state.userKeywords.delegation,
        state.userKeywords.tracked,
      );
      return { text: formatDiscoveryReport(result) };
    },
  });

  api.registerCommand({
    name: "mao-level",
    description: "Show current enforcement level and upgrade/downgrade progress",
    handler: () => {
      const stats = computeStats(loadRecentObservations(OFMS_SHARED_ROOT, 24 * 7));
      return { text: formatEnforcementStatus(state.enforcementState, stats) };
    },
  });

  api.registerCommand({
    name: "mao-reset",
    description: "Reset OMA to Level 0 (restart observation phase)",
    handler: () => {
      state.enforcementState = createDefaultState();
      saveEnforcementState(OFMS_SHARED_ROOT, state.enforcementState);
      return { text: "OMA reset to Level 0. Observation phase restarted." };
    },
  });

  api.registerCommand({
    name: "mao-export",
    description: "Export learned patterns to a shareable file",
    handler: () => {
      const exported = exportPatterns({
        intentRegistry: state.intentRegistry,
        userKeywords: state.userKeywords,
        enforcementState: state.enforcementState,
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
        const result = importPatterns({ exported, intentRegistry: state.intentRegistry, userKeywords: state.userKeywords });
        if (existsSync(OFMS_SHARED_ROOT)) {
          saveIntentRegistry(OFMS_SHARED_ROOT, state.intentRegistry);
          saveUserKeywords(OFMS_SHARED_ROOT, state.userKeywords);
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
        intentRegistry: state.intentRegistry,
        userKeywords: state.userKeywords,
        enforcementState: state.enforcementState,
        existingDelegationKeywords: [],
        existingTrackedKeywords: [],
      });
      saveUserKeywords(OFMS_SHARED_ROOT, state.userKeywords);
      saveIntentRegistry(OFMS_SHARED_ROOT, state.intentRegistry);
      saveEnforcementState(OFMS_SHARED_ROOT, state.enforcementState);
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
        intentRegistry: state.intentRegistry,
        userKeywords: state.userKeywords,
        enforcementState: state.enforcementState,
        existingDelegationKeywords: [],
        existingTrackedKeywords: [],
      });
      lastEvolutionDate = today;
      if (report.autoApplied.length > 0 || report.enforcementLevelBefore !== report.enforcementLevelAfter) {
        api.logger.info(`[OMA Evolution] ${report.summary}`);
        saveUserKeywords(OFMS_SHARED_ROOT, state.userKeywords);
        saveEnforcementState(OFMS_SHARED_ROOT, state.enforcementState);
        appendEvolutionReport(OFMS_SHARED_ROOT, report);
      }
    }
  }, 60 * 60 * 1000); // check every hour
  evolutionTimer.unref?.(); // don't block process exit

  // Flush observation buffer on service stop
  process.on("exit", () => {
    flushBuffer(OFMS_SHARED_ROOT);
    saveEnforcementState(OFMS_SHARED_ROOT, state.enforcementState);
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
