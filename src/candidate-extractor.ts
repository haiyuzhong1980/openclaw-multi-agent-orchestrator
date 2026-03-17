import type { CandidateItem, TrackInput } from "./types.ts";
import { cleanInlineText, DIRTY_MARKERS, looksLikeNoiseLine } from "./noise-filter.ts";
import { GITHUB_URL_RE, inferTrackKind, normalizeUrl, urlMatchesTrack } from "./url-utils.ts";

export function extractCommentCount(text: string): number | null {
  const patterns = [
    /评论数[:：]?\s*(\d+)/i,
    /(\d+)\s*评论/i,
    /comments?[:：]?\s*(\d+)/i,
    /\b(\d+)\s*comments?\b/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return Number(match[1]);
    }
  }
  return null;
}

export function compactTitle(value: string): string {
  const cleaned = cleanInlineText(value)
    .replace(/^[-*0-9.\s|]+/, "")
    .replace(/\|\s*/g, " ")
    .replace(/\s+-\s+https?:\/\/\S+$/, "")
    .trim();
  if (!cleaned) {
    return "";
  }
  if (cleaned.length <= 140) {
    return cleaned;
  }
  return `${cleaned.slice(0, 137)}...`;
}

export function summarizeDirtyReasons(text: string): string[] {
  const reasons: string[] = [];
  for (const marker of DIRTY_MARKERS) {
    if (text.includes(marker)) {
      if (marker === "<<<BEGIN_UNTRUSTED_CHILD_RESULT>>>" || marker === "<<<END_UNTRUSTED_CHILD_RESULT>>>") {
        reasons.push("子结果原始包裹");
      } else if (marker === "```json") {
        reasons.push("JSON/代码块包装");
      } else if (marker === "NO_REPLY") {
        reasons.push("无用户可见内容");
      } else if (marker === "<html" || marker === "<!DOCTYPE html") {
        reasons.push("HTML 页面");
      } else if (marker === "\"status\": \"error\"") {
        reasons.push("工具错误包装");
      } else {
        reasons.push(marker);
      }
    }
  }
  return [...new Set(reasons)];
}

export function extractCandidateItems(
  text: string,
  maxItemsPerTrack: number,
  trackKind: ReturnType<typeof inferTrackKind>,
): CandidateItem[] {
  const lines = text.split(/\r?\n/);
  const items: CandidateItem[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || looksLikeNoiseLine(trimmed)) {
      continue;
    }
    const urls = trimmed.match(GITHUB_URL_RE) ?? [];
    for (const rawUrl of urls) {
      const url = normalizeUrl(rawUrl);
      if (!urlMatchesTrack(url, trackKind)) {
        continue;
      }
      if (seen.has(url)) {
        continue;
      }
      const title = compactTitle(trimmed.replace(rawUrl, ""));
      const comments = extractCommentCount(trimmed);
      if (comments !== null && comments <= 0) {
        continue;
      }
      items.push({
        title: title || url.split("/").slice(-1)[0] || url,
        url,
        raw: trimmed,
        comments,
      });
      seen.add(url);
      if (items.length >= maxItemsPerTrack) {
        return items;
      }
    }
  }

  return items;
}

export type ClassifiedTrack = {
  trackId: string;
  label: string;
  status: "ok" | "partial" | "failed";
  items: CandidateItem[];
  dirtyReasons: string[];
  summaryLine: string;
};

export function classifyTrack(
  track: TrackInput,
  maxItemsPerTrack: number,
): ClassifiedTrack {
  const label = track.label?.trim() || track.trackId;
  const dirtyReasons = summarizeDirtyReasons(track.resultText);
  const trackKind = inferTrackKind(track.trackId);
  const invalidTypeCount = (track.resultText.match(GITHUB_URL_RE) ?? [])
    .map(normalizeUrl)
    .filter((url) => !urlMatchesTrack(url, trackKind)).length;
  const zeroCommentCount = track.resultText
    .split(/\r?\n/)
    .filter((line) => {
      const count = extractCommentCount(line);
      return count !== null && count <= 0;
    }).length;
  if (invalidTypeCount > 0) {
    dirtyReasons.push(`链接类型不符 ${invalidTypeCount} 条`);
  }
  if (zeroCommentCount > 0) {
    dirtyReasons.push(`comments<=0 ${zeroCommentCount} 条`);
  }
  const items = extractCandidateItems(track.resultText, maxItemsPerTrack, trackKind).sort((a, b) => {
    const left = a.comments ?? -1;
    const right = b.comments ?? -1;
    return right - left;
  });

  if (items.length > 0 && dirtyReasons.length > 0) {
    return {
      trackId: track.trackId,
      label,
      status: "partial",
      items,
      dirtyReasons,
      summaryLine: `${label}: partial，保留 ${items.length} 条有效结果，丢弃脏内容（${dirtyReasons.join(", ")}）`,
    };
  }
  if (items.length > 0) {
    return {
      trackId: track.trackId,
      label,
      status: "ok",
      items,
      dirtyReasons: [],
      summaryLine: `${label}: ok，验收通过 ${items.length} 条。`,
    };
  }
  const fallbackReason = dirtyReasons.length > 0 ? dirtyReasons.join(", ") : "没有提取到有效 GitHub 链接";
  return {
    trackId: track.trackId,
    label,
    status: "failed",
    items: [],
    dirtyReasons,
    summaryLine: `${label}: failed，${fallbackReason}。`,
  };
}

export function dedupeItems(
  tracks: ClassifiedTrack[],
): { deduped: Array<CandidateItem & { trackId: string; label: string }>; duplicates: number } {
  const deduped: Array<CandidateItem & { trackId: string; label: string }> = [];
  const seen = new Set<string>();
  let duplicates = 0;

  for (const track of tracks) {
    for (const item of track.items) {
      if (seen.has(item.url)) {
        duplicates += 1;
        continue;
      }
      seen.add(item.url);
      deduped.push({ ...item, trackId: track.trackId, label: track.label });
    }
  }

  return { deduped, duplicates };
}
