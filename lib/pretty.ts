/**
 * lib/pretty.ts — Human-readable output formatting for --pretty flag
 * Only used by read-only commands; write commands always output JSON
 */

import type { Issue, SnapshotGroup } from "./issues.js";

const PRIORITY_LABEL: Record<string, string> = {
  urgent: "🔴 urgent",
  high:   "🟠 high",
  medium: "🟡 medium",
  low:    "🔵 low",
  none:   "⚪ none",
};

const STATE_LABEL: Record<string, string> = {
  backlog:     "backlog    ",
  todo:        "todo       ",
  in_progress: "in_progress",
  done:        "done       ",
  canceled:    "canceled   ",
};

function issueOneLine(i: Issue): string {
  const seq = `T-${i.seq}`.padEnd(6);
  const state = (STATE_LABEL[i.state] ?? i.state).padEnd(11);
  const prio = (PRIORITY_LABEL[i.priority] ?? i.priority).padEnd(12);
  const due = i.due_date ? ` due:${i.due_date}` : "";
  const labels = i.labels.length > 0 ? ` [${i.labels.join(",")}]` : "";
  return `${seq} ${state} ${prio} ${i.title}${due}${labels}`;
}

export function prettyIssue(issue: Issue & { relations?: unknown[]; subtasks?: Issue[] }): string {
  const lines: string[] = [];
  lines.push(`T-${issue.seq}  ${issue.title}`);
  lines.push(`  state:    ${issue.state}`);
  lines.push(`  priority: ${issue.priority}`);
  if (issue.project) lines.push(`  project:  ${issue.project}`);
  if (issue.labels.length > 0) lines.push(`  labels:   ${issue.labels.join(", ")}`);
  if (issue.parent_id) lines.push(`  parent:   ${issue.parent_id}`);
  if (issue.start_date) lines.push(`  start:    ${issue.start_date}`);
  if (issue.due_date)   lines.push(`  due:      ${issue.due_date}`);
  if (issue.done_at)    lines.push(`  done_at:  ${issue.done_at}`);
  lines.push(`  created:  ${issue.created_at}`);
  lines.push(`  updated:  ${issue.updated_at}`);
  if (issue.description) {
    lines.push("\n--- description ---");
    lines.push(issue.description);
  }
  if (issue.relations && issue.relations.length > 0) {
    lines.push("\n--- relations ---");
    for (const r of issue.relations as Array<{ source_id: string; target_id: string; type: string }>) {
      lines.push(`  ${r.type}: ${r.source_id} → ${r.target_id}`);
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

export function prettyList(issues: Issue[]): string {
  if (issues.length === 0) return "(no issues)";
  return issues.map(issueOneLine).join("\n");
}

export function prettySnapshot(snap: SnapshotGroup): string {
  const lines: string[] = [];

  const section = (title: string, items: Issue[]) => {
    lines.push(`\n=== ${title} (${items.length}) ===`);
    if (items.length === 0) { lines.push("  (none)"); return; }
    items.forEach(i => lines.push("  " + issueOneLine(i)));
  };

  section("OVERDUE", snap.overdue);
  section("DUE TODAY", snap.due_today);
  section("IN PROGRESS", snap.in_progress);
  section("ACTIONABLE", snap.actionable);

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
