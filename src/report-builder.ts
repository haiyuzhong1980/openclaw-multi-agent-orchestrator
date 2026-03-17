import type { CandidateItem } from "./types.ts";
import type { ClassifiedTrack } from "./candidate-extractor.ts";
import { compactTitle } from "./candidate-extractor.ts";

export const USER_FACING_MAX_ITEMS = 12;

export function buildHumanReport(params: {
  request?: string;
  tracks: ClassifiedTrack[];
  deduped: Array<CandidateItem & { trackId: string; label: string }>;
  duplicates: number;
}): string {
  const sections: string[] = [];

  sections.push("执行步骤");
  sections.push("- 1. 主 agent 已调用 multi-agent-orchestrator 生成 track 计划。");
  sections.push(`- 2. 按计划执行了 ${params.tracks.length} 个 track，并收集子结果。`);
  sections.push("- 3. 主 agent 已调用 multi-agent-orchestrator 进行验收、去重和汇总。");
  sections.push("");

  sections.push("协同情况");
  sections.push(
    `- 主 agent 负责派工、验收、去重和汇总，共处理 ${params.tracks.length} 个 track。`,
  );
  for (const track of params.tracks) {
    sections.push(`- ${track.label}: ${track.status}`);
  }
  sections.push("");

  sections.push("验收结果");
  for (const track of params.tracks) {
    sections.push(`- ${track.summaryLine}`);
  }
  sections.push("");

  sections.push("最终汇总");
  if (params.deduped.length === 0) {
    sections.push("- 无通过验收的有效结果。");
  } else {
    const visibleItems = params.deduped.slice(0, USER_FACING_MAX_ITEMS);
    for (const item of visibleItems) {
      const title = compactTitle(item.title || item.raw || item.url) || item.url;
      sections.push(`- [${item.label}] ${title} — ${item.url}`);
    }
    if (params.deduped.length > visibleItems.length) {
      sections.push(
        `- 其余 ${params.deduped.length - visibleItems.length} 条有效结果已保留在结构化结果中，聊天窗口不展开原始长表。`,
      );
    }
  }
  sections.push("");

  sections.push("去重说明");
  sections.push(`- 按 URL 去重，去掉重复项 ${params.duplicates} 条。`);
  sections.push("- 已过滤 HTML、404 页面、工具日志、run metadata 和空 payload 痕迹。");
  sections.push("- 已过滤 JSON 包装、子 agent 原始结果包裹、超长原始段落和明显非用户可见脏数据。");
  sections.push("- 对 issues/discussions track 已校验链接类型，并过滤 comments<=0 的条目。");

  return sections.join("\n");
}
