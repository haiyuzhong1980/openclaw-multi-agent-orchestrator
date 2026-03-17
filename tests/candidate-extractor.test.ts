import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractCandidateItems,
  classifyTrack,
  dedupeItems,
  extractCommentCount,
} from "../src/candidate-extractor.ts";
import type { ClassifiedTrack } from "../src/candidate-extractor.ts";

describe("extractCommentCount", () => {
  it("parses 评论数: 5", () => {
    assert.equal(extractCommentCount("评论数: 5"), 5);
  });

  it("parses 3 评论", () => {
    assert.equal(extractCommentCount("3 评论"), 3);
  });

  it("parses comments: 10", () => {
    assert.equal(extractCommentCount("comments: 10"), 10);
  });

  it("parses 12 comments inline", () => {
    assert.equal(extractCommentCount("This issue has 12 comments"), 12);
  });

  it("returns null when no match", () => {
    assert.equal(extractCommentCount("no comment info here"), null);
  });

  it("parses 评论数：5 with fullwidth colon", () => {
    assert.equal(extractCommentCount("评论数：5"), 5);
  });

  it("parses comment count with surrounding text", () => {
    assert.equal(extractCommentCount("Active issue https://github.com/foo/bar/issues/1 评论数: 7"), 7);
  });
});

describe("extractCandidateItems", () => {
  it("extracts GitHub issue URLs from text", () => {
    const text = "- Some issue https://github.com/foo/bar/issues/1 评论数: 3";
    const items = extractCandidateItems(text, 10, "issues");
    assert.equal(items.length, 1);
    assert.equal(items[0].url, "https://github.com/foo/bar/issues/1");
  });

  it("filters noise lines and keeps valid URL lines", () => {
    const text = [
      "EXTERNAL_UNTRUSTED_CONTENT",
      "Page not found",
      "- Real issue https://github.com/foo/bar/issues/42 评论数: 5",
    ].join("\n");
    const items = extractCandidateItems(text, 10, "issues");
    assert.equal(items.length, 1);
    assert.equal(items[0].url, "https://github.com/foo/bar/issues/42");
  });

  it("respects maxItemsPerTrack limit", () => {
    const lines = Array.from({ length: 10 }, (_, i) =>
      `- Issue ${i} https://github.com/foo/bar/issues/${i + 1} 评论数: ${i + 1}`,
    ).join("\n");
    const items = extractCandidateItems(lines, 3, "issues");
    assert.equal(items.length, 3);
  });

  it("deduplicates URLs within single track", () => {
    const text = [
      "- First mention https://github.com/foo/bar/issues/10 评论数: 5",
      "- Duplicate https://github.com/foo/bar/issues/10 评论数: 5",
    ].join("\n");
    const items = extractCandidateItems(text, 10, "issues");
    assert.equal(items.length, 1);
  });

  it("rejects discussion URLs for issues track kind", () => {
    const text = "- Discussion https://github.com/foo/bar/discussions/99 评论数: 3";
    const items = extractCandidateItems(text, 10, "issues");
    assert.equal(items.length, 0);
  });

  it("accepts any GitHub URL for generic track kind", () => {
    const text = "- Item https://github.com/foo/bar/issues/1 评论数: 5";
    const items = extractCandidateItems(text, 10, "generic");
    assert.equal(items.length, 1);
  });

  it("filters out items with zero comment count", () => {
    const text = "- Stale https://github.com/foo/bar/issues/5 评论数: 0";
    const items = extractCandidateItems(text, 10, "issues");
    assert.equal(items.length, 0);
  });

  it("includes items where comment count is null (unknown)", () => {
    const text = "- Unknown https://github.com/foo/bar/issues/8";
    const items = extractCandidateItems(text, 10, "issues");
    assert.equal(items.length, 1);
    assert.equal(items[0].comments, null);
  });
});

describe("classifyTrack", () => {
  it("returns status ok for clean results", () => {
    const track = {
      trackId: "issues-track",
      label: "Issues",
      resultText: "- Real issue https://github.com/foo/bar/issues/1 评论数: 5",
    };
    const result = classifyTrack(track, 10);
    assert.equal(result.status, "ok");
    assert.equal(result.items.length, 1);
    assert.deepEqual(result.dirtyReasons, []);
  });

  it("returns status partial for mixed clean + dirty results", () => {
    const track = {
      trackId: "issues-track",
      label: "Issues",
      resultText: [
        "Page not found",
        "- Valid https://github.com/foo/bar/issues/2 评论数: 3",
      ].join("\n"),
    };
    const result = classifyTrack(track, 10);
    assert.equal(result.status, "partial");
    assert.equal(result.items.length, 1);
    assert.ok(result.dirtyReasons.length > 0);
  });

  it("returns status failed for all dirty results", () => {
    const track = {
      trackId: "issues-track",
      label: "Issues",
      resultText: "Page not found\nEXTERNAL_UNTRUSTED_CONTENT",
    };
    const result = classifyTrack(track, 10);
    assert.equal(result.status, "failed");
    assert.equal(result.items.length, 0);
  });

  it("sorts items by comment count descending", () => {
    const track = {
      trackId: "issues-track",
      label: "Issues",
      resultText: [
        "- Low https://github.com/foo/bar/issues/1 评论数: 2",
        "- High https://github.com/foo/bar/issues/2 评论数: 10",
        "- Mid https://github.com/foo/bar/issues/3 评论数: 5",
      ].join("\n"),
    };
    const result = classifyTrack(track, 10);
    assert.equal(result.items[0].comments, 10);
    assert.equal(result.items[1].comments, 5);
    assert.equal(result.items[2].comments, 2);
  });

  it("uses trackId as label when label is not provided", () => {
    const track = {
      trackId: "issues-track",
      resultText: "- Item https://github.com/foo/bar/issues/9 评论数: 1",
    };
    const result = classifyTrack(track, 10);
    assert.equal(result.label, "issues-track");
  });

  it("marks dirty reason for wrong URL type in issues track", () => {
    const track = {
      trackId: "issues-track",
      label: "Issues",
      resultText: "- Discussion https://github.com/foo/bar/discussions/1 评论数: 3",
    };
    const result = classifyTrack(track, 10);
    assert.ok(result.dirtyReasons.some((r) => r.includes("链接类型不符")));
  });
});

describe("dedupeItems", () => {
  it("deduplicates items with the same URL across tracks", () => {
    const tracks: ClassifiedTrack[] = [
      {
        trackId: "issues-track",
        label: "Issues",
        status: "ok",
        items: [{ title: "A", url: "https://github.com/foo/bar/issues/1", raw: "...", comments: 3 }],
        dirtyReasons: [],
        summaryLine: "",
      },
      {
        trackId: "issues-track-2",
        label: "Issues 2",
        status: "ok",
        items: [{ title: "A dup", url: "https://github.com/foo/bar/issues/1", raw: "...", comments: 3 }],
        dirtyReasons: [],
        summaryLine: "",
      },
    ];
    const { deduped, duplicates } = dedupeItems(tracks);
    assert.equal(deduped.length, 1);
    assert.equal(duplicates, 1);
  });

  it("keeps all items with different URLs", () => {
    const tracks: ClassifiedTrack[] = [
      {
        trackId: "issues-track",
        label: "Issues",
        status: "ok",
        items: [
          { title: "A", url: "https://github.com/foo/bar/issues/1", raw: "...", comments: 3 },
          { title: "B", url: "https://github.com/foo/bar/issues/2", raw: "...", comments: 5 },
        ],
        dirtyReasons: [],
        summaryLine: "",
      },
    ];
    const { deduped, duplicates } = dedupeItems(tracks);
    assert.equal(deduped.length, 2);
    assert.equal(duplicates, 0);
  });

  it("correctly counts multiple duplicates", () => {
    const sharedItem = { title: "Dup", url: "https://github.com/foo/bar/issues/99", raw: "...", comments: 1 };
    const tracks: ClassifiedTrack[] = [
      { trackId: "t1", label: "T1", status: "ok", items: [sharedItem], dirtyReasons: [], summaryLine: "" },
      { trackId: "t2", label: "T2", status: "ok", items: [sharedItem], dirtyReasons: [], summaryLine: "" },
      { trackId: "t3", label: "T3", status: "ok", items: [sharedItem], dirtyReasons: [], summaryLine: "" },
    ];
    const { deduped, duplicates } = dedupeItems(tracks);
    assert.equal(deduped.length, 1);
    assert.equal(duplicates, 2);
  });

  it("returns empty deduped and zero duplicates for empty tracks", () => {
    const { deduped, duplicates } = dedupeItems([]);
    assert.equal(deduped.length, 0);
    assert.equal(duplicates, 0);
  });

  it("includes trackId and label on deduped items", () => {
    const tracks: ClassifiedTrack[] = [
      {
        trackId: "issues-track",
        label: "Issues",
        status: "ok",
        items: [{ title: "A", url: "https://github.com/foo/bar/issues/7", raw: "...", comments: 2 }],
        dirtyReasons: [],
        summaryLine: "",
      },
    ];
    const { deduped } = dedupeItems(tracks);
    assert.equal(deduped[0].trackId, "issues-track");
    assert.equal(deduped[0].label, "Issues");
  });
});
