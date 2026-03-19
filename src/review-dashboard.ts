export interface ReviewRecord {
  reviewType: 'code-review' | 'security-review' | 'test-coverage' | 'architecture-review' | 'codex-review';
  agentType: string;
  runs: number;
  lastRunAt: string | null;      // ISO8601
  lastCommitHash: string | null;  // 审查时的 HEAD commit
  status: 'CLEAR' | 'CONCERNS' | 'FAILED' | 'NOT_RUN';
  required: boolean;
  findings?: { critical: number; high: number; medium: number; low: number };
}

export interface ReviewDashboard {
  projectId: string;
  projectName: string;
  records: ReviewRecord[];
  verdict: 'CLEARED' | 'BLOCKED' | 'INCOMPLETE';
  verdictReason: string;
}

const DEFAULT_RECORDS: ReviewRecord[] = [
  {
    reviewType: 'code-review',
    agentType: 'code-reviewer',
    runs: 0,
    lastRunAt: null,
    lastCommitHash: null,
    status: 'NOT_RUN',
    required: true,
  },
  {
    reviewType: 'security-review',
    agentType: 'security-reviewer',
    runs: 0,
    lastRunAt: null,
    lastCommitHash: null,
    status: 'NOT_RUN',
    required: true,
  },
  {
    reviewType: 'test-coverage',
    agentType: 'test-engineer',
    runs: 0,
    lastRunAt: null,
    lastCommitHash: null,
    status: 'NOT_RUN',
    required: true,
  },
  {
    reviewType: 'architecture-review',
    agentType: 'architect',
    runs: 0,
    lastRunAt: null,
    lastCommitHash: null,
    status: 'NOT_RUN',
    required: false,
  },
  {
    reviewType: 'codex-review',
    agentType: 'codex',
    runs: 0,
    lastRunAt: null,
    lastCommitHash: null,
    status: 'NOT_RUN',
    required: false,
  },
];

/**
 * Creates an empty dashboard with default review records.
 */
export function createDashboard(projectId: string, projectName: string): ReviewDashboard {
  const records = DEFAULT_RECORDS.map((r) => ({ ...r }));
  const { verdict, reason } = computeVerdict({ projectId, projectName, records, verdict: 'INCOMPLETE', verdictReason: '' });
  return { projectId, projectName, records, verdict, verdictReason: reason };
}

/**
 * Records a review result. Returns a new dashboard object (immutable).
 */
export function recordReview(
  dashboard: ReviewDashboard,
  review: Omit<ReviewRecord, 'runs'> & { commitHash: string },
): ReviewDashboard {
  const { commitHash, ...reviewData } = review;

  const updatedRecords = dashboard.records.map((record) => {
    if (record.reviewType !== review.reviewType) {
      return { ...record };
    }
    return {
      ...reviewData,
      runs: record.runs + 1,
      lastCommitHash: commitHash,
    };
  });

  // If no matching record existed, add it
  const hasExisting = dashboard.records.some((r) => r.reviewType === review.reviewType);
  const finalRecords = hasExisting
    ? updatedRecords
    : [
        ...updatedRecords,
        {
          ...reviewData,
          runs: 1,
          lastCommitHash: commitHash,
        },
      ];

  const partial: ReviewDashboard = {
    ...dashboard,
    records: finalRecords,
    verdict: dashboard.verdict,
    verdictReason: dashboard.verdictReason,
  };

  const { verdict, reason } = computeVerdict(partial);
  return { ...partial, verdict, verdictReason: reason };
}

/**
 * Checks which reviews are stale (current commit differs from review commit).
 */
export function checkStaleness(
  dashboard: ReviewDashboard,
  currentCommitHash: string,
): Array<{ reviewType: string; stale: boolean; commitsBehind?: number }> {
  return dashboard.records.map((record) => {
    if (record.lastCommitHash === null || record.status === 'NOT_RUN') {
      return { reviewType: record.reviewType, stale: false };
    }
    const stale = record.lastCommitHash !== currentCommitHash;
    return { reviewType: record.reviewType, stale };
  });
}

/**
 * Computes overall verdict based on review records.
 * - BLOCKED: any required review is FAILED
 * - INCOMPLETE: any required review is NOT_RUN or stale (NOT_RUN used here)
 * - CLEARED: all required reviews are CLEAR
 */
export function computeVerdict(dashboard: ReviewDashboard): { verdict: 'CLEARED' | 'BLOCKED' | 'INCOMPLETE'; reason: string } {
  const required = dashboard.records.filter((r) => r.required);

  const blocked = required.find((r) => r.status === 'FAILED');
  if (blocked) {
    return {
      verdict: 'BLOCKED',
      reason: `${formatReviewType(blocked.reviewType)} required and FAILED`,
    };
  }

  const notRun = required.find((r) => r.status === 'NOT_RUN');
  if (notRun) {
    return {
      verdict: 'INCOMPLETE',
      reason: `${formatReviewType(notRun.reviewType)} required but not run`,
    };
  }

  const hasConcerns = required.find((r) => r.status === 'CONCERNS');
  if (hasConcerns) {
    return {
      verdict: 'INCOMPLETE',
      reason: `${formatReviewType(hasConcerns.reviewType)} has unresolved concerns`,
    };
  }

  return {
    verdict: 'CLEARED',
    reason: 'All required reviews passed',
  };
}

function formatReviewType(reviewType: string): string {
  return reviewType
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function padEnd(str: string, len: number): string {
  if (str.length >= len) return str.slice(0, len);
  return str + ' '.repeat(len - str.length);
}

function padStart(str: string, len: number): string {
  if (str.length >= len) return str.slice(0, len);
  return ' '.repeat(len - str.length) + str;
}

function formatDateTime(iso: string | null): string {
  if (!iso) return '--';
  // Format as "YYYY-MM-DD HH:MM"
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso.slice(0, 16);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
}

/**
 * Formats the dashboard as an ASCII table.
 */
export function formatDashboard(dashboard: ReviewDashboard, currentCommitHash?: string): string {
  const stalenessMap: Record<string, boolean> = {};
  if (currentCommitHash) {
    for (const s of checkStaleness(dashboard, currentCommitHash)) {
      stalenessMap[s.reviewType] = s.stale;
    }
  }

  // Column widths
  const COL_REVIEW = 17;
  const COL_RUNS = 4;
  const COL_LAST_RUN = 19;
  const COL_STATUS = 9;
  const COL_REQUIRED = 8;

  const totalWidth =
    2 + COL_REVIEW + 3 + COL_RUNS + 3 + COL_LAST_RUN + 3 + COL_STATUS + 3 + COL_REQUIRED + 2;
  // = 2 + 17 + 3 + 4 + 3 + 19 + 3 + 9 + 3 + 8 + 2 = 73

  const border = '+' + '='.repeat(totalWidth - 2) + '+';
  const separator = '+' + '-'.repeat(totalWidth - 2) + '+';

  const title = 'REVIEW READINESS DASHBOARD';
  const titlePad = Math.floor((totalWidth - 2 - title.length) / 2);
  const titleRight = totalWidth - 2 - title.length - titlePad;
  const titleLine = '|' + ' '.repeat(titlePad) + title + ' '.repeat(titleRight) + '|';

  const header =
    '| ' +
    padEnd('Review', COL_REVIEW) +
    ' | ' +
    padEnd('Runs', COL_RUNS) +
    ' | ' +
    padEnd('Last Run', COL_LAST_RUN) +
    ' | ' +
    padEnd('Status', COL_STATUS) +
    ' | ' +
    padEnd('Required', COL_REQUIRED) +
    ' |';

  const divider =
    '|' +
    '-'.repeat(COL_REVIEW + 2) +
    '|' +
    '-'.repeat(COL_RUNS + 2) +
    '|' +
    '-'.repeat(COL_LAST_RUN + 2) +
    '|' +
    '-'.repeat(COL_STATUS + 2) +
    '|' +
    '-'.repeat(COL_REQUIRED + 2) +
    '|';

  const rows = dashboard.records.map((record) => {
    const label = formatReviewType(record.reviewType);
    const runs = padStart(String(record.runs), COL_RUNS);
    const lastRun = padEnd(formatDateTime(record.lastRunAt), COL_LAST_RUN);
    let statusStr = record.status;
    if (currentCommitHash && stalenessMap[record.reviewType] && record.status !== 'NOT_RUN') {
      statusStr = 'STALE';
    }
    const status = padEnd(statusStr, COL_STATUS);
    const required = padEnd(record.required ? 'YES' : 'no', COL_REQUIRED);

    return (
      '| ' +
      padEnd(label, COL_REVIEW) +
      ' | ' +
      runs +
      ' | ' +
      lastRun +
      ' | ' +
      status +
      ' | ' +
      required +
      ' |'
    );
  });

  const { verdict, reason } = computeVerdict(dashboard);
  const verdictText = `VERDICT: ${verdict} — ${reason}`;
  const verdictPad = totalWidth - 2 - verdictText.length;
  const verdictLine =
    '| ' + verdictText + ' '.repeat(Math.max(0, verdictPad - 1)) + '|';

  const lines = [
    border,
    titleLine,
    border,
    header,
    divider,
    ...rows,
    separator,
    verdictLine,
    border,
  ];

  return lines.join('\n');
}
