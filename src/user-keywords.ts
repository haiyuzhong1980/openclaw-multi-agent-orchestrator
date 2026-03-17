import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface UserKeywords {
  delegation: string[];
  tracked: string[];
  light: string[];
  updatedAt: string;
}

const USER_KEYWORDS_FILE = "user-intent-keywords.json";

export function loadUserKeywords(sharedRoot: string): UserKeywords {
  const filePath = join(sharedRoot, USER_KEYWORDS_FILE);
  if (!existsSync(filePath)) {
    return { delegation: [], tracked: [], light: [], updatedAt: "" };
  }
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as UserKeywords;
  } catch {
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
  if (!keywords[tier].includes(lower)) {
    keywords[tier].push(lower);
  }
}
