/**
 * lib/pretty.ts — Human-readable output formatting for --pretty flag
 * Only used by read-only commands; write commands always output JSON
 */

import type { Issue, SnapshotGroup, DerivedFields } from "./issues.js";

const PRIORITY_LABEL: Record<string, string> = {
  urgent: "urgent",
  high:   "high  ",
  medium: "medium",
  low:    "low   ",
  none:   "none  ",
};

const STATE_LABEL: Record<string, string> = {
  backlog:     "backlog    ",
  todo:        "todo       ",
  in_progress: "in_progress",
  done:        "done       ",
  canceled:    "canceled   ",
};

function issueOneLine(i: Issue & { derived?: DerivedFields }): string {
  const seq   = `T-${i.seq}`.padEnd(6);
  const state = (STATE_LABEL[i.state] ?? i.state).padEnd(11);
  const prio  = (PRIORITY_LABEL[i.priority] ?? i.priority).padEnd(6);
  const due   = i.due_ts ? ` due:${i.due_date ?? i.due_ts.slice(0,10)}` : (i.due_date ? ` due:${i.due_date}` : "");
  const labels = i.labels.length > 0 ? ` [${i.labels.join(",")}]` : "";
  const derived = i.derived
    ? ` [r=${i.derived.readiness_score.toFixed(2)}${i.derived.is_blocked ? " BLOCKED" : ""}${i.derived.is_overdue ? " OVERDUE" : ""}${i.derived.is_snoozed ? " snoozed" : ""}]`
    : "";
  return `${seq} ${state} ${prio} ${i.title}${due}${labels}${derived}`;
}

export function prettyIssue(issue: Issue & { relations?: unknown[]; subtasks?: Issue[]; derived?: DerivedFields }): string {
  const lines: string[] = [];
  lines.push(`T-${issue.seq}  ${issue.title}`);
  lines.push(`  state:    ${issue.state}`);
  lines.push(`  priority: ${issue.priority}`);
  if (issue.project) lines.push(`  project:  ${issue.project}`);
  if (issue.labels.length > 0) lines.push(`  labels:   ${issue.labels.join(", ")}`);
  if (issue.parent_id) lines.push(`  parent:   ${issue.parent_id}`);
  if (issue.start_ts)    lines.push(`  start_ts: ${issue.start_ts}`);
  if (issue.due_ts)      lines.push(`  due_ts:   ${issue.due_ts}${issue.due_tz ? ` (${issue.due_tz})` : ""}`);
  if (issue.due_date)    lines.push(`  due_date: ${issue.due_date}`);
  if (issue.rrule)       lines.push(`  rrule:    ${issue.rrule}`);
  if (issue.snooze_until) lines.push(`  snoozed:  until ${issue.snooze_until}`);
  if (issue.verify)      lines.push(`  verify:   ${JSON.stringify(issue.verify)}`);
  if (issue.done_at)     lines.push(`  done_at:  ${issue.done_at}`);
  lines.push(`  created:  ${issue.created_at}`);
  lines.push(`  updated:  ${issue.updated_at}`);
  if (issue.derived) {
    const d = issue.derived;
    lines.push(`  readiness: ${d.readiness_score.toFixed(3)}  hint: ${d.next_action_hint}`);
    lines.push(`  is_blocked:${d.is_blocked} is_overdue:${d.is_overdue} is_stale:${d.is_stale} is_snoozed:${d.is_snoozed} is_verified:${d.is_verified ?? "n/a"}`);
  }
  if (issue.description) {
    lines.push("\n--- description ---");
    lines.push(issue.description);
  }
  if (issue.relations && issue.relations.length > 0) {
    lines.push("\n--- relations ---");
    for (const r of issue.relations as Array<{ source_id: string; target_id: string; type: string; weight: number }>) {
      lines.push(`  ${r.type}(w=${r.weight}): ${r.source_id} → ${r.target_id}`);
    }
  }
  if (issue.subtasks && issue.subtasks.length > 0) {
    lines.push("\n--- subtasks ---");
    for (const s of issue.subtasks) {
      lines.push(`  ${issueOneLine(s)}`);
    }
  }
  return lines.join("\n");
}

export function prettyList(issues: (Issue & { derived?: DerivedFields })[]): string {
  if (issues.length === 0) return "(no issues)";
  return issues.map(issueOneLine).join("\n");
}

export function prettySnapshot(snap: SnapshotGroup): string {
  const lines: string[] = [];

  const section = (title: string, items: (Issue & { derived?: DerivedFields })[]) => {
    lines.push(`\n=== ${title} (${items.length}) ===`);
    if (items.length === 0) { lines.push("  (none)"); return; }
    items.forEach(i => lines.push("  " + issueOneLine(i)));
  };

  section("OVERDUE", snap.overdue);
  section("DUE TODAY", snap.due_today);
  section("IN PROGRESS", snap.in_progress);
  section("ACTIONABLE (by readiness)", snap.actionable);

  lines.push(`\n=== BLOCKED (${snap.blocked.length}) ===`);
  if (snap.blocked.length === 0) {
    lines.push("  (none)");
  } else {
    for (const item of snap.blocked) {
      lines.push("  " + issueOneLine(item));
      for (const b of item.blockers) {
        lines.push(`    ← blocked by: T-${b.seq} [${b.state}] ${b.title}`);
      }
    }
  }

  section("STALE (>30d)", snap.stale);
  section("AWAITING USER", snap.awaiting_user);

  // done_unverified notice
  const doneUnverified = [
    ...snap.in_progress,
    ...snap.actionable,
  ].filter(i => i.state === "done" && i.derived?.is_verified === false);
  if (doneUnverified.length > 0) {
    lines.push(`\n=== DONE BUT UNVERIFIED (${doneUnverified.length}) ===`);
    doneUnverified.forEach(i => lines.push("  " + issueOneLine(i)));
  }

  return lines.join("\n");
}

export function prettyBoard(issuesByState: Map<string, Issue[]>): string {
  const COLS: Array<{ state: string; label: string }> = [
    { state: "backlog",     label: "BACKLOG" },
    { state: "todo",        label: "TODO" },
    { state: "in_progress", label: "IN PROGRESS" },
    { state: "done",        label: "DONE" },
    { state: "canceled",    label: "CANCELED" },
  ];

  const COL_WIDTH = 30;
  const lines: string[] = [];

  // Header
  lines.push(COLS.map(c => c.label.padEnd(COL_WIDTH)).join(" | "));
  lines.push(COLS.map(() => "-".repeat(COL_WIDTH)).join("-+-"));

  // Find max rows
  const columns = COLS.map(c => issuesByState.get(c.state) ?? []);
  const maxRows = Math.max(...columns.map(c => c.length), 1);

  for (let row = 0; row < maxRows; row++) {
    const cells = columns.map(col => {
      if (row >= col.length) return " ".repeat(COL_WIDTH);
      const i = col[row];
      const cell = `T-${i.seq} ${i.title}`;
      return cell.length > COL_WIDTH ? cell.slice(0, COL_WIDTH - 1) + "…" : cell.padEnd(COL_WIDTH);
    });
    lines.push(cells.join(" | "));
  }

  return lines.join("\n");
}
