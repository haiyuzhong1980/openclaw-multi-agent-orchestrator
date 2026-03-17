import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadOnboardingState,
  saveOnboardingState,
  needsOnboarding,
  generateWelcomeMessage,
  processOnboardingResponse,
} from "../src/onboarding.ts";
import type { OnboardingState } from "../src/onboarding.ts";
import { createDefaultState } from "../src/enforcement-ladder.ts";
import type { UserKeywords } from "../src/user-keywords.ts";

let testDir: string;

function makeKeywords(): UserKeywords {
  return { delegation: [], tracked: [], light: [], updatedAt: "" };
}

function makeOnboardingState(completed = false): OnboardingState {
  return { completed, userProfile: { customPhrases: [] } };
}

describe("loadOnboardingState", () => {
  beforeEach(() => {
    testDir = join(tmpdir(), `oma-onboarding-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("returns incomplete state when file does not exist", () => {
    const state = loadOnboardingState(testDir);
    assert.equal(state.completed, false);
    assert.deepEqual(state.userProfile.customPhrases, []);
  });

  it("returns incomplete state when file is malformed JSON", () => {
    writeFileSync(join(testDir, "onboarding-state.json"), "not-json");
    const state = loadOnboardingState(testDir);
    assert.equal(state.completed, false);
  });

  it("round-trip: saved state can be loaded back", () => {
    const state: OnboardingState = {
      completed: true,
      completedAt: "2024-01-01T00:00:00.000Z",
      userProfile: {
        workType: "development",
        aggressiveness: "moderate",
        customPhrases: ["全力推进"],
        language: "zh",
      },
    };
    saveOnboardingState(testDir, state);
    const loaded = loadOnboardingState(testDir);
    assert.equal(loaded.completed, true);
    assert.equal(loaded.userProfile.workType, "development");
    assert.equal(loaded.userProfile.aggressiveness, "moderate");
    assert.deepEqual(loaded.userProfile.customPhrases, ["全力推进"]);
  });

  it("creates directory if it does not exist when saving", () => {
    const dir = join(tmpdir(), `oma-new-dir-${Date.now()}`);
    assert.equal(existsSync(dir), false);
    saveOnboardingState(dir, makeOnboardingState());
    assert.equal(existsSync(dir), true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("needsOnboarding", () => {
  it("returns true for a new (uncompleted) state", () => {
    const state = makeOnboardingState(false);
    assert.equal(needsOnboarding(state), true);
  });

  it("returns false when completed is true", () => {
    const state = makeOnboardingState(true);
    assert.equal(needsOnboarding(state), false);
  });
});

describe("generateWelcomeMessage", () => {
  it("contains the welcome heading", () => {
    const msg = generateWelcomeMessage(makeOnboardingState());
    assert.ok(msg.includes("欢迎使用"));
  });

  it("contains the three question sections", () => {
    const msg = generateWelcomeMessage(makeOnboardingState());
    assert.ok(msg.includes("1."));
    assert.ok(msg.includes("2."));
    assert.ok(msg.includes("3."));
  });

  it("contains reply format hint", () => {
    const msg = generateWelcomeMessage(makeOnboardingState());
    assert.ok(msg.includes("回复格式"));
  });

  it("contains mao-setup reset hint", () => {
    const msg = generateWelcomeMessage(makeOnboardingState());
    assert.ok(msg.includes("/mao-setup"));
  });
});

describe("processOnboardingResponse", () => {
  it("marks onboarding as completed after response", () => {
    const state = makeOnboardingState();
    const keywords = makeKeywords();
    const enforcement = createDefaultState();
    processOnboardingResponse({
      response: "1a 2b",
      onboardingState: state,
      userKeywords: keywords,
      enforcementState: enforcement,
    });
    assert.equal(state.completed, true);
    assert.ok(state.completedAt);
  });

  it("sets workType correctly from '1a 2b 3:全力推进,出报告'", () => {
    const state = makeOnboardingState();
    const keywords = makeKeywords();
    const enforcement = createDefaultState();
    processOnboardingResponse({
      response: "1a 2c 3:全力推进,出报告",
      onboardingState: state,
      userKeywords: keywords,
      enforcementState: enforcement,
    });
    assert.equal(state.userProfile.workType, "development");
  });

  it("aggressive aggressiveness (2c) sets enforcement to Level 2", () => {
    const state = makeOnboardingState();
    const keywords = makeKeywords();
    const enforcement = createDefaultState();
    const result = processOnboardingResponse({
      response: "1a 2c",
      onboardingState: state,
      userKeywords: keywords,
      enforcementState: enforcement,
    });
    assert.equal(result.initialLevel, 2);
    assert.equal(enforcement.currentLevel, 2);
  });

  it("conservative aggressiveness (2a) keeps enforcement at Level 0", () => {
    const state = makeOnboardingState();
    const keywords = makeKeywords();
    const enforcement = createDefaultState();
    const result = processOnboardingResponse({
      response: "1b 2a",
      onboardingState: state,
      userKeywords: keywords,
      enforcementState: enforcement,
    });
    assert.equal(result.initialLevel, 0);
    assert.equal(enforcement.currentLevel, 0);
  });

  it("moderate aggressiveness (2b) sets enforcement to Level 1", () => {
    const state = makeOnboardingState();
    const keywords = makeKeywords();
    const enforcement = createDefaultState();
    const result = processOnboardingResponse({
      response: "1b 2b",
      onboardingState: state,
      userKeywords: keywords,
      enforcementState: enforcement,
    });
    assert.equal(result.initialLevel, 1);
    assert.equal(enforcement.currentLevel, 1);
  });

  it("custom phrases from '3:' are added to delegation keywords", () => {
    const state = makeOnboardingState();
    const keywords = makeKeywords();
    const enforcement = createDefaultState();
    const result = processOnboardingResponse({
      response: "1a 2c 3:全力推进,出报告",
      onboardingState: state,
      userKeywords: keywords,
      enforcementState: enforcement,
    });
    assert.ok(result.keywordsAdded.includes("全力推进"));
    assert.ok(result.keywordsAdded.includes("出报告"));
    assert.ok(keywords.delegation.includes("全力推进"));
    assert.ok(keywords.delegation.includes("出报告"));
  });

  it("configured is true when response is parseable", () => {
    const result = processOnboardingResponse({
      response: "1a 2b",
      onboardingState: makeOnboardingState(),
      userKeywords: makeKeywords(),
      enforcementState: createDefaultState(),
    });
    assert.equal(result.configured, true);
  });

  it("message contains confirmation text", () => {
    const result = processOnboardingResponse({
      response: "1a 2b",
      onboardingState: makeOnboardingState(),
      userKeywords: makeKeywords(),
      enforcementState: createDefaultState(),
    });
    assert.ok(result.message.includes("配置完成") || result.message.includes("OMA"));
  });
});
