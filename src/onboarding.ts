import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { EnforcementState } from "./enforcement-ladder.ts";
import type { UserKeywords } from "./user-keywords.ts";
import { addUserKeyword } from "./user-keywords.ts";
import { applyLevelChange } from "./enforcement-ladder.ts";
import { loggers } from "./errors.ts";

export interface OnboardingState {
  completed: boolean;
  completedAt?: string;
  userProfile: {
    workType?: "development" | "research" | "operations" | "management" | "mixed";
    aggressiveness?: "conservative" | "moderate" | "aggressive";
    customPhrases: string[];
    language?: "zh" | "en" | "mixed";
  };
}

const ONBOARDING_FILE = "onboarding-state.json";

export function loadOnboardingState(sharedRoot: string): OnboardingState {
  const filePath = join(sharedRoot, ONBOARDING_FILE);
  if (!existsSync(filePath)) {
    return createDefaultOnboardingState();
  }
  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as OnboardingState;
    if (typeof parsed.completed !== "boolean") {
      return createDefaultOnboardingState();
    }
    // Ensure userProfile always has customPhrases array
    if (!parsed.userProfile) {
      parsed.userProfile = { customPhrases: [] };
    } else if (!Array.isArray(parsed.userProfile.customPhrases)) {
      parsed.userProfile.customPhrases = [];
    }
    return parsed;
  } catch (error) {
    loggers.onboarding.error(`Failed to load onboarding state`, error, { path: filePath });
    return createDefaultOnboardingState();
  }
}

function createDefaultOnboardingState(): OnboardingState {
  return {
    completed: false,
    userProfile: {
      customPhrases: [],
    },
  };
}

export function saveOnboardingState(sharedRoot: string, state: OnboardingState): void {
  if (!existsSync(sharedRoot)) {
    mkdirSync(sharedRoot, { recursive: true });
  }
  const filePath = join(sharedRoot, ONBOARDING_FILE);
  writeFileSync(filePath, JSON.stringify(state, null, 2), "utf-8");
}

/**
 * Check if onboarding is needed (first time or reset).
 */
export function needsOnboarding(state: OnboardingState): boolean {
  return !state.completed;
}

/**
 * Generate the welcome message for new users.
 */
export function generateWelcomeMessage(state: OnboardingState): string {
  void state; // state reserved for future personalisation
  return [
    "👋 **欢迎使用 OpenClaw Multi-Agent Orchestrator (OMA)!**",
    "",
    "我会自动学习你的使用习惯，帮你高效调度多 agent 协作。",
    "",
    "为了更快适应你，请告诉我：",
    "",
    "**1. 你主要做什么类型的工作？**",
    "   a) 软件开发 (development)",
    "   b) 调研分析 (research)",
    "   c) 运维部署 (operations)",
    "   d) 项目管理 (management)",
    "   e) 以上都有 (mixed)",
    "",
    "**2. 你希望 OMA 多主动帮你调度 agent 吗？**",
    "   a) 保守 — 只在我明确说要派工时才触发",
    "   b) 适中 — 复杂任务自动建议派工",
    "   c) 激进 — 大部分任务都自动安排多 agent",
    "",
    '**3. 你有什么口头禅/常用语来表达"帮我做复杂任务"？**',
    "   (直接输入，用逗号分隔，或跳过)",
    "",
    "回复格式: `1a 2c 3:全力推进,出报告` 或 `/mao-setup` 随时重新设置",
  ].join("\n");
}

/**
 * Process user's onboarding response and configure OMA accordingly.
 */
export function processOnboardingResponse(params: {
  response: string;
  onboardingState: OnboardingState;
  userKeywords: UserKeywords;
  enforcementState: EnforcementState;
}): {
  configured: boolean;
  initialLevel: number;
  keywordsAdded: string[];
  message: string;
} {
  const { response, onboardingState, userKeywords, enforcementState } = params;
  const trimmed = response.trim();

  // Parse work type from "1x"
  const workMatch = /1([a-e])/i.exec(trimmed);
  const workTypeMap: Record<string, OnboardingState["userProfile"]["workType"]> = {
    a: "development",
    b: "research",
    c: "operations",
    d: "management",
    e: "mixed",
  };
  if (workMatch) {
    onboardingState.userProfile.workType = workTypeMap[workMatch[1].toLowerCase()];
  }

  // Parse aggressiveness from "2x"
  const aggrMatch = /2([a-c])/i.exec(trimmed);
  const aggrMap: Record<string, OnboardingState["userProfile"]["aggressiveness"]> = {
    a: "conservative",
    b: "moderate",
    c: "aggressive",
  };
  let initialLevel = enforcementState.currentLevel;
  if (aggrMatch) {
    const aggressiveness = aggrMap[aggrMatch[1].toLowerCase()];
    onboardingState.userProfile.aggressiveness = aggressiveness;
    if (aggressiveness === "conservative") {
      initialLevel = 0;
    } else if (aggressiveness === "moderate") {
      initialLevel = 1;
    } else if (aggressiveness === "aggressive") {
      initialLevel = 2;
    }
    if (initialLevel !== enforcementState.currentLevel) {
      applyLevelChange(
        enforcementState,
        initialLevel as 0 | 1 | 2 | 3,
        `onboarding: aggressiveness=${aggressiveness}`,
      );
    }
  }

  // Parse custom phrases from "3:phrase1,phrase2"
  const keywordsAdded: string[] = [];
  const phrasesMatch = /3:([^\n]+)/i.exec(trimmed);
  if (phrasesMatch) {
    const raw = phrasesMatch[1].trim();
    const phrases = raw
      .split(/[,，]/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    for (const phrase of phrases) {
      addUserKeyword(userKeywords, "delegation", phrase);
      onboardingState.userProfile.customPhrases.push(phrase);
      keywordsAdded.push(phrase);
    }
  }

  onboardingState.completed = true;
  onboardingState.completedAt = new Date().toISOString();

  const messageParts = [
    "✅ **OMA 配置完成！**",
    "",
  ];
  if (onboardingState.userProfile.workType) {
    messageParts.push(`工作类型: ${onboardingState.userProfile.workType}`);
  }
  if (onboardingState.userProfile.aggressiveness) {
    messageParts.push(`调度激进度: ${onboardingState.userProfile.aggressiveness} → 从 Level ${initialLevel} 开始`);
  }
  if (keywordsAdded.length > 0) {
    messageParts.push(`已添加委派关键词: ${keywordsAdded.join(", ")}`);
  }
  messageParts.push("", "随时使用 `/mao-setup` 重新配置。");

  return {
    configured: true,
    initialLevel,
    keywordsAdded,
    message: messageParts.join("\n"),
  };
}
