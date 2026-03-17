import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import type { PlannedTrack } from "./types.ts";

export interface AgentDefinition {
  name: string;
  description: string;
  category: string;
  emoji?: string;
  vibe?: string;
  filePath: string;
  identity: string;
  coreMission: string;
  criticalRules: string;
  tools?: string[];
}

export interface AgentRegistry {
  agents: AgentDefinition[];
  categories: string[];
  loadedFrom: string;
  loadedAt: string;
}

// Cache
let cachedRegistry: AgentRegistry | null = null;
let cachedPath = "";

/**
 * Parse YAML-like frontmatter from an agent .md file.
 */
export function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const lines = match[1].split("\n");
  const result: Record<string, string> = {};
  for (const line of lines) {
    const colonIdx = line.indexOf(":");
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim();
      const value = line.slice(colonIdx + 1).trim();
      result[key] = value;
    }
  }
  return result;
}

/**
 * Extract a markdown section by heading pattern.
 * Captures content until the next heading of same or higher level.
 */
export function extractSection(content: string, headingPattern: RegExp): string {
  const lines = content.split("\n");
  let capturing = false;
  let level = 0;
  const captured: string[] = [];

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      if (capturing) {
        if (headingMatch[1].length <= level) break;
      }
      if (!capturing && headingPattern.test(headingMatch[2])) {
        capturing = true;
        level = headingMatch[1].length;
        continue;
      }
    }
    if (capturing) {
      captured.push(line);
    }
  }

  return captured.join("\n").trim();
}

/**
 * Parse a single agent definition file.
 */
export function parseAgentFile(filePath: string, category: string): AgentDefinition | null {
  try {
    const content = readFileSync(filePath, "utf-8");
    const frontmatter = parseFrontmatter(content);

    const name = frontmatter.name || basename(filePath, ".md");
    const description = frontmatter.description || "";
    const emoji = frontmatter.emoji;
    const vibe = frontmatter.vibe;
    const tools = frontmatter.tools
      ? frontmatter.tools
          .replace(/[\[\]]/g, "")
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean)
      : undefined;

    const identity = extractSection(content, /identity|your identity/i) || "";
    const coreMission = extractSection(content, /core mission|your core mission|mission/i) || "";
    const criticalRules = extractSection(content, /critical rules|rules you must follow/i) || "";

    return {
      name,
      description,
      category,
      emoji,
      vibe,
      filePath,
      identity: identity.slice(0, 500),
      coreMission: coreMission.slice(0, 500),
      criticalRules: criticalRules.slice(0, 500),
      tools,
    };
  } catch {
    return null;
  }
}

/**
 * Load all agents from a directory structure.
 * Expects: rootDir/{category}/*.md
 */
export function loadAgentRegistry(rootDir: string): AgentRegistry {
  if (cachedPath === rootDir && cachedRegistry) return cachedRegistry;

  const agents: AgentDefinition[] = [];
  const categories = new Set<string>();

  if (!existsSync(rootDir)) {
    return {
      agents: [],
      categories: [],
      loadedFrom: rootDir,
      loadedAt: new Date().toISOString(),
    };
  }

  const entries = readdirSync(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (
      entry.name.startsWith(".") ||
      entry.name === "scripts" ||
      entry.name === "integrations" ||
      entry.name === "examples"
    )
      continue;

    const category = entry.name;
    categories.add(category);

    const categoryDir = join(rootDir, category);
    const files = readdirSync(categoryDir).filter((f) => f.endsWith(".md"));

    for (const file of files) {
      const agent = parseAgentFile(join(categoryDir, file), category);
      if (agent) agents.push(agent);
    }
  }

  cachedRegistry = {
    agents,
    categories: [...categories].sort(),
    loadedFrom: rootDir,
    loadedAt: new Date().toISOString(),
  };
  cachedPath = rootDir;

  return cachedRegistry;
}

/**
 * Clear the registry cache. Useful for testing.
 */
export function clearRegistryCache(): void {
  cachedRegistry = null;
  cachedPath = "";
}

/**
 * Search agents by keyword (matches name, description, category, vibe).
 */
export function searchAgents(registry: AgentRegistry, query: string): AgentDefinition[] {
  const lower = query.toLowerCase();
  return registry.agents.filter(
    (a) =>
      a.name.toLowerCase().includes(lower) ||
      a.description.toLowerCase().includes(lower) ||
      a.category.toLowerCase().includes(lower) ||
      (a.vibe ?? "").toLowerCase().includes(lower),
  );
}

/**
 * Get agents by category.
 */
export function getAgentsByCategory(registry: AgentRegistry, category: string): AgentDefinition[] {
  return registry.agents.filter((a) => a.category === category);
}

/**
 * Build a subagent prompt from an agent definition + task context.
 */
export function buildAgentPrompt(agent: AgentDefinition, task: string): string {
  const lines = [
    `You are ${agent.name}.`,
    agent.description ? `Role: ${agent.description}` : "",
    agent.identity ? `\n${agent.identity}` : "",
    agent.coreMission ? `\nMission: ${agent.coreMission}` : "",
    agent.criticalRules ? `\nRules:\n${agent.criticalRules}` : "",
    `\nTask: ${task}`,
  ].filter(Boolean);
  return lines.join("\n");
}

/**
 * Plan tracks using agents from the registry, custom track list, or keyword inference fallback.
 */
export function planTracksWithAgents(params: {
  request?: string;
  agentType?: string;
  agentCategory?: string;
  agentRegistryPath?: string;
  customTracks?: Array<{ trackId: string; label: string; goal: string }>;
}): PlannedTrack[] | null {
  if (params.agentRegistryPath && (params.agentType || params.agentCategory)) {
    const registry = loadAgentRegistry(params.agentRegistryPath);
    let agents: AgentDefinition[] = [];

    if (params.agentType) {
      agents = searchAgents(registry, params.agentType);
    } else if (params.agentCategory) {
      agents = getAgentsByCategory(registry, params.agentCategory);
    }

    if (agents.length > 0) {
      return agents.slice(0, 3).map((agent) => ({
        trackId: `${agent.category}-${agent.name.toLowerCase().replace(/\s+/g, "-")}-track`,
        label: agent.name,
        goal: params.request ?? `Execute task using ${agent.name} expertise`,
        outputContract: ["Provide detailed analysis based on your domain expertise"],
        failureContract: ["If unable to complete, explain the specific blocker"],
        subagentPrompt: buildAgentPrompt(agent, params.request ?? ""),
      }));
    }
  }

  if (params.customTracks && params.customTracks.length > 0) {
    return params.customTracks.map((t) => ({
      trackId: t.trackId,
      label: t.label,
      goal: t.goal,
      outputContract: ["Provide structured results"],
      failureContract: ["Explain blockers clearly"],
      subagentPrompt: `You are responsible for the "${t.label}" track.\nGoal: ${t.goal}\nTask: ${params.request ?? t.goal}`,
    }));
  }

  return null;
}
