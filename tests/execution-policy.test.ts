import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  inferExecutionComplexity,
  shouldRequireTaskBus,
  shouldRequireDelegation,
  buildExecutionPolicyReport,
} from "../src/execution-policy.ts";

describe("inferExecutionComplexity", () => {
  it('returns delegation for Chinese "真实执行一个多 agent 调研"', () => {
    assert.equal(inferExecutionComplexity("真实执行一个多 agent 调研"), "delegation");
  });

  it('returns tracked for Chinese "按步骤部署"', () => {
    assert.equal(inferExecutionComplexity("按步骤部署"), "tracked");
  });

  it('returns light for Chinese "查一下"', () => {
    assert.equal(inferExecutionComplexity("查一下"), "light");
  });

  it('returns tracked for English "deploy step by step with multiple agents" (no exact delegation marker)', () => {
    // "multiple agents" does not match delegation markers ("multi agent", "worker", etc.)
    assert.equal(inferExecutionComplexity("deploy step by step with multiple agents"), "tracked");
  });

  it('returns tracked for English "audit the security"', () => {
    assert.equal(inferExecutionComplexity("audit the security"), "tracked");
  });

  it('returns light for English "hello"', () => {
    assert.equal(inferExecutionComplexity("hello"), "light");
  });

  it('returns delegation for mixed "multi agent 调研"', () => {
    assert.equal(inferExecutionComplexity("multi agent 调研"), "delegation");
  });

  it("returns light for empty string", () => {
    assert.equal(inferExecutionComplexity(""), "light");
  });

  it("returns light for undefined", () => {
    assert.equal(inferExecutionComplexity(undefined), "light");
  });

  it("returns tracked for Chinese 分步骤", () => {
    assert.equal(inferExecutionComplexity("请分步骤处理"), "tracked");
  });

  it("returns tracked for English step by step", () => {
    assert.equal(inferExecutionComplexity("do it step by step"), "tracked");
  });

  it("returns delegation for sub-agent keyword", () => {
    assert.equal(inferExecutionComplexity("use a subagent"), "delegation");
  });

  it("returns delegation for delegate keyword", () => {
    assert.equal(inferExecutionComplexity("delegate this task"), "delegation");
  });

  it("returns tracked for download keyword", () => {
    assert.equal(inferExecutionComplexity("download the package"), "tracked");
  });

  it("returns tracked for install keyword", () => {
    assert.equal(inferExecutionComplexity("install the dependencies"), "tracked");
  });

  it("returns tracked for configure keyword", () => {
    assert.equal(inferExecutionComplexity("configure the server"), "tracked");
  });

  it("prioritizes delegation over tracked when both markers match", () => {
    assert.equal(inferExecutionComplexity("multi agent deploy step by step"), "delegation");
  });

  it("returns tracked for 检查 keyword", () => {
    assert.equal(inferExecutionComplexity("检查一下配置"), "tracked");
  });

  it("returns tracked for 汇报进度 keyword", () => {
    assert.equal(inferExecutionComplexity("请汇报进度"), "tracked");
  });

  it("returns delegation for 子 agent keyword", () => {
    assert.equal(inferExecutionComplexity("派出子 agent"), "delegation");
  });

  it("returns delegation for dispatch keyword", () => {
    assert.equal(inferExecutionComplexity("dispatch workers now"), "delegation");
  });

  it("returns delegation for worker keyword", () => {
    assert.equal(inferExecutionComplexity("spawn a worker"), "delegation");
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

  it("returns false for strict-orchestrated + light", () => {
    assert.equal(shouldRequireDelegation("strict-orchestrated", "light"), false);
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
      request: "step by step deploy",
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
      request: "deploy step by step",
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
      request: "dispatch workers",
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
      request: "step by step deploy",
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
      request: "step by step deploy",
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
      request: "step by step deploy",
      state: { hasTaskBus: false, hasPlan: false },
    });
    assert.ok(details.resumePrompt.includes("tracked"));
  });
});
