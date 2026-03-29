import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { loggers, ErrorCode } from "./errors.ts";

export interface TopicHeat {
  topic: string;
  importance: number;
  totalMentions: number;
  uniqueAgents: number;
  lastSeen: string;
}

/**
 * Load top topics from OFMS topic registry.
 */
export function loadTopTopics(sharedRoot: string, limit?: number): TopicHeat[] {
  const registryPath = join(sharedRoot, "topic_registry.json");
  if (!existsSync(registryPath)) return [];

  try {
    const data = JSON.parse(readFileSync(registryPath, "utf-8"));
    const topics = data.topics ?? {};

    const result: TopicHeat[] = [];
    for (const [topic, entry] of Object.entries(topics)) {
      const e = entry as Record<string, unknown>;
      const totalMentions = (e.totalMentions as number) ?? 0;
      const lastSeen = (e.lastSeen as string) ?? "";
      const agents = Array.isArray(e.agents) ? e.agents : [];
      const baseWeight = (e.baseWeight as number) ?? 1.0;
      const dailyCounts = (e.dailyCounts as Record<string, number>) ?? {};
      const mentionDays = Object.keys(dailyCounts).length;

      // Simplified importance calculation (mirrors OFMS topic-registry.ts)
      const daysSinceLast = lastSeen
        ? (Date.now() - new Date(lastSeen).getTime()) / (1000 * 60 * 60 * 24)
        : 999;
      const recency = 1 / (1 + daysSinceLast / 7);
      const frequency = Math.log2(1 + mentionDays);
      const spread = 1 + 0.5 * agents.length;
      const importance = recency * frequency * spread * baseWeight;

      result.push({
        topic,
        importance,
        totalMentions,
        uniqueAgents: agents.length,
        lastSeen,
      });
    }

    return result
      .sort((a, b) => b.importance - a.importance)
      .slice(0, limit ?? 20);
  } catch (error) {
    loggers.ofmsBridge.error(`Failed to load top topics`, error, { sharedRoot });
    return [];
  }
}

/**
 * Suggest research tracks based on high-importance OFMS topics.
 * Topics with importance > threshold become suggested tracks.
 */
export function suggestTracksFromTopics(
  sharedRoot: string,
  threshold?: number,
): Array<{ topic: string; importance: number; suggestedTrackId: string; suggestedGoal: string }> {
  const topics = loadTopTopics(sharedRoot, 10);
  const minImportance = threshold ?? 3.0;

  return topics
    .filter((t) => t.importance >= minImportance)
    .map((t) => ({
      topic: t.topic,
      importance: t.importance,
      suggestedTrackId: `topic-${t.topic.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")}-track`,
      suggestedGoal: `Research and gather information about "${t.topic}" — this is a high-importance topic (importance: ${t.importance.toFixed(1)}, mentioned ${t.totalMentions} times across ${t.uniqueAgents} agents).`,
    }));
}

/**
 * Enqueue validated orchestration results as OFMS shared memory candidates.
 */
export function feedbackToOfms(params: {
  sharedRoot: string;
  agent: string;
  validatedItems: Array<{ title: string; url: string; trackLabel: string }>;
  request?: string;
}): number {
  const pendingDir = join(params.sharedRoot, "queue", "pending");
  if (!existsSync(pendingDir)) {
    try {
      mkdirSync(pendingDir, { recursive: true });
    } catch (error) {
      loggers.ofmsBridge.error(`Failed to create pending directory`, error, { path: pendingDir });
      return 0;
    }
  }

  let enqueued = 0;
  const date = new Date().toISOString().slice(0, 10);

  for (const item of params.validatedItems.slice(0, 5)) {
    // Max 5 feedback items
    const candidateText = `[${item.trackLabel}] ${item.title} — ${item.url}`;
    if (candidateText.length < 20 || candidateText.length > 500) continue;

    const hash = createHash("sha1")
      .update(`validated_research\n${candidateText.toLowerCase().replace(/\s+/g, " ").trim()}`)
      .digest("hex")
      .slice(0, 12);
    const slug = item.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, 40);
    const fileName = `${date}-${slug}-${hash}.md`;
    const filePath = join(pendingDir, fileName);

    if (existsSync(filePath)) continue; // Already enqueued

    const content = [
      "# Shared Memory Candidate",
      "",
      `agent: ${params.agent}`,
      `created_at: ${new Date().toISOString()}`,
      `category: validated_research`,
      `priority: medium`,
      `source: multi-agent-orchestrator`,
      "",
      "## Candidate",
      candidateText,
      "",
      "## Why",
      `Validated result from multi-agent orchestration${params.request ? `: "${params.request.slice(0, 100)}"` : ""}.`,
    ].join("\n");

    try {
      writeFileSync(filePath, content, "utf-8");
      enqueued++;
    } catch (error) {
      loggers.ofmsBridge.warn(`Failed to write feedback item`, { file: fileName, error: String(error) });
    }
  }

  return enqueued;
}
