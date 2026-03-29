import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseToml,
  parseTomlTemplate,
  loadTomlTemplate,
  loadTomlTemplates,
  validateTomlTemplate,
  formatTomlTemplate,
} from "../src/toml-parser.ts";

describe("TOML Parser", () => {
  describe("parseToml", () => {
    it("parses simple key-value pairs", () => {
      const result = parseToml(`
id = "test-id"
name = "Test Name"
description = "Test description"
`);

      assert.equal(result.id, "test-id");
      assert.equal(result.name, "Test Name");
      assert.equal(result.description, "Test description");
    });

    it("parses string arrays", () => {
      const result = parseToml(`
items = ["item1", "item2", "item3"]
`);

      assert.deepEqual(result.items, ["item1", "item2", "item3"]);
    });

    it("parses tables", () => {
      const result = parseToml(`
[template]
id = "my-template"
name = "My Template"
`);

      assert.ok(result.template);
      assert.equal((result.template as Record<string, unknown>).id, "my-template");
    });

    it("parses nested tables", () => {
      const result = parseToml(`
[template.leader]
name = "leader-1"
type = "planner"
`);

      const template = result.template as Record<string, unknown>;
      const leader = template.leader as Record<string, unknown>;
      assert.equal(leader.name, "leader-1");
      assert.equal(leader.type, "planner");
    });

    it("parses arrays of tables", () => {
      const result = parseToml(`
[[template.agents]]
name = "agent-1"
type = "worker"

[[template.agents]]
name = "agent-2"
type = "reviewer"
`);

      const template = result.template as Record<string, unknown>;
      const agents = template.agents as Record<string, unknown>[];
      assert.equal(agents.length, 2);
      assert.equal(agents[0].name, "agent-1");
      assert.equal(agents[1].name, "agent-2");
    });

    it("handles comments", () => {
      const result = parseToml(`
# This is a comment
id = "value"  # inline comment
`);

      assert.equal(result.id, "value");
    });

    it("handles booleans and numbers", () => {
      const result = parseToml(`
enabled = true
disabled = false
count = 42
ratio = 3.14
`);

      assert.equal(result.enabled, true);
      assert.equal(result.disabled, false);
      assert.equal(result.count, 42);
      assert.equal(result.ratio, 3.14);
    });

    it("handles multiline strings", () => {
      const result = parseToml(`
task = "This is a\\nmultiline\\ntask description"
`);

      assert.ok((result.task as string).includes("\n"));
    });
  });

  describe("parseTomlTemplate", () => {
    it("parses a complete template", () => {
      const toml = `
[template]
id = "code-review"
name = "Code Review Team"
description = "Multi-perspective code review with security focus"

[template.leader]
name = "review-lead"
type = "code-reviewer"
task = "Organize the code review process"

[[template.agents]]
name = "security-reviewer"
type = "security-reviewer"
task = "Check for security vulnerabilities"

[[template.agents]]
name = "performance-reviewer"
type = "performance-reviewer"
task = "Analyze performance issues"

[[template.tasks]]
subject = "Security review"
owner = "security-reviewer"

[[template.tasks]]
subject = "Performance review"
owner = "performance-reviewer"
blockedBy = ["Security review"]
`;

      const template = parseTomlTemplate(toml);

      assert.ok(template);
      assert.equal(template!.id, "code-review");
      assert.equal(template!.name, "Code Review Team");
      assert.equal(template!.leader!.name, "review-lead");
      assert.equal(template!.agents.length, 2);
      assert.equal(template!.tasks.length, 2);
      assert.deepEqual(template!.tasks[1].blockedBy, ["Security review"]);
    });

    it("returns null for invalid TOML", () => {
      const template = parseTomlTemplate("not valid toml [[[[");
      assert.equal(template, null);
    });

    it("handles template without leader", () => {
      const toml = `
[template]
id = "simple"
name = "Simple Template"
description = "No leader"
`;

      const template = parseTomlTemplate(toml);
      assert.ok(template);
      assert.equal(template!.leader, undefined);
    });
  });

  describe("validateTomlTemplate", () => {
    it("validates a correct template", () => {
      const template = {
        id: "test",
        name: "Test",
        description: "Test template",
        agents: [{ name: "worker", type: "executor", task: "Do work" }],
        tasks: [{ subject: "Task 1", owner: "worker" }],
      };

      const errors = validateTomlTemplate(template);
      assert.deepEqual(errors, []);
    });

    it("detects missing id", () => {
      const template = {
        id: "",
        name: "Test",
        description: "Test",
        agents: [],
        tasks: [],
      };

      const errors = validateTomlTemplate(template);
      assert.ok(errors.some((e) => e.includes("'id'")));
    });

    it("detects duplicate task subjects", () => {
      const template = {
        id: "test",
        name: "Test",
        description: "Test",
        agents: [],
        tasks: [
          { subject: "Task A", owner: "agent1" },
          { subject: "Task A", owner: "agent2" },
        ],
      };

      const errors = validateTomlTemplate(template);
      assert.ok(errors.some((e) => e.includes("Duplicate task subject")));
    });

    it("detects invalid blockedBy references", () => {
      const template = {
        id: "test",
        name: "Test",
        description: "Test",
        agents: [],
        tasks: [{ subject: "Task A", owner: "agent1", blockedBy: ["NonExistent"] }],
      };

      const errors = validateTomlTemplate(template);
      assert.ok(errors.some((e) => e.includes("blockedBy non-existent")));
    });

    it("detects unknown task owners", () => {
      const template = {
        id: "test",
        name: "Test",
        description: "Test",
        agents: [],
        tasks: [{ subject: "Task A", owner: "unknown-agent" }],
      };

      const errors = validateTomlTemplate(template);
      assert.ok(errors.some((e) => e.includes("unknown owner")));
    });
  });

  describe("formatTomlTemplate", () => {
    it("formats template for display", () => {
      const template = {
        id: "test",
        name: "Test Template",
        description: "A test template",
        leader: { name: "lead", type: "planner", task: "Lead the team" },
        agents: [{ name: "worker", type: "executor", task: "Do work" }],
        tasks: [{ subject: "Task 1", owner: "worker" }],
      };

      const formatted = formatTomlTemplate(template);
      assert.ok(formatted.includes("Test Template"));
      assert.ok(formatted.includes("Leader: lead"));
      assert.ok(formatted.includes("worker"));
      assert.ok(formatted.includes("Task 1"));
    });
  });
});

describe("TOML File Operations", () => {
  let testDir: string;

  before(() => {
    testDir = join(tmpdir(), `toml-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  after(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("loads template from file", () => {
    const filePath = join(testDir, "test.toml");
    writeFileSync(filePath, `
[template]
id = "file-test"
name = "File Test"
description = "Loaded from file"
`);

    const template = loadTomlTemplate(filePath);
    assert.ok(template);
    assert.equal(template!.id, "file-test");
  });

  it("returns null for non-existent file", () => {
    const template = loadTomlTemplate("/nonexistent/path/file.toml");
    assert.equal(template, null);
  });

  it("loads all templates from directory", () => {
    writeFileSync(join(testDir, "template1.toml"), `
[template]
id = "tpl-1"
name = "Template 1"
description = "First"
`);

    writeFileSync(join(testDir, "template2.toml"), `
[template]
id = "tpl-2"
name = "Template 2"
description = "Second"
`);

    const templates = loadTomlTemplates(testDir);
    assert.ok(templates.length >= 2);
    assert.ok(templates.some((t) => t.id === "tpl-1"));
    assert.ok(templates.some((t) => t.id === "tpl-2"));
  });

  it("returns empty array for non-existent directory", () => {
    const templates = loadTomlTemplates("/nonexistent/directory");
    assert.deepEqual(templates, []);
  });
});
