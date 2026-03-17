import { inferRecentWindowDays } from "./track-planner.ts";
import type { PlannedTrack } from "./types.ts";

export interface TrackTemplate {
  id: string;
  name: string;
  description: string;
  category: "research" | "audit" | "development" | "analysis" | "operations";
  defaultGoal: string;
  outputContract: string[];
  failureContract: string[];
}

export const TRACK_TEMPLATES: TrackTemplate[] = [
  // Research
  {
    id: "github-issues",
    name: "GitHub Issues Research",
    description: "Find and analyze GitHub issues for a given repository or topic",
    category: "research",
    defaultGoal: "Find the most relevant and active issues",
    outputContract: ["Issue title + URL + activity metrics", "Filter by time window if specified"],
    failureContract: ["Explain if no results or access denied", "Do not return HTML or tool logs"],
  },
  {
    id: "github-discussions",
    name: "GitHub Discussions Research",
    description: "Find and analyze GitHub discussions",
    category: "research",
    defaultGoal: "Find the most relevant discussions",
    outputContract: ["Discussion title + URL + activity", "Note if discussions are disabled"],
    failureContract: ["Distinguish disabled vs no results", "Do not return noise"],
  },
  {
    id: "security-audit",
    name: "Security Audit",
    description: "Audit a codebase or dependency for security vulnerabilities",
    category: "audit",
    defaultGoal: "Identify security vulnerabilities and risks",
    outputContract: ["Severity rating per finding", "CVE references where applicable", "Remediation suggestions"],
    failureContract: ["Report if scope is too broad", "Do not skip findings for brevity"],
  },
  {
    id: "performance-review",
    name: "Performance Review",
    description: "Analyze performance characteristics of a system or codebase",
    category: "audit",
    defaultGoal: "Identify performance bottlenecks and optimization opportunities",
    outputContract: ["Metrics and benchmarks", "Prioritized optimization suggestions"],
    failureContract: ["Report if unable to measure", "Do not estimate without evidence"],
  },
  {
    id: "competitive-analysis",
    name: "Competitive Analysis",
    description: "Research and compare competing products, tools, or approaches",
    category: "analysis",
    defaultGoal: "Compare alternatives on features, quality, and fit",
    outputContract: ["Comparison matrix", "Recommendation with rationale"],
    failureContract: ["Report data gaps", "Do not fabricate feature comparisons"],
  },
  {
    id: "code-review",
    name: "Code Review",
    description: "Review code for quality, patterns, and potential issues",
    category: "development",
    defaultGoal: "Identify code quality issues, bugs, and improvement opportunities",
    outputContract: ["Issue severity (critical/major/minor)", "Specific file and line references", "Fix suggestions"],
    failureContract: ["Report if codebase is too large for thorough review", "Do not give generic advice"],
  },
  {
    id: "dependency-audit",
    name: "Dependency Audit",
    description: "Audit project dependencies for security, licensing, and health",
    category: "audit",
    defaultGoal: "Assess dependency health and risks",
    outputContract: ["Security vulnerability count", "License compatibility", "Maintenance status"],
    failureContract: ["Report if package registry is unreachable", "Do not skip transitive dependencies"],
  },
  {
    id: "documentation-review",
    name: "Documentation Review",
    description: "Review and assess documentation quality and completeness",
    category: "development",
    defaultGoal: "Identify documentation gaps and quality issues",
    outputContract: ["Coverage assessment", "Missing sections", "Accuracy issues"],
    failureContract: ["Report if no docs found", "Do not invent coverage metrics"],
  },
  {
    id: "market-research",
    name: "Market Research",
    description: "Research market trends, user needs, and opportunities",
    category: "research",
    defaultGoal: "Identify market opportunities and user needs",
    outputContract: ["Trend analysis", "User need patterns", "Opportunity ranking"],
    failureContract: ["Distinguish verified data from estimates", "Do not fabricate statistics"],
  },
  {
    id: "ops-health-check",
    name: "Operations Health Check",
    description: "Check infrastructure, service, and deployment health",
    category: "operations",
    defaultGoal: "Verify system health and identify issues",
    outputContract: ["Service status", "Resource utilization", "Alert summary"],
    failureContract: ["Report if unable to access monitoring", "Do not assume healthy without evidence"],
  },
];

/**
 * Find a track template by ID or keyword.
 */
export function findTemplate(query: string): TrackTemplate | undefined {
  const lower = query.toLowerCase();
  return TRACK_TEMPLATES.find(
    (t) =>
      t.id === lower ||
      t.name.toLowerCase().includes(lower) ||
      t.description.toLowerCase().includes(lower),
  );
}

/**
 * List templates by category.
 */
export function listTemplates(category?: string): TrackTemplate[] {
  if (!category) return TRACK_TEMPLATES;
  return TRACK_TEMPLATES.filter((t) => t.category === category);
}

/**
 * Build a PlannedTrack from a template + custom goal.
 */
export function buildTrackFromTemplate(
  template: TrackTemplate,
  customGoal?: string,
  windowDays?: number | null,
): PlannedTrack {
  const goal = customGoal || template.defaultGoal;
  return {
    trackId: `${template.id}-track`,
    label: template.name,
    goal,
    outputContract: template.outputContract,
    failureContract: template.failureContract,
    subagentPrompt: [
      `You are responsible for: ${template.name}.`,
      `Goal: ${goal}`,
      windowDays ? `Time window: last ${windowDays} days.` : "",
      "Output requirements:",
      ...template.outputContract.map((c) => `- ${c}`),
      "Failure requirements:",
      ...template.failureContract.map((c) => `- ${c}`),
      "Do not output HTML, 404 pages, tool logs, or run metadata.",
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

/**
 * Plan tracks from explicit template IDs or custom definitions.
 */
export function planCustomTracks(params: {
  templateIds?: string[];
  customTracks?: Array<{ trackId: string; label: string; goal: string }>;
  request?: string;
}): PlannedTrack[] {
  const windowDays = inferRecentWindowDays(params.request);
  const tracks: PlannedTrack[] = [];

  // From templates
  if (params.templateIds) {
    for (const id of params.templateIds) {
      const template = findTemplate(id);
      if (template) {
        tracks.push(buildTrackFromTemplate(template, undefined, windowDays));
      }
    }
  }

  // From custom definitions
  if (params.customTracks) {
    for (const ct of params.customTracks) {
      const outputContract = ["Provide structured results with evidence"];
      const failureContract = ["Explain specific blockers if unable to complete"];
      tracks.push({
        trackId: ct.trackId,
        label: ct.label,
        goal: ct.goal,
        outputContract,
        failureContract,
        subagentPrompt: [
          `You are responsible for: ${ct.label}.`,
          `Goal: ${ct.goal}`,
          windowDays ? `Time window: last ${windowDays} days.` : "",
          "Output requirements:",
          ...outputContract.map((c) => `- ${c}`),
          "Failure requirements:",
          ...failureContract.map((c) => `- ${c}`),
          "Do not output HTML, 404 pages, tool logs, or run metadata.",
        ]
          .filter(Boolean)
          .join("\n"),
      });
    }
  }

  return tracks;
}
