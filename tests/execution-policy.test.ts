import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  inferExecutionComplexity,
  shouldRequireTaskBus,
  shouldRequireDelegation,
  buildExecutionPolicyReport,
} from "../src/execution-policy.ts";
import { createEmptyRegistry, recordClassification } from "../src/intent-registry.ts";
import type { UserKeywords } from "../src/user-keywords.ts";

describe("inferExecutionComplexity", () => {
  it('returns delegation for Chinese "真实执行一个多 agent 调研"', () => {
    assert.equal(inferExecutionComplexity("真实执行一个多 agent 调研"), "delegation");
  });

  it('returns tracked for short Chinese "按步骤部署" (work command, not bare ack)', () => {
    assert.equal(inferExecutionComplexity("按步骤部署"), "tracked");
  });

  it('returns light for Chinese "查一下" (3 chars, <= 6, not bare ack but too short)', () => {
    assert.equal(inferExecutionComplexity("查一下"), "light");
  });

  it('returns tracked for English "deploy step by step with multiple agents" (2 markers: deploy + step by step)', () => {
    assert.equal(inferExecutionComplexity("deploy step by step with multiple agents"), "tracked");
  });

  it('returns tracked for English "audit the security" (work request, > 6 chars)', () => {
    assert.equal(inferExecutionComplexity("audit the security"), "tracked");
  });

  it('returns light for English "hello"', () => {
    assert.equal(inferExecutionComplexity("hello"), "light");
  });

  it('returns delegation for mixed "multi agent 调研任务" (>= 15 chars)', () => {
    assert.equal(inferExecutionComplexity("multi agent 调研任务"), "delegation");
  });

  it("returns light for empty string", () => {
    assert.equal(inferExecutionComplexity(""), "light");
  });

  it("returns light for undefined", () => {
    assert.equal(inferExecutionComplexity(undefined), "light");
  });

  it("returns light for short Chinese 分步骤 (6 chars, <= 6, not bare ack but too short)", () => {
    assert.equal(inferExecutionComplexity("请分步骤处理"), "light");
  });

  it("returns tracked for short English step by step (work command)", () => {
    assert.equal(inferExecutionComplexity("do it step by step"), "tracked");
  });

  it("returns delegation for sub-agent keyword (>= 15 chars)", () => {
    assert.equal(inferExecutionComplexity("use a subagent now"), "delegation");
  });

  it("returns delegation for delegate keyword", () => {
    assert.equal(inferExecutionComplexity("delegate this task"), "delegation");
  });

  it("returns tracked for download keyword alone (work request, > 6 chars)", () => {
    assert.equal(inferExecutionComplexity("download the package"), "tracked");
  });

  it("returns tracked for install keyword alone (work request, > 6 chars)", () => {
    assert.equal(inferExecutionComplexity("install the dependencies"), "tracked");
  });

  it('returns tracked for "configure the server" (tracked marker: configure)', () => {
    assert.equal(inferExecutionComplexity("configure the server"), "tracked");
  });

  it("prioritizes delegation over tracked when both markers match", () => {
    assert.equal(inferExecutionComplexity("multi agent deploy step by step"), "delegation");
  });

  it("returns tracked for short 检查 keyword (work command)", () => {
    assert.equal(inferExecutionComplexity("检查一下配置"), "tracked");
  });

  it("returns light for short 汇报进度 keyword (5 chars, <= 6, falls through to light)", () => {
    assert.equal(inferExecutionComplexity("请汇报进度"), "light");
  });

  it("returns delegation for 子 agent keyword (>= 15 chars)", () => {
    assert.equal(inferExecutionComplexity("请派出子 agent 执行任务"), "delegation");
  });

  it("returns delegation for dispatch keyword", () => {
    assert.equal(inferExecutionComplexity("dispatch workers now"), "delegation");
  });

  it("returns delegation for worker keyword (>= 15 chars)", () => {
    assert.equal(inferExecutionComplexity("spawn a worker process"), "delegation");
  });

  // Light detection: only bare acknowledgments and greetings
  it('returns light for "你好" (greeting)', () => {
    assert.equal(inferExecutionComplexity("你好"), "light");
  });

  it('returns light for "ok" (bare ack, <= 6 chars)', () => {
    assert.equal(inferExecutionComplexity("ok"), "light");
  });

  it('returns light for "好的" (bare ack, <= 6 chars)', () => {
    assert.equal(inferExecutionComplexity("好的"), "light");
  });

  it('returns light for "方案B" (explicit choice response)', () => {
    assert.equal(inferExecutionComplexity("方案B"), "light");
  });

  it('returns light for "hello" (greeting)', () => {
    assert.equal(inferExecutionComplexity("hello"), "light");
  });

  it('returns tracked for "check" (> 0 chars, work-like, but <= 6 chars and not bare ack — actually 5 chars, returns light if <= 6 and not ack)', () => {
    // "check" is 5 chars, <= 6, but not in bareAcks list — falls to default return "light"
    assert.equal(inferExecutionComplexity("check"), "light");
  });

  it('returns tracked for "hello, how are you" (18 chars, greeting regex does not match due to comma+extra text)', () => {
    assert.equal(inferExecutionComplexity("hello, how are you"), "tracked");
  });

  it('returns light for "帮我检查一下" (6 chars exactly, <= 6, not bare ack but too short)', () => {
    assert.equal(inferExecutionComplexity("帮我检查一下"), "light");
  });

  // Fix B: Compound evidence tests
  it('returns tracked for two keywords "请按步骤执行完整的部署和安装流程" (2+ markers)', () => {
    assert.equal(inferExecutionComplexity("请按步骤执行完整的部署和安装流程"), "tracked");
  });

  it("returns tracked for long request with single keyword (> 50 chars)", () => {
    assert.equal(
      inferExecutionComplexity("please configure the entire deployment pipeline for our production environment"),
      "tracked",
    );
  });

  it("returns tracked for two English markers: deploy + download", () => {
    assert.equal(inferExecutionComplexity("deploy and download all dependencies for the project"), "tracked");
  });

  it("returns tracked for single marker request exactly at 50 chars boundary (> 6 chars → tracked by default)", () => {
    // 50 chars exactly with "check" marker
    const text = "please check this item for me right now ok thanks!"; // 50 chars
    assert.equal(text.length, 50);
    // > 6 chars and not a bare ack/greeting → tracked by default
    assert.equal(inferExecutionComplexity(text), "tracked");
  });

  it("returns tracked for single marker request just over 50 chars", () => {
    const text = "please check this item for me right now ok thanks!!"; // 51 chars
    assert.equal(text.length, 51);
    assert.equal(inferExecutionComplexity(text), "tracked");
  });

  // New: compound action verb detection
  it("returns delegation for 3 action verbs in one message", () => {
    assert.equal(inferExecutionComplexity("请帮我审计、评测和审查整个系统的安全性"), "delegation");
  });

  it("returns delegation for 3 English action verbs", () => {
    assert.equal(inferExecutionComplexity("please audit, review and test the entire security system"), "delegation");
  });

  it("returns tracked for exactly 2 action verbs", () => {
    const result = inferExecutionComplexity("audit and review the security module");
    assert.equal(result, "tracked");
  });

  // New: numbered list detection
  it("returns delegation for numbered list with 3+ items (> 80 chars)", () => {
    const text = "Complete the following steps for our release pipeline:\n1. Set up the staging environment\n2. Run a smoke test suite\n3. Deploy to production servers";
    assert.ok(text.length > 80, `Text length: ${text.length}`);
    assert.equal(inferExecutionComplexity(text), "delegation");
  });

  it("returns delegation for numbered list with 3+ items using period", () => {
    const text = "Complete the following:\n1. Deploy to production\n2. Run security audit\n3. Configure monitoring system and alerts";
    assert.ok(text.length > 80, `Text length: ${text.length}`);
    assert.equal(inferExecutionComplexity(text), "delegation");
  });

  it("does NOT return delegation for numbered list with only 2 items and simple verbs", () => {
    const text = "Please complete the following steps carefully:\n1. Write the unit tests\n2. Submit a pull request when done";
    const numberedItems = text.match(/(?:^|\n)\s*[0-9]+[.、)）]/gm);
    assert.ok(numberedItems && numberedItems.length === 2, `Expected 2 items, got ${numberedItems?.length}`);
    const result = inferExecutionComplexity(text);
    assert.ok(result !== "delegation", `Expected not delegation, got ${result}`);
  });

  it("does NOT return delegation for numbered list with 3+ items but short text (< 80 chars)", () => {
    const text = "1. do A\n2. do B\n3. do C";
    assert.ok(text.length < 80);
    const result = inferExecutionComplexity(text);
    assert.ok(result !== "delegation", `Expected not delegation for short text, got ${result}`);
  });

  // New: user custom keywords override static detection (run before short-circuit)
  it("user delegation keyword triggers delegation even for short message", () => {
    const userKeywords: UserKeywords = {
      delegation: ["全力推进"],
      tracked: [],
      light: [],
      updatedAt: "",
    };
    // Short text but user keyword should still override
    assert.equal(inferExecutionComplexity("全力推进", undefined, userKeywords), "delegation");
  });

  it("user tracked keyword triggers tracked", () => {
    const userKeywords: UserKeywords = {
      delegation: [],
      tracked: ["出个报告"],
      light: [],
      updatedAt: "",
    };
    assert.equal(inferExecutionComplexity("出个报告", undefined, userKeywords), "tracked");
  });

  it("user light keyword overrides tracked detection", () => {
    const userKeywords: UserKeywords = {
      delegation: [],
      tracked: [],
      light: ["随便聊聊"],
      updatedAt: "",
    };
    // Even with a tracked marker, light keyword should win (runs before short-circuit)
    assert.equal(inferExecutionComplexity("随便聊聊", undefined, userKeywords), "light");
  });

  it("user delegation keyword takes precedence over static tracked detection", () => {
    const userKeywords: UserKeywords = {
      delegation: ["深度分析"],
      tracked: [],
      light: [],
      updatedAt: "",
    };
    assert.equal(inferExecutionComplexity("深度分析", undefined, userKeywords), "delegation");
  });

  // New: learned patterns from intent registry
  it("learned patterns boost delegation classification", () => {
    const registry = createEmptyRegistry();
    // Train "部署系统" as delegation 3 times
    recordClassification(registry, ["部署系统"], "delegation");
    recordClassification(registry, ["部署系统"], "delegation");
    recordClassification(registry, ["部署系统"], "delegation");
    // Text is >= 7 chars so it passes the length check and then hits the registry
    const text = "这次需要把部署系统整体推上生产环境";
    assert.ok(text.length > 6, `Text length: ${text.length}`);
    const result = inferExecutionComplexity(text, registry);
    assert.equal(result, "delegation");
  });

  it("learned patterns with insufficient occurrences do not override", () => {
    const registry = createEmptyRegistry();
    // Only 2 occurrences — not enough
    recordClassification(registry, ["deploy"], "delegation");
    recordClassification(registry, ["deploy"], "delegation");
    // Should fall through to static detection: "just deploy it" > 6 chars → tracked by default
    const result = inferExecutionComplexity("just deploy it", registry);
    assert.equal(result, "tracked");
  });

  // New: delegation markers from expanded list
  it("returns delegation for 全力推进 marker", () => {
    const text = "请帮我全力推进这个复杂系统改造项目";
    assert.ok(text.length > 6, `Text length: ${text.length}`);
    assert.equal(inferExecutionComplexity(text), "delegation");
  });

  it("returns delegation for 全面推进 marker", () => {
    const text = "需要你全面推进这个系统的改造和升级";
    assert.ok(text.length > 6, `Text length: ${text.length}`);
    assert.equal(inferExecutionComplexity(text), "delegation");
  });

  it("returns delegation for orchestrate keyword", () => {
    assert.equal(inferExecutionComplexity("orchestrate the deployment process"), "delegation");
  });

  it("returns delegation for parallel keyword", () => {
    assert.equal(inferExecutionComplexity("run these tasks in parallel workers"), "delegation");
  });

  // New: light keyword overrides even delegation markers (user explicit light)
  it("user light keyword beats delegation markers", () => {
    const userKeywords: UserKeywords = {
      delegation: [],
      tracked: [],
      light: ["multi agent"],
      updatedAt: "",
    };
    // "multi agent" is a static delegation marker, but user says light
    assert.equal(inferExecutionComplexity("this multi agent thing is light", undefined, userKeywords), "light");
  });

  // New tests from mining results
  it('returns tracked for "把M0-M3跑通" (work command, > 6 chars)', () => {
    assert.equal(inferExecutionComplexity("把M0-M3跑通"), "tracked");
  });

  it('returns light for "ok" (bare ack)', () => {
    assert.equal(inferExecutionComplexity("ok"), "light");
  });

  it('returns light for "好的" (bare ack)', () => {
    assert.equal(inferExecutionComplexity("好的"), "light");
  });

  it('returns light for "方案B" (explicit choice response)', () => {
    assert.equal(inferExecutionComplexity("方案B"), "light");
  });

  it('returns light for "你好" (greeting)', () => {
    assert.equal(inferExecutionComplexity("你好"), "light");
  });

  it('returns tracked for "帮我配置一下服务器" (tracked marker: 帮我配置)', () => {
    assert.equal(inferExecutionComplexity("帮我配置一下服务器"), "tracked");
  });

  it('returns delegation for "全面审查代码，出审查报告" (delegation markers: 全面审查 + 出审查报告)', () => {
    assert.equal(inferExecutionComplexity("全面审查代码，出审查报告"), "delegation");
  });

  it('returns delegation for "从M0推进到M4，每一个里程碑检查+测试" (regex + delegation markers)', () => {
    assert.equal(inferExecutionComplexity("从M0推进到M4，每一个里程碑检查+测试"), "delegation");
  });

  it('returns tracked for "帮我重启 gateway" (tracked marker: 帮我重启)', () => {
    assert.equal(inferExecutionComplexity("帮我重启 gateway"), "tracked");
  });

  it('returns tracked for "出现403错误" (tracked marker: 403, 7 chars → default tracked)', () => {
    assert.equal(inferExecutionComplexity("出现403错误"), "tracked");
  });

  it("default for any unknown work message > 6 chars is tracked", () => {
    assert.equal(inferExecutionComplexity("请帮我处理这个问题"), "tracked");
    assert.equal(inferExecutionComplexity("something work related"), "tracked");
  });
});

describe("shouldRequireTaskBus", () => {
  it("returns false for free + light", () => {
    assert.equal(shouldRequireTaskBus("free", "light"), false);
  });

  it("returns true for free + tracked", () => {
    assert.equal(shouldRequireTaskBus("free", "tracked"), true);
  });

  it("returns true for free + delegation", () => {
    assert.equal(shouldRequireTaskBus("free", "delegation"), true);
  });

  it("returns false for guided + light", () => {
    assert.equal(shouldRequireTaskBus("guided", "light"), false);
  });

  it("returns true for guided + tracked", () => {
    assert.equal(shouldRequireTaskBus("guided", "tracked"), true);
  });

  it("returns true for guided + delegation", () => {
    assert.equal(shouldRequireTaskBus("guided", "delegation"), true);
  });

  it("returns true for tracked + light", () => {
    assert.equal(shouldRequireTaskBus("tracked", "light"), true);
  });

  it("returns true for tracked + tracked", () => {
    assert.equal(shouldRequireTaskBus("tracked", "tracked"), true);
  });

  it("returns true for tracked + delegation", () => {
    assert.equal(shouldRequireTaskBus("tracked", "delegation"), true);
  });

  it("returns true for delegation-first + light", () => {
    assert.equal(shouldRequireTaskBus("delegation-first", "light"), true);
  });

  it("returns true for delegation-first + tracked", () => {
    assert.equal(shouldRequireTaskBus("delegation-first", "tracked"), true);
  });

  it("returns true for strict-orchestrated + light", () => {
    assert.equal(shouldRequireTaskBus("strict-orchestrated", "light"), true);
  });

  it("returns true for strict-orchestrated + tracked", () => {
    assert.equal(shouldRequireTaskBus("strict-orchestrated", "tracked"), true);
  });

  it("returns true for strict-orchestrated + delegation", () => {
    assert.equal(shouldRequireTaskBus("strict-orchestrated", "delegation"), true);
  });
});

describe("shouldRequireDelegation", () => {
  it("returns true for delegation-first + tracked", () => {
    assert.equal(shouldRequireDelegation("delegation-first", "tracked"), true);
  });

  it("returns false for delegation-first + light", () => {
    assert.equal(shouldRequireDelegation("delegation-first", "light"), false);
  });

  it("returns true for free + delegation", () => {
    assert.equal(shouldRequireDelegation("free", "delegation"), true);
  });

  it("returns false for guided + light", () => {
    assert.equal(shouldRequireDelegation("guided", "light"), false);
  });

  it("returns false for free + light", () => {
    assert.equal(shouldRequireDelegation("free", "light"), false);
  });

  it("returns false for free + tracked", () => {
    assert.equal(shouldRequireDelegation("free", "tracked"), false);
  });

  it("returns true for strict-orchestrated + tracked", () => {
    assert.equal(shouldRequireDelegation("strict-orchestrated", "tracked"), true);
  });

  it("returns true for strict-orchestrated + light (always require delegation)", () => {
    assert.equal(shouldRequireDelegation("strict-orchestrated", "light"), true);
  });

  it("returns true for strict-orchestrated + delegation", () => {
    assert.equal(shouldRequireDelegation("strict-orchestrated", "delegation"), true);
  });

  it("returns true for guided + delegation", () => {
    assert.equal(shouldRequireDelegation("guided", "delegation"), true);
  });
});

describe("buildExecutionPolicyReport", () => {
  const baseState = {
    hasTaskBus: true,
    hasPlan: true,
    hasCheckpoint: false,
    hasWorkerStart: true,
    hasTrackedExecution: true,
    hasCompletedStep: false,
    hasFinalMerge: false,
    currentStep: 0,
    totalSteps: 0,
  };

  it("produces no violations when all requirements are met for free + light", () => {
    const { details } = buildExecutionPolicyReport({
      mode: "free",
      delegationStartGate: "off",
      request: "hello",
      state: {
        hasTaskBus: false,
        hasPlan: false,
        hasCheckpoint: false,
        hasWorkerStart: false,
        hasTrackedExecution: false,
      },
    });
    assert.equal(details.violations.length, 0);
  });

  it("adds violation when task bus required but missing", () => {
    const { details } = buildExecutionPolicyReport({
      mode: "tracked",
      delegationStartGate: "off",
      request: "step by step deploy and install everything",
      state: {
        hasTaskBus: false,
        hasPlan: true,
        hasWorkerStart: true,
        hasTrackedExecution: true,
      },
    });
    assert.ok(details.violations.some((v: string) => v.includes("task bus")));
  });

  it("adds violation when plan required but missing", () => {
    const { details } = buildExecutionPolicyReport({
      mode: "guided",
      delegationStartGate: "off",
      request: "deploy step by step and then install all the dependencies",
      state: {
        hasTaskBus: true,
        hasPlan: false,
        hasWorkerStart: true,
        hasTrackedExecution: true,
      },
    });
    assert.ok(details.violations.some((v: string) => v.includes("步骤计划")));
  });

  it("adds violation when checkpoint announced but no real execution", () => {
    const { details } = buildExecutionPolicyReport({
      mode: "free",
      delegationStartGate: "off",
      request: "hello",
      state: {
        hasCheckpoint: true,
        hasWorkerStart: false,
        hasTrackedExecution: false,
      },
    });
    assert.ok(details.violations.some((v: string) => v.includes("真实执行")));
  });

  it("advisory mode with no worker adds suggestion to nextActions, not violations", () => {
    const { details, report } = buildExecutionPolicyReport({
      mode: "free",
      delegationStartGate: "advisory",
      request: "dispatch workers now",
      state: {
        hasTaskBus: true,
        hasPlan: true,
        hasWorkerStart: false,
        hasTrackedExecution: false,
      },
    });
    // The advisory suggestion goes to nextActions (not violations)
    assert.ok(report.includes("建议"));
    // delegation is required for "dispatch" keyword in free mode
    // check that advisory suggestion is present whether or not there are violations
    const allNextActions = details.requiredNow.join(" ") + report;
    assert.ok(allNextActions.includes("建议") || report.includes("advisory"));
  });

  it("required gate with no worker adds hard violation", () => {
    const { details } = buildExecutionPolicyReport({
      mode: "delegation-first",
      delegationStartGate: "required",
      request: "multi agent deploy",
      state: {
        hasTaskBus: true,
        hasPlan: true,
        hasCheckpoint: false,
        hasWorkerStart: false,
        hasTrackedExecution: false,
      },
    });
    assert.ok(details.violations.length > 0);
  });

  it("adds violation about final merge when all steps done but no finalMerge", () => {
    const { details } = buildExecutionPolicyReport({
      mode: "tracked",
      delegationStartGate: "off",
      request: "step by step deploy and install",
      state: {
        ...baseState,
        currentStep: 3,
        totalSteps: 3,
        hasFinalMerge: false,
      },
    });
    assert.ok(details.violations.some((v: string) => v.includes("汇总") || v.includes("验收")));
  });

  it("adds violation about advancing when a step is completed with remaining steps", () => {
    const { details } = buildExecutionPolicyReport({
      mode: "tracked",
      delegationStartGate: "off",
      request: "step by step deploy and install",
      state: {
        ...baseState,
        hasCompletedStep: true,
        currentStep: 1,
        totalSteps: 3,
      },
    });
    assert.ok(details.violations.some((v: string) => v.includes("Step 1") || v.includes("推进")));
  });

  it("free mode + light task produces no requirements", () => {
    const { details } = buildExecutionPolicyReport({
      mode: "free",
      delegationStartGate: "off",
      request: "hello",
      state: {},
    });
    assert.equal(details.requireTaskBus, false);
    assert.equal(details.requireDelegation, false);
  });

  it("report contains policy mode string", () => {
    const { report } = buildExecutionPolicyReport({
      mode: "guided",
      delegationStartGate: "off",
      request: "hello",
      state: { hasPlan: true },
    });
    assert.ok(report.includes("guided"));
  });

  it("resumePrompt contains required actions when violations exist", () => {
    const { details } = buildExecutionPolicyReport({
      mode: "tracked",
      delegationStartGate: "off",
      request: "step by step deploy and install all dependencies",
      state: { hasTaskBus: false, hasPlan: false },
    });
    assert.ok(details.resumePrompt.includes("tracked"));
  });

  it("strict-orchestrated always requires task bus even for light task", () => {
    const { details } = buildExecutionPolicyReport({
      mode: "strict-orchestrated",
      delegationStartGate: "off",
      request: "hello",
      state: { hasTaskBus: false, hasPlan: true, hasWorkerStart: true },
    });
    assert.equal(details.requireTaskBus, true);
    assert.ok(details.violations.some((v: string) => v.includes("task bus")));
  });

  it("strict-orchestrated always requires delegation even for light task", () => {
    const { details } = buildExecutionPolicyReport({
      mode: "strict-orchestrated",
      delegationStartGate: "off",
      request: "hello",
      state: { hasTaskBus: true, hasPlan: true, hasWorkerStart: false },
    });
    assert.equal(details.requireDelegation, true);
    assert.ok(details.violations.some((v: string) => v.includes("worker/subagent")));
  });
});
