import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ACTION_VERBS, ESCALATION_SIGNALS, DE_ESCALATION_SIGNALS } from "./constants.ts";

export interface ObservationRecord {
  id: string;                    // unique ID (timestamp + random)
  timestamp: string;             // ISO8601
  agent: string;                 // which agent received the message

  // User message features
  messageText: string;           // first 200 chars
  messageLength: number;
  language: "zh" | "en" | "mixed";
  hasNumberedList: boolean;
  actionVerbCount: number;

  // OMA classification
  predictedTier: "light" | "tracked" | "delegation";

  // Outcome (filled asynchronously)
  toolsCalled: string[];
  didSpawnSubagent: boolean;
  spawnCount: number;

  // User feedback (filled on next message)
  userFollowUp: "satisfied" | "corrected_up" | "corrected_down" | "continued" | null;
  actualTier: "light" | "tracked" | "delegation" | null;
}

export interface ObservationStats {
  totalObservations: number;
  last24h: number;
  last7d: number;
  tierDistribution: { light: number; tracked: number; delegation: number };
  accuracy: number;              // % where predicted == actual (from corrections)
  correctionRate: number;        // % of messages that got corrected
  topMispredictions: Array<{ text: string; predicted: string; actual: string }>;
}

const OBS_FILE = "observation-log.jsonl";
const MAX_AGE_DAYS = 30;

// ACTION_VERBS, ESCALATION_SIGNALS, DE_ESCALATION_SIGNALS imported from constants.ts

const SATISFACTION_SIGNALS: RegExp[] = [
  /^(ok|好|好的|嗯|可以|行|收到|明白|对|是的|nice|great|perfect|thanks|谢谢)[\s!！.。]*$/i,
];

// In-memory buffer for recent observations
let recentBuffer: ObservationRecord[] = [];
let bufferDirty = false;

/**
 * Generate a unique observation ID.
 */
export function generateObservationId(): string {
  const ts = Date.now();
  const rand = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, "0");
  return `obs-${ts}-${rand}`;
}

/**
 * Detect language of a message.
 */
export function detectLanguage(text: string): "zh" | "en" | "mixed" {
  if (!text) return "en";
  const cjkCount = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f]/g) ?? []).length;
  const latinCount = (text.match(/[a-zA-Z]/g) ?? []).length;
  const total = cjkCount + latinCount;
  if (total === 0) return "en";
  const cjkRatio = cjkCount / total;
  const latinRatio = latinCount / total;
  if (cjkRatio > 0.7) return "zh";
  if (latinRatio > 0.7) return "en";
  return "mixed";
}

/**
 * Count action verbs in a message.
 */
export function countActionVerbs(text: string): number {
  const lower = text.toLowerCase();
  const matched = ACTION_VERBS.filter((v) => lower.includes(v.toLowerCase()));
  return new Set(matched).size;
}

/**
 * Check if message contains a numbered list.
 */
export function hasNumberedList(text: string): boolean {
  const matches = text.match(/(?:^|\n)\s*[0-9]+[.、)）]/gm);
  return matches !== null && matches.length >= 3;
}

/**
 * Create a new observation record from a user message.
 */
export function createObservation(params: {
  message: string;
  agent: string;
  predictedTier: "light" | "tracked" | "delegation";
}): ObservationRecord {
  const { message, agent, predictedTier } = params;
  return {
    id: generateObservationId(),
    timestamp: new Date(Date.now()).toISOString(),
    agent,
    messageText: message.slice(0, 200),
    messageLength: message.length,
    language: detectLanguage(message),
    hasNumberedList: hasNumberedList(message),
    actionVerbCount: countActionVerbs(message),
    predictedTier,
    toolsCalled: [],
    didSpawnSubagent: false,
    spawnCount: 0,
    userFollowUp: null,
    actualTier: null,
  };
}

/**
 * Append an observation to the log file (JSONL format).
 */
export function appendObservation(sharedRoot: string, record: ObservationRecord): void {
  const filePath = join(sharedRoot, OBS_FILE);
  if (!existsSync(sharedRoot)) {
    mkdirSync(sharedRoot, { recursive: true });
  }
  appendFileSync(filePath, JSON.stringify(record) + "\n", "utf-8");

  // Keep a copy in the buffer for fast in-memory updates
  recentBuffer.push(record);
  if (recentBuffer.length > 20) {
    recentBuffer = recentBuffer.slice(recentBuffer.length - 20);
  }
}

/**
 * Get a buffered observation by ID.
 */
export function getBufferedObservation(id: string): ObservationRecord | undefined {
  return recentBuffer.find((r) => r.id === id);
}

/**
 * Flush the in-memory buffer back to disk by rewriting matching lines.
 * Reads the JSONL file, replaces lines whose IDs are in the buffer, writes back.
 */
export function flushBuffer(sharedRoot: string): void {
  if (!bufferDirty) return;
  const filePath = join(sharedRoot, OBS_FILE);
  if (!existsSync(filePath)) return;

  const bufferMap = new Map<string, ObservationRecord>();
  for (const rec of recentBuffer) {
    bufferMap.set(rec.id, rec);
  }

  const raw = readFileSync(filePath, "utf-8");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  const updated = lines.map((line) => {
    try {
      const rec = JSON.parse(line) as ObservationRecord;
      if (bufferMap.has(rec.id)) {
        return JSON.stringify(bufferMap.get(rec.id));
      }
      return line;
    } catch {
      return line;
    }
  });

  writeFileSync(filePath, updated.join("\n") + "\n", "utf-8");
  bufferDirty = false;
}

/**
 * Update the most recent observation's outcome (tools called, spawn status).
 * Uses Option A: in-memory buffer with periodic flush.
 */
export function updateObservationOutcome(
  sharedRoot: string,
  observationId: string,
  outcome: {
    toolsCalled?: string[];
    didSpawnSubagent?: boolean;
    spawnCount?: number;
  },
): void {
  const rec = recentBuffer.find((r) => r.id === observationId);
  if (!rec) return;

  if (outcome.toolsCalled !== undefined) {
    // Merge tool calls (accumulate across multiple after_tool_call events)
    const merged = new Set([...rec.toolsCalled, ...outcome.toolsCalled]);
    rec.toolsCalled = [...merged];
  }
  if (outcome.didSpawnSubagent !== undefined && outcome.didSpawnSubagent) {
    rec.didSpawnSubagent = true;
  }
  if (outcome.spawnCount !== undefined) {
    rec.spawnCount = rec.spawnCount + outcome.spawnCount;
  }
  bufferDirty = true;
}

/**
 * Update the most recent observation's user feedback.
 */
export function updateObservationFeedback(
  sharedRoot: string,
  observationId: string,
  feedback: {
    userFollowUp: "satisfied" | "corrected_up" | "corrected_down" | "continued";
    actualTier?: "light" | "tracked" | "delegation";
  },
): void {
  const rec = recentBuffer.find((r) => r.id === observationId);
  if (!rec) {
    // Not in buffer — fall back to disk scan of last 50 lines
    const filePath = join(sharedRoot, OBS_FILE);
    if (!existsSync(filePath)) return;
    const raw = readFileSync(filePath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    const last50 = lines.slice(-50);
    const idx = last50.findIndex((l) => {
      try {
        return (JSON.parse(l) as ObservationRecord).id === observationId;
      } catch {
        return false;
      }
    });
    if (idx < 0) return;
    const target = JSON.parse(last50[idx]) as ObservationRecord;
    target.userFollowUp = feedback.userFollowUp;
    if (feedback.actualTier !== undefined) target.actualTier = feedback.actualTier;
    last50[idx] = JSON.stringify(target);
    const beginning = lines.slice(0, lines.length - last50.length);
    writeFileSync(filePath, [...beginning, ...last50].join("\n") + "\n", "utf-8");
    return;
  }

  rec.userFollowUp = feedback.userFollowUp;
  if (feedback.actualTier !== undefined) {
    rec.actualTier = feedback.actualTier;
  }
  bufferDirty = true;
}

/**
 * Load recent observations (last N hours).
 */
export function loadRecentObservations(sharedRoot: string, hours = 24): ObservationRecord[] {
  const filePath = join(sharedRoot, OBS_FILE);
  if (!existsSync(filePath)) return [];

  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
  const raw = readFileSync(filePath, "utf-8");
  const records: ObservationRecord[] = [];

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const rec = JSON.parse(trimmed) as ObservationRecord;
      if (new Date(rec.timestamp) >= cutoff) {
        records.push(rec);
      }
    } catch {
      // skip malformed lines
    }
  }

  return records;
}

/**
 * Compute observation statistics.
 */
export function computeStats(observations: ObservationRecord[]): ObservationStats {
  const now = Date.now();
  const ms24h = 24 * 60 * 60 * 1000;
  const ms7d = 7 * 24 * 60 * 60 * 1000;

  const tierDist = { light: 0, tracked: 0, delegation: 0 };
  let correctCount = 0;
  let correctedCount = 0;
  const mispredictions: Array<{ text: string; predicted: string; actual: string }> = [];

  let last24hCount = 0;
  let last7dCount = 0;

  for (const obs of observations) {
    const age = now - new Date(obs.timestamp).getTime();
    if (age <= ms24h) last24hCount++;
    if (age <= ms7d) last7dCount++;

    tierDist[obs.predictedTier]++;

    if (obs.userFollowUp === "corrected_up" || obs.userFollowUp === "corrected_down") {
      correctedCount++;
      if (obs.actualTier && obs.actualTier !== obs.predictedTier) {
        mispredictions.push({
          text: obs.messageText.slice(0, 60),
          predicted: obs.predictedTier,
          actual: obs.actualTier,
        });
      }
    } else if (obs.userFollowUp === "satisfied") {
      correctCount++;
    }
  }

  const feedbackCount = correctedCount + correctCount;
  const accuracy = feedbackCount > 0 ? correctCount / feedbackCount : 0;
  const correctionRate = observations.length > 0 ? correctedCount / observations.length : 0;

  return {
    totalObservations: observations.length,
    last24h: last24hCount,
    last7d: last7dCount,
    tierDistribution: tierDist,
    accuracy,
    correctionRate,
    topMispredictions: mispredictions.slice(0, 5),
  };
}

/**
 * Prune old observations (> MAX_AGE_DAYS).
 * Returns the number of pruned records.
 */
export function pruneObservations(sharedRoot: string, maxAgeDays = MAX_AGE_DAYS): number {
  const filePath = join(sharedRoot, OBS_FILE);
  if (!existsSync(filePath)) return 0;

  const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000);
  const raw = readFileSync(filePath, "utf-8");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);

  let pruned = 0;
  const kept: string[] = [];

  for (const line of lines) {
    try {
      const rec = JSON.parse(line) as ObservationRecord;
      if (new Date(rec.timestamp) < cutoff) {
        pruned++;
      } else {
        kept.push(line);
      }
    } catch {
      kept.push(line); // keep malformed lines to avoid data loss
    }
  }

  if (pruned > 0) {
    writeFileSync(filePath, kept.join("\n") + (kept.length > 0 ? "\n" : ""), "utf-8");
  }

  return pruned;
}

/**
 * Detect if a new user message is a correction of the previous prediction.
 */
export function detectFeedbackSignal(
  currentMessage: string,
  previousPrediction: "light" | "tracked" | "delegation",
): { type: "satisfied" | "corrected_up" | "corrected_down" | "continued"; actualTier?: "light" | "tracked" | "delegation" } {
  const lower = currentMessage.toLowerCase().trim();

  // Check satisfaction signals first (short positive replies)
  if (SATISFACTION_SIGNALS.some((r) => r.test(lower))) {
    return { type: "satisfied" };
  }

  // Check escalation signals (user wants more agents)
  if (ESCALATION_SIGNALS.some((r) => r.test(lower))) {
    const actualTier: "light" | "tracked" | "delegation" = "delegation";
    return { type: "corrected_up", actualTier };
  }

  // Check de-escalation signals (user wants less complexity)
  if (DE_ESCALATION_SIGNALS.some((r) => r.test(lower))) {
    const actualTier: "light" | "tracked" | "delegation" = "light";
    return { type: "corrected_down", actualTier };
  }

  return { type: "continued" };
}
