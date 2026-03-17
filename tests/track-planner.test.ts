import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { inferResearchTracks, buildSubagentPrompt, inferRecentWindowDays } from "../src/track-planner.ts";

describe("inferResearchTracks", () => {
  it('returns issues track for request containing "查 issues"', () => {
    const tracks = inferResearchTracks("查 issues");
    assert.ok(tracks.some((t) => t.trackId === "issues-track"));
  });

  it('returns discussions track for request containing "查 discussions"', () => {
    const tracks = inferResearchTracks("查 discussions");
    assert.ok(tracks.some((t) => t.trackId === "discussions-track"));
  });

  it('returns skills track for request containing "查 skills"', () => {
    const tracks = inferResearchTracks("查 skills");
    assert.ok(tracks.some((t) => t.trackId === "skills-track"));
  });

  it('returns both issues and discussions tracks for "查 issues 和 discussions"', () => {
    const tracks = inferResearchTracks("查 issues 和 discussions");
    const ids = tracks.map((t) => t.trackId);
    assert.ok(ids.includes("issues-track"));
    assert.ok(ids.includes("discussions-track"));
  });

  it("returns issues track as fallback for unrelated request (not issues/discussions/skills)", () => {
    // The condition is: wantsIssues || (!wantsDiscussions && !wantsSkills)
    // When neither discussions nor skills appear, issues track is the fallback.
    const tracks = inferResearchTracks("something unrelated");
    assert.ok(tracks.some((t) => t.trackId === "issues-track"));
  });

  it("returns issues track as fallback for undefined request", () => {
    const tracks = inferResearchTracks(undefined);
    assert.ok(tracks.some((t) => t.trackId === "issues-track"));
  });

  it('sets windowDays = 7 for request containing "最近 7 天"', () => {
    const tracks = inferResearchTracks("查 issues 最近 7 天");
    const issuesTrack = tracks.find((t) => t.trackId === "issues-track");
    assert.ok(issuesTrack?.goal.includes("7"));
  });

  it('sets windowDays = 30 for request containing "last 30 days"', () => {
    const tracks = inferResearchTracks("查 issues last 30 days");
    const issuesTrack = tracks.find((t) => t.trackId === "issues-track");
    assert.ok(issuesTrack?.goal.includes("30"));
  });

  it("each returned track has a non-empty subagentPrompt", () => {
    const tracks = inferResearchTracks("查 issues");
    for (const track of tracks) {
      assert.ok(track.subagentPrompt.length > 0);
    }
  });

  it("each returned track has outputContract and failureContract arrays", () => {
    const tracks = inferResearchTracks("查 discussions");
    for (const track of tracks) {
      assert.ok(Array.isArray(track.outputContract));
      assert.ok(Array.isArray(track.failureContract));
    }
  });
});

describe("buildSubagentPrompt", () => {
  const baseParams = {
    label: "Issues",
    goal: "Find top issues",
    outputContract: ["Return only issue links"],
    failureContract: ["Say when there are no results"],
    windowDays: null,
  };

  it('starts with "你只负责" prefix', () => {
    const prompt = buildSubagentPrompt(baseParams);
    assert.ok(prompt.startsWith("你只负责"));
  });

  it("contains the goal text", () => {
    const prompt = buildSubagentPrompt(baseParams);
    assert.ok(prompt.includes("Find top issues"));
  });

  it("mentions time window when windowDays is provided", () => {
    const prompt = buildSubagentPrompt({ ...baseParams, windowDays: 14 });
    assert.ok(prompt.includes("14"));
    assert.ok(prompt.includes("时间窗口"));
  });

  it("still includes time window note when windowDays is null", () => {
    const prompt = buildSubagentPrompt(baseParams);
    assert.ok(prompt.includes("时间窗口"));
  });

  it("includes output contract items", () => {
    const prompt = buildSubagentPrompt(baseParams);
    assert.ok(prompt.includes("Return only issue links"));
  });

  it("includes failure contract items", () => {
    const prompt = buildSubagentPrompt(baseParams);
    assert.ok(prompt.includes("Say when there are no results"));
  });
});

describe("inferRecentWindowDays", () => {
  it('parses "最近 7 天" as 7', () => {
    assert.equal(inferRecentWindowDays("最近 7 天"), 7);
  });

  it('parses "last 30 days" as 30', () => {
    assert.equal(inferRecentWindowDays("last 30 days"), 30);
  });

  it("returns null for no time window", () => {
    assert.equal(inferRecentWindowDays("查 issues"), null);
  });

  it("returns null for undefined", () => {
    assert.equal(inferRecentWindowDays(undefined), null);
  });

  it('parses "最近14天" without space as 14', () => {
    assert.equal(inferRecentWindowDays("最近14天"), 14);
  });
});
