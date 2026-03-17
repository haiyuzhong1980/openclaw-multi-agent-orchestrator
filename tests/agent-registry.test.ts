import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseFrontmatter,
  extractSection,
  parseAgentFile,
  loadAgentRegistry,
  clearRegistryCache,
  searchAgents,
  getAgentsByCategory,
  buildAgentPrompt,
} from "../src/agent-registry.ts";

const REAL_LIBRARY = join(process.env.HOME ?? "", "Documents/agency-agents-backup");

const SAMPLE_AGENT_CONTENT = `---
name: Test Agent
description: A test agent for unit tests
color: blue
emoji: 🧪
vibe: Testing is my life.
---

# Test Agent

## 🧠 Your Identity & Memory
- **Role**: Test specialist
- **Personality**: Precise and methodical

## 🎯 Your Core Mission
- Run tests reliably
- Catch all bugs

## 🚨 Critical Rules You Must Follow
- Never skip a test
- Always validate results
`;

// Helpers
function makeTmpLibrary(categories: Record<string, string[]>): string {
  const root = join(tmpdir(), `agent-reg-test-${Date.now()}`);
  for (const [cat, files] of Object.entries(categories)) {
    const dir = join(root, cat);
    mkdirSync(dir, { recursive: true });
    for (const file of files) {
      writeFileSync(join(dir, file), SAMPLE_AGENT_CONTENT);
    }
  }
  return root;
}

describe("parseFrontmatter", () => {
  it("parses name, description, emoji, vibe from valid frontmatter", () => {
    const result = parseFrontmatter(SAMPLE_AGENT_CONTENT);
    assert.equal(result.name, "Test Agent");
    assert.equal(result.description, "A test agent for unit tests");
    assert.equal(result.emoji, "🧪");
    assert.equal(result.vibe, "Testing is my life.");
    assert.equal(result.color, "blue");
  });

  it("returns empty object when no frontmatter block present", () => {
    const result = parseFrontmatter("# Just a heading\n\nSome body text.");
    assert.deepEqual(result, {});
  });

  it("handles frontmatter with no trailing values gracefully", () => {
    const content = "---\nname: Minimal\n---\n# Body";
    const result = parseFrontmatter(content);
    assert.equal(result.name, "Minimal");
  });
});

describe("extractSection", () => {
  it("extracts content under a matching heading", () => {
    const result = extractSection(SAMPLE_AGENT_CONTENT, /core mission/i);
    assert.ok(result.includes("Run tests reliably"));
    assert.ok(result.includes("Catch all bugs"));
  });

  it("stops at the next heading of same or higher level", () => {
    const result = extractSection(SAMPLE_AGENT_CONTENT, /core mission/i);
    assert.ok(!result.includes("Critical Rules"));
  });

  it("returns empty string for a non-existent section", () => {
    const result = extractSection(SAMPLE_AGENT_CONTENT, /nonexistent section xyz/i);
    assert.equal(result, "");
  });

  it("matches identity section by pattern", () => {
    const result = extractSection(SAMPLE_AGENT_CONTENT, /identity/i);
    assert.ok(result.includes("Test specialist"));
  });

  it("matches critical rules section", () => {
    const result = extractSection(SAMPLE_AGENT_CONTENT, /critical rules/i);
    assert.ok(result.includes("Never skip a test"));
  });
});

describe("parseAgentFile", () => {
  let tmpDir: string;

  beforeEach(() => {
    clearRegistryCache();
    tmpDir = join(tmpdir(), `parse-agent-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("parses a real agent file from the library", () => {
    const filePath = join(REAL_LIBRARY, "testing", "testing-evidence-collector.md");
    const agent = parseAgentFile(filePath, "testing");
    assert.ok(agent !== null);
    assert.equal(agent!.name, "Evidence Collector");
    assert.equal(agent!.category, "testing");
    assert.ok(agent!.description.length > 0);
    assert.ok(agent!.emoji === "📸");
  });

  it("extracts identity from a real agent file", () => {
    const filePath = join(REAL_LIBRARY, "engineering", "engineering-frontend-developer.md");
    const agent = parseAgentFile(filePath, "engineering");
    assert.ok(agent !== null);
    assert.ok(agent!.identity.length > 0);
  });

  it("returns null for a non-existent file", () => {
    const agent = parseAgentFile("/nonexistent/path/agent.md", "test");
    assert.equal(agent, null);
  });

  it("falls back to filename when no frontmatter name present", () => {
    const filePath = join(tmpDir, "my-test-agent.md");
    writeFileSync(filePath, "# Just a heading\n\nNo frontmatter here.");
    const agent = parseAgentFile(filePath, "custom");
    assert.ok(agent !== null);
    assert.equal(agent!.name, "my-test-agent");
  });
});

describe("loadAgentRegistry", () => {
  beforeEach(() => {
    clearRegistryCache();
  });

  it("loads agents from the real library directory", () => {
    const registry = loadAgentRegistry(REAL_LIBRARY);
    assert.ok(registry.agents.length >= 100, `Expected 100+ agents, got ${registry.agents.length}`);
    assert.ok(registry.categories.length > 0);
  });

  it("reports correct categories from the real library", () => {
    const registry = loadAgentRegistry(REAL_LIBRARY);
    assert.ok(registry.categories.includes("engineering"));
    assert.ok(registry.categories.includes("testing"));
    assert.ok(registry.categories.includes("specialized"));
  });

  it("returns empty registry for a non-existent directory", () => {
    const registry = loadAgentRegistry("/path/that/does/not/exist/at/all");
    assert.equal(registry.agents.length, 0);
    assert.equal(registry.categories.length, 0);
  });

  it("returns cached result for the same path on second call", () => {
    const r1 = loadAgentRegistry(REAL_LIBRARY);
    const r2 = loadAgentRegistry(REAL_LIBRARY);
    assert.strictEqual(r1, r2, "Second call should return the identical cached object");
  });

  it("skips scripts, integrations, and examples directories", () => {
    const root = makeTmpLibrary({
      engineering: ["eng-agent.md"],
      scripts: ["helper.md"],
      integrations: ["some.md"],
    });
    clearRegistryCache();
    const registry = loadAgentRegistry(root);
    assert.ok(registry.categories.includes("engineering"));
    assert.ok(!registry.categories.includes("scripts"));
    assert.ok(!registry.categories.includes("integrations"));
    rmSync(root, { recursive: true, force: true });
  });

  it("loadedFrom and loadedAt are set correctly", () => {
    const registry = loadAgentRegistry(REAL_LIBRARY);
    assert.equal(registry.loadedFrom, REAL_LIBRARY);
    assert.ok(registry.loadedAt.length > 0);
  });
});

describe("searchAgents", () => {
  let registry: ReturnType<typeof loadAgentRegistry>;

  beforeEach(() => {
    clearRegistryCache();
    registry = loadAgentRegistry(REAL_LIBRARY);
  });

  it("finds agents by name keyword", () => {
    const results = searchAgents(registry, "evidence");
    assert.ok(results.some((a) => a.name === "Evidence Collector"));
  });

  it("finds agents by category keyword", () => {
    const results = searchAgents(registry, "testing");
    assert.ok(results.length > 0);
    assert.ok(results.every((a) => a.category === "testing" || a.name.toLowerCase().includes("testing") || a.description.toLowerCase().includes("testing") || (a.vibe ?? "").toLowerCase().includes("testing")));
  });

  it("finds agents by description keyword", () => {
    const results = searchAgents(registry, "frontend");
    assert.ok(results.some((a) => a.name === "Frontend Developer"));
  });

  it("returns empty array when no agent matches", () => {
    const results = searchAgents(registry, "xyzzy-completely-nonexistent-agent-abc123");
    assert.equal(results.length, 0);
  });

  it("search is case-insensitive", () => {
    const lower = searchAgents(registry, "evidence collector");
    const upper = searchAgents(registry, "EVIDENCE COLLECTOR");
    assert.equal(lower.length, upper.length);
    assert.ok(lower.length > 0);
  });
});

describe("getAgentsByCategory", () => {
  let registry: ReturnType<typeof loadAgentRegistry>;

  beforeEach(() => {
    clearRegistryCache();
    registry = loadAgentRegistry(REAL_LIBRARY);
  });

  it("returns only agents in the requested category", () => {
    const agents = getAgentsByCategory(registry, "testing");
    assert.ok(agents.length > 0);
    assert.ok(agents.every((a) => a.category === "testing"));
  });

  it("returns empty array for a non-existent category", () => {
    const agents = getAgentsByCategory(registry, "nonexistent-xyz");
    assert.equal(agents.length, 0);
  });
});

describe("buildAgentPrompt", () => {
  it("includes agent name and task in the prompt", () => {
    const agent = {
      name: "Test Specialist",
      description: "A testing specialist",
      category: "testing",
      filePath: "/fake/path.md",
      identity: "Identity section text here",
      coreMission: "Mission text here",
      criticalRules: "Rule: never skip tests",
    };
    const prompt = buildAgentPrompt(agent, "Run a full audit");
    assert.ok(prompt.includes("Test Specialist"));
    assert.ok(prompt.includes("Run a full audit"));
  });

  it("includes identity content when present", () => {
    const agent = {
      name: "Agent X",
      description: "",
      category: "engineering",
      filePath: "/fake/x.md",
      identity: "I am a coding expert",
      coreMission: "",
      criticalRules: "",
    };
    const prompt = buildAgentPrompt(agent, "Fix bugs");
    assert.ok(prompt.includes("I am a coding expert"));
  });

  it("includes mission content when present", () => {
    const agent = {
      name: "Planner",
      description: "A strategic planner",
      category: "specialized",
      filePath: "/fake/planner.md",
      identity: "",
      coreMission: "Plan everything carefully",
      criticalRules: "",
    };
    const prompt = buildAgentPrompt(agent, "Build a roadmap");
    assert.ok(prompt.includes("Plan everything carefully"));
  });

  it("starts with 'You are <name>' line", () => {
    const agent = {
      name: "My Agent",
      description: "Does stuff",
      category: "test",
      filePath: "/x.md",
      identity: "",
      coreMission: "",
      criticalRules: "",
    };
    const prompt = buildAgentPrompt(agent, "Do the thing");
    assert.ok(prompt.startsWith("You are My Agent."));
  });
});
