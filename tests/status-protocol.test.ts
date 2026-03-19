/**
 * Tests for src/status-protocol.ts
 *
 * 覆盖：
 * - serializeCompletionReport：各种状态的序列化
 * - parseCompletionStatus：从文本中解析
 * - shouldEscalate：3-strike 规则
 * - buildEscalationPrompt：升级提示生成
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  serializeCompletionReport,
  parseCompletionStatus,
  shouldEscalate,
  buildEscalationPrompt,
} from "../src/status-protocol.ts";
import type { CompletionReport } from "../src/status-protocol.ts";

// ── serializeCompletionReport ───────────────────────────────────

describe("serializeCompletionReport — DONE", () => {
  it("包含 COMPLETION_STATUS: DONE", () => {
    const report: CompletionReport = { status: "DONE", summary: "任务完成" };
    const text = serializeCompletionReport(report);
    assert.ok(text.includes("COMPLETION_STATUS: DONE"));
  });

  it("包含 SUMMARY", () => {
    const report: CompletionReport = { status: "DONE", summary: "测试通过" };
    const text = serializeCompletionReport(report);
    assert.ok(text.includes("SUMMARY: 测试通过"));
  });

  it("包含 evidence 列表", () => {
    const report: CompletionReport = {
      status: "DONE",
      summary: "完成",
      evidence: ["测试通过 5/5", "文件已修改"],
    };
    const text = serializeCompletionReport(report);
    assert.ok(text.includes("EVIDENCE:"));
    assert.ok(text.includes("测试通过 5/5"));
    assert.ok(text.includes("文件已修改"));
  });

  it("没有 evidence 时不输出 EVIDENCE 块", () => {
    const report: CompletionReport = { status: "DONE", summary: "完成" };
    const text = serializeCompletionReport(report);
    assert.ok(!text.includes("EVIDENCE:"));
  });
});

describe("serializeCompletionReport — DONE_WITH_CONCERNS", () => {
  it("包含 COMPLETION_STATUS: DONE_WITH_CONCERNS", () => {
    const report: CompletionReport = {
      status: "DONE_WITH_CONCERNS",
      summary: "完成但有顾虑",
      concerns: ["性能可能有问题"],
    };
    const text = serializeCompletionReport(report);
    assert.ok(text.includes("COMPLETION_STATUS: DONE_WITH_CONCERNS"));
  });

  it("包含 CONCERNS 列表", () => {
    const report: CompletionReport = {
      status: "DONE_WITH_CONCERNS",
      summary: "完成",
      concerns: ["覆盖率不足", "边界情况未处理"],
    };
    const text = serializeCompletionReport(report);
    assert.ok(text.includes("CONCERNS:"));
    assert.ok(text.includes("覆盖率不足"));
    assert.ok(text.includes("边界情况未处理"));
  });
});

describe("serializeCompletionReport — BLOCKED", () => {
  it("包含 COMPLETION_STATUS: BLOCKED", () => {
    const report: CompletionReport = {
      status: "BLOCKED",
      summary: "无法继续",
      blockers: ["缺少权限"],
    };
    const text = serializeCompletionReport(report);
    assert.ok(text.includes("COMPLETION_STATUS: BLOCKED"));
  });

  it("包含 BLOCKERS 列表", () => {
    const report: CompletionReport = {
      status: "BLOCKED",
      summary: "被阻塞",
      blockers: ["API 不可用", "网络超时"],
    };
    const text = serializeCompletionReport(report);
    assert.ok(text.includes("BLOCKERS:"));
    assert.ok(text.includes("API 不可用"));
    assert.ok(text.includes("网络超时"));
  });

  it("包含 ATTEMPTED 列表", () => {
    const report: CompletionReport = {
      status: "BLOCKED",
      summary: "被阻塞",
      blockers: ["未知错误"],
      attempted: ["方案 A", "方案 B"],
    };
    const text = serializeCompletionReport(report);
    assert.ok(text.includes("ATTEMPTED:"));
    assert.ok(text.includes("方案 A"));
    assert.ok(text.includes("方案 B"));
  });

  it("包含 RECOMMENDATION", () => {
    const report: CompletionReport = {
      status: "BLOCKED",
      summary: "被阻塞",
      recommendation: "请提供 API key",
    };
    const text = serializeCompletionReport(report);
    assert.ok(text.includes("RECOMMENDATION: 请提供 API key"));
  });
});

describe("serializeCompletionReport — NEEDS_CONTEXT", () => {
  it("包含 COMPLETION_STATUS: NEEDS_CONTEXT", () => {
    const report: CompletionReport = {
      status: "NEEDS_CONTEXT",
      summary: "需要更多信息",
    };
    const text = serializeCompletionReport(report);
    assert.ok(text.includes("COMPLETION_STATUS: NEEDS_CONTEXT"));
  });
});

describe("serializeCompletionReport — strikeCount", () => {
  it("包含 STRIKE_COUNT 当 strikeCount 存在", () => {
    const report: CompletionReport = { status: "BLOCKED", summary: "失败", strikeCount: 2 };
    const text = serializeCompletionReport(report);
    assert.ok(text.includes("STRIKE_COUNT: 2"));
  });

  it("不输出 STRIKE_COUNT 当未提供", () => {
    const report: CompletionReport = { status: "DONE", summary: "完成" };
    const text = serializeCompletionReport(report);
    assert.ok(!text.includes("STRIKE_COUNT"));
  });
});

// ── parseCompletionStatus ───────────────────────────────────────

describe("parseCompletionStatus — 基础解析", () => {
  it("返回 null 当文本中无 COMPLETION_STATUS", () => {
    const result = parseCompletionStatus("这是一段普通输出文本");
    assert.equal(result, null);
  });

  it("返回 null 当 status 值非法", () => {
    const result = parseCompletionStatus("COMPLETION_STATUS: UNKNOWN_VALUE");
    assert.equal(result, null);
  });

  it("解析 DONE 状态", () => {
    const text = "COMPLETION_STATUS: DONE\nSUMMARY: 任务完成";
    const result = parseCompletionStatus(text);
    assert.ok(result !== null);
    assert.equal(result.status, "DONE");
    assert.equal(result.summary, "任务完成");
  });

  it("解析 DONE_WITH_CONCERNS 状态", () => {
    const text = "COMPLETION_STATUS: DONE_WITH_CONCERNS\nSUMMARY: 有顾虑";
    const result = parseCompletionStatus(text);
    assert.ok(result !== null);
    assert.equal(result.status, "DONE_WITH_CONCERNS");
  });

  it("解析 BLOCKED 状态", () => {
    const text = "COMPLETION_STATUS: BLOCKED\nSUMMARY: 被阻塞";
    const result = parseCompletionStatus(text);
    assert.ok(result !== null);
    assert.equal(result.status, "BLOCKED");
  });

  it("解析 NEEDS_CONTEXT 状态", () => {
    const text = "COMPLETION_STATUS: NEEDS_CONTEXT\nSUMMARY: 缺少上下文";
    const result = parseCompletionStatus(text);
    assert.ok(result !== null);
    assert.equal(result.status, "NEEDS_CONTEXT");
  });
});

describe("parseCompletionStatus — 列表解析", () => {
  it("解析 EVIDENCE 列表", () => {
    const text = [
      "COMPLETION_STATUS: DONE",
      "SUMMARY: 完成",
      "EVIDENCE:",
      "  - 测试通过 5/5",
      "  - 文件已修改",
    ].join("\n");
    const result = parseCompletionStatus(text);
    assert.ok(result !== null);
    assert.deepEqual(result.evidence, ["测试通过 5/5", "文件已修改"]);
  });

  it("解析 CONCERNS 列表", () => {
    const text = [
      "COMPLETION_STATUS: DONE_WITH_CONCERNS",
      "SUMMARY: 有顾虑",
      "CONCERNS:",
      "  - 覆盖率不足",
      "  - 边界情况",
    ].join("\n");
    const result = parseCompletionStatus(text);
    assert.ok(result !== null);
    assert.deepEqual(result.concerns, ["覆盖率不足", "边界情况"]);
  });

  it("解析 BLOCKERS 列表", () => {
    const text = [
      "COMPLETION_STATUS: BLOCKED",
      "SUMMARY: 被阻塞",
      "BLOCKERS:",
      "  - API 不可用",
    ].join("\n");
    const result = parseCompletionStatus(text);
    assert.ok(result !== null);
    assert.deepEqual(result.blockers, ["API 不可用"]);
  });

  it("解析 ATTEMPTED 列表", () => {
    const text = [
      "COMPLETION_STATUS: BLOCKED",
      "SUMMARY: 被阻塞",
      "ATTEMPTED:",
      "  - 方案 A",
      "  - 方案 B",
    ].join("\n");
    const result = parseCompletionStatus(text);
    assert.ok(result !== null);
    assert.deepEqual(result.attempted, ["方案 A", "方案 B"]);
  });

  it("解析 RECOMMENDATION", () => {
    const text = [
      "COMPLETION_STATUS: BLOCKED",
      "SUMMARY: 被阻塞",
      "RECOMMENDATION: 请提供 API key",
    ].join("\n");
    const result = parseCompletionStatus(text);
    assert.ok(result !== null);
    assert.equal(result.recommendation, "请提供 API key");
  });

  it("解析 STRIKE_COUNT", () => {
    const text = [
      "COMPLETION_STATUS: BLOCKED",
      "SUMMARY: 被阻塞",
      "STRIKE_COUNT: 2",
    ].join("\n");
    const result = parseCompletionStatus(text);
    assert.ok(result !== null);
    assert.equal(result.strikeCount, 2);
  });
});

describe("parseCompletionStatus — 往返一致性（roundtrip）", () => {
  it("序列化再解析 DONE 报告与原始一致", () => {
    const original: CompletionReport = {
      status: "DONE",
      summary: "完成所有任务",
      evidence: ["测试通过", "PR 已提交"],
    };
    const text = serializeCompletionReport(original);
    const parsed = parseCompletionStatus(text);
    assert.ok(parsed !== null);
    assert.equal(parsed.status, original.status);
    assert.equal(parsed.summary, original.summary);
    assert.deepEqual(parsed.evidence, original.evidence);
  });

  it("序列化再解析 BLOCKED 报告与原始一致", () => {
    const original: CompletionReport = {
      status: "BLOCKED",
      summary: "无法访问 API",
      strikeCount: 3,
      blockers: ["网络超时", "认证失败"],
      attempted: ["重试 3 次", "切换节点"],
      recommendation: "请检查 VPN 配置",
    };
    const text = serializeCompletionReport(original);
    const parsed = parseCompletionStatus(text);
    assert.ok(parsed !== null);
    assert.equal(parsed.status, original.status);
    assert.equal(parsed.strikeCount, original.strikeCount);
    assert.deepEqual(parsed.blockers, original.blockers);
    assert.deepEqual(parsed.attempted, original.attempted);
    assert.equal(parsed.recommendation, original.recommendation);
  });
});

// ── shouldEscalate ──────────────────────────────────────────────

describe("shouldEscalate — 3-strike 规则", () => {
  it("strikeCount 0 → false", () => {
    assert.equal(shouldEscalate(0), false);
  });

  it("strikeCount 1 → false（Strike 1: 换一个方法）", () => {
    assert.equal(shouldEscalate(1), false);
  });

  it("strikeCount 2 → false（Strike 2: 降低范围）", () => {
    assert.equal(shouldEscalate(2), false);
  });

  it("strikeCount 3 → true（Strike 3: STOP，升级）", () => {
    assert.equal(shouldEscalate(3), true);
  });

  it("strikeCount 5 → true（超过 3 次依然升级）", () => {
    assert.equal(shouldEscalate(5), true);
  });
});

// ── buildEscalationPrompt ───────────────────────────────────────

describe("buildEscalationPrompt", () => {
  const blockedReport: CompletionReport = {
    status: "BLOCKED",
    summary: "API 调用失败",
    strikeCount: 3,
    blockers: ["认证错误"],
    attempted: ["重新登录", "刷新 token"],
    recommendation: "请人工检查 API 配置",
  };

  it("包含升级通知标题", () => {
    const text = buildEscalationPrompt(blockedReport);
    assert.ok(text.includes("ESCALATION REQUIRED") || text.includes("升级通知"));
  });

  it("包含 status", () => {
    const text = buildEscalationPrompt(blockedReport);
    assert.ok(text.includes("BLOCKED"));
  });

  it("包含 summary", () => {
    const text = buildEscalationPrompt(blockedReport);
    assert.ok(text.includes("API 调用失败"));
  });

  it("包含 strikeCount 信息", () => {
    const text = buildEscalationPrompt(blockedReport);
    assert.ok(text.includes("3"));
  });

  it("包含 blockers", () => {
    const text = buildEscalationPrompt(blockedReport);
    assert.ok(text.includes("认证错误"));
  });

  it("包含 attempted", () => {
    const text = buildEscalationPrompt(blockedReport);
    assert.ok(text.includes("重新登录") || text.includes("刷新 token"));
  });

  it("包含 recommendation", () => {
    const text = buildEscalationPrompt(blockedReport);
    assert.ok(text.includes("请人工检查 API 配置"));
  });

  it("包含停止自动重试说明", () => {
    const text = buildEscalationPrompt(blockedReport);
    assert.ok(text.includes("停止自动重试") || text.includes("需要人工介入"));
  });

  it("返回非空字符串", () => {
    const text = buildEscalationPrompt({ status: "BLOCKED", summary: "失败" });
    assert.ok(typeof text === "string");
    assert.ok(text.length > 0);
  });
});
