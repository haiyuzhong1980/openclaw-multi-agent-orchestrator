import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  oagEventToObservation,
  taskFailureToRootCause,
  predictionToSchedulingHint,
  loadUnifiedOagConfig,
} from "../src/oag-bridge.ts";
import type { OagEvent, TaskFailureReport, PredictionAlert } from "../src/oag-bridge.ts";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "oag-bridge-test-"));
}

function makeEvent(overrides: Partial<OagEvent> = {}): OagEvent {
  return {
    type: 'channel_restart',
    channel: 'whatsapp',
    severity: 'medium',
    message: 'Channel restarted unexpectedly',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function makeFailureReport(overrides: Partial<TaskFailureReport> = {}): TaskFailureReport {
  return {
    taskId: 'task-001',
    projectId: 'proj-001',
    error: 'Unknown error occurred',
    agentType: 'executor',
    duration: 5000,
    ...overrides,
  };
}

function makeAlert(overrides: Partial<PredictionAlert> = {}): PredictionAlert {
  return {
    metric: 'request_rate',
    currentValue: 50,
    predictedValue: 80,
    breachThreshold: 100,
    timeToBreachMinutes: 60,
    ...overrides,
  };
}

// ─── oagEventToObservation ────────────────────────────────────────────────────

describe("oagEventToObservation", () => {
  it("maps critical severity to delegation tier", () => {
    const result = oagEventToObservation(makeEvent({ severity: 'critical' }));
    assert.equal(result.predictedTier, 'delegation');
  });

  it("maps high severity to delegation tier", () => {
    const result = oagEventToObservation(makeEvent({ severity: 'high' }));
    assert.equal(result.predictedTier, 'delegation');
  });

  it("maps medium severity to tracked tier", () => {
    const result = oagEventToObservation(makeEvent({ severity: 'medium' }));
    assert.equal(result.predictedTier, 'tracked');
  });

  it("maps low severity to light tier", () => {
    const result = oagEventToObservation(makeEvent({ severity: 'low' }));
    assert.equal(result.predictedTier, 'light');
  });

  it("always returns agent as oag-bridge", () => {
    const result = oagEventToObservation(makeEvent());
    assert.equal(result.agent, 'oag-bridge');
  });

  it("message includes event type", () => {
    const result = oagEventToObservation(makeEvent({ type: 'delivery_failure' }));
    assert.ok(result.message.includes('delivery_failure'));
  });

  it("message includes channel when provided", () => {
    const result = oagEventToObservation(makeEvent({ channel: 'telegram' }));
    assert.ok(result.message.includes('telegram'));
  });

  it("message works without optional channel field", () => {
    const event = makeEvent();
    delete (event as Partial<OagEvent>).channel;
    const result = oagEventToObservation({ ...event, channel: undefined } as OagEvent);
    assert.equal(typeof result.message, 'string');
    assert.ok(result.message.length > 0);
  });

  it("message includes rootCause when provided", () => {
    const result = oagEventToObservation(makeEvent({ rootCause: 'memory_overflow' }));
    assert.ok(result.message.includes('memory_overflow'));
  });

  it("message does not include rootCause marker when absent", () => {
    const result = oagEventToObservation(makeEvent({ rootCause: undefined }));
    assert.ok(!result.message.includes('Root cause'));
  });

  it("all severity variants produce valid tier values", () => {
    const validTiers = new Set(['light', 'tracked', 'delegation']);
    for (const severity of ['low', 'medium', 'high', 'critical'] as const) {
      const result = oagEventToObservation(makeEvent({ severity }));
      assert.ok(validTiers.has(result.predictedTier), `Unexpected tier for severity=${severity}`);
    }
  });
});

// ─── taskFailureToRootCause ───────────────────────────────────────────────────

describe("taskFailureToRootCause", () => {
  it("classifies rate_limit error correctly", () => {
    const result = taskFailureToRootCause(makeFailureReport({ error: 'API rate_limit exceeded' }));
    assert.equal(result.category, 'rate_limit');
    assert.equal(result.confidence, 0.9);
  });

  it("classifies 'rate limit' (with space) as rate_limit", () => {
    const result = taskFailureToRootCause(makeFailureReport({ error: 'You have hit the rate limit' }));
    assert.equal(result.category, 'rate_limit');
  });

  it("classifies timeout error correctly", () => {
    const result = taskFailureToRootCause(makeFailureReport({ error: 'Request timeout after 30s' }));
    assert.equal(result.category, 'network');
    assert.equal(result.confidence, 0.7);
  });

  it("classifies auth error correctly", () => {
    const result = taskFailureToRootCause(makeFailureReport({ error: 'auth token invalid' }));
    assert.equal(result.category, 'auth_failure');
    assert.equal(result.confidence, 0.9);
  });

  it("classifies unknown errors as internal with low confidence", () => {
    const result = taskFailureToRootCause(makeFailureReport({ error: 'segmentation fault' }));
    assert.equal(result.category, 'internal');
    assert.equal(result.confidence, 0.3);
  });

  it("rate_limit takes priority over timeout when both present", () => {
    const result = taskFailureToRootCause(makeFailureReport({ error: 'rate_limit after timeout' }));
    assert.equal(result.category, 'rate_limit');
  });

  it("suggestion is a non-empty string for all categories", () => {
    const errors = ['rate_limit exceeded', 'connection timeout', 'auth failed', 'unknown crash'];
    for (const error of errors) {
      const result = taskFailureToRootCause(makeFailureReport({ error }));
      assert.equal(typeof result.suggestion, 'string');
      assert.ok(result.suggestion.length > 0, `Empty suggestion for error: ${error}`);
    }
  });

  it("is case-insensitive for error matching", () => {
    const result = taskFailureToRootCause(makeFailureReport({ error: 'RATE_LIMIT EXCEEDED' }));
    assert.equal(result.category, 'rate_limit');
  });
});

// ─── predictionToSchedulingHint ───────────────────────────────────────────────

describe("predictionToSchedulingHint", () => {
  it("returns none when breach is far away", () => {
    const result = predictionToSchedulingHint(makeAlert({ timeToBreachMinutes: 120, currentValue: 10, breachThreshold: 100 }));
    assert.equal(result.action, 'none');
  });

  it("returns reduce_concurrency when breach is within 30 min", () => {
    const result = predictionToSchedulingHint(makeAlert({
      timeToBreachMinutes: 20,
      currentValue: 50,
      breachThreshold: 100,
    }));
    assert.equal(result.action, 'reduce_concurrency');
  });

  it("returns defer_tasks when breach is within 5 min", () => {
    const result = predictionToSchedulingHint(makeAlert({
      timeToBreachMinutes: 3,
      currentValue: 90,
      breachThreshold: 100,
    }));
    assert.equal(result.action, 'defer_tasks');
  });

  it("returns reduce_concurrency when current value is already at threshold (non-rate metric)", () => {
    const result = predictionToSchedulingHint(makeAlert({
      metric: 'cpu_usage',
      currentValue: 100,
      breachThreshold: 100,
    }));
    assert.equal(result.action, 'reduce_concurrency');
  });

  it("returns switch_model when rate metric is already at threshold", () => {
    const result = predictionToSchedulingHint(makeAlert({
      metric: 'api_rate',
      currentValue: 150,
      breachThreshold: 100,
    }));
    assert.equal(result.action, 'switch_model');
  });

  it("returns switch_model when quota metric is already at threshold", () => {
    const result = predictionToSchedulingHint(makeAlert({
      metric: 'quota_usage',
      currentValue: 200,
      breachThreshold: 100,
    }));
    assert.equal(result.action, 'switch_model');
  });

  it("reason is a non-empty string for all actions", () => {
    const scenarios: PredictionAlert[] = [
      makeAlert({ timeToBreachMinutes: 120, currentValue: 10, breachThreshold: 100 }),
      makeAlert({ timeToBreachMinutes: 20, currentValue: 50, breachThreshold: 100 }),
      makeAlert({ timeToBreachMinutes: 3, currentValue: 90, breachThreshold: 100 }),
      makeAlert({ metric: 'api_rate', currentValue: 150, breachThreshold: 100 }),
    ];
    for (const alert of scenarios) {
      const result = predictionToSchedulingHint(alert);
      assert.equal(typeof result.reason, 'string');
      assert.ok(result.reason.length > 0, `Empty reason for alert: ${JSON.stringify(alert)}`);
    }
  });

  it("result action is one of the valid enum values", () => {
    const validActions = new Set(['reduce_concurrency', 'switch_model', 'defer_tasks', 'none']);
    const scenarios: PredictionAlert[] = [
      makeAlert({ timeToBreachMinutes: 120 }),
      makeAlert({ timeToBreachMinutes: 20 }),
      makeAlert({ timeToBreachMinutes: 3 }),
      makeAlert({ metric: 'api_rate', currentValue: 200, breachThreshold: 100 }),
    ];
    for (const alert of scenarios) {
      const result = predictionToSchedulingHint(alert);
      assert.ok(validActions.has(result.action), `Invalid action: ${result.action}`);
    }
  });
});

// ─── loadUnifiedOagConfig ─────────────────────────────────────────────────────

describe("loadUnifiedOagConfig", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = makeTempDir();
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty objects when file does not exist", () => {
    const result = loadUnifiedOagConfig(join(tmpDir, "nonexistent.json"));
    assert.deepEqual(result, { pluginConfig: {}, coreConfig: {}, merged: {} });
  });

  it("returns empty objects when file contains invalid JSON", () => {
    const badPath = join(tmpDir, "bad.json");
    writeFileSync(badPath, "{ not valid", "utf-8");
    const result = loadUnifiedOagConfig(badPath);
    assert.deepEqual(result, { pluginConfig: {}, coreConfig: {}, merged: {} });
  });

  it("reads top-level oag key as pluginConfig", () => {
    const cfgPath = join(tmpDir, "config-toplevel.json");
    writeFileSync(cfgPath, JSON.stringify({ oag: { enabled: true, threshold: 42 } }), "utf-8");
    const result = loadUnifiedOagConfig(cfgPath);
    assert.equal(result.pluginConfig['enabled'], true);
    assert.equal(result.pluginConfig['threshold'], 42);
  });

  it("reads plugins.multi-agent-orchestrator.oag as pluginConfig (highest priority)", () => {
    const cfgPath = join(tmpDir, "config-plugin.json");
    writeFileSync(cfgPath, JSON.stringify({
      oag: { enabled: false },
      plugins: {
        'multi-agent-orchestrator': { oag: { enabled: true, mode: 'strict' } },
      },
    }), "utf-8");
    const result = loadUnifiedOagConfig(cfgPath);
    // Plugin namespace overrides top-level oag
    assert.equal(result.pluginConfig['enabled'], true);
    assert.equal(result.pluginConfig['mode'], 'strict');
  });

  it("reads core.oag as coreConfig", () => {
    const cfgPath = join(tmpDir, "config-core.json");
    writeFileSync(cfgPath, JSON.stringify({
      core: { oag: { healthCheckInterval: 30 } },
    }), "utf-8");
    const result = loadUnifiedOagConfig(cfgPath);
    assert.equal(result.coreConfig['healthCheckInterval'], 30);
  });

  it("reads gateway.oag as coreConfig", () => {
    const cfgPath = join(tmpDir, "config-gateway.json");
    writeFileSync(cfgPath, JSON.stringify({
      gateway: { oag: { retryLimit: 5 } },
    }), "utf-8");
    const result = loadUnifiedOagConfig(cfgPath);
    assert.equal(result.coreConfig['retryLimit'], 5);
  });

  it("merged prefers pluginConfig over coreConfig for same keys", () => {
    const cfgPath = join(tmpDir, "config-merge.json");
    writeFileSync(cfgPath, JSON.stringify({
      oag: { enabled: true, timeout: 10 },
      core: { oag: { enabled: false, timeout: 30, coreOnly: 'yes' } },
    }), "utf-8");
    const result = loadUnifiedOagConfig(cfgPath);
    // Plugin (oag) overrides core for shared keys
    assert.equal(result.merged['enabled'], true);
    assert.equal(result.merged['timeout'], 10);
    // Core-only key is still present in merged
    assert.equal(result.merged['coreOnly'], 'yes');
  });

  it("returns empty objects when JSON root is not an object", () => {
    const cfgPath = join(tmpDir, "config-array.json");
    writeFileSync(cfgPath, JSON.stringify([1, 2, 3]), "utf-8");
    const result = loadUnifiedOagConfig(cfgPath);
    assert.deepEqual(result, { pluginConfig: {}, coreConfig: {}, merged: {} });
  });

  it("all three returned objects are plain objects", () => {
    const cfgPath = join(tmpDir, "config-empty.json");
    writeFileSync(cfgPath, JSON.stringify({}), "utf-8");
    const result = loadUnifiedOagConfig(cfgPath);
    assert.ok(typeof result.pluginConfig === 'object');
    assert.ok(typeof result.coreConfig === 'object');
    assert.ok(typeof result.merged === 'object');
  });
});
