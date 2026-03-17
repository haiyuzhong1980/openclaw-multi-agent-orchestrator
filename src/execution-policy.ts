import type { DelegationStartGateMode, ExecutionGuardRequest, ExecutionPolicyMode } from "./types.ts";

export function inferExecutionComplexity(request?: string): "light" | "tracked" | "delegation" {
  const text = (request ?? "").toLowerCase();
  const longTaskMarkers = [
    // Chinese
    "分步骤",
    "按步骤",
    "汇报进度",
    "真实执行",
    "下载",
    "安装",
    "部署",
    "审计",
    "检查",
    "配置",
    // English
    "step by step",
    "report progress",
    "real execution",
    "download",
    "install",
    "deploy",
    "audit",
    "inspect",
    "check",
    "configure",
    "config",
  ];
  const delegationMarkers = [
    // Chinese
    "多 agent",
    "子 agent",
    "派",
    "分工",
    // English
    "multi agent",
    "multi-agent",
    "subagent",
    "sub-agent",
    "delegate",
    "dispatch",
    "worker",
  ];
  const matchedLong = longTaskMarkers.some((marker) => text.includes(marker));
  const matchedDelegation = delegationMarkers.some((marker) => text.includes(marker));
  if (matchedDelegation) {
    return "delegation";
  }
  if (matchedLong) {
    return "tracked";
  }
  return "light";
}

export function shouldRequireTaskBus(
  mode: ExecutionPolicyMode,
  complexity: ReturnType<typeof inferExecutionComplexity>,
): boolean {
  if (mode === "free") {
    return complexity !== "light";
  }
  if (mode === "guided") {
    return complexity === "tracked" || complexity === "delegation";
  }
  return true;
}

export function shouldRequireDelegation(
  mode: ExecutionPolicyMode,
  complexity: ReturnType<typeof inferExecutionComplexity>,
): boolean {
  if (mode === "delegation-first" || mode === "strict-orchestrated") {
    return complexity !== "light";
  }
  return complexity === "delegation";
}

export function buildExecutionPolicyReport(params: {
  mode: ExecutionPolicyMode;
  delegationStartGate: DelegationStartGateMode;
  request?: string;
  state: ExecutionGuardRequest;
}) {
  const complexity = inferExecutionComplexity(params.request);
  const requiresTaskBus = shouldRequireTaskBus(params.mode, complexity);
  const requiresDelegation = shouldRequireDelegation(params.mode, complexity);
  const requiresStepPlan = params.mode !== "free" || complexity !== "light";
  const realExecutionStarted = Boolean(params.state.hasTrackedExecution || params.state.hasWorkerStart);
  const enforceDispatchFirst = params.delegationStartGate === "required" && requiresDelegation;
  const advisoryDispatch = params.delegationStartGate === "advisory" && requiresDelegation;
  const currentStep = Number(params.state.currentStep ?? 0);
  const totalSteps = Number(params.state.totalSteps ?? 0);

  const violations: string[] = [];
  const requiredNow: string[] = [];
  const nextActions: string[] = [];

  if (requiresTaskBus && !params.state.hasTaskBus) {
    violations.push("缺少 task bus");
    requiredNow.push("先创建 canonical tracked task / task bus（必须是 TASK-* 目录，不允许单个 json 伪 task）");
  }
  if (requiresStepPlan && !params.state.hasPlan) {
    violations.push("缺少明确步骤计划");
    requiredNow.push("先输出 step plan");
  }
  if (params.state.hasCheckpoint && !realExecutionStarted) {
    violations.push("已对外宣告开始，但没有真实执行证据");
    requiredNow.push("立即启动 tracked execution 或 spawn 第一个 worker");
  }
  if (requiresDelegation && !params.state.hasWorkerStart) {
    violations.push("当前策略要求先派遣，但未发现 worker/subagent 启动");
    requiredNow.push("立即派出第一个 worker/subagent");
  }
  if (enforceDispatchFirst && !realExecutionStarted) {
    violations.push("delegationStartGate 已开启：首次派工前，主 agent 不能自己执行实质工作");
    requiredNow.push("先完成首次派工，再进行仓库检查/安全分析/部署执行/最终汇总");
  }
  if (params.state.hasCompletedStep && currentStep > 0 && totalSteps > 0 && currentStep < totalSteps) {
    violations.push(`Step ${currentStep} 已完成，但尚未推进下一步`);
    requiredNow.push(`立即推进 Step ${currentStep + 1}/${totalSteps}`);
  }
  if (currentStep >= totalSteps && totalSteps > 0 && !params.state.hasFinalMerge) {
    violations.push("所有步骤已完成，但还没有做最终验收与汇总");
    requiredNow.push("执行最终验收、去重、汇总");
  }

  if (violations.length === 0) {
    nextActions.push("当前执行状态符合策略要求，可以继续正常推进。");
  } else {
    nextActions.push(...requiredNow);
  }

  // Advisory: warn but don't block
  if (advisoryDispatch && !params.state.hasWorkerStart) {
    nextActions.push("💡 建议：当前任务适合派遣 worker/subagent 执行（advisory 模式，非强制）");
  }

  const lines = [
    "执行策略判定",
    `- policy: ${params.mode}`,
    `- complexity: ${complexity}`,
    `- requireTaskBus: ${requiresTaskBus ? "yes" : "no"}`,
    `- requireStepPlan: ${requiresStepPlan ? "yes" : "no"}`,
    `- requireDelegation: ${requiresDelegation ? "yes" : "no"}`,
    `- delegationStartGate: ${params.delegationStartGate}`,
    "",
    "当前状态",
    `- taskBus: ${params.state.hasTaskBus ? "yes" : "no"}`,
    `- plan: ${params.state.hasPlan ? "yes" : "no"}`,
    `- checkpoint: ${params.state.hasCheckpoint ? "yes" : "no"}`,
    `- workerStarted: ${params.state.hasWorkerStart ? "yes" : "no"}`,
    `- trackedExecution: ${params.state.hasTrackedExecution ? "yes" : "no"}`,
    `- completedStep: ${params.state.hasCompletedStep ? "yes" : "no"}`,
    `- currentStep: ${currentStep}`,
    `- totalSteps: ${totalSteps}`,
    "",
    "违规项",
    ...(violations.length > 0 ? violations.map((item) => `- ${item}`) : ["- 无"]),
    "",
    "下一步",
    ...nextActions.map((item) => `- ${item}`),
  ];

  return {
    report: lines.join("\n"),
    details: {
      policy: params.mode,
      complexity,
      requireTaskBus: requiresTaskBus,
      requireStepPlan: requiresStepPlan,
      requireDelegation: requiresDelegation,
      delegationStartGate: params.delegationStartGate,
      enforceDispatchFirst,
      realExecutionStarted,
      violations,
      requiredNow,
      recommendedAction:
        requiredNow[0] ??
        (params.state.hasFinalMerge ? "continue" : "continue_with_current_step"),
      resumePrompt:
        requiredNow.length > 0
          ? `按 ${params.mode} 策略继续执行。不要只汇报计划；现在必须先完成：${requiredNow.join("；")}。`
          : "按当前策略继续执行并保持步骤同步。",
    },
  };
}
