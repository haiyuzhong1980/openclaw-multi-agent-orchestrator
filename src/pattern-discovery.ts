import type { ObservationRecord } from "./observation-engine.js";

export interface DiscoveredPattern {
  phrase: string;
  suggestedTier: "delegation" | "tracked";
  confidence: number;         // 0-1
  occurrences: number;        // how many times seen
  delegationRate: number;     // % of times this phrase led to delegation behavior
  trackedRate: number;
  evidence: string[];         // sample messages containing this phrase
}

export interface DiscoveryResult {
  newDelegationKeywords: DiscoveredPattern[];
  newTrackedKeywords: DiscoveredPattern[];
  thresholdSuggestions: {
    minLengthForTracked?: number;
    minVerbsForDelegation?: number;
    defaultTierShouldBe?: "light" | "tracked";
  };
  sampleSize: number;
  overallAccuracy: number;
}

// English stop words (shared with intent-registry pattern)
const ENGLISH_STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "shall", "should",
  "may", "might", "must", "can", "could", "to", "of", "in", "on", "at",
  "by", "for", "with", "from", "as", "it", "its", "this", "that", "these",
  "those", "and", "or", "but", "not", "no", "so", "if", "then", "than",
  "all", "also", "just", "me", "my", "we", "our", "you", "your", "he",
  "she", "they", "them", "their", "i", "am", "now", "please", "ok",
]);

// Chinese stop characters (single chars commonly skipped)
const CHINESE_STOP_CHARS = new Set([
  "的", "了", "在", "是", "我", "有", "和", "就", "不", "人", "都", "一",
  "上", "也", "很", "到", "说", "要", "去", "你", "会", "着", "没", "看",
  "好", "自", "这", "那", "什", "为", "啊", "把", "被", "让", "从", "与",
]);

/**
 * Extract significant words/phrases from a message.
 * Returns bigrams and meaningful single words.
 */
export function extractSignificantTokens(text: string): string[] {
  const lower = text.toLowerCase().trim();
  const tokens: string[] = [];

  const hasChinese = /[\u4e00-\u9fff]/.test(lower);

  if (hasChinese) {
    // Split on whitespace and extract runs of CJK chars
    const segments = lower.split(/[\s\p{P}]+/u).filter(Boolean);

    for (const seg of segments) {
      // Check if segment is CJK
      if (/[\u4e00-\u9fff]/.test(seg)) {
        // Extract individual CJK chars and check stop list
        const chars = [...seg.replace(/[^\u4e00-\u9fff]/g, "")];

        // Unigrams (length >= 2 sequences handled as words below)
        // Chinese "words" — runs of 2–6 CJK chars not starting with stop char
        const wordPattern = /[\u4e00-\u9fff]{2,6}/g;
        let match: RegExpExecArray | null;
        while ((match = wordPattern.exec(seg)) !== null) {
          if (!CHINESE_STOP_CHARS.has(match[0][0])) {
            tokens.push(match[0]);
          }
        }

        // Bigrams from CJK chars
        for (let i = 0; i < chars.length - 1; i++) {
          if (!CHINESE_STOP_CHARS.has(chars[i]) && !CHINESE_STOP_CHARS.has(chars[i + 1])) {
            tokens.push(chars[i] + chars[i + 1]);
          }
        }
      } else {
        // English segment
        if (seg.length >= 2 && !ENGLISH_STOP_WORDS.has(seg)) {
          tokens.push(seg);
        }
      }
    }

    // Cross-segment bigrams for English words adjacent in the original
    const englishWords = lower
      .split(/\s+/)
      .map((w) => w.replace(/[^\w]/g, ""))
      .filter((w) => w.length >= 2 && !ENGLISH_STOP_WORDS.has(w) && !/[\u4e00-\u9fff]/.test(w));

    for (let i = 0; i < englishWords.length - 1; i++) {
      tokens.push(`${englishWords[i]} ${englishWords[i + 1]}`);
    }
  } else {
    // Pure English: extract words and bigrams
    const words = lower
      .split(/\s+/)
      .map((w) => w.replace(/[^\w]/g, ""))
      .filter((w) => w.length >= 2 && !ENGLISH_STOP_WORDS.has(w));

    tokens.push(...words);

    for (let i = 0; i < words.length - 1; i++) {
      tokens.push(`${words[i]} ${words[i + 1]}`);
    }
  }

  // Deduplicate and limit to max 30
  const unique = [...new Set(tokens)];
  return unique.slice(0, 30);
}

/**
 * Compute TF-IDF-like significance score for each token.
 * A token is significant for delegation if it appears often in delegation
 * messages but rarely in light messages.
 *
 * score = (freq_in_delegation / total_delegation) / (freq_in_light / total_light + 0.01)
 */
export function computeTokenSignificance(observations: ObservationRecord[]): Map<string, {
  token: string;
  delegationFreq: number;
  trackedFreq: number;
  lightFreq: number;
  significance: number;
}> {
  const delegationObs = observations.filter((o) => (o.actualTier ?? o.predictedTier) === "delegation");
  const trackedObs = observations.filter((o) => (o.actualTier ?? o.predictedTier) === "tracked");
  const lightObs = observations.filter((o) => (o.actualTier ?? o.predictedTier) === "light");

  const delegationTotal = Math.max(delegationObs.length, 1);
  const lightTotal = Math.max(lightObs.length, 1);

  // Count token frequencies per group
  const delegationFreqs = new Map<string, number>();
  const trackedFreqs = new Map<string, number>();
  const lightFreqs = new Map<string, number>();

  for (const obs of delegationObs) {
    for (const tok of extractSignificantTokens(obs.messageText)) {
      delegationFreqs.set(tok, (delegationFreqs.get(tok) ?? 0) + 1);
    }
  }
  for (const obs of trackedObs) {
    for (const tok of extractSignificantTokens(obs.messageText)) {
      trackedFreqs.set(tok, (trackedFreqs.get(tok) ?? 0) + 1);
    }
  }
  for (const obs of lightObs) {
    for (const tok of extractSignificantTokens(obs.messageText)) {
      lightFreqs.set(tok, (lightFreqs.get(tok) ?? 0) + 1);
    }
  }

  // Collect all unique tokens
  const allTokens = new Set([
    ...delegationFreqs.keys(),
    ...trackedFreqs.keys(),
    ...lightFreqs.keys(),
  ]);

  const result = new Map<string, {
    token: string;
    delegationFreq: number;
    trackedFreq: number;
    lightFreq: number;
    significance: number;
  }>();

  for (const token of allTokens) {
    const dFreq = delegationFreqs.get(token) ?? 0;
    const tFreq = trackedFreqs.get(token) ?? 0;
    const lFreq = lightFreqs.get(token) ?? 0;

    // significance = (delegation_freq / delegation_total) / (light_freq / light_total + 0.01)
    const significance = (dFreq / delegationTotal) / ((lFreq / lightTotal) + 0.01);

    result.set(token, {
      token,
      delegationFreq: dFreq,
      trackedFreq: tFreq,
      lightFreq: lFreq,
      significance,
    });
  }

  return result;
}

/**
 * Discover new patterns from observation data.
 */
export function discoverPatterns(
  observations: ObservationRecord[],
  existingDelegationKeywords: string[],
  existingTrackedKeywords: string[],
  minOccurrences = 3,
  minConfidence = 0.6,
): DiscoveryResult {
  // Need enough data to be meaningful
  if (observations.length < 10) {
    return {
      newDelegationKeywords: [],
      newTrackedKeywords: [],
      thresholdSuggestions: {},
      sampleSize: observations.length,
      overallAccuracy: 0,
    };
  }

  const significanceMap = computeTokenSignificance(observations);
  const existingDelegationSet = new Set(existingDelegationKeywords.map((k) => k.toLowerCase()));
  const existingTrackedSet = new Set(existingTrackedKeywords.map((k) => k.toLowerCase()));

  const newDelegationKeywords: DiscoveredPattern[] = [];
  const newTrackedKeywords: DiscoveredPattern[] = [];

  for (const [token, stats] of significanceMap) {
    const totalFreq = stats.delegationFreq + stats.trackedFreq + stats.lightFreq;

    // Must appear enough times
    if (totalFreq < minOccurrences) continue;

    // Skip existing keywords
    if (existingDelegationSet.has(token) || existingTrackedSet.has(token)) continue;

    const delegationRate = totalFreq > 0 ? stats.delegationFreq / totalFreq : 0;
    const trackedRate = totalFreq > 0 ? stats.trackedFreq / totalFreq : 0;

    // Delegation candidates: significance > 2.0 (2x more in delegation than light)
    if (stats.significance > 2.0) {
      const confidence = delegationRate * Math.min(1, totalFreq / 5);
      if (confidence >= minConfidence) {
        // Collect evidence messages
        const evidence = observations
          .filter((o) => {
            const tier = o.actualTier ?? o.predictedTier;
            return tier === "delegation" && o.messageText.toLowerCase().includes(token);
          })
          .slice(0, 3)
          .map((o) => o.messageText.slice(0, 80));

        newDelegationKeywords.push({
          phrase: token,
          suggestedTier: "delegation",
          confidence,
          occurrences: totalFreq,
          delegationRate,
          trackedRate,
          evidence,
        });
      }
    } else if (trackedRate > delegationRate && trackedRate >= 0.5) {
      // Tracked candidates: appears more in tracked than delegation
      const confidence = trackedRate * Math.min(1, totalFreq / 5);
      if (confidence >= minConfidence) {
        const evidence = observations
          .filter((o) => {
            const tier = o.actualTier ?? o.predictedTier;
            return tier === "tracked" && o.messageText.toLowerCase().includes(token);
          })
          .slice(0, 3)
          .map((o) => o.messageText.slice(0, 80));

        newTrackedKeywords.push({
          phrase: token,
          suggestedTier: "tracked",
          confidence,
          occurrences: totalFreq,
          delegationRate,
          trackedRate,
          evidence,
        });
      }
    }
  }

  // Sort by confidence descending
  newDelegationKeywords.sort((a, b) => b.confidence - a.confidence);
  newTrackedKeywords.sort((a, b) => b.confidence - a.confidence);

  // Analyze structural correlations
  const structural = analyzeStructuralCorrelations(observations);

  // Suggest thresholds based on structural analysis
  const thresholdSuggestions: DiscoveryResult["thresholdSuggestions"] = {};
  if (structural.lengthCorrelation.avgTrackedLength > 0) {
    thresholdSuggestions.minLengthForTracked = Math.round(
      (structural.lengthCorrelation.avgLightLength + structural.lengthCorrelation.avgTrackedLength) / 2,
    );
  }
  if (structural.verbCorrelation.avgDelegationVerbs > 0) {
    thresholdSuggestions.minVerbsForDelegation = Math.ceil(structural.verbCorrelation.avgDelegationVerbs);
  }

  // Determine default tier suggestion based on distribution
  const delegationObs = observations.filter((o) => (o.actualTier ?? o.predictedTier) === "delegation");
  const lightObs = observations.filter((o) => (o.actualTier ?? o.predictedTier) === "light");
  const trackedObs = observations.filter((o) => (o.actualTier ?? o.predictedTier) === "tracked");

  if (trackedObs.length + delegationObs.length > lightObs.length * 3) {
    thresholdSuggestions.defaultTierShouldBe = "tracked";
  } else if (lightObs.length > trackedObs.length + delegationObs.length) {
    thresholdSuggestions.defaultTierShouldBe = "light";
  }

  // Compute overall accuracy from feedback
  const withFeedback = observations.filter(
    (o) => o.userFollowUp === "satisfied" || o.userFollowUp === "corrected_up" || o.userFollowUp === "corrected_down",
  );
  const correct = withFeedback.filter((o) => o.userFollowUp === "satisfied").length;
  const overallAccuracy = withFeedback.length > 0 ? correct / withFeedback.length : 0;

  return {
    newDelegationKeywords,
    newTrackedKeywords,
    thresholdSuggestions,
    sampleSize: observations.length,
    overallAccuracy,
  };
}

/**
 * Analyze structural features and their correlation with actual tier.
 */
export function analyzeStructuralCorrelations(observations: ObservationRecord[]): {
  lengthCorrelation: { avgLightLength: number; avgTrackedLength: number; avgDelegationLength: number };
  verbCorrelation: { avgLightVerbs: number; avgTrackedVerbs: number; avgDelegationVerbs: number };
  listCorrelation: { listDelegationRate: number; noListDelegationRate: number };
} {
  const byTier = {
    light: observations.filter((o) => (o.actualTier ?? o.predictedTier) === "light"),
    tracked: observations.filter((o) => (o.actualTier ?? o.predictedTier) === "tracked"),
    delegation: observations.filter((o) => (o.actualTier ?? o.predictedTier) === "delegation"),
  };

  const avg = (nums: number[]) => nums.length > 0 ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;

  const avgLightLength = avg(byTier.light.map((o) => o.messageLength));
  const avgTrackedLength = avg(byTier.tracked.map((o) => o.messageLength));
  const avgDelegationLength = avg(byTier.delegation.map((o) => o.messageLength));

  const avgLightVerbs = avg(byTier.light.map((o) => o.actionVerbCount));
  const avgTrackedVerbs = avg(byTier.tracked.map((o) => o.actionVerbCount));
  const avgDelegationVerbs = avg(byTier.delegation.map((o) => o.actionVerbCount));

  const withList = observations.filter((o) => o.hasNumberedList);
  const withoutList = observations.filter((o) => !o.hasNumberedList);

  const listDelegationRate = withList.length > 0
    ? withList.filter((o) => (o.actualTier ?? o.predictedTier) === "delegation").length / withList.length
    : 0;
  const noListDelegationRate = withoutList.length > 0
    ? withoutList.filter((o) => (o.actualTier ?? o.predictedTier) === "delegation").length / withoutList.length
    : 0;

  return {
    lengthCorrelation: { avgLightLength, avgTrackedLength, avgDelegationLength },
    verbCorrelation: { avgLightVerbs, avgTrackedVerbs, avgDelegationVerbs },
    listCorrelation: { listDelegationRate, noListDelegationRate },
  };
}

/**
 * Filter discoveries to only include patterns NOT already in existing keyword lists.
 */
export function filterNewPatterns(
  discoveries: DiscoveredPattern[],
  existingKeywords: string[],
): DiscoveredPattern[] {
  const existingSet = new Set(existingKeywords.map((k) => k.toLowerCase()));
  return discoveries.filter((d) => !existingSet.has(d.phrase.toLowerCase()));
}

/**
 * Format a discovery report as human-readable text.
 */
export function formatDiscoveryReport(result: DiscoveryResult): string {
  const lines: string[] = [
    `Pattern Discovery Report`,
    `========================`,
    `Sample size: ${result.sampleSize} observations`,
    `Overall accuracy: ${(result.overallAccuracy * 100).toFixed(1)}%`,
    "",
  ];

  if (result.newDelegationKeywords.length > 0) {
    lines.push(`New delegation keywords (${result.newDelegationKeywords.length}):`);
    for (const p of result.newDelegationKeywords.slice(0, 10)) {
      lines.push(
        `  "${p.phrase}" — confidence ${(p.confidence * 100).toFixed(0)}%, ` +
        `seen ${p.occurrences}x, delegation rate ${(p.delegationRate * 100).toFixed(0)}%`,
      );
    }
    lines.push("");
  } else {
    lines.push("No new delegation keywords discovered.");
    lines.push("");
  }

  if (result.newTrackedKeywords.length > 0) {
    lines.push(`New tracked keywords (${result.newTrackedKeywords.length}):`);
    for (const p of result.newTrackedKeywords.slice(0, 10)) {
      lines.push(
        `  "${p.phrase}" — confidence ${(p.confidence * 100).toFixed(0)}%, ` +
        `seen ${p.occurrences}x, tracked rate ${(p.trackedRate * 100).toFixed(0)}%`,
      );
    }
    lines.push("");
  } else {
    lines.push("No new tracked keywords discovered.");
    lines.push("");
  }

  const ts = result.thresholdSuggestions;
  const hasSuggestions =
    ts.minLengthForTracked !== undefined ||
    ts.minVerbsForDelegation !== undefined ||
    ts.defaultTierShouldBe !== undefined;

  if (hasSuggestions) {
    lines.push("Threshold suggestions:");
    if (ts.minLengthForTracked !== undefined) {
      lines.push(`  Min message length for tracked: ${ts.minLengthForTracked}`);
    }
    if (ts.minVerbsForDelegation !== undefined) {
      lines.push(`  Min action verbs for delegation: ${ts.minVerbsForDelegation}`);
    }
    if (ts.defaultTierShouldBe !== undefined) {
      lines.push(`  Default tier should be: ${ts.defaultTierShouldBe}`);
    }
  }

  return lines.join("\n");
}
