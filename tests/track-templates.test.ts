import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  TRACK_TEMPLATES,
  findTemplate,
  listTemplates,
  buildTrackFromTemplate,
} from "../src/track-templates.ts";

describe("TRACK_TEMPLATES", () => {
  it("has exactly 10 entries", () => {
    assert.equal(TRACK_TEMPLATES.length, 10);
  });

  it("each entry has required fields", () => {
    for (const t of TRACK_TEMPLATES) {
      assert.ok(t.id, `missing id`);
      assert.ok(t.name, `missing name in ${t.id}`);
      assert.ok(t.description, `missing description in ${t.id}`);
      assert.ok(t.category, `missing category in ${t.id}`);
      assert.ok(t.defaultGoal, `missing defaultGoal in ${t.id}`);
      assert.ok(Array.isArray(t.outputContract), `outputContract not array in ${t.id}`);
      assert.ok(Array.isArray(t.failureContract), `failureContract not array in ${t.id}`);
    }
  });
});

describe("findTemplate", () => {
  it("finds by exact ID", () => {
    const t = findTemplate("security-audit");
    assert.ok(t);
    assert.equal(t.id, "security-audit");
  });

  it("finds by partial name keyword", () => {
    const t = findTemplate("GitHub Issues");
    assert.ok(t);
    assert.equal(t.id, "github-issues");
  });

  it("finds by keyword in description (case-insensitive)", () => {
    const t = findTemplate("performance");
    assert.ok(t);
    assert.equal(t.id, "performance-review");
  });

  it("returns undefined for unknown query", () => {
    const t = findTemplate("completely-unknown-xyz");
    assert.equal(t, undefined);
  });

  it("is case-insensitive for exact ID match", () => {
    const t = findTemplate("SECURITY-AUDIT");
    // ID comparison is lowercased, so this should still match
    assert.ok(t);
    assert.equal(t.id, "security-audit");
  });
});

describe("listTemplates", () => {
  it("returns all templates when no category given", () => {
    const all = listTemplates();
    assert.equal(all.length, TRACK_TEMPLATES.length);
  });

  it("returns only research templates when filtering by 'research'", () => {
    const research = listTemplates("research");
    assert.ok(research.length > 0);
    for (const t of research) {
      assert.equal(t.category, "research");
    }
  });

  it("returns only audit templates when filtering by 'audit'", () => {
    const audit = listTemplates("audit");
    assert.ok(audit.length > 0);
    for (const t of audit) {
      assert.equal(t.category, "audit");
    }
  });

  it("returns empty array for unknown category", () => {
    const result = listTemplates("nonexistent-category");
    assert.equal(result.length, 0);
  });

  it("returns only development templates when filtering by 'development'", () => {
    const dev = listTemplates("development");
    assert.ok(dev.length > 0);
    for (const t of dev) {
      assert.equal(t.category, "development");
    }
  });
});

describe("buildTrackFromTemplate", () => {
  const template = TRACK_TEMPLATES.find((t) => t.id === "security-audit")!;

  it("returns a PlannedTrack with correct trackId", () => {
    const track = buildTrackFromTemplate(template);
    assert.equal(track.trackId, "security-audit-track");
  });

  it("uses template defaultGoal when no customGoal given", () => {
    const track = buildTrackFromTemplate(template);
    assert.equal(track.goal, template.defaultGoal);
  });

  it("uses customGoal when provided", () => {
    const track = buildTrackFromTemplate(template, "Custom security goal");
    assert.equal(track.goal, "Custom security goal");
  });

  it("sets label from template name", () => {
    const track = buildTrackFromTemplate(template);
    assert.equal(track.label, template.name);
  });

  it("includes outputContract and failureContract", () => {
    const track = buildTrackFromTemplate(template);
    assert.deepEqual(track.outputContract, template.outputContract);
    assert.deepEqual(track.failureContract, template.failureContract);
  });

  it("includes windowDays in subagentPrompt when provided", () => {
    const track = buildTrackFromTemplate(template, undefined, 14);
    assert.ok(track.subagentPrompt.includes("14"));
    assert.ok(track.subagentPrompt.includes("Time window"));
  });

  it("does not include time window line when windowDays is null", () => {
    const track = buildTrackFromTemplate(template, undefined, null);
    assert.ok(!track.subagentPrompt.includes("Time window"));
  });

  it("subagentPrompt contains template name", () => {
    const track = buildTrackFromTemplate(template);
    assert.ok(track.subagentPrompt.includes(template.name));
  });

  it("subagentPrompt contains output contract items", () => {
    const track = buildTrackFromTemplate(template);
    for (const item of template.outputContract) {
      assert.ok(track.subagentPrompt.includes(item));
    }
  });

  it("subagentPrompt contains failure contract items", () => {
    const track = buildTrackFromTemplate(template);
    for (const item of template.failureContract) {
      assert.ok(track.subagentPrompt.includes(item));
    }
  });
});
