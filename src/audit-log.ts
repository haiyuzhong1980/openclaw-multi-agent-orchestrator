export interface AuditEntry {
  timestamp: string;
  event:
    | "policy_check"
    | "tool_blocked"
    | "tool_blocked_l3"
    | "subagent_spawned"
    | "subagent_ended"
    | "plan_created"
    | "merge_completed"
    | "classification";
  details: Record<string, unknown>;
}

export interface AuditLog {
  entries: AuditEntry[];
  maxEntries: number;
}

export function createAuditLog(maxEntries = 200): AuditLog {
  return {
    entries: [],
    maxEntries,
  };
}

export function logEvent(
  log: AuditLog,
  event: AuditEntry["event"],
  details: Record<string, unknown>,
): void {
  const entry: AuditEntry = {
    timestamp: new Date().toISOString(),
    event,
    details,
  };
  log.entries.push(entry);
  if (log.entries.length > log.maxEntries) {
    log.entries.shift();
  }
}

/**
 * Get recent entries, optionally filtered by event type.
 */
export function getRecentEntries(
  log: AuditLog,
  eventType?: string,
  limit?: number,
): AuditEntry[] {
  let entries = eventType ? log.entries.filter((e) => e.event === eventType) : [...log.entries];
  if (limit !== undefined && limit > 0) {
    entries = entries.slice(-limit);
  }
  return entries;
}

/**
 * Format audit log as a human-readable report.
 */
export function formatAuditReport(log: AuditLog, limit?: number): string {
  if (log.entries.length === 0) {
    return "";
  }
  let entries = [...log.entries];
  if (limit !== undefined && limit > 0) {
    entries = entries.slice(-limit);
  }
  const lines = entries.map((e) => {
    const detailStr = Object.entries(e.details)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(" ");
    return `[${e.timestamp}] ${e.event}${detailStr ? " " + detailStr : ""}`;
  });
  return lines.join("\n");
}
