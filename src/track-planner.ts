import type { PlannedTrack } from "./types.ts";

export function inferRecentWindowDays(request?: string): number | null {
  const source = request ?? "";
  const cn = source.match(/最近\s*(\d+)\s*天/);
  if (cn) {
    return Number(cn[1]);
  }
  const en = source.match(/last\s+(\d+)\s+days/i);
  if (en) {
    return Number(en[1]);
  }
  return null;
}

export function buildSubagentPrompt(params: {
  label: string;
  goal: string;
  outputContract: string[];
  failureContract: string[];
  windowDays: number | null;
}): string {
  const lines = [
    `你只负责 ${params.label} 这一个 track。`,
    `目标：${params.goal}`,
    params.windowDays
      ? `时间窗口：最近 ${params.windowDays} 天；如果不能严格筛选，必须明确说明。`
      : "时间窗口：按用户请求指定的最近时间窗口执行；如果未指定，说明你采用的窗口。",
    "输出要求：",
    ...params.outputContract.map((item) => `- ${item}`),
    "失败要求：",
    ...params.failureContract.map((item) => `- ${item}`),
    "不要输出 HTML、404 页面、工具日志、run metadata、JSON 包装。",
    "只返回该 track 的原始收集结果，不要做最终跨 track 汇总。",
  ];
  return lines.join("\n");
}

export function inferResearchTracks(request?: string): PlannedTrack[] {
  const lowered = (request ?? "").toLowerCase();
  const wantsIssues = /issue/.test(lowered);
  const wantsDiscussions = /discussion/.test(lowered);
  const wantsSkills = /skill|plugin|extension/.test(lowered);
  const windowDays = inferRecentWindowDays(request);

  const tracks: PlannedTrack[] = [];

  if (wantsIssues || (!wantsDiscussions && !wantsSkills)) {
    const goal = windowDays
      ? `查找目标仓库最近 ${windowDays} 天内最相关、最活跃的 issues。`
      : "查找目标仓库最近时间窗口内最相关、最活跃的 issues。";
    const outputContract = [
      "仅返回 issue 条目，不混入 pull requests。",
      "每条必须包含标题、GitHub issue 链接、活跃度依据。",
      "如果用户给了时间窗口，必须显式按该窗口筛选或说明无法严格筛选。",
    ];
    const failureContract = [
      "如果没有结果，说明是无结果、权限问题还是查询路径失效。",
      "不要返回 HTML、404 页面、工具日志或 run metadata。",
    ];
    tracks.push({
      trackId: "issues-track",
      label: "Issues",
      goal,
      outputContract,
      failureContract,
      subagentPrompt: buildSubagentPrompt({
        label: "Issues",
        goal,
        outputContract,
        failureContract,
        windowDays,
      }),
    });
  }

  if (wantsDiscussions) {
    const goal = windowDays
      ? `查找目标仓库最近 ${windowDays} 天内最相关、最活跃的 discussions。`
      : "查找目标仓库最近时间窗口内最相关、最活跃的 discussions。";
    const outputContract = [
      "仅返回 discussion 条目。",
      "每条必须包含标题、GitHub discussion 链接、活跃度依据。",
      "如果仓库未启用 discussions，要明确写出这一点。",
    ];
    const failureContract = [
      "区分\u201c仓库未启用 discussions\u201d和\u201c最近时间窗口内无有效结果\u201d。",
      "不要返回 HTML、404 页面、工具日志或 run metadata。",
    ];
    tracks.push({
      trackId: "discussions-track",
      label: "Discussions",
      goal,
      outputContract,
      failureContract,
      subagentPrompt: buildSubagentPrompt({
        label: "Discussions",
        goal,
        outputContract,
        failureContract,
        windowDays,
      }),
    });
  }

  if (wantsSkills) {
    const goal = windowDays
      ? `查找最近 ${windowDays} 天内与目标主题强相关的 skills、plugins 或 extension 项目。`
      : "查找与目标主题强相关的 skills、plugins 或 extension 项目。";
    const outputContract = [
      "每条必须包含项目名称、GitHub 链接、相关性说明。",
      "优先返回真实项目仓库或 discussion 链接，不返回聚合页。",
    ];
    const failureContract = [
      "如果只找到噪声内容，明确说明无有效结果。",
      "不要返回 HTML、404 页面、工具日志或 run metadata。",
    ];
    tracks.push({
      trackId: "skills-track",
      label: "Skills / Plugins",
      goal,
      outputContract,
      failureContract,
      subagentPrompt: buildSubagentPrompt({
        label: "Skills / Plugins",
        goal,
        outputContract,
        failureContract,
        windowDays,
      }),
    });
  }

  if (tracks.length === 0) {
    throw new Error("request did not imply any supported research tracks");
  }

  return tracks;
}

export function buildPlanningReport(request: string | undefined, tracks: PlannedTrack[]): string {
  const lines: string[] = [];
  lines.push("协同计划");
  lines.push(`- 主 agent 负责拆任务、验收、去重和最终汇总，共规划 ${tracks.length} 个 track。`);
  if (request) {
    lines.push(`- 原始请求: ${request}`);
  }
  lines.push("");
  lines.push("派工模板");
  for (const track of tracks) {
    lines.push(`- ${track.label} (${track.trackId})`);
    lines.push(`  目标: ${track.goal}`);
    lines.push("  输出要求:");
    for (const item of track.outputContract) {
      lines.push(`  - ${item}`);
    }
    lines.push("  失败要求:");
    for (const item of track.failureContract) {
      lines.push(`  - ${item}`);
    }
  }
  lines.push("");
  lines.push("主 agent 验收要求");
  lines.push("- 只保留带有效 GitHub 链接的条目。");
  lines.push("- 过滤 HTML、404、工具日志、run metadata、空 payload 痕迹。");
  lines.push("- 允许 partial：保留有效条目，丢弃脏条目，并记录失败原因。");
  lines.push("- 只有出现真实 worker/subagent/tracked execution 证据后，才能对外声称某个 track 已开始或已派工。");
  lines.push("- 验收失败不等于任务完成；如果 required track 未运行、请求的最小样本数未满足、或证据仍可补充，主 agent 必须补派、重试或补证据。");
  lines.push("- 只有在所有 required track 都有真实执行证据，且已经完成最终验收/补跑决策后，任务才允许收尾。");
  lines.push("- 最终输出固定为：协同情况 / 验收结果 / 最终汇总 / 去重说明。");
  return lines.join("\n");
}
