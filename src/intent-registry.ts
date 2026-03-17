import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface IntentPattern {
  phrase: string;
  occurrences: number;
  delegationCount: number;
  trackedCount: number;
  lightCount: number;
  lastSeen: string;
  confidence: {
    delegation: number;
    tracked: number;
    light: number;
  };
}

export interface IntentRegistry {
  patterns: Record<string, IntentPattern>;
  totalClassifications: number;
  totalCorrections: number;
  lastUpdated: string;
  version: number;
}

const INTENT_REGISTRY_FILE = "intent-registry.json";

// Chinese stop words (common single characters to skip as standalone phrases)
const CHINESE_STOP_CHARS = new Set([
  "的", "了", "在", "是", "我", "有", "和", "就", "不", "人", "都", "一", "一个",
  "上", "也", "很", "到", "说", "要", "去", "你", "会", "着", "没有", "看", "好",
  "自", "这", "那", "什么", "没", "为", "啊", "把", "被", "让", "从", "与",
]);

// English stop words
const ENGLISH_STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "shall", "should",
  "may", "might", "must", "can", "could", "to", "of", "in", "on", "at",
  "by", "for", "with", "from", "as", "it", "its", "this", "that", "these",
  "those", "and", "or", "but", "not", "no", "so", "if", "then", "than",
  "all", "also", "just", "me", "my", "we", "our", "you", "your", "he",
  "she", "they", "them", "their", "i", "am", "now", "please", "ok",
]);

export function createEmptyRegistry(): IntentRegistry {
  return {
    patterns: {},
    totalClassifications: 0,
    totalCorrections: 0,
    lastUpdated: new Date().toISOString(),
    version: 1,
  };
}

export function loadIntentRegistry(sharedRoot: string): IntentRegistry {
  const filePath = join(sharedRoot, INTENT_REGISTRY_FILE);
  if (!existsSync(filePath)) {
    return createEmptyRegistry();
  }
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as IntentRegistry;
  } catch {
    return createEmptyRegistry();
  }
}

export function saveIntentRegistry(sharedRoot: string, registry: IntentRegistry): void {
  const updated: IntentRegistry = { ...registry, lastUpdated: new Date().toISOString() };
  const filePath = join(sharedRoot, INTENT_REGISTRY_FILE);
  writeFileSync(filePath, JSON.stringify(updated, null, 2), "utf-8");
}

/**
 * Extract key phrases from a message for pattern tracking.
 * Returns 2-4 word phrases and significant single words.
 */
export function extractIntentPhrases(text: string): string[] {
  const phrases: string[] = [];
  const lower = text.toLowerCase().trim();

  // Detect if text contains Chinese characters
  const hasChinese = /[\u4e00-\u9fff]/.test(lower);

  if (hasChinese) {
    // Extract Chinese character n-grams (2 and 3 char windows)
    const chineseChars = lower.replace(/[^\u4e00-\u9fff]/g, "");
    for (let i = 0; i < chineseChars.length - 1; i++) {
      const bigram = chineseChars.slice(i, i + 2);
      if (!CHINESE_STOP_CHARS.has(bigram[0]) && !CHINESE_STOP_CHARS.has(bigram[1])) {
        phrases.push(bigram);
      }
      if (i < chineseChars.length - 2) {
        const trigram = chineseChars.slice(i, i + 3);
        phrases.push(trigram);
      }
    }

    // Also extract individual Chinese words of length >= 2 that aren't stop chars
    const chineseWordPattern = /[\u4e00-\u9fff]{2,6}/g;
    let match: RegExpExecArray | null;
    while ((match = chineseWordPattern.exec(lower)) !== null) {
      if (!CHINESE_STOP_CHARS.has(match[0])) {
        phrases.push(match[0]);
      }
    }
  } else {
    // English: extract words and bigrams
    const words = lower.split(/\s+/).filter((w) => w.length >= 3 && !ENGLISH_STOP_WORDS.has(w));
    phrases.push(...words);

    // Bigrams from cleaned words
    for (let i = 0; i < words.length - 1; i++) {
      phrases.push(`${words[i]} ${words[i + 1]}`);
    }
  }

  // Deduplicate and limit to max 10
  const unique = [...new Set(phrases)];
  return unique.slice(0, 10);
}

function recalculateConfidence(pattern: IntentPattern): void {
  const total = pattern.occurrences;
  if (total === 0) {
    pattern.confidence = { delegation: 0, tracked: 0, light: 0 };
    return;
  }
  pattern.confidence = {
    delegation: pattern.delegationCount / total,
    tracked: pattern.trackedCount / total,
    light: pattern.lightCount / total,
  };
}

/**
 * Record what classification was made for a message.
 */
export function recordClassification(
  registry: IntentRegistry,
  phrases: string[],
  predictedTier: "light" | "tracked" | "delegation",
): void {
  for (const phrase of phrases) {
    if (!phrase) continue;
    const existing = registry.patterns[phrase];
    if (existing) {
      existing.occurrences++;
      if (predictedTier === "delegation") existing.delegationCount++;
      else if (predictedTier === "tracked") existing.trackedCount++;
      else existing.lightCount++;
      existing.lastSeen = new Date().toISOString();
      recalculateConfidence(existing);
    } else {
      const newPattern: IntentPattern = {
        phrase,
        occurrences: 1,
        delegationCount: predictedTier === "delegation" ? 1 : 0,
        trackedCount: predictedTier === "tracked" ? 1 : 0,
        lightCount: predictedTier === "light" ? 1 : 0,
        lastSeen: new Date().toISOString(),
        confidence: { delegation: 0, tracked: 0, light: 0 },
      };
      recalculateConfidence(newPattern);
      registry.patterns[phrase] = newPattern;
    }
  }
  registry.totalClassifications++;
}

/**
 * Record a correction signal: user indicated the classification was wrong.
 */
export function recordCorrection(
  registry: IntentRegistry,
  phrases: string[],
  predictedTier: "light" | "tracked" | "delegation",
  actualTier: "light" | "tracked" | "delegation",
): void {
  for (const phrase of phrases) {
    if (!phrase) continue;
    const pattern = registry.patterns[phrase];
    if (!pattern) continue;

    // Decrement the predicted tier count (clamp to 0)
    if (predictedTier === "delegation") pattern.delegationCount = Math.max(0, pattern.delegationCount - 1);
    else if (predictedTier === "tracked") pattern.trackedCount = Math.max(0, pattern.trackedCount - 1);
    else pattern.lightCount = Math.max(0, pattern.lightCount - 1);

    // Increment the actual tier count
    if (actualTier === "delegation") pattern.delegationCount++;
    else if (actualTier === "tracked") pattern.trackedCount++;
    else pattern.lightCount++;

    recalculateConfidence(pattern);
  }
  registry.totalCorrections++;
}

/**
 * Check if any learned patterns suggest a specific tier.
 * Returns the tier if confidence > 0.7, or null if uncertain.
 *
 * Strategy: extract phrases from the text AND do direct substring lookup
 * for known registry patterns (top patterns by occurrence).
 */
export function checkLearnedPatterns(
  text: string,
  registry: IntentRegistry,
): "light" | "tracked" | "delegation" | null {
  const lower = text.toLowerCase();

  // Strategy 1: extract phrases from the text and look them up
  const phrases = extractIntentPhrases(lower);
  for (const phrase of phrases) {
    const pattern = registry.patterns[phrase];
    if (!pattern || pattern.occurrences < 3) continue;

    if (pattern.confidence.delegation > 0.7) return "delegation";
    if (pattern.confidence.tracked > 0.7) return "tracked";
    if (pattern.confidence.light > 0.7) return "light";
  }

  // Strategy 2: check if known high-confidence patterns appear in the text
  // (handles the case where trained phrases are substrings of longer text sequences)
  const topPatterns = Object.values(registry.patterns)
    .filter((p) => p.occurrences >= 3)
    .sort((a, b) => b.occurrences - a.occurrences)
    .slice(0, 50);

  for (const pattern of topPatterns) {
    if (!lower.includes(pattern.phrase.toLowerCase())) continue;

    if (pattern.confidence.delegation > 0.7) return "delegation";
    if (pattern.confidence.tracked > 0.7) return "tracked";
    if (pattern.confidence.light > 0.7) return "light";
  }

  return null;
}

// Escalation signals: user telling the system to use more agents
const ESCALATION_SIGNALS = [
  /应该派.*(agent|子|工)/,
  /不要自己做/,
  /派出去/,
  /用多.*agent/,
  /需要.*agent.*去/,
  /应该.*调度/,
  /太简单了/,
  /这个要.*agent/,
];

// De-escalation signals: user telling the system it's overdoing it
const DE_ESCALATION_SIGNALS = [
  /不用这么复杂/,
  /直接做就好/,
  /太重了/,
  /不需要.*agent/,
  /简单.*就行/,
  /不用派/,
];

/**
 * Detect if user's current message is a correction of the previous classification.
 */
export function detectCorrection(
  currentMessage: string,
  previousTier: "light" | "tracked" | "delegation",
): { isCorrection: boolean; actualTier?: "light" | "tracked" | "delegation" } {
  const lower = currentMessage.toLowerCase();

  // Check escalation signals (user wants more agents)
  if (ESCALATION_SIGNALS.some((p) => p.test(lower))) {
    if (previousTier !== "delegation") {
      return { isCorrection: true, actualTier: "delegation" };
    }
  }

  // Check de-escalation signals (user wants less complexity)
  if (DE_ESCALATION_SIGNALS.some((p) => p.test(lower))) {
    if (previousTier !== "light") {
      return { isCorrection: true, actualTier: "light" };
    }
  }

  return { isCorrection: false };
}

/**
 * Apply periodic decay to learned patterns.
 * Patterns not seen recently lose confidence by multiplying counts by decayFactor.
 * Returns the number of patterns that were decayed.
 */
export function decayPatterns(registry: IntentRegistry, decayFactor = 0.9): number {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 7); // decay patterns not seen in 7 days

  let decayed = 0;
  for (const pattern of Object.values(registry.patterns)) {
    const lastSeen = new Date(pattern.lastSeen);
    if (lastSeen < cutoff) {
      pattern.delegationCount = Math.floor(pattern.delegationCount * decayFactor);
      pattern.trackedCount = Math.floor(pattern.trackedCount * decayFactor);
      pattern.lightCount = Math.floor(pattern.lightCount * decayFactor);
      pattern.occurrences = pattern.delegationCount + pattern.trackedCount + pattern.lightCount;
      recalculateConfidence(pattern);
      decayed++;
    }
  }

  return decayed;
}
