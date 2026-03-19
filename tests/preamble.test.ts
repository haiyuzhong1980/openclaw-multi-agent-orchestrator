/**
 * Tests for src/preamble.ts
 *
 * 覆盖：
 * - buildUnifiedPreamble 基础结构
 * - 角色定位块
 * - Session 上下文块（普通 / 高并发）
 * - 完整性原则块
 * - 升级协议块
 * - 禁止行为块
 * - buildLightPreamble
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildUnifiedPreamble, buildLightPreamble } from "../src/preamble.ts";
import type { PreambleConfig } from "../src/preamble.ts";

// ── buildUnifiedPreamble ────────────────────────────────────────

describe("buildUnifiedPreamble — 角色定位块", () => {
  it("包含 agentName", () => {
    const result = buildUnifiedPreamble({ agentName: "executor", agentRole: "执行者" });
    assert.ok(result.includes("executor"));
  });

  it("包含 agentRole", () => {
    const result = buildUnifiedPreamble({ agentName: "executor", agentRole: "执行者" });
    assert.ok(result.includes("执行者"));
  });

  it("包含 OMA Preamble 标题", () => {
    const result = buildUnifiedPreamble({ agentName: "planner", agentRole: "规划者" });
    assert.ok(result.includes("[OMA Preamble — planner]"));
  });

  it("包含 sessionId（如果提供）", () => {
    const result = buildUnifiedPreamble({
      agentName: "worker",
      agentRole: "工作者",
      sessionId: "sess-abc-123",
    });
    assert.ok(result.includes("sess-abc-123"));
  });

  it("不包含 sessionId（如果未提供）", () => {
    const result = buildUnifiedPreamble({ agentName: "worker", agentRole: "工作者" });
    assert.ok(!result.includes("Session ID"));
  });
});

describe("buildUnifiedPreamble — Session 上下文块", () => {
  it("activeAgentCount < 3 且有 projectName 时显示项目信息", () => {
    const result = buildUnifiedPreamble({
      agentName: "worker",
      agentRole: "工作者",
      projectName: "MyProject",
      activeAgentCount: 2,
    });
    assert.ok(result.includes("MyProject"));
  });

  it("activeAgentCount < 3 且有 currentBranch 时显示分支信息", () => {
    const result = buildUnifiedPreamble({
      agentName: "worker",
      agentRole: "工作者",
      currentBranch: "feature/xyz",
      activeAgentCount: 2,
    });
    assert.ok(result.includes("feature/xyz"));
  });

  it("activeAgentCount >= 3 时注入高并发上下文定位块", () => {
    const result = buildUnifiedPreamble({
      agentName: "worker",
      agentRole: "工作者",
      activeAgentCount: 3,
    });
    assert.ok(result.includes("3 个以上 agent 并行"));
  });

  it("activeAgentCount >= 3 时包含 20 分钟假设提示", () => {
    const result = buildUnifiedPreamble({
      agentName: "worker",
      agentRole: "工作者",
      activeAgentCount: 5,
    });
    assert.ok(result.includes("20 分钟"));
  });

  it("activeAgentCount >= 3 且有 projectName 时显示项目", () => {
    const result = buildUnifiedPreamble({
      agentName: "worker",
      agentRole: "工作者",
      projectName: "HighConcurrencyProject",
      activeAgentCount: 4,
    });
    assert.ok(result.includes("HighConcurrencyProject"));
  });

  it("activeAgentCount 默认值为 1（不触发高并发块）", () => {
    const result = buildUnifiedPreamble({ agentName: "worker", agentRole: "工作者" });
    assert.ok(!result.includes("3 个以上 agent 并行"));
  });
});

describe("buildUnifiedPreamble — 完整性原则块", () => {
  it("包含完整性原则标题", () => {
    const result = buildUnifiedPreamble({ agentName: "worker", agentRole: "工作者" });
    assert.ok(result.includes("完整性原则"));
  });

  it("包含 Completeness > Speed 原则", () => {
    const result = buildUnifiedPreamble({ agentName: "worker", agentRole: "工作者" });
    assert.ok(result.includes("Completeness > Speed"));
  });

  it("包含宁可多做一步确认提示", () => {
    const result = buildUnifiedPreamble({ agentName: "worker", agentRole: "工作者" });
    assert.ok(result.includes("宁可多做一步确认"));
  });
});

describe("buildUnifiedPreamble — 升级协议块", () => {
  it("包含升级协议标题", () => {
    const result = buildUnifiedPreamble({ agentName: "worker", agentRole: "工作者" });
    assert.ok(result.includes("升级协议"));
  });

  it("包含四种 CompletionStatus 值", () => {
    const result = buildUnifiedPreamble({ agentName: "worker", agentRole: "工作者" });
    assert.ok(result.includes("DONE"));
    assert.ok(result.includes("DONE_WITH_CONCERNS"));
    assert.ok(result.includes("BLOCKED"));
    assert.ok(result.includes("NEEDS_CONTEXT"));
  });

  it("包含 3-strike 规则说明", () => {
    const result = buildUnifiedPreamble({ agentName: "worker", agentRole: "工作者" });
    assert.ok(result.includes("3-strike"));
  });
});

describe("buildUnifiedPreamble — 禁止行为块", () => {
  it("包含禁止行为标题", () => {
    const result = buildUnifiedPreamble({ agentName: "worker", agentRole: "工作者" });
    assert.ok(result.includes("禁止行为"));
  });

  it("包含不要自我审批规则", () => {
    const result = buildUnifiedPreamble({ agentName: "worker", agentRole: "工作者" });
    assert.ok(result.includes("不要自我审批"));
  });

  it("包含不要跳步骤规则", () => {
    const result = buildUnifiedPreamble({ agentName: "worker", agentRole: "工作者" });
    assert.ok(result.includes("不要跳步骤"));
  });
});

describe("buildUnifiedPreamble — 返回类型", () => {
  it("返回非空字符串", () => {
    const result = buildUnifiedPreamble({ agentName: "worker", agentRole: "工作者" });
    assert.ok(typeof result === "string");
    assert.ok(result.length > 0);
  });

  it("开头包含分隔线", () => {
    const result = buildUnifiedPreamble({ agentName: "worker", agentRole: "工作者" });
    assert.ok(result.startsWith("══"));
  });
});

// ── buildLightPreamble ──────────────────────────────────────────

describe("buildLightPreamble", () => {
  it("包含 agentName", () => {
    const result = buildLightPreamble("executor", "执行者");
    assert.ok(result.includes("executor"));
  });

  it("包含 agentRole", () => {
    const result = buildLightPreamble("executor", "执行者");
    assert.ok(result.includes("执行者"));
  });

  it("包含 Completeness > Speed", () => {
    const result = buildLightPreamble("executor", "执行者");
    assert.ok(result.includes("Completeness > Speed"));
  });

  it("返回比 buildUnifiedPreamble 更短的字符串", () => {
    const light = buildLightPreamble("executor", "执行者");
    const full = buildUnifiedPreamble({ agentName: "executor", agentRole: "执行者" });
    assert.ok(light.length < full.length);
  });

  it("返回非空字符串", () => {
    const result = buildLightPreamble("any-agent", "任意角色");
    assert.ok(typeof result === "string");
    assert.ok(result.length > 0);
  });
});
