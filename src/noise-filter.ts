// DIRTY_MARKERS: bare "404" removed — only HTML-specific 404 variants kept
export const DIRTY_MARKERS = [
  "EXTERNAL_UNTRUSTED_CONTENT",
  "Page not found",
  "web_fetch failed",
  "payloads: []",
  "systemPromptReport",
  "runId",
  "<html",
  "<!DOCTYPE html",
  "<<<BEGIN_UNTRUSTED_CHILD_RESULT>>>",
  "<<<END_UNTRUSTED_CHILD_RESULT>>>",
  "```json",
  "NO_REPLY",
  "\"status\": \"error\"",
];

export const TOOL_LOG_MARKERS = [
  "browser service ready",
  "sendMessage ok",
  "tracked_run_pulse",
  "tracked_run_completed",
  "Command:",
  "### Stdout",
  "### Stderr",
];

export function cleanInlineText(value: string): string {
  return value
    .replace(/<<<BEGIN_UNTRUSTED_CHILD_RESULT>>>/g, "")
    .replace(/<<<END_UNTRUSTED_CHILD_RESULT>>>/g, "")
    .replace(/```json|```/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function looksLikeNoiseLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) {
    return true;
  }
  if (DIRTY_MARKERS.some((marker) => trimmed.includes(marker))) {
    return true;
  }
  if (TOOL_LOG_MARKERS.some((marker) => trimmed.includes(marker))) {
    return true;
  }
  if (
    trimmed.startsWith("{") ||
    trimmed.startsWith("[") ||
    trimmed.startsWith("]") ||
    trimmed.startsWith("}") ||
    /^"(name|github_url|stars|description|relevance|use_cases|data_sources|compliance_risks)"/i.test(
      trimmed,
    )
  ) {
    return true;
  }
  if (/^https?:\/\/[^ ]+$/.test(trimmed)) {
    return false;
  }
  if (trimmed.length > 500) {
    return true;
  }
  return false;
}
