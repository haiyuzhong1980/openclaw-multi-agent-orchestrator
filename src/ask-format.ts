export interface AskOption {
  label: string;
  description: string;
  completeness: number; // 0-10 完整性评分
  effort?: {
    human: string; // 人工估算，如 "~2h"
    ai: string;    // AI 估算，如 "~15min"
  };
}

export interface AskQuestionParams {
  context: {
    project?: string;
    branch?: string;
    currentTask?: string;
  };
  question: string;
  options: AskOption[];
  recommendation?: number; // 推荐选项 index
}

/**
 * Generate a four-section formatted question string.
 *
 * Sections:
 * 1. Re-ground — context header for multi-window users
 * 2. Simplify — plain-language summary of the question
 * 3. Recommend — recommended option with reason and completeness scores
 * 4. Options — lettered choices with dual effort estimates
 */
export function formatAskQuestion(params: AskQuestionParams): string {
  const { context, question, options, recommendation } = params;

  // Section 1: Re-ground
  const contextParts: string[] = [];
  if (context.project) contextParts.push(`项目: ${context.project}`);
  if (context.branch) contextParts.push(`分支: ${context.branch}`);
  if (context.currentTask) contextParts.push(`当前任务: ${context.currentTask}`);
  const contextLine =
    contextParts.length > 0 ? `[${contextParts.join(" | ")}]` : "[无上下文]";

  // Section 3: Recommend
  let recommendText = "";
  if (recommendation !== undefined && recommendation >= 0 && recommendation < options.length) {
    const letter = String.fromCharCode(65 + recommendation);
    recommendText = `推荐: 选项 [${letter}]`;
  }

  // Section 4: Options
  const optionLines: string[] = [];
  for (let i = 0; i < options.length; i++) {
    const letter = String.fromCharCode(65 + i);
    const opt = options[i];
    const effortStr =
      opt.effort
        ? ` (人工: ${opt.effort.human} / AI: ${opt.effort.ai})`
        : "";
    const isRecommended = recommendation === i ? " ← 推荐" : "";
    optionLines.push(
      `  ${letter}. ${opt.label}${effortStr}${isRecommended}`,
      `     ${opt.description}`,
      `     完整性: ${opt.completeness}/10`,
    );
  }

  const sections: string[] = [
    contextLine,
    "",
    question,
    "",
  ];

  if (recommendText) {
    sections.push(recommendText, "");
  }

  if (options.length > 0) {
    sections.push("选项:", ...optionLines);
  }

  return sections.join("\n");
}

/**
 * Validate whether a text string conforms to the four-section ask format.
 * Returns { valid, issues } where issues lists specific problems found.
 */
export function validateAskFormat(text: string): { valid: boolean; issues: string[] } {
  const issues: string[] = [];

  if (!text || text.trim().length === 0) {
    return { valid: false, issues: ["文本为空"] };
  }

  // Check Re-ground section: must have a context header like [项目: X | ...]
  const hasContextHeader = /\[.*?\]/.test(text);
  if (!hasContextHeader) {
    issues.push("缺少 Re-ground 上下文标头（格式：[项目: X | 分支: Y | 当前任务: Z]）");
  }

  // Check for at least one option (A., B., etc.)
  const hasOptions = /^\s*[A-Z]\./m.test(text);
  if (!hasOptions) {
    issues.push("缺少选项列表（格式：A. 选项名称）");
  }

  // Check for completeness score
  const hasCompleteness = /完整性:\s*\d+\/10/.test(text);
  if (!hasCompleteness) {
    issues.push("缺少完整性评分（格式：完整性: X/10）");
  }

  // Check for a question (non-empty line that isn't a header or option)
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  const questionLine = lines.find(
    (l) => !l.startsWith("[") && !/^[A-Z]\./.test(l) && !l.startsWith("推荐") && !l.startsWith("选项"),
  );
  if (!questionLine) {
    issues.push("缺少问题描述");
  }

  return { valid: issues.length === 0, issues };
}
