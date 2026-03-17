import { join } from "node:path";
import { existsSync } from "node:fs";
import { Type } from "@sinclair/typebox";
import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createMultiAgentOrchestratorTool, MultiAgentOrchestratorSchema } from "./src/tool.ts";
import { buildOrchestratorPromptGuidance } from "./src/prompt-guidance.ts";
import { loadAgentRegistry, searchAgents, getAgentsByCategory } from "./src/agent-registry.ts";
import { listTemplates, findTemplate } from "./src/track-templates.ts";

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
  const tool = createMultiAgentOrchestratorTool({
    executionPolicy,
    delegationStartGate,
    maxItemsPerTrack:
      typeof pluginConfig.maxItemsPerTrack === "number" ? pluginConfig.maxItemsPerTrack : 8,
    logger: (message) => api.logger.info(`[multi-agent-orchestrator] ${message}`),
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
      return { appendSystemContext: guidance };
    });
  }

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
