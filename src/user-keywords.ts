import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loggers } from "./errors.ts";

export interface UserKeywords {
  delegation: string[];
  tracked: string[];
  light: string[];
  updatedAt: string;
}

const MAX_KEYWORDS_PER_TIER = 80;
const MAX_KEYWORDS_TOTAL = 200;

const USER_KEYWORDS_FILE = "user-intent-keywords.json";

export function loadUserKeywords(sharedRoot: string): UserKeywords {
  const filePath = join(sharedRoot, USER_KEYWORDS_FILE);
  if (!existsSync(filePath)) {
    return { delegation: [], tracked: [], light: [], updatedAt: "" };
  }
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as UserKeywords;
  } catch (error) {
    loggers.userKeywords.error(`Failed to load user keywords`, error, { path: filePath });
    return { delegation: [], tracked: [], light: [], updatedAt: "" };
  }
}

export function saveUserKeywords(sharedRoot: string, keywords: UserKeywords): void {
  const updated: UserKeywords = { ...keywords, updatedAt: new Date().toISOString() };
  const filePath = join(sharedRoot, USER_KEYWORDS_FILE);
  writeFileSync(filePath, JSON.stringify(updated, null, 2), "utf-8");
}

export function addUserKeyword(
  keywords: UserKeywords,
  tier: "delegation" | "tracked" | "light",
  phrase: string,
): void {
  const lower = phrase.toLowerCase().trim();
  if (!lower) return;
  if (keywords[tier].includes(lower)) return;

  // Enforce per-tier cap: drop oldest when full
  if (keywords[tier].length >= MAX_KEYWORDS_PER_TIER) {
    keywords[tier].shift();
  }

  // Enforce total cap: drop oldest from the largest tier
  const total = keywords.delegation.length + keywords.tracked.length + keywords.light.length;
  if (total >= MAX_KEYWORDS_TOTAL) {
    const largest = (["delegation", "tracked", "light"] as const)
      .sort((a, b) => keywords[b].length - keywords[a].length)[0];
    keywords[largest].shift();
  }

  keywords[tier].push(lower);
}

/**
 * Prune keywords that are no longer useful.
 * Removes entries that are substrings of longer entries in the same tier.
 */
export function pruneSubstringKeywords(keywords: UserKeywords): number {
  let pruned = 0;
  for (const tier of ["delegation", "tracked", "light"] as const) {
    const sorted = [...keywords[tier]].sort((a, b) => b.length - a.length);
    const kept: string[] = [];
    for (const kw of sorted) {
      const isSubstring = kept.some((longer) => longer.includes(kw) && longer !== kw);
      if (isSubstring) {
        pruned++;
      } else {
        kept.push(kw);
      }
    }
    keywords[tier] = kept;
  }
  return pruned;
}
