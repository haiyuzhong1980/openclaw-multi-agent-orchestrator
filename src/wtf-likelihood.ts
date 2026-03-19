export interface WtfState {
  revertCount: number;
  largeFixCount: number;      // number of fixes that changed >3 files
  totalFixCount: number;
  touchedUnrelatedFiles: boolean;
  allRemainingLow: boolean;   // all remaining issues are Low severity
}

// Score weights
const REVERT_WEIGHT = 15;
const LARGE_FIX_WEIGHT = 5;
const EXTRA_FIX_WEIGHT = 1;        // applied per fix beyond 15
const ALL_LOW_WEIGHT = 10;
const UNRELATED_TOUCH_WEIGHT = 20;

// Thresholds
const STOP_AND_ASK_THRESHOLD = 20;
const HARD_STOP_MAX_FIXES = 50;
const EXTRA_FIX_THRESHOLD = 15;

/**
 * Calculate WTF-likelihood as a percentage (0-100+).
 * All inputs are taken from the WtfState snapshot; this is a pure function.
 */
export function calculateWtfLikelihood(state: WtfState): number {
  let score = 0;

  score += state.revertCount * REVERT_WEIGHT;
  score += state.largeFixCount * LARGE_FIX_WEIGHT;

  if (state.totalFixCount > EXTRA_FIX_THRESHOLD) {
    score += (state.totalFixCount - EXTRA_FIX_THRESHOLD) * EXTRA_FIX_WEIGHT;
  }

  if (state.allRemainingLow) {
    score += ALL_LOW_WEIGHT;
  }

  if (state.touchedUnrelatedFiles) {
    score += UNRELATED_TOUCH_WEIGHT;
  }

  return score;
}

/**
 * Return true when WTF-likelihood exceeds the soft threshold (20%).
 */
export function shouldStopAndAsk(likelihood: number): boolean {
  return likelihood > STOP_AND_ASK_THRESHOLD;
}

/**
 * Return true when the hard stop limit has been reached.
 * maxFixes defaults to 50.
 */
export function shouldForceStop(state: WtfState, maxFixes?: number): boolean {
  const limit = maxFixes ?? HARD_STOP_MAX_FIXES;
  return state.totalFixCount >= limit;
}

/**
 * Build a human-readable stop prompt showing current WTF state.
 */
export function buildStopPrompt(state: WtfState, likelihood: number): string {
  const lines: string[] = [
    `WTF-likelihood: ${likelihood}%`,
    "",
    "当前修复状态:",
    `  总修复次数: ${state.totalFixCount}`,
    `  回退次数: ${state.revertCount}`,
    `  大范围修复次数 (>3 文件): ${state.largeFixCount}`,
    `  触及无关文件: ${state.touchedUnrelatedFiles ? "是" : "否"}`,
    `  剩余问题均为 Low 级别: ${state.allRemainingLow ? "是" : "否"}`,
    "",
  ];

  if (shouldForceStop(state)) {
    lines.push(
      `已达到硬限制（${state.totalFixCount} 次修复 ≥ ${HARD_STOP_MAX_FIXES} 次）。`,
      "强制停止，请人工接管并检查问题根因。",
    );
  } else {
    lines.push(
      `WTF-likelihood 超过 ${STOP_AND_ASK_THRESHOLD}%，建议暂停。`,
      "请确认：是否继续？还是需要人工检查当前方向？",
    );
  }

  return lines.join("\n");
}

/**
 * Return a new WtfState updated by the given event.
 * This function is immutable — it never modifies the input state.
 */
export function updateWtfState(
  state: WtfState,
  event: { type: "revert" | "fix" | "large_fix" | "unrelated_touch"; filesChanged?: number },
): WtfState {
  switch (event.type) {
    case "revert":
      return { ...state, revertCount: state.revertCount + 1 };

    case "fix":
      return { ...state, totalFixCount: state.totalFixCount + 1 };

    case "large_fix": {
      return {
        ...state,
        totalFixCount: state.totalFixCount + 1,
        largeFixCount: state.largeFixCount + 1,
      };
    }

    case "unrelated_touch":
      return { ...state, touchedUnrelatedFiles: true };

    default: {
      // exhaustive check — TypeScript will warn if a case is missing
      const _never: never = event.type;
      return state;
    }
  }
}
