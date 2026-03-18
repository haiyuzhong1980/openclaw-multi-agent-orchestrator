import type { ExecutionPolicyMode } from "./types.ts";
import type { Project } from "./task-board.ts";

export function buildOrchestratorPromptGuidance(mode: ExecutionPolicyMode): string {
  return [
    "When a task requires multi-agent research or other non-trivial execution,",
    "call multi-agent-orchestrator with action=enforce_execution_policy before deep execution.",
    `Current execution policy is ${mode}.`,
    "If the policy says task bus, plan, worker delegation, or tracked execution is required, do that first.",
    "When a task bus is required, it must be a canonical TASK-* directory with spec.md, plan.md, status.json, events.jsonl, handoff.md, and result.md; a single json file does not count.",
    "Before the first real worker/subagent/tracked execution starts, the orchestrator agent may only do task framing, task-bus creation, and step planning.",
    "Before first dispatch, do not perform substantive repo inspection, security analysis, code modification, deployment work, or final synthesis in the orchestrator agent itself.",
    "Do not announce step start or kickoff unless there is real execution evidence.",
    "Do not treat planned tracks as dispatched tracks; only a real worker/subagent spawn or tracked execution counts as dispatch evidence.",
    "Validation failure does not end the task when required tracks are still pending, worker evidence is missing, or the requested minimum result count has not been met.",
    "If a required track failed or returned too few validated results, the next action must be retry, narrower sourcing, or an additional worker dispatch unless there is a concrete blocker.",
    "Use the multi-agent-orchestrator tool to plan tracks before delegation and to validate/merge raw child outputs before the final answer.",
    "Only include validated items from the tool result in the final answer.",
    "Do not include HTML, 404 pages, tool logs, run metadata, or empty payload diagnostics.",
  ].join("\n");
}

/**
 * L1 强制编排指令 — 当消息被分类为 delegation 时注入。
 * 不 block 任何工具，但把"该怎么做"喂到嘴里，让 agent 大概率照做。
 */
export function buildDelegationMandate(request: string, availableAgents?: string[]): string {
  const lines = [
    "",
    "══════════════════════════════════════════",
    "DELEGATION MODE — 当前任务需要多 agent 协作",
    "══════════════════════════════════════════",
    "",
    "你是编排者（orchestrator），不是执行者（executor）。",
    "当前用户消息已被系统识别为需要派遣子 agent 的任务。",
    "",
    "你必须按以下顺序操作，不要跳步：",
    "",
    "Step 1: 分析任务，拆分为 2-5 个可并行的子任务",
    "Step 2: 调用 multi-agent-orchestrator tool，action=orchestrate，request=用户原始请求",
    "        这会在 task board 上创建项目和任务",
    "Step 3: 对每个子任务，调用 Agent tool 派出子 agent（可并行派出多个）",
    '        示例：Agent({ prompt: "子任务描述", subagent_type: "executor" })',
    "Step 4: 收集所有子 agent 的结果",
    "Step 5: 调用 multi-agent-orchestrator tool，action=validate_and_merge 验收",
    "Step 6: 汇总输出最终报告给用户",
    "",
    "禁止行为：",
    "- 不要自己直接写代码、改文件、跑命令来完成实质工作",
    "- 不要跳过 Step 2-3 直接给出结果",
    "- 不要把所有工作放在一个 agent 里（除非任务确实不可拆分）",
    "",
    `用户原始请求：「${request.slice(0, 300)}」`,
  ];

  if (availableAgents && availableAgents.length > 0) {
    lines.push("");
    lines.push("可用的子 agent 类型：");
    for (const agent of availableAgents.slice(0, 12)) {
      lines.push(`  - ${agent}`);
    }
  }

  lines.push("");
  lines.push("══════════════════════════════════════════");
  lines.push("");

  return lines.join("\n");
}

export function buildDispatchGuidance(project: Project): string {
  const pendingTasks = project.tasks.filter((t) => t.status === "pending");
  if (pendingTasks.length === 0) return "";

  const lines = [
    `\n[OMA Dispatch Plan — ${project.name}]`,
    `你是编排者。以下 ${pendingTasks.length} 个任务需要派出子 agent 执行：`,
    "",
  ];

  for (const task of pendingTasks) {
    lines.push(`📌 ${task.label} (${task.id})`);
    if (task.agentType) lines.push(`   Agent: ${task.agentType}`);
    lines.push(`   调用 sessions_spawn，task 参数：`);
    lines.push(`   "${task.subagentPrompt?.slice(0, 200) ?? task.label}"`);
    lines.push("");
  }

  lines.push(
    "完成派工后，等待子 agent 返回（sessions_yield），然后调用 multi-agent-orchestrator action=validate_and_merge 验收。",
  );

  return lines.join("\n");
}
