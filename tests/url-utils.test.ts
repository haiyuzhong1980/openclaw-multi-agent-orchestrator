import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeUrl, inferTrackKind, urlMatchesTrack } from "../src/url-utils.ts";

describe("normalizeUrl", () => {
  it("strips trailing closing parenthesis", () => {
    assert.equal(normalizeUrl("https://github.com/foo/bar)"), "https://github.com/foo/bar");
  });

  it("strips trailing comma", () => {
    assert.equal(normalizeUrl("https://github.com/foo/bar,"), "https://github.com/foo/bar");
  });

  it("strips trailing period", () => {
    assert.equal(normalizeUrl("https://github.com/foo/bar."), "https://github.com/foo/bar");
  });

  it("strips trailing semicolon", () => {
    assert.equal(normalizeUrl("https://github.com/foo/bar;"), "https://github.com/foo/bar");
  });

  it("strips trailing closing square bracket", () => {
    assert.equal(normalizeUrl("https://github.com/foo/bar]"), "https://github.com/foo/bar");
  });

  it("strips trailing angle bracket", () => {
    assert.equal(normalizeUrl("https://github.com/foo/bar>"), "https://github.com/foo/bar");
  });

  it("strips multiple trailing punctuation characters", () => {
    assert.equal(normalizeUrl("https://github.com/foo/bar)."), "https://github.com/foo/bar");
  });

  it("leaves clean URL unchanged", () => {
    const url = "https://github.com/foo/bar/issues/123";
    assert.equal(normalizeUrl(url), url);
  });

  it("leaves URL with path unchanged", () => {
    const url = "https://github.com/foo/bar/discussions/42";
    assert.equal(normalizeUrl(url), url);
  });

  it("strips trailing semicolons and commas in sequence", () => {
    assert.equal(normalizeUrl("https://github.com/foo/bar;,"), "https://github.com/foo/bar");
  });
});

describe("inferTrackKind", () => {
  it('returns "issues" for "issues-track"', () => {
    assert.equal(inferTrackKind("issues-track"), "issues");
  });

  it('returns "discussions" for "discussions-track"', () => {
    assert.equal(inferTrackKind("discussions-track"), "discussions");
  });

  it('returns "skills" for "skills-track"', () => {
    assert.equal(inferTrackKind("skills-track"), "skills");
  });

  it('returns "generic" for unrecognized track', () => {
    assert.equal(inferTrackKind("random"), "generic");
  });

  it('returns "skills" for track containing "plugin"', () => {
    assert.equal(inferTrackKind("plugin-track"), "skills");
  });

  it('is case-insensitive for "Issues-Track"', () => {
    assert.equal(inferTrackKind("Issues-Track"), "issues");
  });

  it('returns "generic" for empty string', () => {
    assert.equal(inferTrackKind(""), "generic");
  });
});

describe("urlMatchesTrack", () => {
  it("returns true for issues kind + issue URL", () => {
    assert.equal(urlMatchesTrack("https://github.com/foo/bar/issues/123", "issues"), true);
  });

  it("returns false for issues kind + discussion URL", () => {
    assert.equal(urlMatchesTrack("https://github.com/foo/bar/discussions/42", "issues"), false);
  });

  it("returns true for discussions kind + discussion URL", () => {
    assert.equal(urlMatchesTrack("https://github.com/foo/bar/discussions/42", "discussions"), true);
  });

  it("returns false for discussions kind + issue URL", () => {
    assert.equal(urlMatchesTrack("https://github.com/foo/bar/issues/99", "discussions"), false);
  });

  it("returns true for skills kind + repo URL", () => {
    assert.equal(urlMatchesTrack("https://github.com/foo/bar", "skills"), true);
  });

  it("returns true for generic kind + any GitHub URL", () => {
    assert.equal(urlMatchesTrack("https://github.com/foo/bar/issues/1", "generic"), true);
  });

  it("returns true for generic kind + discussion URL", () => {
    assert.equal(urlMatchesTrack("https://github.com/foo/bar/discussions/5", "generic"), true);
  });

  it("returns false for issues kind + repo-only URL without issue number", () => {
    assert.equal(urlMatchesTrack("https://github.com/foo/bar", "issues"), false);
  });
});
