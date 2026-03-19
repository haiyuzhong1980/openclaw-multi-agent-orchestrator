/**
 * Completion Status Protocol — 每个 agent 完成任务时必须报告的标准格式。
 *
 * 设计原则：
 * - 所有函数为纯函数，无副作用
 * - 3-strike 规则：连续失败 3 次必须 STOP 并升级，不再自行重试
 */

export type CompletionStatus = "DONE" | "DONE_WITH_CONCERNS" | "BLOCKED" | "NEEDS_CONTEXT";

export interface CompletionReport {
  status: CompletionStatus;
  summary: string;
  evidence?: string[];     // 完成证据（测试通过、文件已修改等）
  concerns?: string[];     // DONE_WITH_CONCERNS 时的顾虑
  blockers?: string[];     // BLOCKED 时的阻塞原因
  attempted?: string[];    // BLOCKED 时已尝试的方案
  recommendation?: string; // BLOCKED/NEEDS_CONTEXT 时的建议
  strikeCount?: number;    // 当前重试次数（3-strike rule）
}

// ── 序列化 ────────────────────────────────────────────────────────

/**
 * 将 CompletionReport 序列化为 agent 可读的文本格式。
 * 格式设计为人机均可解析：以 "COMPLETION_STATUS:" 开头的标记行。
 */
export function serializeCompletionReport(report: CompletionReport): string {
  const lines: string[] = [];

  lines.push(`COMPLETION_STATUS: ${report.status}`);
  lines.push(`SUMMARY: ${report.summary}`);

  if (report.strikeCount !== undefined) {
    lines.push(`STRIKE_COUNT: ${report.strikeCount}`);
  }

  if (report.evidence && report.evidence.length > 0) {
    lines.push("EVIDENCE:");
    for (const item of report.evidence) {
      lines.push(`  - ${item}`);
    }
  }

  if (report.concerns && report.concerns.length > 0) {
    lines.push("CONCERNS:");
    for (const item of report.concerns) {
      lines.push(`  - ${item}`);
    }
  }

  if (report.blockers && report.blockers.length > 0) {
    lines.push("BLOCKERS:");
    for (const item of report.blockers) {
      lines.push(`  - ${item}`);
    }
  }

  if (report.attempted && report.attempted.length > 0) {
    lines.push("ATTEMPTED:");
    for (const item of report.attempted) {
      lines.push(`  - ${item}`);
    }
  }

  if (report.recommendation) {
    lines.push(`RECOMMENDATION: ${report.recommendation}`);
  }

  return lines.join("\n");
}

// ── 解析 ────────────────────────────────────────────────────────

/**
 * 从 agent 输出文本中解析 completion 状态。
 * 返回 null 表示文本中没有找到有效的 COMPLETION_STATUS 块。
 */
export function parseCompletionStatus(text: string): CompletionReport | null {
  const lines = text.split("\n");

  // 找到 COMPLETION_STATUS 行
  const statusLine = lines.find((l) => l.trimStart().startsWith("COMPLETION_STATUS:"));
  if (!statusLine) return null;

  const rawStatus = statusLine.replace(/^.*COMPLETION_STATUS:\s*/, "").trim();
  const validStatuses: CompletionStatus[] = ["DONE", "DONE_WITH_CONCERNS", "BLOCKED", "NEEDS_CONTEXT"];
  if (!validStatuses.includes(rawStatus as CompletionStatus)) return null;

  const status = rawStatus as CompletionStatus;

  // 解析 SUMMARY
  const summaryLine = lines.find((l) => l.trimStart().startsWith("SUMMARY:"));
  const summary = summaryLine ? summaryLine.replace(/^.*SUMMARY:\s*/, "").trim() : "";

  // 解析 STRIKE_COUNT
  const strikeLine = lines.find((l) => l.trimStart().startsWith("STRIKE_COUNT:"));
  const strikeCount = strikeLine
    ? parseInt(strikeLine.replace(/^.*STRIKE_COUNT:\s*/, "").trim(), 10)
    : undefined;

  // 解析 RECOMMENDATION
  const recLine = lines.find((l) => l.trimStart().startsWith("RECOMMENDATION:"));
  const recommendation = recLine ? recLine.replace(/^.*RECOMMENDATION:\s*/, "").trim() : undefined;

  // 解析列表块的通用函数
  function parseList(sectionLabel: string): string[] | undefined {
    const sectionIdx = lines.findIndex((l) => l.trimStart().startsWith(`${sectionLabel}:`));
    if (sectionIdx === -1) return undefined;

    const items: string[] = [];
    for (let i = sectionIdx + 1; i < lines.length; i++) {
      const line = lines[i];
      // 以 "  - " 开头的行属于本 section
      if (/^\s+-\s+/.test(line)) {
        items.push(line.replace(/^\s+-\s+/, "").trim());
      } else if (line.trim() === "") {
        // 空行继续（section 内可能有空行）
        continue;
      } else {
        // 遇到非列表行（新 section 或正文），停止
        break;
      }
    }

    return items.length > 0 ? items : undefined;
  }

  const evidence = parseList("EVIDENCE");
  const concerns = parseList("CONCERNS");
  const blockers = parseList("BLOCKERS");
  const attempted = parseList("ATTEMPTED");

  const report: CompletionReport = { status, summary };

  if (strikeCount !== undefined && !Number.isNaN(strikeCount)) report.strikeCount = strikeCount;
  if (evidence) report.evidence = evidence;
  if (concerns) report.concerns = concerns;
  if (blockers) report.blockers = blockers;
  if (attempted) report.attempted = attempted;
  if (recommendation) report.recommendation = recommendation;

  return report;
}

// ── 3-Strike 规则 ────────────────────────────────────────────────

/**
 * 3-strike 规则检查：连续失败 3 次（strikeCount >= 3）必须 STOP 并升级。
 *
 * Strike 1: 重试，换一个方法
 * Strike 2: 重试，降低范围
 * Strike 3: STOP，不再尝试，升级给用户或上级 agent
 */
export function shouldEscalate(strikeCount: number): boolean {
  return strikeCount >= 3;
}

/**
 * 生成升级提示，向用户或上级 agent 说明阻塞情况。
 * 仅在 shouldEscalate() 返回 true 时调用。
 */
export function buildEscalationPrompt(report: CompletionReport): string {
  const lines: string[] = [
    "══════════════════════════════════════════",
    "[OMA 升级通知 — ESCALATION REQUIRED]",
    "══════════════════════════════════════════",
    "",
    `状态：${report.status}`,
    `摘要：${report.summary}`,
  ];

  if (report.strikeCount !== undefined) {
    lines.push(`已重试次数：${report.strikeCount} 次（已触发 3-strike 升级规则）`);
  }

  if (report.blockers && report.blockers.length > 0) {
    lines.push("");
    lines.push("阻塞原因：");
    for (const blocker of report.blockers) {
      lines.push(`  - ${blocker}`);
    }
  }

  if (report.attempted && report.attempted.length > 0) {
    lines.push("");
    lines.push("已尝试的方案：");
    for (const attempt of report.attempted) {
      lines.push(`  - ${attempt}`);
    }
  }

  if (report.recommendation) {
    lines.push("");
    lines.push(`建议：${report.recommendation}`);
  }

  lines.push("");
  lines.push("需要人工介入或上级 agent 决策，当前 agent 已停止自动重试。");
  lines.push("══════════════════════════════════════════");

  return lines.join("\n");
}
