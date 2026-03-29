import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { CHINESE_STOP_CHARS, CHINESE_STOP_WORDS, CHINESE_PHRASE_BLACKLIST, ENGLISH_STOP_WORDS, ESCALATION_SIGNALS, DE_ESCALATION_SIGNALS } from "./constants.ts";

// ============================================================================
// Pattern Conflict Resolution Types
// ============================================================================

/**
 * Conflict resolution strategy for multiple pattern matches.
 * - first: Return the first matching pattern (legacy behavior)
 * - voting: Use majority voting based on occurrences count
 * - weighted: Use weighted fusion based on confidence and occurrences
 * - highest_confidence: Return the pattern with highest confidence
 */
export type ConflictResolutionStrategy = "first" | "voting" | "weighted" | "highest_confidence";

/**
 * Configuration for pattern conflict resolution.
 */
export interface ConflictResolutionConfig {
  strategy: ConflictResolutionStrategy;
  minOccurrences: number;           // Minimum occurrences for a pattern to be considered
  confidenceThreshold: number;      // Minimum confidence to consider a pattern valid
  weightDecayFactor: number;        // Decay factor for older patterns (0-1)
}

/**
 * Default conflict resolution configuration.
 */
export const DEFAULT_CONFLICT_CONFIG: ConflictResolutionConfig = {
  strategy: "weighted",
  minOccurrences: 3,
  confidenceThreshold: 0.7,
  weightDecayFactor: 0.95,
};

// ============================================================================
// Dynamic Threshold Adjustment Types
// ============================================================================

/**
 * Threshold adjustment configuration for dynamic threshold based on accuracy.
 */
export interface DynamicThresholdConfig {
  /** Enable dynamic threshold adjustment (default: true) */
  enabled: boolean;
  /** Base threshold when no accuracy history exists (default: 0.7) */
  baseThreshold: number;
  /** Minimum threshold value (default: 0.5) */
  minThreshold: number;
  /** Maximum threshold value (default: 0.9) */
  maxThreshold: number;
  /** Adjustment factor when accuracy is high (default: 0.05) */
  adjustmentStep: number;
  /** Minimum number of samples before adjustment (default: 20) */
  minSamplesForAdjustment: number;
  /** Accuracy target for lowering threshold (default: 0.85) */
  highAccuracyTarget: number;
  /** Accuracy target for raising threshold (default: 0.6) */
  lowAccuracyTarget: number;
}

/**
 * Default dynamic threshold configuration.
 */
export const DEFAULT_DYNAMIC_THRESHOLD_CONFIG: DynamicThresholdConfig = {
  enabled: true,
  baseThreshold: 0.7,
  minThreshold: 0.5,
  maxThreshold: 0.9,
  adjustmentStep: 0.05,
  minSamplesForAdjustment: 20,
  highAccuracyTarget: 0.85,
  lowAccuracyTarget: 0.6,
};

/**
 * Threshold history entry for tracking accuracy over time.
 */
export interface ThresholdHistoryEntry {
  timestamp: string;
  threshold: number;
  accuracy: number;
  sampleCount: number;
  reason: string;
}

/**
 * Extended intent registry with dynamic threshold support.
 */
export interface DynamicThresholdState {
  currentThreshold: number;
  accuracyHistory: ThresholdHistoryEntry[];
  totalCorrect: number;
  totalPredictions: number;
  lastAdjustment: string;
}

/**
 * Result of pattern matching with conflict resolution.
 */
export interface PatternMatchResult {
  tier: "light" | "tracked" | "delegation" | null;
  matchedPatterns: MatchedPattern[];
  resolution: ConflictResolutionDetails;
}

/**
 * A single matched pattern with its details.
 */
export interface MatchedPattern {
  phrase: string;
  tier: "light" | "tracked" | "delegation";
  confidence: number;
  occurrences: number;
  matchType: "extracted" | "substring";
}

/**
 * Details about how the conflict was resolved.
 */
export interface ConflictResolutionDetails {
  strategy: ConflictResolutionStrategy;
  totalMatches: number;
  hasConflict: boolean;
  scores?: Record<string, number>;  // Final scores for each tier
  winner?: string;                   // Winning tier
  reason: string;                    // Explanation of resolution
}

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
  totalConfirmations: number;
  lastUpdated: string;
  version: number;
  /** Dynamic threshold state for adaptive adjustment */
  thresholdState?: DynamicThresholdState;
}

const INTENT_REGISTRY_FILE = "intent-registry.json";

// CHINESE_STOP_CHARS and ENGLISH_STOP_WORDS imported from constants.ts

export function createEmptyRegistry(): IntentRegistry {
  return {
    patterns: {},
    totalClassifications: 0,
    totalCorrections: 0,
    totalConfirmations: 0,
    lastUpdated: new Date(Date.now()).toISOString(),
    version: 1,
    thresholdState: {
      currentThreshold: DEFAULT_DYNAMIC_THRESHOLD_CONFIG.baseThreshold,
      accuracyHistory: [],
      totalCorrect: 0,
      totalPredictions: 0,
      lastAdjustment: new Date().toISOString(),
    },
  };
}

export function loadIntentRegistry(sharedRoot: string): IntentRegistry {
  const filePath = join(sharedRoot, INTENT_REGISTRY_FILE);
  if (!existsSync(filePath)) {
    return createEmptyRegistry();
  }
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as IntentRegistry;
  } catch (error) {
    console.error(`[intent-registry] Failed to load intent registry:`, error);
    return createEmptyRegistry();
  }
}

export function saveIntentRegistry(sharedRoot: string, registry: IntentRegistry): void {
  const updated: IntentRegistry = { ...registry, lastUpdated: new Date().toISOString() };
  const filePath = join(sharedRoot, INTENT_REGISTRY_FILE);
  writeFileSync(filePath, JSON.stringify(updated, null, 2), "utf-8");
}

/**
 * Check if a Chinese phrase contains stop characters or is a blacklisted phrase.
 */
function isInvalidChinesePhrase(phrase: string): boolean {
  // Check if it's a blacklisted phrase
  if (CHINESE_PHRASE_BLACKLIST.has(phrase)) return true;
  
  // Check if any character is a stop character
  for (const char of phrase) {
    if (CHINESE_STOP_CHARS.has(char)) return true;
  }
  
  // Check if it's a stop word
  if (CHINESE_STOP_WORDS.has(phrase)) return true;
  
  return false;
}

/**
 * Extract key phrases from a message for pattern tracking.
 * Returns 2-4 word phrases and significant single words.
 * Improved version with better Chinese phrase filtering.
 */
export function extractIntentPhrases(text: string): string[] {
  const phrases: string[] = [];
  const lower = text.toLowerCase().trim();

  // Detect if text contains Chinese characters
  const hasChinese = /[\u4e00-\u9fff]/.test(lower);

  if (hasChinese) {
    // Extract Chinese character n-grams with improved filtering
    const chineseChars = lower.replace(/[^\u4e00-\u9fff]/g, "");
    
    // Extract meaningful bigrams (filter out stop chars and blacklisted phrases)
    for (let i = 0; i < chineseChars.length - 1; i++) {
      const bigram = chineseChars.slice(i, i + 2);
      if (!isInvalidChinesePhrase(bigram)) {
        phrases.push(bigram);
      }
    }
    
    // Extract trigrams only if all characters are meaningful
    for (let i = 0; i < chineseChars.length - 2; i++) {
      const trigram = chineseChars.slice(i, i + 3);
      // For trigrams, only filter if the whole phrase is blacklisted
      // or if it starts/ends with a stop char
      if (!CHINESE_PHRASE_BLACKLIST.has(trigram) && 
          !CHINESE_STOP_CHARS.has(trigram[0]) && 
          !CHINESE_STOP_CHARS.has(trigram[2])) {
        phrases.push(trigram);
      }
    }

    // Extract Chinese words of length 2-6 that are meaningful
    const chineseWordPattern = /[\u4e00-\u9fff]{2,6}/g;
    let match: RegExpExecArray | null;
    while ((match = chineseWordPattern.exec(lower)) !== null) {
      const word = match[0];
      // Check if word is meaningful (not starting/ending with stop char, not blacklisted)
      if (!isInvalidChinesePhrase(word) &&
          !CHINESE_STOP_CHARS.has(word[word.length - 1])) {
        phrases.push(word);
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
      existing.lastSeen = new Date(Date.now()).toISOString();
      recalculateConfidence(existing);
    } else {
      const newPattern: IntentPattern = {
        phrase,
        occurrences: 1,
        delegationCount: predictedTier === "delegation" ? 1 : 0,
        trackedCount: predictedTier === "tracked" ? 1 : 0,
        lightCount: predictedTier === "light" ? 1 : 0,
        lastSeen: new Date(Date.now()).toISOString(),
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
 * Learning configuration for confirmation reinforcement.
 */
export interface LearningConfig {
  /** How much to boost the tier count on confirmation (default: 1) */
  confirmationBoost?: number;
  /** Enable/disable confirmation learning (default: true) */
  enableConfirmationLearning?: boolean;
}

// Default learning configuration
const DEFAULT_LEARNING_CONFIG: Required<LearningConfig> = {
  confirmationBoost: 1,
  enableConfirmationLearning: true,
};

/**
 * Record a confirmation signal: user indicated the classification was correct.
 * This reinforces the predicted tier by increasing its count, boosting confidence.
 * 
 * @param registry - The intent registry to update
 * @param phrases - The phrases that were matched
 * @param confirmedTier - The tier that was confirmed as correct
 * @param config - Optional learning configuration
 */
export function recordConfirmation(
  registry: IntentRegistry,
  phrases: string[],
  confirmedTier: "light" | "tracked" | "delegation",
  config?: LearningConfig,
): void {
  const cfg = { ...DEFAULT_LEARNING_CONFIG, ...config };
  
  if (!cfg.enableConfirmationLearning) return;
  
  const boost = cfg.confirmationBoost;
  
  for (const phrase of phrases) {
    if (!phrase) continue;
    const pattern = registry.patterns[phrase];
    if (!pattern) continue;

    // Boost the confirmed tier count to increase confidence
    if (confirmedTier === "delegation") {
      pattern.delegationCount += boost;
    } else if (confirmedTier === "tracked") {
      pattern.trackedCount += boost;
    } else {
      pattern.lightCount += boost;
    }
    
    // Update occurrences to reflect the boost
    pattern.occurrences += boost;
    pattern.lastSeen = new Date(Date.now()).toISOString();
    
    recalculateConfidence(pattern);
  }
  registry.totalConfirmations++;
}

// ============================================================================
// Dynamic Threshold Adjustment Functions
// ============================================================================

/**
 * Record a prediction result for dynamic threshold tracking.
 * Call this when a classification is made and later confirmed/corrected.
 */
export function recordPredictionResult(
  registry: IntentRegistry,
  wasCorrect: boolean,
): void {
  if (!registry.thresholdState) {
    registry.thresholdState = {
      currentThreshold: DEFAULT_DYNAMIC_THRESHOLD_CONFIG.baseThreshold,
      accuracyHistory: [],
      totalCorrect: 0,
      totalPredictions: 0,
      lastAdjustment: new Date().toISOString(),
    };
  }
  
  registry.thresholdState.totalPredictions++;
  if (wasCorrect) {
    registry.thresholdState.totalCorrect++;
  }
}

/**
 * Get the current dynamic threshold based on accuracy history.
 * Returns the base threshold if dynamic adjustment is disabled or not enough data.
 */
export function getDynamicThreshold(
  registry: IntentRegistry,
  config: DynamicThresholdConfig = DEFAULT_DYNAMIC_THRESHOLD_CONFIG,
): number {
  if (!config.enabled) {
    return config.baseThreshold;
  }
  
  if (!registry.thresholdState) {
    return config.baseThreshold;
  }
  
  return registry.thresholdState.currentThreshold;
}

/**
 * Adjust the dynamic threshold based on recent accuracy.
 * Should be called periodically (e.g., after every N classifications).
 * 
 * Algorithm:
 * - If accuracy > highAccuracyTarget: lower threshold (accept more patterns)
 * - If accuracy < lowAccuracyTarget: raise threshold (be more selective)
 * 
 * @returns The new threshold value, or null if no adjustment was made
 */
export function adjustDynamicThreshold(
  registry: IntentRegistry,
  config: DynamicThresholdConfig = DEFAULT_DYNAMIC_THRESHOLD_CONFIG,
): { newThreshold: number; reason: string } | null {
  if (!config.enabled) {
    return null;
  }
  
  if (!registry.thresholdState) {
    return null;
  }
  
  const state = registry.thresholdState;
  
  // Not enough samples to make adjustment
  if (state.totalPredictions < config.minSamplesForAdjustment) {
    return null;
  }
  
  const accuracy = state.totalCorrect / state.totalPredictions;
  const currentThreshold = state.currentThreshold;
  let newThreshold = currentThreshold;
  let reason = "";
  
  if (accuracy >= config.highAccuracyTarget) {
    // High accuracy - can lower threshold to accept more patterns
    newThreshold = Math.max(
      config.minThreshold,
      currentThreshold - config.adjustmentStep
    );
    reason = `Accuracy ${(accuracy * 100).toFixed(1)}% >= ${(config.highAccuracyTarget * 100).toFixed(1)}%, lowering threshold from ${currentThreshold.toFixed(2)} to ${newThreshold.toFixed(2)}`;
  } else if (accuracy < config.lowAccuracyTarget) {
    // Low accuracy - need to raise threshold to be more selective
    newThreshold = Math.min(
      config.maxThreshold,
      currentThreshold + config.adjustmentStep
    );
    reason = `Accuracy ${(accuracy * 100).toFixed(1)}% < ${(config.lowAccuracyTarget * 100).toFixed(1)}%, raising threshold from ${currentThreshold.toFixed(2)} to ${newThreshold.toFixed(2)}`;
  } else {
    // Accuracy in acceptable range - no adjustment needed
    return null;
  }
  
  // Record the adjustment
  state.currentThreshold = newThreshold;
  state.lastAdjustment = new Date().toISOString();
  state.accuracyHistory.push({
    timestamp: new Date().toISOString(),
    threshold: newThreshold,
    accuracy,
    sampleCount: state.totalPredictions,
    reason,
  });
  
  // Keep history limited to last 100 entries
  if (state.accuracyHistory.length > 100) {
    state.accuracyHistory = state.accuracyHistory.slice(-100);
  }
  
  return { newThreshold, reason };
}

/**
 * Get conflict resolution config with dynamic threshold applied.
 */
export function getDynamicConflictConfig(
  registry: IntentRegistry,
  baseConfig: Partial<ConflictResolutionConfig> = {},
  thresholdConfig: DynamicThresholdConfig = DEFAULT_DYNAMIC_THRESHOLD_CONFIG,
): ConflictResolutionConfig {
  const dynamicThreshold = getDynamicThreshold(registry, thresholdConfig);
  return {
    ...DEFAULT_CONFLICT_CONFIG,
    ...baseConfig,
    confidenceThreshold: dynamicThreshold,
  };
}

/**
 * Get the dominant tier for a pattern based on confidence scores.
 */
function getDominantTier(pattern: IntentPattern): "light" | "tracked" | "delegation" | null {
  const { delegation, tracked, light } = pattern.confidence;
  const maxConfidence = Math.max(delegation, tracked, light);
  if (maxConfidence <= 0) return null;
  if (delegation === maxConfidence) return "delegation";
  if (tracked === maxConfidence) return "tracked";
  return "light";
}

/**
 * Collect all matching patterns from the text.
 */
function collectMatchingPatterns(
  text: string,
  registry: IntentRegistry,
  config: ConflictResolutionConfig,
): MatchedPattern[] {
  const lower = text.toLowerCase();
  const matches: MatchedPattern[] = [];
  const seenPhrases = new Set<string>();

  // Strategy 1: extract phrases from the text and look them up
  const phrases = extractIntentPhrases(lower);
  for (const phrase of phrases) {
    const pattern = registry.patterns[phrase];
    if (!pattern || pattern.occurrences < config.minOccurrences) continue;
    if (seenPhrases.has(phrase)) continue;

    const dominantTier = getDominantTier(pattern);
    if (!dominantTier) continue;

    const confidence = pattern.confidence[dominantTier];
    if (confidence < config.confidenceThreshold) continue;

    seenPhrases.add(phrase);
    matches.push({
      phrase,
      tier: dominantTier,
      confidence,
      occurrences: pattern.occurrences,
      matchType: "extracted",
    });
  }

  // Strategy 2: check if known high-confidence patterns appear in the text
  const topPatterns = Object.values(registry.patterns)
    .filter((p) => p.occurrences >= config.minOccurrences)
    .sort((a, b) => b.occurrences - a.occurrences)
    .slice(0, 50);

  for (const pattern of topPatterns) {
    if (seenPhrases.has(pattern.phrase)) continue;
    if (!lower.includes(pattern.phrase.toLowerCase())) continue;

    const dominantTier = getDominantTier(pattern);
    if (!dominantTier) continue;

    const confidence = pattern.confidence[dominantTier];
    if (confidence < config.confidenceThreshold) continue;

    seenPhrases.add(pattern.phrase);
    matches.push({
      phrase: pattern.phrase,
      tier: dominantTier,
      confidence,
      occurrences: pattern.occurrences,
      matchType: "substring",
    });
  }

  return matches;
}

/**
 * Resolve conflicts using voting mechanism.
 * Each pattern votes based on its occurrences count.
 */
function resolveByVoting(
  matches: MatchedPattern[],
): { tier: "light" | "tracked" | "delegation" | null; details: ConflictResolutionDetails } {
  const votes: Record<string, number> = { delegation: 0, tracked: 0, light: 0 };

  for (const match of matches) {
    votes[match.tier] += match.occurrences;
  }

  const maxVotes = Math.max(...Object.values(votes));
  if (maxVotes === 0) {
    return {
      tier: null,
      details: {
        strategy: "voting",
        totalMatches: matches.length,
        hasConflict: false,
        scores: votes,
        reason: "No valid votes cast",
      },
    };
  }

  // Find winner
  let winner: string | null = null;
  for (const [tier, voteCount] of Object.entries(votes)) {
    if (voteCount === maxVotes) {
      winner = tier;
      break;
    }
  }

  // Check for ties
  const winners = Object.entries(votes).filter(([_, v]) => v === maxVotes);
  const hasConflict = winners.length > 1;

  return {
    tier: winner as "light" | "tracked" | "delegation",
    details: {
      strategy: "voting",
      totalMatches: matches.length,
      hasConflict,
      scores: votes,
      winner: winner ?? undefined,
      reason: hasConflict
        ? `Tie detected between tiers: ${winners.map(([t]) => t).join(", ")} with ${maxVotes} votes each`
        : `${winner} won with ${maxVotes} votes`,
    },
  };
}

/**
 * Resolve conflicts using weighted fusion.
 * Score = sum of (confidence * occurrences * weight) for each tier.
 */
function resolveByWeighted(
  matches: MatchedPattern[],
  config: ConflictResolutionConfig,
): { tier: "light" | "tracked" | "delegation" | null; details: ConflictResolutionDetails } {
  const scores: Record<string, number> = { delegation: 0, tracked: 0, light: 0 };

  for (const match of matches) {
    // Weight based on occurrences (log scale to avoid dominance by frequent patterns)
    const occurrenceWeight = Math.log(match.occurrences + 1);
    // Final score contribution
    const contribution = match.confidence * occurrenceWeight * config.weightDecayFactor;
    scores[match.tier] += contribution;
  }

  const maxScore = Math.max(...Object.values(scores));
  if (maxScore === 0) {
    return {
      tier: null,
      details: {
        strategy: "weighted",
        totalMatches: matches.length,
        hasConflict: false,
        scores,
        reason: "No valid scores computed",
      },
    };
  }

  // Find winner
  let winner: string | null = null;
  for (const [tier, score] of Object.entries(scores)) {
    if (score === maxScore) {
      winner = tier;
      break;
    }
  }

  // Check for ties (with tolerance)
  const tolerance = 0.001;
  const winners = Object.entries(scores).filter(([_, s]) => Math.abs(s - maxScore) < tolerance);
  const hasConflict = winners.length > 1;

  return {
    tier: winner as "light" | "tracked" | "delegation",
    details: {
      strategy: "weighted",
      totalMatches: matches.length,
      hasConflict,
      scores,
      winner: winner ?? undefined,
      reason: hasConflict
        ? `Tie detected between tiers: ${winners.map(([t]) => t).join(", ")} with score ${maxScore.toFixed(3)}`
        : `${winner} won with weighted score ${maxScore.toFixed(3)}`,
    },
  };
}

/**
 * Resolve by selecting the pattern with highest confidence.
 */
function resolveByHighestConfidence(
  matches: MatchedPattern[],
): { tier: "light" | "tracked" | "delegation" | null; details: ConflictResolutionDetails } {
  if (matches.length === 0) {
    return {
      tier: null,
      details: {
        strategy: "highest_confidence",
        totalMatches: 0,
        hasConflict: false,
        reason: "No matching patterns found",
      },
    };
  }

  // Sort by confidence descending, then by occurrences
  const sorted = [...matches].sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return b.occurrences - a.occurrences;
  });

  const best = sorted[0];
  const second = sorted[1];

  // Check if there's a close competitor
  const hasConflict = second && (second.confidence >= best.confidence - 0.05);

  return {
    tier: best.tier,
    details: {
      strategy: "highest_confidence",
      totalMatches: matches.length,
      hasConflict,
      scores: { delegation: 0, tracked: 0, light: 0, [best.tier]: best.confidence },
      winner: best.tier,
      reason: hasConflict
        ? `Close competition: "${best.phrase}" (${(best.confidence * 100).toFixed(1)}%) vs "${second.phrase}" (${(second.confidence * 100).toFixed(1)}%)`
        : `"${best.phrase}" has highest confidence: ${(best.confidence * 100).toFixed(1)}%`,
    },
  };
}

/**
 * Resolve using first match (legacy behavior).
 */
function resolveByFirst(
  matches: MatchedPattern[],
): { tier: "light" | "tracked" | "delegation" | null; details: ConflictResolutionDetails } {
  if (matches.length === 0) {
    return {
      tier: null,
      details: {
        strategy: "first",
        totalMatches: 0,
        hasConflict: false,
        reason: "No matching patterns found",
      },
    };
  }

  const first = matches[0];
  return {
    tier: first.tier,
    details: {
      strategy: "first",
      totalMatches: matches.length,
      hasConflict: matches.length > 1,
      winner: first.tier,
      reason: `First match: "${first.phrase}" (${(first.confidence * 100).toFixed(1)}% confidence, ${first.occurrences} occurrences)`,
    },
  };
}

/**
 * Check if any learned patterns suggest a specific tier.
 * Uses configurable conflict resolution strategy.
 *
 * @param text The input text to analyze
 * @param registry The intent registry with learned patterns
 * @param config Optional conflict resolution configuration
 * @returns Pattern match result with tier and resolution details
 */
export function checkLearnedPatterns(
  text: string,
  registry: IntentRegistry,
  config: Partial<ConflictResolutionConfig> = {},
): "light" | "tracked" | "delegation" | null {
  const result = checkLearnedPatternsWithDetails(text, registry, config);
  return result.tier;
}

/**
 * Check patterns with full details about conflict resolution.
 * Returns detailed information about all matches and how conflicts were resolved.
 *
 * @param text The input text to analyze
 * @param registry The intent registry with learned patterns
 * @param config Optional conflict resolution configuration
 * @returns Detailed pattern match result
 */
export function checkLearnedPatternsWithDetails(
  text: string,
  registry: IntentRegistry,
  config: Partial<ConflictResolutionConfig> = {},
): PatternMatchResult {
  const resolvedConfig: ConflictResolutionConfig = {
    ...DEFAULT_CONFLICT_CONFIG,
    ...config,
  };

  // Collect all matching patterns
  const matches = collectMatchingPatterns(text, registry, resolvedConfig);

  // No matches found
  if (matches.length === 0) {
    return {
      tier: null,
      matchedPatterns: [],
      resolution: {
        strategy: resolvedConfig.strategy,
        totalMatches: 0,
        hasConflict: false,
        reason: "No patterns matched with sufficient confidence",
      },
    };
  }

  // Only one match - no conflict
  if (matches.length === 1) {
    return {
      tier: matches[0].tier,
      matchedPatterns: matches,
      resolution: {
        strategy: resolvedConfig.strategy,
        totalMatches: 1,
        hasConflict: false,
        winner: matches[0].tier,
        reason: `Single match: "${matches[0].phrase}" (${(matches[0].confidence * 100).toFixed(1)}% confidence)`,
      },
    };
  }

  // Check if all matches agree on the same tier
  const uniqueTiers = new Set(matches.map((m) => m.tier));
  if (uniqueTiers.size === 1) {
    const tier = matches[0].tier;
    return {
      tier,
      matchedPatterns: matches,
      resolution: {
        strategy: resolvedConfig.strategy,
        totalMatches: matches.length,
        hasConflict: false,
        winner: tier,
        reason: `All ${matches.length} patterns agree on tier: ${tier}`,
      },
    };
  }

  // Multiple tiers - need conflict resolution
  let resolution: { tier: "light" | "tracked" | "delegation" | null; details: ConflictResolutionDetails };

  switch (resolvedConfig.strategy) {
    case "voting":
      resolution = resolveByVoting(matches);
      break;
    case "weighted":
      resolution = resolveByWeighted(matches, resolvedConfig);
      break;
    case "highest_confidence":
      resolution = resolveByHighestConfidence(matches);
      break;
    case "first":
    default:
      resolution = resolveByFirst(matches);
      break;
  }

  return {
    tier: resolution.tier,
    matchedPatterns: matches,
    resolution: resolution.details,
  };
}

// ESCALATION_SIGNALS and DE_ESCALATION_SIGNALS imported from constants.ts

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
