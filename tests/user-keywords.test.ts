import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadUserKeywords,
  saveUserKeywords,
  addUserKeyword,
} from "../src/user-keywords.ts";
import type { UserKeywords } from "../src/user-keywords.ts";

let testDir: string;

describe("loadUserKeywords", () => {
  beforeEach(() => {
    testDir = join(tmpdir(), `oma-test-keywords-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("returns empty object when file does not exist", () => {
    const result = loadUserKeywords(testDir);
    assert.deepEqual(result.delegation, []);
    assert.deepEqual(result.tracked, []);
    assert.deepEqual(result.light, []);
    assert.equal(result.updatedAt, "");
  });

  it("returns empty object when file is malformed JSON", () => {
    writeFileSync(join(testDir, "user-intent-keywords.json"), "not-json");
    const result = loadUserKeywords(testDir);
    assert.deepEqual(result.delegation, []);
  });

  it("loads existing keywords from file", () => {
    const data: UserKeywords = {
      delegation: ["全力推进", "深度分析"],
      tracked: ["按步骤"],
      light: ["随便看看"],
      updatedAt: "2024-01-01T00:00:00.000Z",
    };
    writeFileSync(join(testDir, "user-intent-keywords.json"), JSON.stringify(data));
    const result = loadUserKeywords(testDir);
    assert.deepEqual(result.delegation, ["全力推进", "深度分析"]);
    assert.deepEqual(result.tracked, ["按步骤"]);
    assert.deepEqual(result.light, ["随便看看"]);
  });
});

describe("saveUserKeywords / loadUserKeywords round-trip", () => {
  beforeEach(() => {
    testDir = join(tmpdir(), `oma-test-keywords-save-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("saves and reloads keywords correctly", () => {
    const keywords: UserKeywords = {
      delegation: ["全力推进"],
      tracked: ["出报告"],
      light: ["随便聊聊"],
      updatedAt: "",
    };
    saveUserKeywords(testDir, keywords);
    const loaded = loadUserKeywords(testDir);
    assert.deepEqual(loaded.delegation, ["全力推进"]);
    assert.deepEqual(loaded.tracked, ["出报告"]);
    assert.deepEqual(loaded.light, ["随便聊聊"]);
  });

  it("save updates the updatedAt field", () => {
    const before = new Date().toISOString();
    const keywords: UserKeywords = { delegation: [], tracked: [], light: [], updatedAt: "" };
    saveUserKeywords(testDir, keywords);
    const loaded = loadUserKeywords(testDir);
    assert.ok(loaded.updatedAt >= before);
  });

  it("saves to correct file path", () => {
    const keywords: UserKeywords = { delegation: ["test"], tracked: [], light: [], updatedAt: "" };
    saveUserKeywords(testDir, keywords);
    assert.ok(existsSync(join(testDir, "user-intent-keywords.json")));
  });
});

describe("addUserKeyword", () => {
  it("adds phrase to delegation tier", () => {
    const keywords: UserKeywords = { delegation: [], tracked: [], light: [], updatedAt: "" };
    addUserKeyword(keywords, "delegation", "全力推进");
    assert.deepEqual(keywords.delegation, ["全力推进"]);
    assert.deepEqual(keywords.tracked, []);
  });

  it("adds phrase to tracked tier", () => {
    const keywords: UserKeywords = { delegation: [], tracked: [], light: [], updatedAt: "" };
    addUserKeyword(keywords, "tracked", "按步骤来");
    assert.deepEqual(keywords.tracked, ["按步骤来"]);
  });

  it("adds phrase to light tier", () => {
    const keywords: UserKeywords = { delegation: [], tracked: [], light: [], updatedAt: "" };
    addUserKeyword(keywords, "light", "随便看看");
    assert.deepEqual(keywords.light, ["随便看看"]);
  });

  it("normalizes phrase to lowercase", () => {
    const keywords: UserKeywords = { delegation: [], tracked: [], light: [], updatedAt: "" };
    addUserKeyword(keywords, "delegation", "FullForce");
    assert.deepEqual(keywords.delegation, ["fullforce"]);
  });

  it("trims whitespace from phrase", () => {
    const keywords: UserKeywords = { delegation: [], tracked: [], light: [], updatedAt: "" };
    addUserKeyword(keywords, "tracked", "  出报告  ");
    assert.deepEqual(keywords.tracked, ["出报告"]);
  });

  it("does not add duplicate phrases", () => {
    const keywords: UserKeywords = { delegation: [], tracked: [], light: [], updatedAt: "" };
    addUserKeyword(keywords, "delegation", "全力推进");
    addUserKeyword(keywords, "delegation", "全力推进");
    assert.equal(keywords.delegation.length, 1);
  });

  it("does not add empty phrase", () => {
    const keywords: UserKeywords = { delegation: [], tracked: [], light: [], updatedAt: "" };
    addUserKeyword(keywords, "delegation", "  ");
    assert.equal(keywords.delegation.length, 0);
  });

  it("can add to multiple tiers independently", () => {
    const keywords: UserKeywords = { delegation: [], tracked: [], light: [], updatedAt: "" };
    addUserKeyword(keywords, "delegation", "全力推进");
    addUserKeyword(keywords, "tracked", "按步骤");
    addUserKeyword(keywords, "light", "随便看看");
    assert.equal(keywords.delegation.length, 1);
    assert.equal(keywords.tracked.length, 1);
    assert.equal(keywords.light.length, 1);
  });
});
