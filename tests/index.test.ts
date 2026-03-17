/**
 * Tests for index.ts behavior via createMultiAgentOrchestratorTool (src/tool.ts).
 *
 * index.ts requires openclaw/plugin-sdk and @sinclair/typebox which are not
 * installed in the extension's local node_modules. Node 22.16 does not support
 * mock.module in node:test. Instead, we test all observable plugin behaviour
 * through createMultiAgentOrchestratorTool, which is the core factory used by
 * register(), covering:
 *
 *   - tool name / label / description
 *   - default policy is "delegation-first" (matches index.ts default)
 *   - custom executionPolicy from config
 *   - plan_tracks action
 *   - validate_and_merge action
 *   - enforce_execution_policy action
 *   - unsupported action throws
 *   - empty tracks throws
 *   - missing trackId throws
 *   - missing resultText throws
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createMultiAgentOrchestratorTool } from "../src/tool.ts";

// Helper: create a tool with the same defaults as index.ts uses
function createDefaultTool(overrides?: Parameters<typeof createMultiAgentOrchestratorTool>[0]) {
  return createMultiAgentOrchestratorTool({
    executionPolicy: "delegation-first",
    delegationStartGate: "required",
    maxItemsPerTrack: 8,
    ...overrides,
  });
}

describe("plugin tool registration behavior", () => {
  it("tool has name multi-agent-orchestrator", () => {
    const tool = createDefaultTool();
    assert.equal(tool.name, "multi-agent-orchestrator");
  });

  it("tool has a non-empty label", () => {
    const tool = createDefaultTool();
    assert.ok(tool.label && tool.label.length > 0);
  });

  it("tool has a non-empty description", () => {
    const tool = createDefaultTool();
    assert.ok(tool.description && tool.description.length > 0);
  });

  it("tool has execute function", () => {
    const tool = createDefaultTool();
    assert.equal(typeof tool.execute, "function");
  });

  it("default policy is delegation-first (matches index.ts default)", () => {
    const tool = createDefaultTool({ executionPolicy: "delegation-first" });
    assert.ok(tool.name === "multi-agent-orchestrator");
    // Verify policy is reflected in enforce_execution_policy output
    return tool.execute("t1", {
      action: "enforce_execution_policy",
      request: "hello",
    }).then((result) => {
      const text = String(result.content?.[0]?.text ?? "");
      assert.ok(text.includes("delegation-first"));
    });
  });

  it("custom policy from config is used in enforcement report", async () => {
    const tool = createMultiAgentOrchestratorTool({
      executionPolicy: "free",
      delegationStartGate: "off",
    });
    const result = await tool.execute("t2", {
      action: "enforce_execution_policy",
      request: "hello",
    });
    const text = String(result.content?.[0]?.text ?? "");
    assert.ok(text.includes("free"));
  });
});

describe("plugin action: plan_tracks", () => {
  it("returns a planning report for issues request", async () => {
    const tool = createDefaultTool();
    const result = await tool.execute("t3", {
      action: "plan_tracks",
      request: "查 issues 最近 7 天",
    });
    const text = String(result.content?.[0]?.text ?? "");
    assert.ok(text.includes("协同计划"));
  });

  it("result details contains tracks array", async () => {
    const tool = createDefaultTool();
    const result = await tool.execute("t4", {
      action: "plan_tracks",
      request: "查 issues",
    });
    assert.ok(Array.isArray((result as any).details?.tracks));
    assert.ok((result as any).details.tracks.length > 0);
  });

  it("result details contains windowDays when specified", async () => {
    const tool = createDefaultTool();
    const result = await tool.execute("t5", {
      action: "plan_tracks",
      request: "查 issues 最近 7 天",
    });
    assert.equal((result as any).details?.windowDays, 7);
  });
});

describe("plugin action: validate_and_merge", () => {
  it("validates and merges clean issue tracks", async () => {
    const tool = createDefaultTool();
    const result = await tool.execute("t6", {
      action: "validate_and_merge",
      tracks: [
        {
          trackId: "issues-track",
          label: "Issues",
          resultText: "- Real issue https://github.com/foo/bar/issues/5 评论数: 3",
        },
      ],
    });
    const text = String(result.content?.[0]?.text ?? "");
    assert.ok(text.length > 0);
  });

  it("throws when tracks is empty array", async () => {
    const tool = createDefaultTool();
    await assert.rejects(
      () => tool.execute("t7", { action: "validate_and_merge", tracks: [] }),
      /tracks required/,
    );
  });

  it("throws when track is missing trackId", async () => {
    const tool = createDefaultTool();
    await assert.rejects(
      () =>
        tool.execute("t8", {
          action: "validate_and_merge",
          tracks: [{ resultText: "some text" }],
        }),
      /trackId/,
    );
  });

  it("throws when track is missing resultText", async () => {
    const tool = createDefaultTool();
    await assert.rejects(
      () =>
        tool.execute("t9", {
          action: "validate_and_merge",
          tracks: [{ trackId: "issues-track" }],
        }),
      /resultText/,
    );
  });

  it("details includes statusCounts", async () => {
    const tool = createDefaultTool();
    const result = await tool.execute("t10", {
      action: "validate_and_merge",
      tracks: [
        {
          trackId: "issues-track",
          label: "Issues",
          resultText: "- Real issue https://github.com/foo/bar/issues/1 评论数: 2",
        },
      ],
    });
    const counts = (result as any).details?.statusCounts;
    assert.ok(counts !== undefined);
    assert.ok(typeof counts.ok === "number");
    assert.ok(typeof counts.partial === "number");
    assert.ok(typeof counts.failed === "number");
  });
});

describe("plugin action: enforce_execution_policy", () => {
  it("returns policy report text", async () => {
    const tool = createDefaultTool();
    const result = await tool.execute("t11", {
      action: "enforce_execution_policy",
      request: "真实执行一个多 agent 调研",
      hasTaskBus: true,
      hasPlan: true,
      hasWorkerStart: true,
    });
    const text = String(result.content?.[0]?.text ?? "");
    assert.ok(text.includes("执行策略判定"));
  });

  it("returns violations array in details", async () => {
    const tool = createDefaultTool();
    const result = await tool.execute("t12", {
      action: "enforce_execution_policy",
      request: "multi agent deploy",
      hasTaskBus: false,
      hasPlan: false,
    });
    assert.ok(Array.isArray((result as any).details?.violations));
  });
});

describe("plugin action: unsupported", () => {
  it("throws for unknown action", async () => {
    const tool = createDefaultTool();
    await assert.rejects(
      () => tool.execute("t13", { action: "unknown_action" }),
      /Unsupported action/,
    );
  });
});
