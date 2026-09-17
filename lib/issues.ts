/**
 * lib/issues.ts — 唯一业务入口
 * 负责：CRUD / 批量更新 / 关系管理 / 环检测 / snapshot 聚合
 * 所有写操作经过此模块，以保证：发号、done_at 联动、md 文件同步、环检测
 */

import { nanoid } from "nanoid";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { getWriteDb, getReadDb, DATA_DIR } from "./db.js";
import { z } from "zod";

// ─── Types ────────────────────────────────────────────────────────────────────

export type State = "backlog" | "todo" | "in_progress" | "done" | "canceled";
export type Priority = "urgent" | "high" | "medium" | "low" | "none";
export type LinkType = "blocks" | "relates" | "duplicate";

export interface Issue {
  id: string;
  seq: number;
  title: string;
  state: State;
  priority: Priority;
  project: string | null;
  parent_id: string | null;
  labels: string[];
  start_date: string | null;
  due_date: string | null;
  done_at: string | null;
  created_at: string;
  updated_at: string;
  description?: string;
}

export interface IssueLink {
  source_id: string;
  target_id: string;
  type: LinkType;
  created_at: string;
}

export interface InboxItem {
  id: string;
  raw: string;
  status: "pending" | "resolved";
  resolved_issue_id: string | null;
  created_at: string;
}

// ─── Schemas (for input validation) ──────────────────────────────────────────

export const StateSchema = z.enum(["backlog", "todo", "in_progress", "done", "canceled"]);
export const PrioritySchema = z.enum(["urgent", "high", "medium", "low", "none"]);
export const LinkTypeSchema = z.enum(["blocks", "relates", "duplicate"]);

export const CreateIssueSchema = z.object({
  title: z.string().min(1),
  state: StateSchema.optional().default("todo"),
  priority: PrioritySchema.optional().default("none"),
  project: z.string().optional(),
  labels: z.array(z.string()).optional().default([]),
  start_date: z.string().optional(),
  due_date: z.string().optional(),
  parent_id: z.string().optional(),
  description: z.string().optional(),
});

export const UpdateIssueSchema = z.object({
  title: z.string().min(1).optional(),
  state: StateSchema.optional(),
  priority: PrioritySchema.optional(),
  project: z.string().nullable().optional(),
  labels: z.array(z.string()).optional(),
  start_date: z.string().nullable().optional(),
  due_date: z.string().nullable().optional(),
  parent_id: z.string().nullable().optional(),
  description: z.string().optional(),
});

export type CreateIssueInput = z.infer<typeof CreateIssueSchema>;
export type UpdateIssueInput = z.infer<typeof UpdateIssueSchema>;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Parse row from DB: deserialize labels JSON array */
function parseIssueRow(row: Record<string, unknown>): Issue {
  return {
    ...(row as Omit<Issue, "labels">),
    labels: JSON.parse((row.labels as string) ?? "[]"),
  } as Issue;
}

/** UTC ISO8601 timestamp */
function utcNow(): string {
  return new Date().toISOString();
}

/** Descriptions directory */
function descPath(id: string): string {
  const dir = resolve(DATA_DIR, "descriptions");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return resolve(dir, `${id}.md`);
}

/** Read description file content, returns null if not found */
function readDescription(id: string): string | null {
  const p = descPath(id);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

/** Write description file */
function writeDescription(id: string, content: string): void {
  writeFileSync(descPath(id), content, "utf8");
}

/** Delete description file if exists */
function deleteDescription(id: string): void {
  const p = descPath(id);
  if (existsSync(p)) unlinkSync(p);
}

/** Resolve an `idOrSeq` string to internal nanoid.
 *  Format: T-{digits} → seq lookup; otherwise direct id lookup.
 *  Returns null if not found.
 */
export function resolveId(idOrSeq: string): string | null {
  const db = getWriteDb();
  if (/^T-\d+$/.test(idOrSeq)) {
    const seq = parseInt(idOrSeq.slice(2), 10);
    const row = db.prepare("SELECT id FROM issues WHERE seq = ?").get(seq) as { id: string } | undefined;
    return row?.id ?? null;
  }
  const row = db.prepare("SELECT id FROM issues WHERE id = ?").get(idOrSeq) as { id: string } | undefined;
  return row?.id ?? null;
}

/** Next sequence number (atomic via transaction) */
function nextSeq(db: ReturnType<typeof getWriteDb>): number {
  db.prepare("UPDATE seq SET n = n + 1 WHERE id = 1").run();
  const row = db.prepare("SELECT n FROM seq WHERE id = 1").get() as { n: number };
  return row.n;
}

// ─── Issue CRUD ───────────────────────────────────────────────────────────────

export function createIssue(input: CreateIssueInput): Issue {
  const db = getWriteDb();
  const now = utcNow();
  const id = nanoid();
  const seq = nextSeq(db);

  const doneAt = (input.state === "done" || input.state === "canceled") ? now : null;

  // Resolve parent_id: accept nanoid or T-N format
  let parentId: string | null = null;
  if (input.parent_id) {
    parentId = resolveId(input.parent_id);
    if (!parentId) throw Object.assign(new Error(`Parent issue not found: ${input.parent_id}`), { code: "NOT_FOUND" });
  }

  db.prepare(`
    INSERT INTO issues (id, seq, title, state, priority, project, parent_id, labels, start_date, due_date, done_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, seq, input.title, input.state, input.priority,
    input.project ?? null, parentId,
    JSON.stringify(input.labels),
    input.start_date ?? null, input.due_date ?? null,
    doneAt, now, now
  );

  if (input.description) {
    writeDescription(id, input.description);
  }

  return getIssue(id)!;
}

export function getIssue(idOrSeq: string, includeRelations = false, includeSubtasks = false): Issue & { relations?: IssueLink[]; subtasks?: Issue[] } | null {
  const db = getWriteDb();

  // Try direct id first, then seq
  let row = db.prepare("SELECT * FROM issues WHERE id = ?").get(idOrSeq) as Record<string, unknown> | undefined;
  if (!row && /^T-\d+$/.test(idOrSeq)) {
    const seq = parseInt(idOrSeq.slice(2), 10);
    row = db.prepare("SELECT * FROM issues WHERE seq = ?").get(seq) as Record<string, unknown> | undefined;
  }
  if (!row) return null;

  const issue = parseIssueRow(row);
  issue.description = readDescription(issue.id) ?? undefined;

  const result: Issue & { relations?: IssueLink[]; subtasks?: Issue[] } = issue;

  if (includeRelations) {
    const links = db.prepare(`
      SELECT * FROM issue_links WHERE source_id = ? OR target_id = ?
    `).all(issue.id, issue.id) as IssueLink[];
    result.relations = links;
  }

  if (includeSubtasks) {
    const children = db.prepare("SELECT * FROM issues WHERE parent_id = ?").all(issue.id) as Record<string, unknown>[];
    result.subtasks = children.map(parseIssueRow);
  }

  return result;
}

export interface ListIssuesOptions {
  state?: State;
  project?: string;
  label?: string;
  due_before?: string;
  due_after?: string;
  q?: string;
  limit?: number;
  sort?: string;
  include_subtasks?: boolean;
}

export function listIssues(opts: ListIssuesOptions = {}): Issue[] {
  const db = getWriteDb();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (opts.state) { conditions.push("i.state = ?"); params.push(opts.state); }
  if (opts.project) { conditions.push("i.project = ?"); params.push(opts.project); }
  if (opts.label) {
    conditions.push("EXISTS (SELECT 1 FROM json_each(i.labels) je WHERE je.value = ?)");
    params.push(opts.label);
  }
  if (opts.due_before) { conditions.push("i.due_date <= ?"); params.push(opts.due_before); }
  if (opts.due_after)  { conditions.push("i.due_date >= ?"); params.push(opts.due_after); }
  if (opts.q) {
    conditions.push("i.title LIKE ?");
    params.push(`%${opts.q}%`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const sortCol = opts.sort === "priority" ? `CASE i.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END, i.due_date IS NULL, i.due_date` : "i.seq";
  const limitClause = opts.limit ? `LIMIT ${Math.min(opts.limit, 1000)}` : "";

  const rows = db.prepare(`SELECT i.* FROM issues i ${where} ORDER BY ${sortCol} ${limitClause}`).all(...params) as Record<string, unknown>[];
  return rows.map(parseIssueRow);
}

export function updateIssue(idOrSeq: string, patch: UpdateIssueInput): Issue {
  const id = resolveId(idOrSeq);
  if (!id) throw Object.assign(new Error(`Issue not found: ${idOrSeq}`), { code: "NOT_FOUND" });

  const db = getWriteDb();
  const now = utcNow();

  // Get current state
  const current = db.prepare("SELECT state, done_at FROM issues WHERE id = ?").get(id) as { state: State; done_at: string | null };

  const setClauses: string[] = [];
  const params: unknown[] = [];

  if (patch.title !== undefined)      { setClauses.push("title = ?");      params.push(patch.title); }
  if (patch.state !== undefined)      { setClauses.push("state = ?");      params.push(patch.state); }
  if (patch.priority !== undefined)   { setClauses.push("priority = ?");   params.push(patch.priority); }
  if (patch.project !== undefined)    { setClauses.push("project = ?");    params.push(patch.project); }
  if (patch.parent_id !== undefined) {
    let parentId: string | null = null;
    if (patch.parent_id) {
      parentId = resolveId(patch.parent_id);
      if (!parentId) throw Object.assign(new Error(`Parent issue not found: ${patch.parent_id}`), { code: "NOT_FOUND" });
    }
    setClauses.push("parent_id = ?");
    params.push(parentId);
  }
  if (patch.labels !== undefined)     { setClauses.push("labels = ?");     params.push(JSON.stringify(patch.labels)); }
  if (patch.start_date !== undefined) { setClauses.push("start_date = ?"); params.push(patch.start_date); }
  if (patch.due_date !== undefined)   { setClauses.push("due_date = ?");   params.push(patch.due_date); }

  // done_at state machine
  const newState = patch.state ?? current.state;
  const wasDoneOrCanceled = current.state === "done" || current.state === "canceled";
  const isDoneOrCanceled  = newState === "done"       || newState === "canceled";
  if (patch.state !== undefined) {
    if (isDoneOrCanceled && !wasDoneOrCanceled) {
      setClauses.push("done_at = ?");
      params.push(now);
    } else if (!isDoneOrCanceled && wasDoneOrCanceled) {
      setClauses.push("done_at = NULL");
    }
  }

  if (patch.description !== undefined) {
    writeDescription(id, patch.description);
  }

  if (setClauses.length > 0) {
    setClauses.push("updated_at = ?");
    params.push(now, id);
    db.prepare(`UPDATE issues SET ${setClauses.join(", ")} WHERE id = ?`).run(...params);
  }

  return getIssue(id)!;
}

export function deleteIssue(idOrSeq: string): void {
  const id = resolveId(idOrSeq);
  if (!id) throw Object.assign(new Error(`Issue not found: ${idOrSeq}`), { code: "NOT_FOUND" });

  const db = getWriteDb();

  // Reject if has subtasks
  const children = db.prepare("SELECT seq, title FROM issues WHERE parent_id = ?").all(id) as { seq: number; title: string }[];
  if (children.length > 0) {
    const list = children.map(c => `T-${c.seq}: ${c.title}`).join(", ");
    throw Object.assign(new Error(`Cannot delete: issue has subtasks: ${list}`), { code: "HAS_SUBTASKS", subtasks: children });
  }

  db.transaction(() => {
    // issue_links cascade on DELETE via FK ON DELETE CASCADE
    db.prepare("DELETE FROM issues WHERE id = ?").run(id);
    // inbox: resolved_issue_id SET NULL via FK ON DELETE SET NULL
  })();

  deleteDescription(id);
}

// ─── Batch Update ─────────────────────────────────────────────────────────────

export interface BatchUpdateItem {
  id: string;
  patch: UpdateIssueInput;
}

export function batchUpdateIssues(items: BatchUpdateItem[]): Issue[] {
  const db = getWriteDb();
  const results: Issue[] = [];

  db.transaction(() => {
    for (const item of items) {
      // Validate each item within transaction; any error rolls back all
      const updated = updateIssue(item.id, item.patch);
      results.push(updated);
    }
  })();

  return results;
}

// ─── Relations / Links ────────────────────────────────────────────────────────

/**
 * Detect cycle when adding edge (proposedSource → proposedTarget, blocks).
 * BFS from `proposedTarget` following FORWARD blocks edges.
 * If we can reach `proposedSource`, adding the new edge would create a cycle.
 *
 * Direction: (source_id, target_id, 'blocks') means source blocks target.
 * Forward traversal: from node X, follow edges where X is source_id → reach target_ids.
 */
function hasCycle(db: ReturnType<typeof getWriteDb>, proposedTarget: string, proposedSource: string): { cycle: boolean; path: string[] } {
  const visited = new Set<string>();
  const queue: Array<{ id: string; path: string[] }> = [{ id: proposedTarget, path: [proposedTarget] }];

  while (queue.length > 0) {
    const { id, path: currentPath } = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);

    // Follow forward edges: find what `id` blocks (target_ids where source_id = id)
    const blocked = db.prepare(
      "SELECT target_id FROM issue_links WHERE source_id = ? AND type = 'blocks'"
    ).all(id) as { target_id: string }[];

    for (const { target_id } of blocked) {
      if (target_id === proposedSource) {
        // Cycle: proposedTarget →...→ proposedSource, and we're adding proposedSource → proposedTarget
        return { cycle: true, path: [...currentPath, target_id] };
      }
      if (!visited.has(target_id)) {
        queue.push({ id: target_id, path: [...currentPath, target_id] });
      }
    }
  }

  return { cycle: false, path: [] };
}

export function linkIssues(sourceIdOrSeq: string, targetIdOrSeq: string, type: LinkType): IssueLink[] {
  const sourceId = resolveId(sourceIdOrSeq);
  if (!sourceId) throw Object.assign(new Error(`Source issue not found: ${sourceIdOrSeq}`), { code: "NOT_FOUND" });

  const targetId = resolveId(targetIdOrSeq);
  if (!targetId) throw Object.assign(new Error(`Target issue not found: ${targetIdOrSeq}`), { code: "NOT_FOUND" });

  const db = getWriteDb();
  const now = utcNow();

  if (type === "blocks") {
    // Adding (source, target, blocks) means source blocks target.
    // Cycle check: can we reach source from target via existing blocks edges?
    const { cycle, path } = hasCycle(db, targetId, sourceId);
    if (cycle) {
      // Build human-readable path with seq numbers
      // path is: [targetId, ..., sourceId]
      // The cycle would be: source → target → ... → source
      const seqMap = db.prepare("SELECT id, seq FROM issues").all() as { id: string; seq: number }[];
      const seqById = new Map(seqMap.map(r => [r.id, r.seq]));
      // Display as: source→target→...→source (the full proposed cycle)
      const cyclePath = [sourceId, ...path].map(id => `T-${seqById.get(id) ?? id}`).join("→");
      throw Object.assign(new Error(`Cycle detected: ${cyclePath}`), { code: "CYCLE", path: cyclePath });
    }
  }

  db.prepare(`
    INSERT OR REPLACE INTO issue_links (source_id, target_id, type, created_at)
    VALUES (?, ?, ?, ?)
  `).run(sourceId, targetId, type, now);

  // Return all links for these two issues
  return db.prepare(`
    SELECT * FROM issue_links WHERE (source_id = ? AND target_id = ?) OR (source_id = ? AND target_id = ?)
  `).all(sourceId, targetId, targetId, sourceId) as IssueLink[];
}

export function unlinkIssues(sourceIdOrSeq: string, targetIdOrSeq: string, type: LinkType): void {
  const sourceId = resolveId(sourceIdOrSeq);
  if (!sourceId) throw Object.assign(new Error(`Source issue not found: ${sourceIdOrSeq}`), { code: "NOT_FOUND" });

  const targetId = resolveId(targetIdOrSeq);
  if (!targetId) throw Object.assign(new Error(`Target issue not found: ${targetIdOrSeq}`), { code: "NOT_FOUND" });

  const db = getWriteDb();

  if (type === "blocks") {
    db.prepare("DELETE FROM issue_links WHERE source_id = ? AND target_id = ? AND type = 'blocks'").run(sourceId, targetId);
  } else {
    // Symmetric: delete both directions
    db.prepare("DELETE FROM issue_links WHERE ((source_id = ? AND target_id = ?) OR (source_id = ? AND target_id = ?)) AND type = ?")
      .run(sourceId, targetId, targetId, sourceId, type);
  }
}

// ─── Dependencies ─────────────────────────────────────────────────────────────

export interface DepNode extends Issue {
  is_blocked: boolean;
}

export function getDeps(idOrSeq: string): DepNode[] {
  const id = resolveId(idOrSeq);
  if (!id) throw Object.assign(new Error(`Issue not found: ${idOrSeq}`), { code: "NOT_FOUND" });

  const db = getWriteDb();

  const rows = db.prepare(`
    WITH RECURSIVE deps(id) AS (
      SELECT l.source_id FROM issue_links l
       WHERE l.target_id = ? AND l.type = 'blocks'
      UNION
      SELECT l.source_id FROM issue_links l
       JOIN deps d ON l.target_id = d.id
       WHERE l.type = 'blocks'
    )
    SELECT i.* FROM issues i WHERE i.id IN (SELECT id FROM deps)
  `).all(id) as Record<string, unknown>[];

  return rows.map(row => {
    const issue = parseIssueRow(row);
    const isBlocked = db.prepare(`
      SELECT 1 FROM issue_links l
        JOIN issues s ON s.id = l.source_id
       WHERE l.target_id = ? AND l.type = 'blocks'
         AND s.state NOT IN ('done','canceled')
       LIMIT 1
    `).get(issue.id) !== undefined;
    return { ...issue, is_blocked: isBlocked };
  });
}

// ─── Snapshot ─────────────────────────────────────────────────────────────────

export interface SnapshotGroup {
  overdue: Issue[];
  due_today: Issue[];
  in_progress: Issue[];
  actionable: Issue[];
  blocked: Array<Issue & { blockers: Issue[] }>;
  stale: Issue[];
}

export function snapshot(staleDays = 30): SnapshotGroup {
  const db = getWriteDb();
  const now = new Date();

  // Local date: YYYY-MM-DD
  const todayStr = now.toLocaleDateString("sv-SE"); // "sv-SE" gives YYYY-MM-DD format
  // Stale threshold: N days ago
  const staleThreshold = new Date(now.getTime() - staleDays * 86400 * 1000).toISOString();

  // Overdue: past due_date, not done/canceled
  const overdue = (db.prepare(`
    SELECT * FROM issues
     WHERE state NOT IN ('done','canceled')
       AND due_date IS NOT NULL AND due_date < ?
     ORDER BY due_date
  `).all(todayStr) as Record<string, unknown>[]).map(parseIssueRow);

  // Due today
  const due_today = (db.prepare(`
    SELECT * FROM issues
     WHERE state NOT IN ('done','canceled')
       AND due_date = ?
     ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END
  `).all(todayStr) as Record<string, unknown>[]).map(parseIssueRow);

  // In progress
  const in_progress = (db.prepare(`
    SELECT * FROM issues WHERE state = 'in_progress' ORDER BY updated_at DESC
  `).all() as Record<string, unknown>[]).map(parseIssueRow);

  // Actionable: todo/in_progress without unfinished blockers, sorted by priority+due
  const actionable = (db.prepare(`
    SELECT * FROM issues i
     WHERE i.state IN ('todo','in_progress')
       AND NOT EXISTS (
         SELECT 1 FROM issue_links l JOIN issues s ON s.id = l.source_id
          WHERE l.target_id = i.id AND l.type = 'blocks'
            AND s.state NOT IN ('done','canceled'))
     ORDER BY CASE i.priority
       WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2
       WHEN 'low' THEN 3 ELSE 4 END,
       i.due_date IS NULL, i.due_date
  `).all() as Record<string, unknown>[]).map(parseIssueRow);

  // Blocked: has at least one unfinished blocker
  const blockedRows = db.prepare(`
    SELECT DISTINCT i.* FROM issues i
      JOIN issue_links l ON l.target_id = i.id AND l.type = 'blocks'
      JOIN issues s ON s.id = l.source_id AND s.state NOT IN ('done','canceled')
     WHERE i.state NOT IN ('done','canceled')
  `).all() as Record<string, unknown>[];

  const blocked: Array<Issue & { blockers: Issue[] }> = blockedRows.map(row => {
    const issue = parseIssueRow(row);
    const blockers = (db.prepare(`
      SELECT s.* FROM issue_links l JOIN issues s ON s.id = l.source_id
       WHERE l.target_id = ? AND l.type = 'blocks'
         AND s.state NOT IN ('done','canceled')
    `).all(issue.id) as Record<string, unknown>[]).map(parseIssueRow);
    return { ...issue, blockers };
  });

  // Stale: not done/canceled, updated_at older than threshold
  const stale = (db.prepare(`
    SELECT * FROM issues
     WHERE state NOT IN ('done','canceled')
       AND updated_at < ?
     ORDER BY updated_at
  `).all(staleThreshold) as Record<string, unknown>[]).map(parseIssueRow);

  return { overdue, due_today, in_progress, actionable, blocked, stale };
}

// ─── Inbox ────────────────────────────────────────────────────────────────────

export function inboxAdd(raw: string): InboxItem {
  const db = getWriteDb();
  const id = nanoid();
  const now = utcNow();
  db.prepare("INSERT INTO inbox (id, raw, status, created_at) VALUES (?, ?, 'pending', ?)").run(id, raw, now);
  return db.prepare("SELECT * FROM inbox WHERE id = ?").get(id) as InboxItem;
}

export function inboxList(status?: "pending" | "resolved"): InboxItem[] {
  const db = getWriteDb();
  if (status) {
    return db.prepare("SELECT * FROM inbox WHERE status = ? ORDER BY created_at").all(status) as InboxItem[];
  }
  return db.prepare("SELECT * FROM inbox ORDER BY created_at").all() as InboxItem[];
}

export function inboxResolve(id: string, issueIdOrSeq?: string): InboxItem {
  const db = getWriteDb();
  let issueId: string | null = null;
  if (issueIdOrSeq) {
    issueId = resolveId(issueIdOrSeq);
    if (!issueId) throw Object.assign(new Error(`Issue not found: ${issueIdOrSeq}`), { code: "NOT_FOUND" });
  }
  const item = db.prepare("SELECT * FROM inbox WHERE id = ?").get(id) as InboxItem | undefined;
  if (!item) throw Object.assign(new Error(`Inbox item not found: ${id}`), { code: "NOT_FOUND" });

  db.prepare("UPDATE inbox SET status = 'resolved', resolved_issue_id = ? WHERE id = ?").run(issueId, id);
  return db.prepare("SELECT * FROM inbox WHERE id = ?").get(id) as InboxItem;
}

// ─── Search ───────────────────────────────────────────────────────────────────

export function searchIssues(q: string): Issue[] {
  const db = getWriteDb();
  const lowerQ = q.toLowerCase();

  const rows = db.prepare(`
    SELECT * FROM issues WHERE title LIKE ? ORDER BY seq DESC LIMIT 200
  `).all(`%${q}%`) as Record<string, unknown>[];
  const titleMatches = rows.map(parseIssueRow);
  const titleMatchIds = new Set(titleMatches.map(i => i.id));

  // Also search description files for issues not already matched by title
  const descDir = resolve(DATA_DIR, "descriptions");
  const extraMatches: Issue[] = [];

  if (existsSync(descDir)) {
    let files: string[] = [];
    try { files = readdirSync(descDir); } catch { /* ignore */ }
    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      const issueId = file.slice(0, -3);
      if (titleMatchIds.has(issueId)) continue;
      const content = readDescription(issueId);
      if (content && content.toLowerCase().includes(lowerQ)) {
        const issue = getIssue(issueId);
        if (issue) extraMatches.push(issue);
      }
    }
  }

  return [...titleMatches, ...extraMatches];
}

// ─── Query (read-only escape hatch) ──────────────────────────────────────────

export function runQuery(sql: string, limit = 200): unknown[] {
  const trimmed = sql.trim();

  // Reject multiple statements (semicolons other than trailing)
  const stripped = trimmed.replace(/;$/, "");
  if (stripped.includes(";")) {
    throw Object.assign(new Error("Multiple statements are not allowed"), { code: "INVALID_SQL" });
  }

  // Must start with SELECT or WITH
  if (!/^(SELECT|WITH)\s/i.test(trimmed)) {
    throw Object.assign(new Error("Only SELECT/WITH statements are allowed"), { code: "INVALID_SQL" });
  }

  const actualLimit = Math.min(limit, 1000);
  const db = getReadDb();

  // Wrap in outer LIMIT to cap results
  const wrapped = `SELECT * FROM (${stripped}) LIMIT ${actualLimit}`;
  try {
    return db.prepare(wrapped).all();
  } catch (e) {
    throw Object.assign(new Error(`SQL error: ${(e as Error).message}`), { code: "SQL_ERROR" });
  }
}

// ─── Schema output ────────────────────────────────────────────────────────────

export const SCHEMA_DDL = `
-- plumb schema
-- Timestamp semantics: created_at/updated_at/done_at = UTC ISO8601
--   start_date/due_date = local date YYYY-MM-DD

-- issues: main task table
--   state: backlog|todo|in_progress|done|canceled
--   priority: urgent|high|medium|low|none
--   labels: JSON array of strings e.g. ["work","q4"]
--   done_at: auto-set when state→done/canceled; cleared on exit

-- issue_links: task relations
--   type=blocks: (source_id, target_id) means source BLOCKS target
--     (source is prerequisite, target is blocked)
--   type=relates|duplicate: symmetric, query both directions

-- inbox: raw capture queue
--   status: pending|resolved
--   resolved_issue_id: optional link to created issue

-- seq: global sequence counter for T-{n} display IDs

-- Example queries:
-- List all open issues by priority:
--   SELECT seq, title, state, priority, due_date FROM issues
--    WHERE state NOT IN ('done','canceled')
--    ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END;
--
-- Issues blocking T-5:
--   SELECT s.seq, s.title, s.state FROM issue_links l
--    JOIN issues s ON s.id = l.source_id
--    WHERE l.target_id = (SELECT id FROM issues WHERE seq = 5) AND l.type = 'blocks';
--
-- Issues with label 'work':
--   SELECT * FROM issues WHERE EXISTS (SELECT 1 FROM json_each(labels) je WHERE je.value = 'work');
`;
