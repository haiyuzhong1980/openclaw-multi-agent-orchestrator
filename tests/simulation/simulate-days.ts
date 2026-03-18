/**
 * OMA 自进化 30 天模拟器
 *
 * 直接调用 OMA 的核心函数，模拟 5 种用户画像 × 30 天的交互，
 * 验证 Level 0→1→2→3 升级路径、模式发现、误判降级等完整流程。
 *
 * 用法:
 *   node --experimental-strip-types tests/simulation/simulate-days.ts [--days 30] [--messages-per-day 40]
 */

import { mkdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { inferExecutionComplexity } from "../../src/execution-policy.ts";
import {
  createObservation,
  appendObservation,
  updateObservationFeedback,
  flushBuffer,
  loadRecentObservations,
  computeStats,
} from "../../src/observation-engine.ts";
import {
  loadIntentRegistry,
  saveIntentRegistry,
  extractIntentPhrases,
  recordClassification,
  recordCorrection,
} from "../../src/intent-registry.ts";
import { loadUserKeywords, saveUserKeywords } from "../../src/user-keywords.ts";
import {
  createDefaultState,
  saveEnforcementState,
  loadEnforcementState,
} from "../../src/enforcement-ladder.ts";
import {
  runEvolutionCycle,
  appendEvolutionReport,
  formatEvolutionReport,
} from "../../src/evolution-cycle.ts";

import {
  PROFILES as BASE_PROFILES,
  sampleTier,
  sampleMessage,
  wouldCorrect,
  sampleCorrectionPhrase,
} from "./user-profiles.ts";
import { EXTENDED_PROFILES } from "./user-profiles-extended.ts";
import { loadCorpus, sampleFromCorpus } from "./llm-message-generator.ts";
import type { } from "./llm-message-generator.ts";

// Merge base + extended profiles
const PROFILES = [...BASE_PROFILES, ...EXTENDED_PROFILES];

// ─── CLI Args ──────────────────────────────────────────────────────────
const { values: args } = parseArgs({
  options: {
    days: { type: "string", default: "30" },
    "messages-per-day": { type: "string", default: "40" },
    "output-dir": { type: "string", default: "" },
    corpus: { type: "string", default: "" },
    verbose: { type: "boolean", default: false },
    seed: { type: "string", default: "" },
  },
});

const TOTAL_DAYS = parseInt(args.days!, 10);
const MESSAGES_PER_DAY = parseInt(args["messages-per-day"]!, 10);
const VERBOSE = args.verbose!;
const CORPUS_PATH = args.corpus || "";

// Load LLM-generated corpus if available
const corpus = CORPUS_PATH ? loadCorpus(CORPUS_PATH) : null;

// ─── Seeded RNG (optional, for reproducibility) ────────────────────────
let rngState = args.seed ? hashSeed(args.seed) : Math.random() * 0xffffffff;

function hashSeed(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function seededRandom(): number {
  // xorshift32
  rngState ^= rngState << 13;
  rngState ^= rngState >> 17;
  rngState ^= rngState << 5;
  return (rngState >>> 0) / 0xffffffff;
}

// Override Math.random if seed provided
if (args.seed) {
  Math.random = seededRandom;
}

// ─── Per-user isolated simulation state ───────────────────────────────
interface UserSimState {
  sharedRoot: string;
  profileId: string;
}

// ─── Day-level result tracking ────────────────────────────────────────
interface DayResult {
  day: number;
  profileId: string;
  messagesProcessed: number;
  correctPredictions: number;
  incorrectPredictions: number;
  correctionsIssued: number;
  enforcementLevel: number;
  accuracy: number;
  newKeywordsDiscovered: number;
  autoApplied: string[];
  pendingReview: string[];
}

interface SimulationSummary {
  totalDays: number;
  messagesPerDay: number;
  profileResults: Record<string, {
    finalLevel: number;
    peakLevel: number;
    finalAccuracy: number;
    totalCorrections: number;
    totalKeywordsLearned: number;
    levelHistory: Array<{ day: number; level: number }>;
    accuracyHistory: Array<{ day: number; accuracy: number }>;
  }>;
  dayResults: DayResult[];
}

// ─── Main Simulation ──────────────────────────────────────────────────

function setupUserState(baseDir: string, profileId: string): UserSimState {
  const sharedRoot = join(baseDir, `user-${profileId}`);
  if (existsSync(sharedRoot)) {
    rmSync(sharedRoot, { recursive: true });
  }
  mkdirSync(sharedRoot, { recursive: true });

  // Initialize enforcement state at Level 0
  saveEnforcementState(sharedRoot, createDefaultState());
  saveIntentRegistry(sharedRoot, {
    patterns: {},
    totalClassifications: 0,
    totalCorrections: 0,
    lastUpdated: new Date().toISOString(),
    version: 1,
  });
  saveUserKeywords(sharedRoot, { delegation: [], tracked: [], light: [], updatedAt: "" });

  return { sharedRoot, profileId };
}

/**
 * Global simulated clock — we override Date.now() so all OMA internals
 * (loadRecentObservations, pruneObservations, etc.) see consistent time.
 */
let simulatedNow = Date.now();
const _realDateNow = Date.now.bind(Date);
Date.now = () => simulatedNow;

function setSimulatedTime(ts: Date): void {
  simulatedNow = ts.getTime();
}

function simulateDay(
  userState: UserSimState,
  profile: typeof PROFILES[number],
  dayNumber: number,
  baseTimestamp: Date,
): DayResult {
  const { sharedRoot } = userState;

  let correctPredictions = 0;
  let incorrectPredictions = 0;
  let correctionsIssued = 0;

  // Load current state
  const intentRegistry = loadIntentRegistry(sharedRoot);
  const userKeywords = loadUserKeywords(sharedRoot);

  for (let msgIdx = 0; msgIdx < MESSAGES_PER_DAY; msgIdx++) {
    // 1. Generate user message (prefer LLM corpus, fallback to templates)
    const intendedTier = sampleTier(profile);
    const message = (corpus && sampleFromCorpus(corpus, profile.id, intendedTier))
      || sampleMessage(profile, intendedTier);

    // 2. OMA classifies it
    const predictedTier = inferExecutionComplexity(message, intentRegistry, userKeywords);

    // 3. Advance simulated clock (3 min per message)
    const msgTime = new Date(baseTimestamp.getTime() + msgIdx * 3 * 60 * 1000);
    setSimulatedTime(msgTime);

    const obs = createObservation({
      message,
      agent: "simulation",
      predictedTier,
    });
    appendObservation(sharedRoot, obs);

    // 4. Record classification in intent registry
    const phrases = extractIntentPhrases(message);
    recordClassification(intentRegistry, phrases, predictedTier);

    // 5. Simulate user feedback
    const isCorrect = predictedTier === intendedTier;

    if (isCorrect) {
      correctPredictions++;
      updateObservationFeedback(sharedRoot, obs.id, {
        userFollowUp: "satisfied",
        actualTier: intendedTier,
      });
    } else {
      incorrectPredictions++;

      if (wouldCorrect(profile, predictedTier, intendedTier)) {
        correctionsIssued++;

        const direction = intendedTier === "delegation" ||
          (intendedTier === "tracked" && predictedTier === "light")
          ? "up" as const
          : "down" as const;

        updateObservationFeedback(sharedRoot, obs.id, {
          userFollowUp: direction === "up" ? "corrected_up" : "corrected_down",
          actualTier: intendedTier,
        });

        recordCorrection(intentRegistry, phrases, predictedTier, intendedTier);
      } else {
        updateObservationFeedback(sharedRoot, obs.id, {
          userFollowUp: "continued",
        });
      }
    }
  }

  // End of day: set clock to end-of-day
  setSimulatedTime(new Date(baseTimestamp.getTime() + 23 * 60 * 60 * 1000));

  // Flush buffer to disk
  flushBuffer(sharedRoot);

  // Save updated intent registry
  saveIntentRegistry(sharedRoot, intentRegistry);

  // 6. End of day: run evolution cycle
  const enforcementState = loadEnforcementState(sharedRoot);
  const currentUserKeywords = loadUserKeywords(sharedRoot);

  // loadRecentObservations now works correctly because Date.now() returns simulated time
  const allObs = loadRecentObservations(sharedRoot, 24 * 7); // last 7 simulated days

  // Patch enforcement state observation count
  enforcementState.observationCount += MESSAGES_PER_DAY;
  enforcementState.correctionCount += correctionsIssued;

  // Compute accuracy for consecutive-day tracking
  const stats = computeStats(allObs);
  if (stats.accuracy >= 0.85) {
    enforcementState.consecutiveAccurateDays++;
  } else {
    enforcementState.consecutiveAccurateDays = 0;
  }

  const evolutionReport = runEvolutionCycle({
    sharedRoot,
    intentRegistry,
    userKeywords: currentUserKeywords,
    enforcementState,
    existingDelegationKeywords: [],
    existingTrackedKeywords: [],
  });

  // Save enforcement state
  saveEnforcementState(sharedRoot, enforcementState);
  saveUserKeywords(sharedRoot, currentUserKeywords);
  appendEvolutionReport(sharedRoot, evolutionReport);

  if (VERBOSE) {
    console.log(`  Day ${dayNumber} [${profile.id}]: ` +
      `correct=${correctPredictions}/${MESSAGES_PER_DAY} ` +
      `corrections=${correctionsIssued} ` +
      `level=${enforcementState.currentLevel} ` +
      `accuracy=${(stats.accuracy * 100).toFixed(1)}% ` +
      `autoApplied=${evolutionReport.autoApplied.length} ` +
      `pending=${evolutionReport.pendingReview.length}`);
  }

  return {
    day: dayNumber,
    profileId: profile.id,
    messagesProcessed: MESSAGES_PER_DAY,
    correctPredictions,
    incorrectPredictions,
    correctionsIssued,
    enforcementLevel: enforcementState.currentLevel,
    accuracy: stats.accuracy,
    newKeywordsDiscovered: evolutionReport.newDelegationKeywords.length + evolutionReport.newTrackedKeywords.length,
    autoApplied: evolutionReport.autoApplied,
    pendingReview: evolutionReport.pendingReview,
  };
}

function runSimulation(): SimulationSummary {
  const baseDir = args["output-dir"] || join(
    process.env.HOME ?? "",
    ".openclaw/shared-memory/simulation-runs",
    `run-${Date.now()}`,
  );
  mkdirSync(baseDir, { recursive: true });

  console.log(`\n🧪 OMA 自进化模拟器`);
  console.log(`   天数: ${TOTAL_DAYS}`);
  console.log(`   每日消息数: ${MESSAGES_PER_DAY}`);
  console.log(`   用户画像: ${PROFILES.length} 个`);
  console.log(`   消息来源: ${corpus ? "LLM 语料库 (" + CORPUS_PATH + ")" : "模板"}`);
  console.log(`   总消息量: ${TOTAL_DAYS * MESSAGES_PER_DAY * PROFILES.length}`);
  console.log(`   输出目录: ${baseDir}\n`);

  // Initialize per-user state
  const userStates: Record<string, UserSimState> = {};
  for (const profile of PROFILES) {
    userStates[profile.id] = setupUserState(baseDir, profile.id);
  }

  const allDayResults: DayResult[] = [];
  const profileTracking: Record<string, {
    levelHistory: Array<{ day: number; level: number }>;
    accuracyHistory: Array<{ day: number; accuracy: number }>;
    peakLevel: number;
    totalCorrections: number;
  }> = {};

  for (const profile of PROFILES) {
    profileTracking[profile.id] = {
      levelHistory: [],
      accuracyHistory: [],
      peakLevel: 0,
      totalCorrections: 0,
    };
  }

  // Simulate day by day
  for (let day = 1; day <= TOTAL_DAYS; day++) {
    if (!VERBOSE) {
      process.stdout.write(`\r  Day ${day}/${TOTAL_DAYS}...`);
    } else {
      console.log(`\n--- Day ${day} ---`);
    }

    // Use timestamps relative to "now" so time-window filters work correctly.
    // Day 1 = (TOTAL_DAYS-1) days ago, last day = today.
    const daysAgo = TOTAL_DAYS - day;
    const baseTimestamp = new Date(_realDateNow() - daysAgo * 24 * 60 * 60 * 1000);
    baseTimestamp.setHours(9, 0, 0, 0);

    for (const profile of PROFILES) {
      const result = simulateDay(
        userStates[profile.id],
        profile,
        day,
        baseTimestamp,
      );

      allDayResults.push(result);

      const tracking = profileTracking[profile.id];
      tracking.levelHistory.push({ day, level: result.enforcementLevel });
      tracking.accuracyHistory.push({ day, accuracy: result.accuracy });
      tracking.peakLevel = Math.max(tracking.peakLevel, result.enforcementLevel);
      tracking.totalCorrections += result.correctionsIssued;
    }
  }

  if (!VERBOSE) {
    process.stdout.write("\r");
  }

  // Build summary
  const profileResults: SimulationSummary["profileResults"] = {};
  for (const profile of PROFILES) {
    const tracking = profileTracking[profile.id];
    const finalDayResult = allDayResults.filter((r) => r.profileId === profile.id).pop()!;

    // Count total keywords learned
    const userKw = loadUserKeywords(userStates[profile.id].sharedRoot);
    const totalKeywordsLearned = userKw.delegation.length + userKw.tracked.length + userKw.light.length;

    profileResults[profile.id] = {
      finalLevel: finalDayResult.enforcementLevel,
      peakLevel: tracking.peakLevel,
      finalAccuracy: finalDayResult.accuracy,
      totalCorrections: tracking.totalCorrections,
      totalKeywordsLearned,
      levelHistory: tracking.levelHistory,
      accuracyHistory: tracking.accuracyHistory,
    };
  }

  return {
    totalDays: TOTAL_DAYS,
    messagesPerDay: MESSAGES_PER_DAY,
    profileResults,
    dayResults: allDayResults,
  };
}

// ─── Report Formatting ────────────────────────────────────────────────

function printReport(summary: SimulationSummary): void {
  console.log(`\n${"=".repeat(70)}`);
  console.log(`  OMA 自进化模拟报告`);
  console.log(`  ${TOTAL_DAYS} 天 × ${MESSAGES_PER_DAY} 消息/天 × ${PROFILES.length} 用户画像`);
  console.log(`${"=".repeat(70)}\n`);

  for (const profile of PROFILES) {
    const result = summary.profileResults[profile.id];
    console.log(`▸ ${profile.name} (${profile.id})`);
    console.log(`  ${profile.description}`);
    console.log(`  Tier 分布: light=${(profile.tierDistribution[0] * 100).toFixed(0)}% ` +
      `tracked=${(profile.tierDistribution[1] * 100).toFixed(0)}% ` +
      `delegation=${(profile.tierDistribution[2] * 100).toFixed(0)}%`);
    console.log(`  纠正倾向: ${(profile.correctionRate * 100).toFixed(0)}%`);
    console.log();
    console.log(`  最终 Enforcement Level: ${result.finalLevel}`);
    console.log(`  峰值 Level:             ${result.peakLevel}`);
    console.log(`  最终准确率:             ${(result.finalAccuracy * 100).toFixed(1)}%`);
    console.log(`  总纠正次数:             ${result.totalCorrections}`);
    console.log(`  学到的关键词数:         ${result.totalKeywordsLearned}`);

    // Level progression
    const levelChanges = result.levelHistory.filter((h, i) =>
      i === 0 || h.level !== result.levelHistory[i - 1].level,
    );
    if (levelChanges.length > 1) {
      console.log(`  Level 变迁: ${levelChanges.map((h) => `Day${h.day}→L${h.level}`).join(" → ")}`);
    }

    // Accuracy trend (first day, mid, last day)
    const accHistory = result.accuracyHistory;
    if (accHistory.length >= 3) {
      const first = accHistory[0];
      const mid = accHistory[Math.floor(accHistory.length / 2)];
      const last = accHistory[accHistory.length - 1];
      console.log(`  准确率趋势: Day${first.day}=${(first.accuracy * 100).toFixed(1)}% → ` +
        `Day${mid.day}=${(mid.accuracy * 100).toFixed(1)}% → ` +
        `Day${last.day}=${(last.accuracy * 100).toFixed(1)}%`);
    }

    console.log();
  }

  // Overall stats
  const allResults = summary.dayResults;
  const totalCorrect = allResults.reduce((s, r) => s + r.correctPredictions, 0);
  const totalMessages = allResults.reduce((s, r) => s + r.messagesProcessed, 0);
  const overallAccuracy = totalMessages > 0 ? totalCorrect / totalMessages : 0;

  console.log(`${"─".repeat(70)}`);
  console.log(`  总计: ${totalMessages} 条消息, 正确预测 ${totalCorrect} 条 (${(overallAccuracy * 100).toFixed(1)}%)`);
  console.log(`${"─".repeat(70)}\n`);

  // Verdict
  console.log(`验证结论:`);

  // Check 1: Level upgrade path
  const anyReachedL2 = Object.values(summary.profileResults).some((r) => r.peakLevel >= 2);
  const anyReachedL3 = Object.values(summary.profileResults).some((r) => r.peakLevel >= 3);
  console.log(`  ${anyReachedL2 ? "✅" : "❌"} Level 0→1→2 升级路径走通`);
  console.log(`  ${anyReachedL3 ? "✅" : "⚠️"} Level 2→3 升级路径${anyReachedL3 ? "走通" : "未触及（可能需要更多天数或更高准确率）"}`);

  // Check 2: Pattern discovery
  const anyLearnedKeywords = Object.values(summary.profileResults).some((r) => r.totalKeywordsLearned > 0);
  console.log(`  ${anyLearnedKeywords ? "✅" : "❌"} 模式发现能提取有意义的关键词`);

  // Check 3: Different profiles converge to different keywords
  // (would need to compare keyword sets — simplified check)
  console.log(`  ℹ️  不同画像的关键词库需人工检查（见输出目录）`);

  // Check 4: Accuracy improvement
  const anyImproved = Object.values(summary.profileResults).some((r) => {
    const first = r.accuracyHistory[0]?.accuracy ?? 0;
    const last = r.accuracyHistory[r.accuracyHistory.length - 1]?.accuracy ?? 0;
    return last > first + 0.05; // at least 5% improvement
  });
  console.log(`  ${anyImproved ? "✅" : "⚠️"} 30 天后准确率${anyImproved ? "有提升" : "提升不明显"}`);
}

// ─── Run ───────────────────────────────────────────────────────────────
const summary = runSimulation();
printReport(summary);

// Save JSON report
import { writeFileSync } from "node:fs";
const reportPath = join(
  args["output-dir"] || join(process.env.HOME ?? "", ".openclaw/shared-memory/simulation-runs", `run-${Date.now()}`),
  "simulation-report.json",
);
try {
  mkdirSync(join(reportPath, ".."), { recursive: true });
  writeFileSync(reportPath, JSON.stringify(summary, null, 2), "utf-8");
  console.log(`\n📊 详细报告已保存: ${reportPath}`);
} catch {
  // output dir may not exist if using default
}
