/**
 * TOML Template Parser — Parse multi-agent orchestration templates from TOML files.
 *
 * Schema design (M8-01):
 *
 * [template]
 * id = "template-id"
 * name = "Template Name"
 * description = "What this template does"
 *
 * [template.leader]
 * name = "leader-agent-name"
 * type = "agent-type"
 * task = "Leader's task description"
 *
 * [[template.agents]]
 * name = "agent-name"
 * type = "agent-type"
 * task = "Task description"
 *
 * [[template.tasks]]
 * subject = "Task subject"
 * owner = "agent-name"
 * blockedBy = ["other-task-subject"]  # Optional dependencies
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SprintStage } from "./task-board.ts";
import { loggers, ErrorCode } from "./errors.ts";

// ============================================================================
// TOML Types
// ============================================================================

export interface TomlAgent {
  name: string;
  type: string;
  task: string;
  stage?: SprintStage;
}

export interface TomlTask {
  subject: string;
  owner: string;
  blockedBy?: string[];
  stage?: SprintStage;
}

export interface TomlLeader {
  name: string;
  type: string;
  task: string;
  stage?: SprintStage;
}

export interface TomlTemplate {
  id: string;
  name: string;
  description: string;
  leader?: TomlLeader;
  agents: TomlAgent[];
  tasks: TomlTask[];
}

// ============================================================================
// Simple TOML Parser
// ============================================================================

/**
 * A minimal TOML parser for OMA templates.
 * Supports: strings, arrays, tables, arrays of tables.
 * Does NOT support: inline tables, nested tables, complex types.
 */
export function parseToml(content: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = content.split("\n");

  let currentTable: string[] = [];
  let currentArrayTable: string[] | null = null;
  let currentArray: unknown[] | null = null;

  for (let line of lines) {
    // Remove comments
    const commentIdx = line.indexOf("#");
    if (commentIdx !== -1) {
      // Check if # is inside a string
      const beforeComment = line.slice(0, commentIdx);
      const quoteCount = (beforeComment.match(/"/g) || []).length;
      if (quoteCount % 2 === 0) {
        line = beforeComment;
      }
    }

    line = line.trim();
    if (!line) continue;

    // Array of tables: [[section]]
    const arrayTableMatch = line.match(/^\[\[([^\]]+)\]\]$/);
    if (arrayTableMatch) {
      currentTable = arrayTableMatch[1].trim().split(".");
      currentArrayTable = currentTable;

      // Get or create the array
      const array = getOrCreateArray(result, currentTable);
      const newObj: Record<string, unknown> = {};
      array.push(newObj);
      currentArray = array;
      continue;
    }

    // Table: [section] or [section.subsection]
    const tableMatch = line.match(/^\[([^\]]+)\]$/);
    if (tableMatch) {
      currentTable = tableMatch[1].trim().split(".");
      currentArrayTable = null;
      currentArray = null;
      getOrCreateTable(result, currentTable);
      continue;
    }

    // Key-value pair
    const kvMatch = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(.+)$/);
    if (kvMatch) {
      const key = kvMatch[1];
      let value: unknown;

      // Parse value
      const rawValue = kvMatch[2].trim();

      if (rawValue.startsWith('"') && rawValue.endsWith('"')) {
        // String
        value = rawValue.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, "\n");
      } else if (rawValue.startsWith("'") && rawValue.endsWith("'")) {
        // Literal string
        value = rawValue.slice(1, -1);
      } else if (rawValue.startsWith("[")) {
        // Array
        value = parseArray(rawValue);
      } else if (rawValue === "true" || rawValue === "false") {
        value = rawValue === "true";
      } else if (/^-?\d+$/.test(rawValue)) {
        value = parseInt(rawValue, 10);
      } else if (/^-?\d+\.\d+$/.test(rawValue)) {
        value = parseFloat(rawValue);
      } else {
        // Treat as string
        value = rawValue;
      }

      // Set the value
      if (currentArrayTable && currentArray) {
        const obj = currentArray[currentArray.length - 1] as Record<string, unknown>;
        obj[key] = value;
      } else {
        setNestedValue(result, [...currentTable, key], value);
      }
    }
  }

  return result;
}

function parseArray(raw: string): unknown[] {
  // Simple array parser for strings
  const result: unknown[] = [];
  let content = raw.slice(1, -1).trim();

  if (!content) return result;

  // Handle string arrays
  const stringMatch = content.match(/"([^"]*)"/g);
  if (stringMatch) {
    for (const s of stringMatch) {
      result.push(s.slice(1, -1));
    }
  }

  return result;
}

function getOrCreateTable(obj: Record<string, unknown>, path: string[]): Record<string, unknown> {
  let current: Record<string, unknown> = obj;

  for (const key of path) {
    if (!current[key]) {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }

  return current;
}

function getOrCreateArray(obj: Record<string, unknown>, path: string[]): unknown[] {
  const parentPath = path.slice(0, -1);
  const arrayKey = path[path.length - 1];

  let parent: Record<string, unknown>;
  if (parentPath.length === 0) {
    parent = obj;
  } else {
    parent = getOrCreateTable(obj, parentPath);
  }

  if (!parent[arrayKey]) {
    parent[arrayKey] = [];
  }

  return parent[arrayKey] as unknown[];
}

function setNestedValue(obj: Record<string, unknown>, path: string[], value: unknown): void {
  const parentPath = path.slice(0, -1);
  const key = path[path.length - 1];

  const parent = parentPath.length === 0 ? obj : getOrCreateTable(obj, parentPath);
  parent[key] = value;
}

// ============================================================================
// Template Parser
// ============================================================================

/**
 * Parse a TOML template file.
 */
export function parseTomlTemplate(content: string): TomlTemplate | null {
  try {
    const raw = parseToml(content);
    const template = raw.template as Record<string, unknown>;

    if (!template) return null;

    const result: TomlTemplate = {
      id: String(template.id ?? ""),
      name: String(template.name ?? ""),
      description: String(template.description ?? ""),
      agents: [],
      tasks: [],
    };

    // Parse leader
    if (template.leader) {
      const leader = template.leader as Record<string, unknown>;
      result.leader = {
        name: String(leader.name ?? "leader"),
        type: String(leader.type ?? "planner"),
        task: String(leader.task ?? ""),
        stage: leader.stage as SprintStage | undefined,
      };
    }

    // Parse agents
    if (Array.isArray(template.agents)) {
      result.agents = template.agents.map((a: Record<string, unknown>) => ({
        name: String(a.name ?? ""),
        type: String(a.type ?? ""),
        task: String(a.task ?? ""),
        stage: a.stage as SprintStage | undefined,
      }));
    }

    // Parse tasks
    if (Array.isArray(template.tasks)) {
      result.tasks = template.tasks.map((t: Record<string, unknown>) => ({
        subject: String(t.subject ?? ""),
        owner: String(t.owner ?? ""),
        blockedBy: Array.isArray(t.blockedBy) ? t.blockedBy as string[] : undefined,
        stage: t.stage as SprintStage | undefined,
      }));
    }

    return result;
  } catch (error) {
    loggers.tomlParser.error(`Failed to parse TOML template`, error);
    return null;
  }
}

/**
 * Load TOML template from file.
 */
export function loadTomlTemplate(filePath: string): TomlTemplate | null {
  if (!existsSync(filePath)) return null;

  try {
    const content = readFileSync(filePath, "utf-8");
    return parseTomlTemplate(content);
  } catch (error) {
    loggers.tomlParser.error(`Failed to load TOML template from file`, error, { path: filePath });
    return null;
  }
}

/**
 * Load all TOML templates from a directory.
 */
export function loadTomlTemplates(dirPath: string): TomlTemplate[] {
  if (!existsSync(dirPath)) return [];

  const templates: TomlTemplate[] = [];

  try {
    const files = readdirSync(dirPath).filter((f) => f.endsWith(".toml"));

    for (const file of files) {
      const template = loadTomlTemplate(join(dirPath, file));
      if (template) {
        templates.push(template);
      }
    }
  } catch (error) {
    // Directory doesn't exist or can't be read
    loggers.tomlParser.error(`Failed to read TOML templates directory`, error, { path: dirPath });
  }

  return templates;
}

/**
 * Validate a TOML template.
 */
export function validateTomlTemplate(template: TomlTemplate): string[] {
  const errors: string[] = [];

  if (!template.id) {
    errors.push("Template missing 'id'");
  }

  if (!template.name) {
    errors.push("Template missing 'name'");
  }

  // Check for duplicate task subjects
  const subjects = new Set<string>();
  for (const task of template.tasks) {
    if (subjects.has(task.subject)) {
      errors.push(`Duplicate task subject: ${task.subject}`);
    }
    subjects.add(task.subject);
  }

  // Check that blockedBy references exist
  for (const task of template.tasks) {
    if (task.blockedBy) {
      for (const dep of task.blockedBy) {
        if (!subjects.has(dep)) {
          errors.push(`Task "${task.subject}" blockedBy non-existent task "${dep}"`);
        }
      }
    }
  }

  // Check that task owners exist as agents or leader
  const owners = new Set<string>();
  if (template.leader) {
    owners.add(template.leader.name);
  }
  for (const agent of template.agents) {
    owners.add(agent.name);
  }

  for (const task of template.tasks) {
    if (!owners.has(task.owner)) {
      errors.push(`Task "${task.subject}" has unknown owner "${task.owner}"`);
    }
  }

  return errors;
}

/**
 * Format a TOML template for display.
 */
export function formatTomlTemplate(template: TomlTemplate): string {
  const lines: string[] = [
    `**${template.name}** (${template.id})`,
    "",
    template.description,
    "",
  ];

  if (template.leader) {
    lines.push(`Leader: ${template.leader.name} (${template.leader.type})`);
    lines.push("");
  }

  if (template.agents.length > 0) {
    lines.push(`**Agents (${template.agents.length}):**`);
    for (const agent of template.agents) {
      lines.push(`  - ${agent.name} (${agent.type})`);
    }
    lines.push("");
  }

  if (template.tasks.length > 0) {
    lines.push(`**Tasks (${template.tasks.length}):**`);
    for (const task of template.tasks) {
      let line = `  - ${task.subject} → ${task.owner}`;
      if (task.blockedBy && task.blockedBy.length > 0) {
        line += ` (blockedBy: ${task.blockedBy.join(", ")})`;
      }
      lines.push(line);
    }
  }

  return lines.join("\n");
}
