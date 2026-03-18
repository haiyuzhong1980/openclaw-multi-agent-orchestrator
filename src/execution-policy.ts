import type { DelegationStartGateMode, ExecutionGuardRequest, ExecutionPolicyMode } from "./types.ts";
import type { IntentRegistry } from "./intent-registry.ts";
import type { UserKeywords } from "./user-keywords.ts";
import { checkLearnedPatterns } from "./intent-registry.ts";

// DELEGATION markers — any ONE of these triggers delegation
const DELEGATION_MARKERS: string[] = [
  // Chinese - explicit delegation
  "多 agent", "子 agent", "主 agent", "派出", "派遣", "调度", "分工", "并行",
  "总控", "编排", "所有 agent", "多个 agent",
  // Chinese - strong intent signals
  "真实执行", "全力推进", "全面推进",
  // From mining — user's actual delegation language
  "推进", "强力推进", "直接推进",
  "落实", "开工", "准备开工",
  "产品经理",
  "里程碑", "任务看板", "任务清单", "进度表",
  "出报告", "出测试报告", "出审查报告", "出验收报告",
  "每一个里程碑", "每完成一个",
  "召唤", "集合",
  "全面审查", "全面审核", "全面优化", "全面提升",
  "深度思考", "最大思考",
  "释放",
  "组成团队", "团队开发",
  // English
  "multi agent", "multi-agent", "subagent", "sub-agent", "delegate", "dispatch",
  "worker", "orchestrate", "parallel", "all agents", "comprehensive",
];

// Regex-based delegation patterns — structural patterns, not fixed strings
const DELEGATION_REGEX: RegExp[] = [
  /从.*推进到/,                                         // "从M0推进到M4"
  /回到.*(?:那条|开发|路线|主线)/,                        // "回到那条开发线"
  /你.*(?:是|当).*(?:总控|产品经理|架构师)/,               // role assignment
  /每.*(?:里程碑|阶段|节点).*(?:检查|测试|审查|验收)/,     // milestone review pattern
  /(?:派出|调度|启动).*(?:所有|全部|多个)/,               // dispatch all
  /释放.*(?:力量|能力|agent)/,                           // "释放你的最大力量"
  /全力.*(?:推进|开干|执行|开发)/,                       // "全力推进"
  /(?:组成|组建).*(?:团队|小组)/,                        // "组成团队开发"
];

// TRACKED markers — need compound evidence
const TRACKED_MARKERS: string[] = [
  // Chinese - task verbs (broad coverage)
  "部署", "安装", "配置", "开发", "实现", "重构", "迁移", "升级",
  "审计", "审查", "审核", "检查", "检测", "检验",
  "测试", "评测", "评估", "验收", "验证",
  "分析", "调研", "研究", "探索", "排查",
  "优化", "修复", "修改", "改进", "改造",
  "创建", "构建", "搭建", "编写", "设计",
  "清理", "整理", "归档", "备份", "恢复",
  // Chinese - workflow signals
  "分步骤", "按步骤", "汇报进度", "阶段", "路线", "主线", "支线",
  "跑通", "M0", "M1", "M2", "M3", "M4", "P0", "P1", "P2",
  // From mining — user's actual tracked language
  "帮我配置", "帮我重启", "帮我找", "帮我看",
  "你先检查", "你先审查", "你查一下", "你去看看", "你去读",
  "启动", "重启", "停止",
  "修复所有", "修复这个",
  "推送到", "同步到", "部署到",
  "保存到", "写入", "记住",
  "写个", "写一个", "创建一个",
  "403", "521", "报错", "出错", "失败",
  "知识库", "文档", "readme",
  "ssh", "服务器", "远程",
  "github", "仓库", "repo",
  "打包", "发布", "上线",
  "读取", "加载", "扫描",
  // English - task verbs
  "step by step", "report progress", "deploy", "install", "configure",
  "develop", "implement", "refactor", "migrate", "upgrade",
  "audit", "review", "inspect", "test", "evaluate", "verify",
  "analyze", "research", "investigate", "troubleshoot",
  "optimize", "fix", "improve", "redesign",
  "build", "create", "design", "write",
  "milestone", "roadmap", "workflow", "phase", "pipeline",
  "download", "check", "config",
];

// ACTION VERBS for compound detection
const ACTION_VERBS: string[] = [
  // Chinese
  "审计", "评测", "审查", "分析", "调研", "测试", "部署", "检查",
  "开发", "实现", "优化", "修复", "重构", "迁移", "设计", "构建",
  "验收", "评估", "研究", "排查", "清理", "整理",
  "配置", "安装", "升级", "发布", "打包", "推送", "同步",
  "编写", "创建", "搭建", "改造", "改进",
  "扫描", "读取", "加载", "备份", "恢复",
  // English
  "audit", "review", "test", "deploy", "analyze", "research",
  "develop", "implement", "optimize", "fix", "refactor", "build",
  "evaluate", "investigate", "design", "verify", "configure",
  "install", "upgrade", "publish", "sync", "scan", "backup",
];

export function inferExecutionComplexity(
  request?: string,
  intentRegistry?: IntentRegistry,
  userKeywords?: UserKeywords,
): "light" | "tracked" | "delegation" {
  const text = (request ?? "").trim();
  const lower = text.toLowerCase();

  // Check user custom keywords first (highest priority — overrides all short-circuits)
  if (userKeywords) {
    for (const kw of userKeywords.delegation) {
      if (lower.includes(kw.toLowerCase())) return "delegation";
    }
    for (const kw of userKeywords.light) {
      if (lower.includes(kw.toLowerCase())) return "light";
    }
    for (const kw of userKeywords.tracked) {
      if (lower.includes(kw.toLowerCase())) return "tracked";
    }
  }

  // Ultra-narrow light detection — only bare acknowledgments
  if (text.length <= 6) {
    const bareAcks = /^(ok|好|好的|嗯|是的|可以|明白|对|行|收到|谢谢|thanks|yes|no)$/i;
    if (bareAcks.test(text.trim())) return "light";
  }

  // Short greetings only (not short work commands!)
  if (/^(你好|hello|hi|hey)[\s!！.。]*$/i.test(text.trim())) return "light";

  // Explicit choice responses: "方案A", "方案B" etc
  if (/^方案\s*[A-Za-z0-9]$/i.test(text.trim())) return "light";

  // Empty input
  if (text.length === 0) return "light";

  // Check learned patterns from intent registry
  if (intentRegistry) {
    const learnedTier = checkLearnedPatterns(lower, intentRegistry);
    if (learnedTier) return learnedTier;
  }

  // Regex-based delegation patterns (before static marker check)
  if (DELEGATION_REGEX.some((r) => r.test(text))) {
    return "delegation";
  }

  // Static delegation markers (any one is enough)
  if (DELEGATION_MARKERS.some((m) => lower.includes(m.toLowerCase()))) {
    return "delegation";
  }

  // Compound action detection: 4+ different action verbs → delegation (was 3+, too aggressive)
  const matchedActions = ACTION_VERBS.filter((v) => lower.includes(v.toLowerCase()));
  const uniqueActions = [...new Set(matchedActions)];
  if (uniqueActions.length >= 4) {
    return "delegation";
  }

  // Structural detection: numbered list with 3+ items → delegation
  const numberedItems = text.match(/(?:^|\n)\s*[0-9]+[.、)）]/gm);
  if (numberedItems && numberedItems.length >= 3 && text.length > 80) {
    return "delegation";
  }

  // 3 action verbs = tracked (not delegation anymore)
  if (uniqueActions.length >= 3) return "tracked";

  // Tracked markers with compound evidence
  const matchedTracked = TRACKED_MARKERS.filter((m) => lower.includes(m.toLowerCase()));
  if (matchedTracked.length >= 2) return "tracked";
  if (matchedTracked.length >= 1 && text.length > 50) return "tracked";

  // 2 action verbs = tracked
  if (uniqueActions.length >= 2) return "tracked";

  // Long message (>100 chars) with 1 action verb = tracked
  if (uniqueActions.length >= 1 && text.length > 100) return "tracked";

  // Default to "tracked" for this user — 99% of messages are work requests
  // Only explicit light indicators stay light
  if (text.length > 6) return "tracked";
  return "light";
}

export function shouldRequireTaskBus(
  mode: ExecutionPolicyMode,
  complexity: ReturnType<typeof inferExecutionComplexity>,
): boolean {
  if (mode === "strict-orchestrated") {
    return true;
  }
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
  if (mode === "strict-orchestrated") {
    return true;
  }
  if (mode === "delegation-first") {
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

  // strict-orchestrated additional enforcement
  if (params.mode === "strict-orchestrated") {
    const verifiedState = (params as { verifiedState?: { totalSpawns: number } }).verifiedState;
    if (verifiedState && verifiedState.totalSpawns > 0) {
      const policyCheckCount = (params as { policyCheckCount?: number }).policyCheckCount ?? 0;
      if (policyCheckCount < verifiedState.totalSpawns) {
        violations.push("strict 模式：每次派工后需重新调用 enforce_execution_policy");
        requiredNow.push("再次调用 enforce_execution_policy 确认当前状态");
      }
    }
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
