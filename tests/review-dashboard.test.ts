import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createDashboard,
  recordReview,
  checkStaleness,
  computeVerdict,
  formatDashboard,
} from "../src/review-dashboard.ts";
import type { ReviewDashboard, ReviewRecord } from "../src/review-dashboard.ts";

// ── createDashboard ────────────────────────────────────────────────────────

describe("createDashboard: initialization", () => {
  it("returns a dashboard with correct projectId and projectName", () => {
    const d = createDashboard("proj-1", "My Project");
    assert.equal(d.projectId, "proj-1");
    assert.equal(d.projectName, "My Project");
  });

  it("initializes with default review types", () => {
    const d = createDashboard("proj-1", "My Project");
    const types = d.records.map((r) => r.reviewType);
    assert.ok(types.includes("code-review"));
    assert.ok(types.includes("security-review"));
    assert.ok(types.includes("test-coverage"));
    assert.ok(types.includes("architecture-review"));
    assert.ok(types.includes("codex-review"));
  });

  it("all records start with NOT_RUN status and 0 runs", () => {
    const d = createDashboard("proj-1", "My Project");
    for (const r of d.records) {
      assert.equal(r.status, "NOT_RUN");
      assert.equal(r.runs, 0);
      assert.equal(r.lastRunAt, null);
      assert.equal(r.lastCommitHash, null);
    }
  });

  it("verdict is INCOMPLETE when no reviews have run", () => {
    const d = createDashboard("proj-1", "My Project");
    assert.equal(d.verdict, "INCOMPLETE");
  });

  it("required: code-review, security-review, test-coverage are required", () => {
    const d = createDashboard("proj-1", "My Project");
    const required = d.records.filter((r) => r.required).map((r) => r.reviewType);
    assert.ok(required.includes("code-review"));
    assert.ok(required.includes("security-review"));
    assert.ok(required.includes("test-coverage"));
  });

  it("optional: architecture-review and codex-review are not required", () => {
    const d = createDashboard("proj-1", "My Project");
    const optional = d.records.filter((r) => !r.required).map((r) => r.reviewType);
    assert.ok(optional.includes("architecture-review"));
    assert.ok(optional.includes("codex-review"));
  });
});

// ── recordReview ──────────────────────────────────────────────────────────

describe("recordReview: records a review result", () => {
  it("returns a new dashboard object (immutable)", () => {
    const d = createDashboard("proj-1", "My Project");
    const d2 = recordReview(d, {
      reviewType: "code-review",
      agentType: "code-reviewer",
      lastRunAt: "2026-03-19T20:00:00Z",
      lastCommitHash: null,
      status: "CLEAR",
      required: true,
      commitHash: "abc123",
    });
    assert.notEqual(d, d2);
    assert.notEqual(d.records, d2.records);
  });

  it("increments runs count on re-review", () => {
    let d = createDashboard("proj-1", "My Project");
    d = recordReview(d, {
      reviewType: "code-review",
      agentType: "code-reviewer",
      lastRunAt: "2026-03-19T20:00:00Z",
      lastCommitHash: null,
      status: "CLEAR",
      required: true,
      commitHash: "abc123",
    });
    d = recordReview(d, {
      reviewType: "code-review",
      agentType: "code-reviewer",
      lastRunAt: "2026-03-19T21:00:00Z",
      lastCommitHash: null,
      status: "CLEAR",
      required: true,
      commitHash: "def456",
    });
    const record = d.records.find((r) => r.reviewType === "code-review")!;
    assert.equal(record.runs, 2);
  });

  it("updates lastCommitHash from commitHash parameter", () => {
    let d = createDashboard("proj-1", "My Project");
    d = recordReview(d, {
      reviewType: "security-review",
      agentType: "security-reviewer",
      lastRunAt: "2026-03-19T19:30:00Z",
      lastCommitHash: null,
      status: "CONCERNS",
      required: true,
      commitHash: "sha999",
    });
    const record = d.records.find((r) => r.reviewType === "security-review")!;
    assert.equal(record.lastCommitHash, "sha999");
  });

  it("updates status and lastRunAt correctly", () => {
    let d = createDashboard("proj-1", "My Project");
    d = recordReview(d, {
      reviewType: "test-coverage",
      agentType: "test-engineer",
      lastRunAt: "2026-03-19T18:00:00Z",
      lastCommitHash: null,
      status: "FAILED",
      required: true,
      commitHash: "aaa111",
    });
    const record = d.records.find((r) => r.reviewType === "test-coverage")!;
    assert.equal(record.status, "FAILED");
    assert.equal(record.lastRunAt, "2026-03-19T18:00:00Z");
  });

  it("stores findings when provided", () => {
    let d = createDashboard("proj-1", "My Project");
    d = recordReview(d, {
      reviewType: "code-review",
      agentType: "code-reviewer",
      lastRunAt: "2026-03-19T20:00:00Z",
      lastCommitHash: null,
      status: "CONCERNS",
      required: true,
      findings: { critical: 0, high: 1, medium: 2, low: 5 },
      commitHash: "bbb222",
    });
    const record = d.records.find((r) => r.reviewType === "code-review")!;
    assert.deepEqual(record.findings, { critical: 0, high: 1, medium: 2, low: 5 });
  });

  it("does not mutate original records array", () => {
    const d = createDashboard("proj-1", "My Project");
    const originalRecords = d.records;
    const d2 = recordReview(d, {
      reviewType: "code-review",
      agentType: "code-reviewer",
      lastRunAt: "2026-03-19T20:00:00Z",
      lastCommitHash: null,
      status: "CLEAR",
      required: true,
      commitHash: "ccc333",
    });
    assert.equal(d.records, originalRecords);
    assert.notEqual(d.records, d2.records);
  });
});

// ── checkStaleness ────────────────────────────────────────────────────────

describe("checkStaleness: staleness detection", () => {
  it("marks review as stale when commit hash differs", () => {
    let d = createDashboard("proj-1", "My Project");
    d = recordReview(d, {
      reviewType: "code-review",
      agentType: "code-reviewer",
      lastRunAt: "2026-03-19T20:00:00Z",
      lastCommitHash: null,
      status: "CLEAR",
      required: true,
      commitHash: "old-hash",
    });
    const results = checkStaleness(d, "new-hash");
    const codeReview = results.find((r) => r.reviewType === "code-review")!;
    assert.equal(codeReview.stale, true);
  });

  it("marks review as not stale when commit hash matches", () => {
    let d = createDashboard("proj-1", "My Project");
    d = recordReview(d, {
      reviewType: "code-review",
      agentType: "code-reviewer",
      lastRunAt: "2026-03-19T20:00:00Z",
      lastCommitHash: null,
      status: "CLEAR",
      required: true,
      commitHash: "same-hash",
    });
    const results = checkStaleness(d, "same-hash");
    const codeReview = results.find((r) => r.reviewType === "code-review")!;
    assert.equal(codeReview.stale, false);
  });

  it("NOT_RUN reviews are not stale", () => {
    const d = createDashboard("proj-1", "My Project");
    const results = checkStaleness(d, "any-hash");
    for (const r of results) {
      assert.equal(r.stale, false);
    }
  });

  it("returns an entry for every record in the dashboard", () => {
    const d = createDashboard("proj-1", "My Project");
    const results = checkStaleness(d, "any-hash");
    assert.equal(results.length, d.records.length);
  });
});

// ── computeVerdict ────────────────────────────────────────────────────────

describe("computeVerdict: CLEARED", () => {
  it("returns CLEARED when all required reviews are CLEAR", () => {
    let d = createDashboard("proj-1", "My Project");
    const requiredTypes = d.records
      .filter((r) => r.required)
      .map((r) => r.reviewType);
    for (const rt of requiredTypes) {
      const record = d.records.find((r) => r.reviewType === rt)!;
      d = recordReview(d, {
        reviewType: rt,
        agentType: record.agentType,
        lastRunAt: "2026-03-19T20:00:00Z",
        lastCommitHash: null,
        status: "CLEAR",
        required: true,
        commitHash: "abc",
      });
    }
    const { verdict } = computeVerdict(d);
    assert.equal(verdict, "CLEARED");
  });
});

describe("computeVerdict: BLOCKED", () => {
  it("returns BLOCKED when any required review is FAILED", () => {
    let d = createDashboard("proj-1", "My Project");
    d = recordReview(d, {
      reviewType: "security-review",
      agentType: "security-reviewer",
      lastRunAt: "2026-03-19T19:30:00Z",
      lastCommitHash: null,
      status: "FAILED",
      required: true,
      commitHash: "abc",
    });
    const { verdict } = computeVerdict(d);
    assert.equal(verdict, "BLOCKED");
  });

  it("BLOCKED takes priority over INCOMPLETE", () => {
    let d = createDashboard("proj-1", "My Project");
    // code-review FAILED, test-coverage NOT_RUN
    d = recordReview(d, {
      reviewType: "code-review",
      agentType: "code-reviewer",
      lastRunAt: "2026-03-19T20:00:00Z",
      lastCommitHash: null,
      status: "FAILED",
      required: true,
      commitHash: "abc",
    });
    const { verdict } = computeVerdict(d);
    assert.equal(verdict, "BLOCKED");
  });
});

describe("computeVerdict: INCOMPLETE", () => {
  it("returns INCOMPLETE when required review has NOT_RUN", () => {
    const d = createDashboard("proj-1", "My Project");
    const { verdict } = computeVerdict(d);
    assert.equal(verdict, "INCOMPLETE");
  });

  it("returns INCOMPLETE when required review has CONCERNS", () => {
    let d = createDashboard("proj-1", "My Project");
    const requiredTypes = d.records
      .filter((r) => r.required)
      .map((r) => r.reviewType);
    // Make all required reviews CLEAR first
    for (const rt of requiredTypes) {
      const record = d.records.find((r) => r.reviewType === rt)!;
      d = recordReview(d, {
        reviewType: rt,
        agentType: record.agentType,
        lastRunAt: "2026-03-19T20:00:00Z",
        lastCommitHash: null,
        status: "CLEAR",
        required: true,
        commitHash: "abc",
      });
    }
    // Then set one to CONCERNS
    d = recordReview(d, {
      reviewType: "code-review",
      agentType: "code-reviewer",
      lastRunAt: "2026-03-19T21:00:00Z",
      lastCommitHash: null,
      status: "CONCERNS",
      required: true,
      commitHash: "abc",
    });
    const { verdict } = computeVerdict(d);
    assert.equal(verdict, "INCOMPLETE");
  });

  it("reason mentions the problematic review type", () => {
    const d = createDashboard("proj-1", "My Project");
    const { reason } = computeVerdict(d);
    assert.ok(reason.length > 0);
    assert.ok(reason.toLowerCase().includes("not run") || reason.includes("NOT_RUN") || reason.includes("required"));
  });
});

// ── formatDashboard ───────────────────────────────────────────────────────

describe("formatDashboard: ASCII format", () => {
  it("contains the title REVIEW READINESS DASHBOARD", () => {
    const d = createDashboard("proj-1", "My Project");
    const output = formatDashboard(d);
    assert.ok(output.includes("REVIEW READINESS DASHBOARD"));
  });

  it("contains column headers", () => {
    const d = createDashboard("proj-1", "My Project");
    const output = formatDashboard(d);
    assert.ok(output.includes("Review"));
    assert.ok(output.includes("Runs"));
    assert.ok(output.includes("Last Run"));
    assert.ok(output.includes("Status"));
    assert.ok(output.includes("Required"));
  });

  it("contains VERDICT line", () => {
    const d = createDashboard("proj-1", "My Project");
    const output = formatDashboard(d);
    assert.ok(output.includes("VERDICT:"));
  });

  it("shows NOT_RUN for unrun reviews", () => {
    const d = createDashboard("proj-1", "My Project");
    const output = formatDashboard(d);
    assert.ok(output.includes("NOT_RUN"));
  });

  it("shows CLEAR status after review passes", () => {
    let d = createDashboard("proj-1", "My Project");
    d = recordReview(d, {
      reviewType: "code-review",
      agentType: "code-reviewer",
      lastRunAt: "2026-03-19T20:00:00Z",
      lastCommitHash: null,
      status: "CLEAR",
      required: true,
      commitHash: "abc123",
    });
    const output = formatDashboard(d);
    assert.ok(output.includes("CLEAR"));
  });

  it("shows STALE when commit hash differs", () => {
    let d = createDashboard("proj-1", "My Project");
    d = recordReview(d, {
      reviewType: "code-review",
      agentType: "code-reviewer",
      lastRunAt: "2026-03-19T20:00:00Z",
      lastCommitHash: null,
      status: "CLEAR",
      required: true,
      commitHash: "old-hash",
    });
    const output = formatDashboard(d, "new-hash");
    assert.ok(output.includes("STALE"));
  });

  it("all lines have the same length (alignment check)", () => {
    const d = createDashboard("proj-1", "My Project");
    const lines = formatDashboard(d).split("\n");
    const lengths = lines.map((l) => l.length);
    const first = lengths[0];
    for (const len of lengths) {
      assert.equal(len, first, `Line length mismatch: expected ${first}, got ${len}`);
    }
  });

  it("uses = borders for outer frame and - for separator", () => {
    const d = createDashboard("proj-1", "My Project");
    const output = formatDashboard(d);
    assert.ok(output.includes("+===="));
    assert.ok(output.includes("+----"));
  });

  it("shows YES for required and no for optional", () => {
    const d = createDashboard("proj-1", "My Project");
    const output = formatDashboard(d);
    assert.ok(output.includes("YES"));
    assert.ok(output.includes(" no ") || output.includes("| no"));
  });

  it("shows -- for last run when NOT_RUN", () => {
    const d = createDashboard("proj-1", "My Project");
    const output = formatDashboard(d);
    assert.ok(output.includes("--"));
  });
});

// ── immutability ──────────────────────────────────────────────────────────

describe("immutability: recordReview returns new object", () => {
  it("original dashboard is unchanged after recordReview", () => {
    const d = createDashboard("proj-1", "My Project");
    const originalStatus = d.records.find((r) => r.reviewType === "code-review")!.status;
    recordReview(d, {
      reviewType: "code-review",
      agentType: "code-reviewer",
      lastRunAt: "2026-03-19T20:00:00Z",
      lastCommitHash: null,
      status: "CLEAR",
      required: true,
      commitHash: "abc",
    });
    // Original should remain NOT_RUN
    assert.equal(
      d.records.find((r) => r.reviewType === "code-review")!.status,
      originalStatus,
    );
  });

  it("chaining recordReview produces independent dashboards", () => {
    let d = createDashboard("proj-1", "My Project");
    const d1 = recordReview(d, {
      reviewType: "code-review",
      agentType: "code-reviewer",
      lastRunAt: "2026-03-19T20:00:00Z",
      lastCommitHash: null,
      status: "CLEAR",
      required: true,
      commitHash: "v1",
    });
    const d2 = recordReview(d1, {
      reviewType: "security-review",
      agentType: "security-reviewer",
      lastRunAt: "2026-03-19T21:00:00Z",
      lastCommitHash: null,
      status: "CLEAR",
      required: true,
      commitHash: "v2",
    });
    // d1 should not have security-review CLEAR
    const d1Security = d1.records.find((r) => r.reviewType === "security-review")!;
    assert.equal(d1Security.status, "NOT_RUN");
    // d2 should have security-review CLEAR
    const d2Security = d2.records.find((r) => r.reviewType === "security-review")!;
    assert.equal(d2Security.status, "CLEAR");
  });
});

// ── edge cases ────────────────────────────────────────────────────────────

describe("edge cases", () => {
  it("empty dashboard (no records) => CLEARED", () => {
    const d: ReviewDashboard = {
      projectId: "p",
      projectName: "P",
      records: [],
      verdict: "CLEARED",
      verdictReason: "",
    };
    const { verdict } = computeVerdict(d);
    assert.equal(verdict, "CLEARED");
  });

  it("all NOT_RUN => INCOMPLETE", () => {
    const d = createDashboard("proj-1", "My Project");
    const { verdict } = computeVerdict(d);
    assert.equal(verdict, "INCOMPLETE");
  });

  it("all required CLEAR => CLEARED", () => {
    let d = createDashboard("proj-1", "My Project");
    const requiredTypes = d.records.filter((r) => r.required).map((r) => r.reviewType);
    for (const rt of requiredTypes) {
      const record = d.records.find((r) => r.reviewType === rt)!;
      d = recordReview(d, {
        reviewType: rt,
        agentType: record.agentType,
        lastRunAt: "2026-03-19T20:00:00Z",
        lastCommitHash: null,
        status: "CLEAR",
        required: true,
        commitHash: "abc",
      });
    }
    assert.equal(d.verdict, "CLEARED");
  });

  it("optional reviews being FAILED does not block", () => {
    let d = createDashboard("proj-1", "My Project");
    // Set all required to CLEAR
    const requiredTypes = d.records.filter((r) => r.required).map((r) => r.reviewType);
    for (const rt of requiredTypes) {
      const record = d.records.find((r) => r.reviewType === rt)!;
      d = recordReview(d, {
        reviewType: rt,
        agentType: record.agentType,
        lastRunAt: "2026-03-19T20:00:00Z",
        lastCommitHash: null,
        status: "CLEAR",
        required: true,
        commitHash: "abc",
      });
    }
    // Set optional to FAILED
    d = recordReview(d, {
      reviewType: "codex-review",
      agentType: "codex",
      lastRunAt: "2026-03-19T20:00:00Z",
      lastCommitHash: null,
      status: "FAILED",
      required: false,
      commitHash: "abc",
    });
    const { verdict } = computeVerdict(d);
    assert.equal(verdict, "CLEARED");
  });

  it("formatDashboard works on empty records dashboard", () => {
    const d: ReviewDashboard = {
      projectId: "p",
      projectName: "P",
      records: [],
      verdict: "CLEARED",
      verdictReason: "All required reviews passed",
    };
    const output = formatDashboard(d);
    assert.ok(output.includes("REVIEW READINESS DASHBOARD"));
    assert.ok(output.includes("VERDICT:"));
  });
});
