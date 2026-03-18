/**
 * 深度验证层 — 不只测分类准确率，还验证 OMA 的实际行为:
 *
 * 1. delegation 消息是否触发正确的执行策略（requireDelegation = true）
 * 2. enforcement level 的行为是否匹配（L1=advisory, L2=guided, L3=block）
 * 3. 不同类型的 delegation 消息能否匹配到合适的 track template
 * 4. 执行策略报告是否正确检测违规
 */

import { inferExecutionComplexity, shouldRequireDelegation, shouldRequireTaskBus } from "../../src/execution-policy.ts";
import { getEnforcementBehavior } from "../../src/enforcement-ladder.ts";
import type { EnforcementLevel } from "../../src/enforcement-ladder.ts";
import { findTemplate, listTemplates } from "../../src/track-templates.ts";
import type { UserProfile } from "./user-profiles.ts";
import { PROFILES as BASE_PROFILES, sampleTier, sampleMessage } from "./user-profiles.ts";
import { EXTENDED_PROFILES } from "./user-profiles-extended.ts";
import { loadCorpus, sampleFromCorpus } from "./llm-message-generator.ts";

const ALL_PROFILES = [...BASE_PROFILES, ...EXTENDED_PROFILES];

export interface DeepValidationResult {
  profileId: string;
  profileName: string;
  totalMessages: number;

  // Tier classification
  tierAccuracy: number;
  tierBreakdown: {
    light: { correct: number; total: number };
    tracked: { correct: number; total: number };
    delegation: { correct: number; total: number };
  };

  // Execution policy validation
  delegationTriggerRate: number;  // % of delegation msgs that trigger requireDelegation
  taskBusTriggerRate: number;     // % of tracked+ msgs that trigger requireTaskBus
  falseDispatchRate: number;      // % of light msgs wrongly triggering delegation

  // Enforcement behavior consistency
  enforcementTests: {
    level: EnforcementLevel;
    injectGuidance: boolean;
    injectDispatchPlan: boolean;
    blockNonDispatch: boolean;
    logOnly: boolean;
    correct: boolean;
  }[];

  // Track template matching
  templateMatchRate: number;      // % of delegation msgs matching a template
  templateMatches: Record<string, number>; // template_id → count

  // Agent dispatch capability
  wouldSpawnAgent: number;        // count of msgs where delegation + policy = spawn required
  wouldNotSpawn: number;          // count of delegation msgs where spawn NOT required (policy mismatch)

  // Edge cases
  misclassifiedExamples: Array<{
    message: string;
    intended: string;
    predicted: string;
    requireDelegation: boolean;
  }>;
}

/**
 * Match a delegation message to the best track template
 */
function matchTemplate(message: string): string | null {
  const lower = message.toLowerCase();
  const templates = listTemplates();

  // Keyword matching heuristics
  const templateKeywords: Record<string, string[]> = {
    "security-audit": ["安全", "漏洞", "security", "audit", "扫描", "渗透"],
    "performance-review": ["性能", "优化", "延迟", "bottleneck", "performance", "profiling", "P99"],
    "code-review": ["代码审查", "review", "code quality", "lint", "代码质量"],
    "dependency-audit": ["依赖", "dependency", "版本", "过期", "升级"],
    "documentation-review": ["文档", "documentation", "README", "注释"],
    "ops-health-check": ["健康检查", "监控", "运维", "health", "状态"],
    "competitive-analysis": ["竞品", "对比", "competitive", "市场"],
    "market-research": ["市场", "趋势", "research", "调研"],
    "github-issues": ["issue", "bug", "问题", "报错"],
    "github-discussions": ["讨论", "discussion", "方案"],
  };

  for (const [templateId, keywords] of Object.entries(templateKeywords)) {
    if (keywords.some((kw) => lower.includes(kw))) {
      return templateId;
    }
  }

  return null;
}

/**
 * Run deep validation for a single profile
 */
export function validateProfile(
  profile: UserProfile,
  messagesPerTier: number,
  corpusPath?: string,
): DeepValidationResult {
  const corpus = corpusPath ? loadCorpus(corpusPath) : null;
  const tiers: Array<"light" | "tracked" | "delegation"> = ["light", "tracked", "delegation"];

  let totalMessages = 0;
  const tierBreakdown = {
    light: { correct: 0, total: 0 },
    tracked: { correct: 0, total: 0 },
    delegation: { correct: 0, total: 0 },
  };

  let delegationTriggers = 0;
  let delegationTotal = 0;
  let taskBusTriggers = 0;
  let taskBusEligible = 0;
  let falseDispatches = 0;
  let lightTotal = 0;

  let templateMatches = 0;
  let delegationMessages = 0;
  const templateMatchCounts: Record<string, number> = {};

  let wouldSpawnAgent = 0;
  let wouldNotSpawn = 0;

  const misclassifiedExamples: DeepValidationResult["misclassifiedExamples"] = [];

  for (const tier of tiers) {
    for (let i = 0; i < messagesPerTier; i++) {
      const message = (corpus && sampleFromCorpus(corpus, profile.id, tier))
        || sampleMessage(profile, tier);

      totalMessages++;

      // 1. Classification
      const predicted = inferExecutionComplexity(message);
      tierBreakdown[tier].total++;
      if (predicted === tier) {
        tierBreakdown[tier].correct++;
      } else if (misclassifiedExamples.length < 10) {
        const requireDel = shouldRequireDelegation("delegation-first", predicted);
        misclassifiedExamples.push({
          message: message.slice(0, 100),
          intended: tier,
          predicted,
          requireDelegation: requireDel,
        });
      }

      // 2. Execution policy checks
      if (tier === "delegation") {
        delegationTotal++;
        const requireDel = shouldRequireDelegation("delegation-first", predicted);
        if (requireDel) delegationTriggers++;

        // Template matching
        delegationMessages++;
        const template = matchTemplate(message);
        if (template) {
          templateMatches++;
          templateMatchCounts[template] = (templateMatchCounts[template] ?? 0) + 1;
        }

        // Would spawn check
        if (predicted === "delegation" && requireDel) {
          wouldSpawnAgent++;
        } else if (predicted === "delegation" && !requireDel) {
          wouldNotSpawn++;
        }
      }

      if (tier === "tracked" || tier === "delegation") {
        taskBusEligible++;
        if (shouldRequireTaskBus("delegation-first", predicted)) {
          taskBusTriggers++;
        }
      }

      if (tier === "light") {
        lightTotal++;
        const requireDel = shouldRequireDelegation("delegation-first", predicted);
        if (requireDel) falseDispatches++;
      }
    }
  }

  // 3. Enforcement behavior tests
  const enforcementTests: DeepValidationResult["enforcementTests"] = [];
  const expectedBehaviors: Record<EnforcementLevel, { guidance: boolean; dispatch: boolean; block: boolean; logOnly: boolean }> = {
    0: { guidance: false, dispatch: false, block: false, logOnly: true },
    1: { guidance: true, dispatch: false, block: false, logOnly: false },
    2: { guidance: true, dispatch: true, block: false, logOnly: false },
    3: { guidance: true, dispatch: true, block: true, logOnly: false },
  };

  for (const level of [0, 1, 2, 3] as EnforcementLevel[]) {
    const behavior = getEnforcementBehavior(level);
    const expected = expectedBehaviors[level];
    const correct =
      behavior.injectGuidance === expected.guidance &&
      behavior.injectDispatchPlan === expected.dispatch &&
      behavior.blockNonDispatchTools === expected.block &&
      behavior.logOnly === expected.logOnly;

    enforcementTests.push({
      level,
      injectGuidance: behavior.injectGuidance,
      injectDispatchPlan: behavior.injectDispatchPlan,
      blockNonDispatch: behavior.blockNonDispatchTools,
      logOnly: behavior.logOnly,
      correct,
    });
  }

  const totalCorrect = tierBreakdown.light.correct + tierBreakdown.tracked.correct + tierBreakdown.delegation.correct;

  return {
    profileId: profile.id,
    profileName: profile.name,
    totalMessages,
    tierAccuracy: totalMessages > 0 ? totalCorrect / totalMessages : 0,
    tierBreakdown,
    delegationTriggerRate: delegationTotal > 0 ? delegationTriggers / delegationTotal : 0,
    taskBusTriggerRate: taskBusEligible > 0 ? taskBusTriggers / taskBusEligible : 0,
    falseDispatchRate: lightTotal > 0 ? falseDispatches / lightTotal : 0,
    enforcementTests,
    templateMatchRate: delegationMessages > 0 ? templateMatches / delegationMessages : 0,
    templateMatches: templateMatchCounts,
    wouldSpawnAgent,
    wouldNotSpawn,
    misclassifiedExamples,
  };
}

/**
 * Run deep validation across all profiles and print report
 */
export function runDeepValidation(messagesPerTier = 100, corpusPath?: string): void {
  console.log(`\n${"═".repeat(70)}`);
  console.log(`  OMA 深度验证 — 分类 + 执行策略 + Agent 触发 + 模板匹配`);
  console.log(`  ${ALL_PROFILES.length} 画像 × ${messagesPerTier * 3} 消息/画像`);
  console.log(`${"═".repeat(70)}\n`);

  const results: DeepValidationResult[] = [];

  for (const profile of ALL_PROFILES) {
    process.stdout.write(`  ${profile.name}...`);
    const result = validateProfile(profile, messagesPerTier, corpusPath);
    results.push(result);
    console.log(` 准确率=${(result.tierAccuracy * 100).toFixed(1)}% ` +
      `delegation触发=${(result.delegationTriggerRate * 100).toFixed(0)}% ` +
      `模板匹配=${(result.templateMatchRate * 100).toFixed(0)}% ` +
      `会spawn=${result.wouldSpawnAgent}`);
  }

  // Summary table
  console.log(`\n${"─".repeat(90)}`);
  const header =
    "画像".padEnd(12) +
    "准确率".padEnd(8) +
    "L分类".padEnd(7) +
    "T分类".padEnd(7) +
    "D分类".padEnd(7) +
    "D触发".padEnd(7) +
    "误触发".padEnd(7) +
    "模板%".padEnd(7) +
    "spawn".padEnd(7) +
    "误例";
  console.log(header);
  console.log("─".repeat(90));

  for (const r of results) {
    const lAcc = r.tierBreakdown.light.total > 0
      ? (r.tierBreakdown.light.correct / r.tierBreakdown.light.total * 100).toFixed(0) + "%"
      : "n/a";
    const tAcc = r.tierBreakdown.tracked.total > 0
      ? (r.tierBreakdown.tracked.correct / r.tierBreakdown.tracked.total * 100).toFixed(0) + "%"
      : "n/a";
    const dAcc = r.tierBreakdown.delegation.total > 0
      ? (r.tierBreakdown.delegation.correct / r.tierBreakdown.delegation.total * 100).toFixed(0) + "%"
      : "n/a";

    console.log(
      `${r.profileName.padEnd(12)}` +
      `${(r.tierAccuracy * 100).toFixed(1)}%`.padEnd(8) +
      `${lAcc}`.padEnd(7) +
      `${tAcc}`.padEnd(7) +
      `${dAcc}`.padEnd(7) +
      `${(r.delegationTriggerRate * 100).toFixed(0)}%`.padEnd(7) +
      `${(r.falseDispatchRate * 100).toFixed(0)}%`.padEnd(7) +
      `${(r.templateMatchRate * 100).toFixed(0)}%`.padEnd(7) +
      `${r.wouldSpawnAgent}`.padEnd(7) +
      `${r.misclassifiedExamples.length}`,
    );
  }

  // Enforcement behavior check
  console.log(`\n${"─".repeat(70)}`);
  console.log("Enforcement 行为一致性检查:");
  const firstResult = results[0];
  for (const test of firstResult.enforcementTests) {
    console.log(`  L${test.level}: guidance=${test.injectGuidance} dispatch=${test.injectDispatchPlan} ` +
      `block=${test.blockNonDispatch} logOnly=${test.logOnly} → ${test.correct ? "✅" : "❌"}`);
  }

  // Template distribution
  console.log(`\n${"─".repeat(70)}`);
  console.log("Track Template 匹配分布:");
  const allTemplateMatches: Record<string, number> = {};
  for (const r of results) {
    for (const [t, c] of Object.entries(r.templateMatches)) {
      allTemplateMatches[t] = (allTemplateMatches[t] ?? 0) + c;
    }
  }
  const sorted = Object.entries(allTemplateMatches).sort((a, b) => b[1] - a[1]);
  for (const [templateId, count] of sorted) {
    console.log(`  ${templateId}: ${count} 次`);
  }

  // Top misclassified examples
  console.log(`\n${"─".repeat(70)}`);
  console.log("典型误分类示例 (前 20 条):");
  const allMisclassified = results.flatMap((r) =>
    r.misclassifiedExamples.map((e) => ({ ...e, profile: r.profileId })),
  );
  for (const ex of allMisclassified.slice(0, 20)) {
    console.log(`  [${ex.profile}] "${ex.message}" → 预测=${ex.predicted} 实际=${ex.intended} dispatch=${ex.requireDelegation}`);
  }

  // Overall stats
  const totalMsgs = results.reduce((s, r) => s + r.totalMessages, 0);
  const totalCorrect = results.reduce((s, r) => s + r.tierAccuracy * r.totalMessages, 0);
  const totalSpawn = results.reduce((s, r) => s + r.wouldSpawnAgent, 0);
  const totalDelegation = results.reduce((s, r) => s + r.tierBreakdown.delegation.total, 0);

  console.log(`\n${"═".repeat(70)}`);
  console.log(`  总消息: ${totalMsgs}  总准确率: ${(totalCorrect / totalMsgs * 100).toFixed(1)}%`);
  console.log(`  总 delegation 消息: ${totalDelegation}  会触发 spawn: ${totalSpawn} (${(totalSpawn / totalDelegation * 100).toFixed(1)}%)`);
  console.log(`${"═".repeat(70)}\n`);
}

// ─── CLI ──────────────────────────────────────────────────────────────
const isMain = process.argv[1]?.endsWith("deep-validation.ts");
if (isMain) {
  const corpusPath = process.argv[2] || undefined;
  const msgsPerTier = parseInt(process.argv[3] || "100", 10);
  runDeepValidation(msgsPerTier, corpusPath);
}
