import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { looksLikeNoiseLine, cleanInlineText } from "../src/noise-filter.ts";

describe("looksLikeNoiseLine", () => {
  it("returns true for empty string", () => {
    assert.equal(looksLikeNoiseLine(""), true);
  });

  it("returns true for whitespace-only string", () => {
    assert.equal(looksLikeNoiseLine("   "), true);
  });

  it("returns true for EXTERNAL_UNTRUSTED_CONTENT marker", () => {
    assert.equal(looksLikeNoiseLine("EXTERNAL_UNTRUSTED_CONTENT"), true);
  });

  it("returns true for Page not found", () => {
    assert.equal(looksLikeNoiseLine("Page not found"), true);
  });

  it("returns true for web_fetch failed", () => {
    assert.equal(looksLikeNoiseLine("web_fetch failed: connection refused"), true);
  });

  it("returns true for <html tag", () => {
    assert.equal(looksLikeNoiseLine("<html lang='en'>"), true);
  });

  it('returns true for ```json marker', () => {
    assert.equal(looksLikeNoiseLine("```json"), true);
  });

  it("returns true for NO_REPLY marker", () => {
    assert.equal(looksLikeNoiseLine("NO_REPLY"), true);
  });

  it("returns true for browser service ready tool log", () => {
    assert.equal(looksLikeNoiseLine("browser service ready"), true);
  });

  it("returns true for tracked_run_pulse tool log", () => {
    assert.equal(looksLikeNoiseLine("tracked_run_pulse"), true);
  });

  it('returns true for JSON object starting with "{"', () => {
    assert.equal(looksLikeNoiseLine('{"name": "test"}'), true);
  });

  it('returns true for JSON array starting with "["', () => {
    assert.equal(looksLikeNoiseLine('[{"id": 1}]'), true);
  });

  it("returns true for line longer than 500 characters", () => {
    const longLine = "a".repeat(501);
    assert.equal(looksLikeNoiseLine(longLine), true);
  });

  it("returns false for normal text about performance", () => {
    assert.equal(looksLikeNoiseLine("Good issue about performance"), false);
  });

  it("returns false for URL-only line", () => {
    assert.equal(looksLikeNoiseLine("https://github.com/foo/bar"), false);
  });

  it('returns false for "Error 404 handling" (bare 404 not a marker)', () => {
    assert.equal(looksLikeNoiseLine("Error 404 handling"), false);
  });

  it("returns false for line exactly 500 characters long", () => {
    const line = "a".repeat(500);
    assert.equal(looksLikeNoiseLine(line), false);
  });

  it("returns true for sendMessage ok tool log", () => {
    assert.equal(looksLikeNoiseLine("sendMessage ok"), true);
  });

  it("returns true for tracked_run_completed tool log", () => {
    assert.equal(looksLikeNoiseLine("tracked_run_completed"), true);
  });

  it('returns true for known JSON field key "name"', () => {
    assert.equal(looksLikeNoiseLine('"name": "something"'), true);
  });

  it('returns true for known JSON field key "github_url"', () => {
    assert.equal(looksLikeNoiseLine('"github_url": "https://github.com/foo/bar"'), true);
  });

  it("returns true for closing JSON bracket", () => {
    assert.equal(looksLikeNoiseLine("}"), true);
  });

  it("returns true for closing JSON array bracket", () => {
    assert.equal(looksLikeNoiseLine("]"), true);
  });

  it("returns true for <!DOCTYPE html", () => {
    assert.equal(looksLikeNoiseLine("<!DOCTYPE html>"), true);
  });
});

describe("cleanInlineText", () => {
  it("strips BEGIN_UNTRUSTED_CHILD_RESULT wrapper", () => {
    const result = cleanInlineText("<<<BEGIN_UNTRUSTED_CHILD_RESULT>>>some content");
    assert.ok(!result.includes("<<<BEGIN_UNTRUSTED_CHILD_RESULT>>>"));
    assert.ok(result.includes("some content"));
  });

  it("strips END_UNTRUSTED_CHILD_RESULT wrapper", () => {
    const result = cleanInlineText("some content<<<END_UNTRUSTED_CHILD_RESULT>>>");
    assert.ok(!result.includes("<<<END_UNTRUSTED_CHILD_RESULT>>>"));
    assert.ok(result.includes("some content"));
  });

  it("strips triple backticks", () => {
    const result = cleanInlineText("```json\n{}\n```");
    assert.ok(!result.includes("```"));
  });

  it("collapses multiple whitespace to single space", () => {
    const result = cleanInlineText("hello   world\t\nfoo");
    assert.equal(result, "hello world foo");
  });

  it("trims leading and trailing whitespace", () => {
    const result = cleanInlineText("  hello  ");
    assert.equal(result, "hello");
  });

  it("handles empty string", () => {
    assert.equal(cleanInlineText(""), "");
  });

  it("removes both wrapper markers from the same string", () => {
    const result = cleanInlineText("<<<BEGIN_UNTRUSTED_CHILD_RESULT>>>data<<<END_UNTRUSTED_CHILD_RESULT>>>");
    assert.ok(!result.includes("<<<"));
    assert.ok(result.includes("data"));
  });
});
