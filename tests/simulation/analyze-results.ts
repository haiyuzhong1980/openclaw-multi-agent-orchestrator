/**
 * 分析 OMA 模拟结果 — 从 simulation-report.json 生成可视化对比报告
 *
 * 用法:
 *   node --experimental-strip-types tests/simulation/analyze-results.ts <report.json>
 */

import { readFileSync } from "node:fs";

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

interface ProfileResult {
  finalLevel: number;
  peakLevel: number;
  finalAccuracy: number;
  totalCorrections: number;
  totalKeywordsLearned: number;
  levelHistory: Array<{ day: number; level: number }>;
  accuracyHistory: Array<{ day: number; accuracy: number }>;
}

interface SimulationSummary {
  totalDays: number;
  messagesPerDay: number;
  profileResults: Record<string, ProfileResult>;
  dayResults: DayResult[];
}

// ─── Load report ──────────────────────────────────────────────────────
const reportPath = process.argv[2];
if (!reportPath) {
  console.error("Usage: analyze-results.ts <simulation-report.json>");
  process.exit(1);
}

const summary: SimulationSummary = JSON.parse(readFileSync(reportPath, "utf-8"));

// ─── ASCII sparkline ──────────────────────────────────────────────────
function sparkline(values: number[], width = 40): string {
  if (values.length === 0) return "";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const blocks = " ▁▂▃▄▅▆▇█";

  // Downsample to width
  const step = Math.max(1, Math.floor(values.length / width));
  const sampled: number[] = [];
  for (let i = 0; i < values.length; i += step) {
    const chunk = values.slice(i, Math.min(i + step, values.length));
    sampled.push(chunk.reduce((a, b) => a + b, 0) / chunk.length);
  }

  return sampled
    .map((v) => {
      const idx = Math.round(((v - min) / range) * (blocks.length - 1));
      return blocks[idx];
    })
    .join("");
}

// ─── Level timeline ───────────────────────────────────────────────────
function levelTimeline(history: Array<{ day: number; level: number }>, totalDays: number): string {
  const levelChars = ["·", "▪", "■", "█"];
  const step = Math.max(1, Math.floor(totalDays / 50));
  const chars: string[] = [];

  for (let d = 0; d < totalDays; d += step) {
    const entry = history.find((h) => h.day === d + 1) ?? history.filter((h) => h.day <= d + 1).pop();
    chars.push(levelChars[entry?.level ?? 0]);
  }

  return chars.join("");
}

// ─── Report ───────────────────────────────────────────────────────────
console.log(`\n${"═".repeat(70)}`);
console.log(`  OMA 自进化模拟 — 深度分析报告`);
console.log(`  ${summary.totalDays} 天 × ${summary.messagesPerDay} 消息/天`);
console.log(`${"═".repeat(70)}\n`);

// Per-profile analysis
const profileIds = Object.keys(summary.profileResults);
const profileNames: Record<string, string> = {
  conservative: "保守型",
  aggressive: "激进型",
  developer: "开发者",
  researcher: "研究者",
  manager: "管理者",
};

for (const pid of profileIds) {
  const result = summary.profileResults[pid];
  const dayData = summary.dayResults.filter((r) => r.profileId === pid);

  console.log(`┌─ ${profileNames[pid] ?? pid} ${"─".repeat(55)}`);

  // Accuracy sparkline
  const accuracies = result.accuracyHistory.map((h) => h.accuracy);
  console.log(`│  准确率: ${sparkline(accuracies)}`);
  console.log(`│          ${(accuracies[0] * 100).toFixed(0)}%${"".padEnd(sparkline(accuracies).length - 6)}${(accuracies[accuracies.length - 1] * 100).toFixed(0)}%`);

  // Level timeline
  console.log(`│  Level:  ${levelTimeline(result.levelHistory, summary.totalDays)}`);
  console.log(`│          0=${"·"} 1=${"▪"} 2=${"■"} 3=${"█"}`);

  // Corrections per day
  const corrections = dayData.map((d) => d.correctionsIssued);
  console.log(`│  纠正数: ${sparkline(corrections)}`);

  // Keywords discovered per day
  const kwPerDay = dayData.map((d) => d.newKeywordsDiscovered);
  console.log(`│  新词数: ${sparkline(kwPerDay)}`);

  // Stats
  const firstWeekAcc = accuracies.slice(0, 7);
  const lastWeekAcc = accuracies.slice(-7);
  const avgFirst = firstWeekAcc.reduce((a, b) => a + b, 0) / firstWeekAcc.length;
  const avgLast = lastWeekAcc.reduce((a, b) => a + b, 0) / lastWeekAcc.length;
  const improvement = avgLast - avgFirst;

  console.log(`│`);
  console.log(`│  第一周平均准确率: ${(avgFirst * 100).toFixed(1)}%`);
  console.log(`│  最后一周平均准确率: ${(avgLast * 100).toFixed(1)}%`);
  console.log(`│  准确率变化: ${improvement > 0 ? "+" : ""}${(improvement * 100).toFixed(1)}%`);
  console.log(`│  最终 Level: ${result.finalLevel}  (峰值: ${result.peakLevel})`);
  console.log(`│  总纠正: ${result.totalCorrections}  学到关键词: ${result.totalKeywordsLearned}`);
  console.log(`└${"─".repeat(65)}\n`);
}

// ─── Cross-profile comparison ─────────────────────────────────────────
console.log(`\n${"═".repeat(70)}`);
console.log(`  画像对比摘要`);
console.log(`${"═".repeat(70)}\n`);

const header = "画像".padEnd(10) +
  "最终Level".padEnd(10) +
  "峰值".padEnd(6) +
  "首周准确率".padEnd(12) +
  "末周准确率".padEnd(12) +
  "变化".padEnd(8) +
  "纠正数".padEnd(8) +
  "关键词";
console.log(header);
console.log("─".repeat(header.length));

for (const pid of profileIds) {
  const result = summary.profileResults[pid];
  const accuracies = result.accuracyHistory.map((h) => h.accuracy);
  const firstWeek = accuracies.slice(0, 7);
  const lastWeek = accuracies.slice(-7);
  const avgFirst = firstWeek.reduce((a, b) => a + b, 0) / firstWeek.length;
  const avgLast = lastWeek.reduce((a, b) => a + b, 0) / lastWeek.length;
  const change = avgLast - avgFirst;

  console.log(
    `${(profileNames[pid] ?? pid).padEnd(10)}` +
    `L${result.finalLevel}`.padEnd(10) +
    `L${result.peakLevel}`.padEnd(6) +
    `${(avgFirst * 100).toFixed(1)}%`.padEnd(12) +
    `${(avgLast * 100).toFixed(1)}%`.padEnd(12) +
    `${change > 0 ? "+" : ""}${(change * 100).toFixed(1)}%`.padEnd(8) +
    `${result.totalCorrections}`.padEnd(8) +
    `${result.totalKeywordsLearned}`,
  );
}

// ─── Verification checklist ───────────────────────────────────────────
console.log(`\n${"═".repeat(70)}`);
console.log(`  验证清单`);
console.log(`${"═".repeat(70)}\n`);

const checks = [
  {
    name: "Level 0→1 升级路径",
    pass: Object.values(summary.profileResults).some((r) => r.peakLevel >= 1),
  },
  {
    name: "Level 1→2 升级路径",
    pass: Object.values(summary.profileResults).some((r) => r.peakLevel >= 2),
  },
  {
    name: "Level 2→3 升级路径",
    pass: Object.values(summary.profileResults).some((r) => r.peakLevel >= 3),
  },
  {
    name: "模式发现提取到关键词",
    pass: Object.values(summary.profileResults).some((r) => r.totalKeywordsLearned > 0),
  },
  {
    name: "误判后降级及时",
    pass: Object.values(summary.profileResults).some((r) =>
      r.levelHistory.some((h, i) =>
        i > 0 && h.level < r.levelHistory[i - 1].level,
      ),
    ),
  },
  {
    name: "不同画像收敛到不同 Level",
    pass: new Set(Object.values(summary.profileResults).map((r) => r.finalLevel)).size > 1,
  },
  {
    name: "30 天后至少一个画像准确率提升 >5%",
    pass: Object.values(summary.profileResults).some((r) => {
      const accs = r.accuracyHistory.map((h) => h.accuracy);
      const first7 = accs.slice(0, 7).reduce((a, b) => a + b, 0) / 7;
      const last7 = accs.slice(-7).reduce((a, b) => a + b, 0) / 7;
      return last7 - first7 > 0.05;
    }),
  },
];

let passCount = 0;
for (const check of checks) {
  const icon = check.pass ? "✅" : "❌";
  console.log(`  ${icon} ${check.name}`);
  if (check.pass) passCount++;
}

console.log(`\n  通过: ${passCount}/${checks.length}`);
console.log();
