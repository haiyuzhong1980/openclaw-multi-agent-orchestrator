import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { planCustomTracks } from "../src/track-templates.ts";

describe("planCustomTracks", () => {
  it("builds tracks from templateIds", () => {
    const tracks = planCustomTracks({ templateIds: ["security-audit"] });
    assert.equal(tracks.length, 1);
    assert.equal(tracks[0].trackId, "security-audit-track");
    assert.equal(tracks[0].label, "Security Audit");
  });

  it("builds multiple tracks from multiple templateIds", () => {
    const tracks = planCustomTracks({ templateIds: ["security-audit", "code-review"] });
    assert.equal(tracks.length, 2);
    const ids = tracks.map((t) => t.trackId);
    assert.ok(ids.includes("security-audit-track"));
    assert.ok(ids.includes("code-review-track"));
  });

  it("builds tracks from customTracks", () => {
    const tracks = planCustomTracks({
      customTracks: [{ trackId: "my-track", label: "My Track", goal: "Do something custom" }],
    });
    assert.equal(tracks.length, 1);
    assert.equal(tracks[0].trackId, "my-track");
    assert.equal(tracks[0].label, "My Track");
    assert.equal(tracks[0].goal, "Do something custom");
  });

  it("combines templateIds and customTracks", () => {
    const tracks = planCustomTracks({
      templateIds: ["security-audit"],
      customTracks: [{ trackId: "custom-1", label: "Custom One", goal: "Custom goal" }],
    });
    assert.equal(tracks.length, 2);
    const ids = tracks.map((t) => t.trackId);
    assert.ok(ids.includes("security-audit-track"));
    assert.ok(ids.includes("custom-1"));
  });

  it("skips unknown templateIds gracefully", () => {
    const tracks = planCustomTracks({ templateIds: ["nonexistent-template-xyz"] });
    assert.equal(tracks.length, 0);
  });

  it("skips unknown templateIds but keeps valid ones", () => {
    const tracks = planCustomTracks({ templateIds: ["nonexistent-xyz", "security-audit"] });
    assert.equal(tracks.length, 1);
    assert.equal(tracks[0].trackId, "security-audit-track");
  });

  it("returns empty array when both templateIds and customTracks are empty", () => {
    const tracks = planCustomTracks({ templateIds: [], customTracks: [] });
    assert.equal(tracks.length, 0);
  });

  it("returns empty array when called with no params", () => {
    const tracks = planCustomTracks({});
    assert.equal(tracks.length, 0);
  });

  it("includes windowDays in subagentPrompt when request contains time window", () => {
    const tracks = planCustomTracks({
      templateIds: ["security-audit"],
      request: "last 7 days",
    });
    assert.ok(tracks[0].subagentPrompt.includes("7"));
    assert.ok(tracks[0].subagentPrompt.includes("Time window"));
  });

  it("customTrack subagentPrompt contains label and goal", () => {
    const tracks = planCustomTracks({
      customTracks: [{ trackId: "ct-1", label: "My Custom Track", goal: "Find XYZ" }],
    });
    assert.ok(tracks[0].subagentPrompt.includes("My Custom Track"));
    assert.ok(tracks[0].subagentPrompt.includes("Find XYZ"));
  });

  it("customTrack has default outputContract and failureContract", () => {
    const tracks = planCustomTracks({
      customTracks: [{ trackId: "ct-2", label: "Another Track", goal: "Some goal" }],
    });
    assert.ok(Array.isArray(tracks[0].outputContract));
    assert.ok(tracks[0].outputContract.length > 0);
    assert.ok(Array.isArray(tracks[0].failureContract));
    assert.ok(tracks[0].failureContract.length > 0);
  });
});
