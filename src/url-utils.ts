export const GITHUB_URL_RE = /https:\/\/github\.com\/[^\s)<>\]]+/g;

export function normalizeUrl(url: string): string {
  // Strip trailing punctuation, closing brackets, and angle brackets
  return url.replace(/[),.;>\]]+$/, "");
}

export function inferTrackKind(trackId: string): "issues" | "discussions" | "skills" | "generic" {
  const lowered = trackId.toLowerCase();
  if (lowered.includes("issue")) {
    return "issues";
  }
  if (lowered.includes("discussion")) {
    return "discussions";
  }
  if (lowered.includes("skill") || lowered.includes("plugin")) {
    return "skills";
  }
  return "generic";
}

export function urlMatchesTrack(url: string, trackKind: ReturnType<typeof inferTrackKind>): boolean {
  if (trackKind === "issues") {
    return /\/issues\/\d+/.test(url);
  }
  if (trackKind === "discussions") {
    return /\/discussions\/\d+/.test(url);
  }
  if (trackKind === "skills") {
    return /https:\/\/github\.com\/[^/]+\/[^/]+/.test(url);
  }
  return true;
}
