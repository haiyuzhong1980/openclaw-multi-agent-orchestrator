/**
 * LLM 驱动的消息生成器 — 用 LongCat API 为每种用户画像生成多样化的真实消息
 *
 * 两种模式:
 *   1. pre-generate: 预生成消息语料库到 JSON 文件（推荐，避免模拟时频繁调 API）
 *   2. on-demand: 模拟器运行时实时生成（慢，但消息最多样）
 */

import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { UserProfile } from "./user-profiles.ts";
import { PROFILES as BASE_PROFILES } from "./user-profiles.ts";
import { EXTENDED_PROFILES } from "./user-profiles-extended.ts";

const PROFILES = [...BASE_PROFILES, ...EXTENDED_PROFILES];

const LONGCAT_BASE_URL = "https://api.longcat.chat/openai/v1/chat/completions";
const LONGCAT_API_KEY = "ak_2oU1jK6aK0Ja9w46fZ9Se8By5LQ9X";
const LONGCAT_MODEL = "LongCat-Flash-Lite";

interface GeneratedCorpus {
  generatedAt: string;
  model: string;
  profiles: Record<string, {
    light: string[];
    tracked: string[];
    delegation: string[];
  }>;
}

/**
 * 调用 LongCat API
 */
async function callLongCat(prompt: string, maxTokens = 2000): Promise<string> {
  const res = await fetch(LONGCAT_BASE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${LONGCAT_API_KEY}`,
    },
    body: JSON.stringify({
      model: LONGCAT_MODEL,
      messages: [{ role: "user", content: prompt }],
      max_tokens: maxTokens,
      temperature: 0.9,
    }),
  });

  if (!res.ok) {
    throw new Error(`LongCat API error: ${res.status} ${await res.text()}`);
  }

  const data = await res.json() as {
    choices: Array<{ message: { content?: string } }>;
  };

  return data.choices[0]?.message?.content ?? "";
}

/**
 * 解析 LLM 输出为消息列表 — 每行一条消息
 */
function parseMessages(raw: string): string[] {
  return raw
    .split("\n")
    .map((line) => line.replace(/^\d+[.、)）]\s*/, "").trim()) // 去掉编号前缀
    .filter((line) => line.length > 0 && line.length < 500)     // 过滤空行和异常长行
    .filter((line) => !line.startsWith("#") && !line.startsWith("---")); // 过滤标题/分隔符
}

/**
 * 为一个画像的一种 tier 生成消息
 */
async function generateMessagesForTier(
  profile: UserProfile,
  tier: "light" | "tracked" | "delegation",
  count: number,
): Promise<string[]> {
  const tierDescriptions = {
    light: '简单的闲聊、确认、回复（如"好的"、"收到"、"嗯"、"ok"等一两个字的回复，或打招呼）',
    tracked: '中等复杂度的工作请求（如修 bug、配置服务器、写脚本、查日志等单一任务）',
    delegation: '复杂的多步骤/多 agent 协作任务（如全面审查、组建团队、多维度分析、里程碑推进等）',
  };

  const prompt = `你是一个模拟器，需要生成真实的用户消息用于测试 AI 助手的意图分类系统。

用户画像: ${profile.name}
画像描述: ${profile.description}

请生成 ${count} 条属于「${tier}」级别的用户消息。

${tier} 级别定义: ${tierDescriptions[tier]}

要求:
- 每行一条消息，不要编号
- 消息要自然真实，像真人会说的话
- 中文为主，可以混合少量英文技术术语
- 消息长度要有变化（${tier === "light" ? "1-10字" : tier === "tracked" ? "10-80字" : "30-200字"}）
- 不要重复，每条都有独特的具体内容
- 不要加引号或其他标记

直接输出消息，每行一条:`;

  const raw = await callLongCat(prompt);
  const messages = parseMessages(raw);

  // 如果生成数量不够，用模板补充
  if (messages.length < count) {
    const templates = profile.templates[tier];
    while (messages.length < count) {
      messages.push(templates[messages.length % templates.length]);
    }
  }

  return messages.slice(0, count);
}

/**
 * 预生成完整语料库
 */
export async function generateCorpus(
  outputPath: string,
  messagesPerTier = 60,
): Promise<GeneratedCorpus> {
  console.log(`\n📝 使用 LongCat (${LONGCAT_MODEL}) 生成消息语料库...`);
  console.log(`   每画像每 tier ${messagesPerTier} 条, 共 ${PROFILES.length * 3 * messagesPerTier} 条\n`);

  const corpus: GeneratedCorpus = {
    generatedAt: new Date().toISOString(),
    model: LONGCAT_MODEL,
    profiles: {},
  };

  for (const profile of PROFILES) {
    console.log(`  ▸ ${profile.name} (${profile.id})...`);
    corpus.profiles[profile.id] = { light: [], tracked: [], delegation: [] };

    for (const tier of ["light", "tracked", "delegation"] as const) {
      process.stdout.write(`    ${tier}...`);
      try {
        const messages = await generateMessagesForTier(profile, tier, messagesPerTier);
        corpus.profiles[profile.id][tier] = messages;
        console.log(` ${messages.length} 条`);
      } catch (err) {
        console.log(` 失败: ${err}`);
        // Fallback to templates
        corpus.profiles[profile.id][tier] = [...profile.templates[tier]];
        console.log(`    (使用模板 fallback: ${profile.templates[tier].length} 条)`);
      }

      // Rate limiting — 避免 API 限流
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  writeFileSync(outputPath, JSON.stringify(corpus, null, 2), "utf-8");
  console.log(`\n✅ 语料库已保存: ${outputPath}`);
  console.log(`   总计: ${Object.values(corpus.profiles).reduce(
    (sum, p) => sum + p.light.length + p.tracked.length + p.delegation.length, 0,
  )} 条消息\n`);

  return corpus;
}

/**
 * 加载已生成的语料库
 */
export function loadCorpus(path: string): GeneratedCorpus | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as GeneratedCorpus;
  } catch {
    return null;
  }
}

/**
 * 从语料库中随机采样消息
 */
export function sampleFromCorpus(
  corpus: GeneratedCorpus,
  profileId: string,
  tier: "light" | "tracked" | "delegation",
): string | null {
  const messages = corpus.profiles[profileId]?.[tier];
  if (!messages || messages.length === 0) return null;
  return messages[Math.floor(Math.random() * messages.length)];
}

// ─── CLI: 直接运行生成语料库 ──────────────────────────────────────────
const isMainModule = process.argv[1]?.endsWith("llm-message-generator.ts");
if (isMainModule) {
  const outputPath = process.argv[2] || join(
    process.cwd(),
    "tests/simulation/corpus.json",
  );
  generateCorpus(outputPath).catch(console.error);
}
