import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatAskQuestion,
  validateAskFormat,
} from "../src/ask-format.ts";
import type { AskQuestionParams, AskOption } from "../src/ask-format.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeOption(overrides: Partial<AskOption> = {}): AskOption {
  return {
    label: "默认选项",
    description: "这是一个测试选项",
    completeness: 8,
    ...overrides,
  };
}

function makeParams(overrides: Partial<AskQuestionParams> = {}): AskQuestionParams {
  return {
    context: { project: "TestProj", branch: "main", currentTask: "实现功能" },
    question: "你希望如何处理这个问题？",
    options: [
      makeOption({ label: "方案A", completeness: 9, effort: { human: "~2h", ai: "~10min" } }),
      makeOption({ label: "方案B", completeness: 6, effort: { human: "~4h", ai: "~20min" } }),
    ],
    recommendation: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// formatAskQuestion — four-section structure
// ---------------------------------------------------------------------------
describe("formatAskQuestion — Re-ground section", () => {
  it("includes project in context header", () => {
    const text = formatAskQuestion(makeParams());
    assert.ok(text.includes("项目: TestProj"), "should include project");
  });

  it("includes branch in context header", () => {
    const text = formatAskQuestion(makeParams());
    assert.ok(text.includes("分支: main"), "should include branch");
  });

  it("includes current task in context header", () => {
    const text = formatAskQuestion(makeParams());
    assert.ok(text.includes("当前任务: 实现功能"), "should include current task");
  });

  it("uses [无上下文] when context is empty", () => {
    const text = formatAskQuestion(makeParams({ context: {} }));
    assert.ok(text.includes("[无上下文]"), "should show no-context placeholder");
  });

  it("wraps context parts in square brackets", () => {
    const text = formatAskQuestion(makeParams());
    assert.match(text, /\[.*项目: TestProj.*\]/);
  });

  it("omits missing context fields", () => {
    const text = formatAskQuestion(makeParams({ context: { project: "MyProj" } }));
    assert.ok(!text.includes("分支:"), "should not include branch when missing");
    assert.ok(!text.includes("当前任务:"), "should not include task when missing");
  });
});

describe("formatAskQuestion — Simplify section (question)", () => {
  it("includes the question text", () => {
    const params = makeParams({ question: "你希望如何处理边界问题？" });
    const text = formatAskQuestion(params);
    assert.ok(text.includes("你希望如何处理边界问题？"));
  });
});

describe("formatAskQuestion — Recommend section", () => {
  it("includes recommendation when provided", () => {
    const text = formatAskQuestion(makeParams({ recommendation: 0 }));
    assert.ok(text.includes("推荐: 选项 [A]"), "should recommend option A");
  });

  it("recommends B when index is 1", () => {
    const text = formatAskQuestion(makeParams({ recommendation: 1 }));
    assert.ok(text.includes("推荐: 选项 [B]"), "should recommend option B");
  });

  it("omits recommendation section when undefined", () => {
    const params = makeParams({ recommendation: undefined });
    const text = formatAskQuestion(params);
    assert.ok(!text.includes("推荐:"), "should not include recommendation");
  });

  it("marks recommended option with arrow", () => {
    const text = formatAskQuestion(makeParams({ recommendation: 0 }));
    assert.ok(text.includes("← 推荐"), "should mark recommended option");
  });
});

describe("formatAskQuestion — Options section (completeness + effort)", () => {
  it("shows completeness score for each option", () => {
    const text = formatAskQuestion(makeParams());
    assert.ok(text.includes("完整性: 9/10"), "should show completeness 9/10 for option A");
    assert.ok(text.includes("完整性: 6/10"), "should show completeness 6/10 for option B");
  });

  it("shows effort dual scale when provided", () => {
    const text = formatAskQuestion(makeParams());
    assert.ok(text.includes("人工: ~2h"), "should show human effort");
    assert.ok(text.includes("AI: ~10min"), "should show AI effort");
  });

  it("omits effort parentheses when effort is undefined", () => {
    const params = makeParams({
      options: [makeOption({ label: "无工作量选项", completeness: 5 })],
    });
    const text = formatAskQuestion(params);
    assert.ok(!text.includes("人工:"), "should not include human effort when undefined");
    assert.ok(!text.includes("AI:"), "should not include AI effort when undefined");
  });

  it("labels options with letters A, B, C...", () => {
    const params = makeParams({
      options: [
        makeOption({ label: "第一" }),
        makeOption({ label: "第二" }),
        makeOption({ label: "第三" }),
      ],
    });
    const text = formatAskQuestion(params);
    assert.ok(text.includes("A."), "should have option A");
    assert.ok(text.includes("B."), "should have option B");
    assert.ok(text.includes("C."), "should have option C");
  });
});

// ---------------------------------------------------------------------------
// Edge cases: empty and single options
// ---------------------------------------------------------------------------
describe("formatAskQuestion — boundary cases", () => {
  it("handles empty options array gracefully", () => {
    const params = makeParams({ options: [] });
    const text = formatAskQuestion(params);
    assert.ok(typeof text === "string");
    assert.ok(text.includes("你希望如何处理这个问题？"), "question still present");
    assert.ok(!text.includes("A."), "no option labels when options empty");
  });

  it("handles single option", () => {
    const params = makeParams({
      options: [makeOption({ label: "唯一方案", completeness: 10 })],
      recommendation: 0,
    });
    const text = formatAskQuestion(params);
    assert.ok(text.includes("A."), "should show single option A");
    assert.ok(text.includes("完整性: 10/10"), "should show completeness");
    assert.ok(text.includes("← 推荐"), "single option can be recommended");
  });

  it("ignores recommendation index out of range", () => {
    const params = makeParams({ recommendation: 99 });
    const text = formatAskQuestion(params);
    assert.ok(!text.includes("推荐: 选项 ["), "out-of-range recommendation should be omitted");
  });

  it("handles context with only project field", () => {
    const params = makeParams({ context: { project: "Only" } });
    const text = formatAskQuestion(params);
    assert.ok(text.includes("[项目: Only]"), "should show bracket with only project");
  });
});

// ---------------------------------------------------------------------------
// validateAskFormat
// ---------------------------------------------------------------------------
describe("validateAskFormat — valid format", () => {
  it("returns valid=true for a properly formatted text", () => {
    const text = formatAskQuestion(makeParams());
    const result = validateAskFormat(text);
    assert.equal(result.valid, true, `Expected valid. Issues: ${result.issues.join(", ")}`);
    assert.deepEqual(result.issues, []);
  });
});

describe("validateAskFormat — missing pieces", () => {
  it("returns valid=false for empty text", () => {
    const result = validateAskFormat("");
    assert.equal(result.valid, false);
    assert.ok(result.issues.length > 0);
  });

  it("flags missing context header", () => {
    const text = "这是一个问题\n  A. 选项一\n     描述\n     完整性: 8/10";
    const result = validateAskFormat(text);
    assert.equal(result.valid, false);
    assert.ok(result.issues.some((i) => i.includes("Re-ground")));
  });

  it("flags missing options", () => {
    const text = "[项目: X]\n这是一个问题\n完整性: 8/10";
    const result = validateAskFormat(text);
    assert.equal(result.valid, false);
    assert.ok(result.issues.some((i) => i.includes("选项列表")));
  });

  it("flags missing completeness score", () => {
    const text = "[项目: X]\n这是一个问题\n  A. 选项一\n     描述";
    const result = validateAskFormat(text);
    assert.equal(result.valid, false);
    assert.ok(result.issues.some((i) => i.includes("完整性")));
  });
});
