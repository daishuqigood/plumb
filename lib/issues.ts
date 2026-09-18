/**
 * lib/issues.ts — 唯一业务入口（v3 重写）
 *
 * 所有写操作 = appendEvents + applyEvent，单事务内完成（事件流与投影保证一致）。
 * 读操作默认走 issues_live 视图（过滤 tombstone）。
 * 派生可执行性层（readiness/blocked/overdue 等）查询时现算，不落库。
 */

import { nanoid } from "nanoid";
import {
  existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, statSync,
} from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { getWriteDb, getReadDb, DATA_DIR } from "./db.js";
import {
  appendEvents, applyEvent, newOpId, utcNow,
  type EventInput, type Event, type Provenance,
} from "./events.js";
import { z } from "zod";
import { nextDueTs, validateRRule } from "./rrule.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type State = "backlog" | "todo" | "in_progress" | "done" | "canceled";
export type Priority = "urgent" | "high" | "medium" | "low" | "none";

/** 开放边类型（blocks 有环检测；其他无） */
export type EdgeType = string;
/** 向后兼容旧枚举 */
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
  attrs: Record<string, unknown>;
  field_meta: Record<string, unknown>;
  // 完整时间模型
  start_ts: string | null;
  due_ts: string | null;
  due_tz: string | null;
  due_date: string | null;
  rrule: string | null;
  snooze_until: string | null;
  start_date: string | null;
  done_at: string | null;
  created_at: string;
  updated_at: string;
  // CAS description
  desc_hash: string | null;
  description?: string;
  // verify
  verify: VerifySpec | null;
  // tombstone
  deleted: number;
  last_event_seq: number;
}

/** 验收标准 */
export interface VerifySpec {
  type: "command" | "manual";
  cmd?: string;
  expect?: string;
  note?: string;
}

export interface Edge {
  id: string;
  source_id: string;
  target_id: string;
  type: string;
  weight: number;
  valid_from: string;
  valid_to: string | null;
  created_at: string;
}

export interface InboxItem {
  id: string;
  raw: string;
  status: "pending" | "resolved";
  resolved_issue_id: string | null;
  origin: string | null;
  session_id: string | null;
  created_at: string;
}

/** 派生可执行性层（查询时现算，不落库） */
export interface DerivedFields {
  is_blocked: boolean;
  is_overdue: boolean;
  is_stale: boolean;
  is_snoozed: boolean;
  is_verified: boolean | null;  // null = no verify spec
  readiness_score: number;
  next_action_hint: string;
}

// ─── Readiness 常数（单测覆盖即行为覆盖）────────────────────────────────────

const READINESS = {
  PRIORITY_WEIGHT: 0.4,
  DUE_WEIGHT: 0.4,
  BLOCKED_PENALTY: 0.5,
  STALE_PENALTY: 0.3,
  STALE_DAYS: 30,
  STALE_WINDOW_DAYS: 90,
  PRIORITY_SCORE: { urgent: 1.0, high: 0.75, medium: 0.5, low: 0.25, none: 0.0 } as Record<Priority, number>,
} as const;

// ─── Schemas ──────────────────────────────────────────────────────────────────

export const StateSchema = z.enum(["backlog", "todo", "in_progress", "done", "canceled"]);
export const PrioritySchema = z.enum(["urgent", "high", "medium", "low", "none"]);
export const LinkTypeSchema = z.enum(["blocks", "relates", "duplicate"]);

const VerifySpecSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("command"), cmd: z.string(), expect: z.string().optional() }),
  z.object({ type: z.literal("manual"), note: z.string().optional() }),
]);

export const CreateIssueSchema = z.object({
  title: z.string().min(1),
  state: StateSchema.optional().default("todo"),
  priority: PrioritySchema.optional().default("none"),
  project: z.string().optional(),
  labels: z.array(z.string()).optional().default([]),
  attrs: z.record(z.unknown()).optional().default({}),
  // 完整时间模型
  start_ts: z.string().optional(),
  due_ts: z.string().optional(),
  due_tz: z.string().optional(),
  due_date: z.string().optional(),
  rrule: z.string().optional(),
  snooze_until: z.string().optional(),
  start_date: z.string().optional(),
  parent_id: z.string().optional(),
  description: z.string().optional(),
  verify: VerifySpecSchema.optional(),
});

export const UpdateIssueSchema = z.object({
  title: z.string().min(1).optional(),
  state: StateSchema.optional(),
  priority: PrioritySchema.optional(),
  project: z.string().nullable().optional(),
  labels: z.array(z.string()).optional(),
  attrs: z.record(z.unknown()).optional(),
  start_ts: z.string().nullable().optional(),
  due_ts: z.string().nullable().optional(),
  due_tz: z.string().nullable().optional(),
  due_date: z.string().nullable().optional(),
  rrule: z.string().nullable().optional(),
  snooze_until: z.string().nullable().optional(),
  start_date: z.string().nullable().optional(),
  parent_id: z.string().nullable().optional(),
  description: z.string().optional(),
  verify: VerifySpecSchema.nullable().optional(),
});

export type CreateIssueInput = z.infer<typeof CreateIssueSchema>;
export type UpdateIssueInput = z.infer<typeof UpdateIssueSchema>;

// ─── CAS Description ──────────────────────────────────────────────────────────

function descDir(): string {
  const d = resolve(DATA_DIR, "descriptions");
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  return d;
}

/** Compute content hash (first 16 hex chars of sha256) */
function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex").slice(0, 32);
}

export function casPath(hash: string): string {
  return resolve(descDir(), `${hash}.md`);
}

/** Write content to CAS, return hash. Idempotent (same content → same hash). */
export function casWrite(content: string): string {
  const hash = hashContent(content);
  const p = casPath(hash);
  if (!existsSync(p)) writeFileSync(p, content, "utf8");
  return hash;
}

/** Read CAS content by hash. Returns null if not found. */
export function casRead(hash: string | null): string | null {
  if (!hash) return null;
  const p = casPath(hash);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

/** List all hashes referenced in issues.desc_hash */
export function referencedHashes(): Set<string> {
  const db = getWriteDb();
  const rows = db.prepare("SELECT desc_hash FROM issues WHERE desc_hash IS NOT NULL").all() as { desc_hash: string }[];
  return new Set(rows.map(r => r.desc_hash));
}

// ─── Row Parsing ──────────────────────────────────────────────────────────────

function parseIssueRow(row: Record<string, unknown>): Issue {
  return {
    ...(row as Omit<Issue, "labels" | "attrs" | "field_meta" | "verify">),
    labels: JSON.parse((row.labels as string) ?? "[]"),
    attrs:  JSON.parse((row.attrs  as string) ?? "{}"),
    field_meta: JSON.parse((row.field_meta as string) ?? "{}"),
    verify: row.verify ? (JSON.parse(row.verify as string) as VerifySpec) : null,
    deleted: (row.deleted as number) ?? 0,
    last_event_seq: (row.last_event_seq as number) ?? 0,
  } as Issue;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Resolve idOrSeq → nanoid. Reads issues (including deleted for undo). */
export function resolveId(idOrSeq: string, includeDeleted = false): string | null {
  const db = getWriteDb();
  const tbl = includeDeleted ? "issues" : "issues_live";
  if (/^T-\d+$/.test(idOrSeq)) {
    const seq = parseInt(idOrSeq.slice(2), 10);
    const row = db.prepare(`SELECT id FROM ${tbl} WHERE seq = ?`).get(seq) as { id: string } | undefined;
    return row?.id ?? null;
  }
  const row = db.prepare(`SELECT id FROM ${tbl} WHERE id = ?`).get(idOrSeq) as { id: string } | undefined;
  return row?.id ?? null;
}

/** Next issue seq (atomic) */
function nextSeq(db: ReturnType<typeof getWriteDb>): number {
  db.prepare("UPDATE seq SET n = n + 1 WHERE id = 1").run();
  return (db.prepare("SELECT n FROM seq WHERE id = 1").get() as { n: number }).n;
}

/** Derive local due_date string (YYYY-MM-DD) from UTC due_ts + IANA tz */
function deriveDueDate(dueTsUtc: string, dueTz?: string | null): string {
  const d = new Date(dueTsUtc);
  if (dueTz) {
    try {
      return d.toLocaleDateString("sv-SE", { timeZone: dueTz }); // sv-SE → YYYY-MM-DD
    } catch {
      // fall through to UTC date
    }
  }
  return d.toISOString().slice(0, 10);
}

// ─── Derived Computability Layer ──────────────────────────────────────────────

/**
 * Compute derived fields for an issue.
 * Called from getIssue / listIssues / snapshot (on-the-fly, not persisted).
 */
export function computeDerived(
  issue: Issue,
  db: ReturnType<typeof getWriteDb>,
  now = new Date(),
): DerivedFields {
  const nowTs = now.toISOString();

  // is_blocked: has active (valid_to IS NULL) blocks edge where source.state ∉ done/canceled
  const blocked = db.prepare(`
    SELECT 1 FROM edges e
      JOIN issues s ON s.id = e.source_id
     WHERE e.target_id = ? AND e.type = 'blocks' AND e.valid_to IS NULL
       AND s.state NOT IN ('done','canceled') AND s.deleted = 0
     LIMIT 1
  `).get(issue.id) !== undefined;

  // is_overdue: due_ts < now AND state ∉ done/canceled
  const isOverdue = !!(issue.due_ts
    && issue.due_ts < nowTs
    && issue.state !== "done"
    && issue.state !== "canceled");

  // is_stale: updated_at < now − STALE_DAYS AND not done/canceled
  const staleThreshold = new Date(now.getTime() - READINESS.STALE_DAYS * 86400_000).toISOString();
  const isStale = issue.state !== "done"
    && issue.state !== "canceled"
    && issue.updated_at < staleThreshold;

  // is_snoozed: snooze_until > now
  const isSnoozed = !!(issue.snooze_until && issue.snooze_until > nowTs);

  // is_verified: latest verify_run event result; null if no verify spec
  let isVerified: boolean | null = null;
  if (issue.verify) {
    const latestRun = db.prepare(`
      SELECT new FROM events
       WHERE entity = 'issue' AND entity_id = ? AND type = 'verify_run'
       ORDER BY seq DESC LIMIT 1
    `).get(issue.id) as { new: string } | undefined;
    if (latestRun) {
      try {
        const data = JSON.parse(latestRun.new) as { result?: string };
        isVerified = data.result === "pass";
      } catch {
        isVerified = false;
      }
    } else {
      isVerified = false;
    }
  }

  // readiness_score
  const priorityScore = READINESS.PRIORITY_SCORE[issue.priority] ?? 0;

  let dueUrgency = 0;
  if (issue.due_ts) {
    const msLeft = new Date(issue.due_ts).getTime() - now.getTime();
    if (msLeft < 0)                                dueUrgency = 1.0;
    else if (msLeft < 86400_000)                   dueUrgency = 0.8;
    else if (msLeft < 7 * 86400_000)               dueUrgency = 0.5;
    else if (msLeft < 30 * 86400_000)              dueUrgency = 0.2;
    else                                           dueUrgency = 0.0;
  }

  const daysStale = (now.getTime() - new Date(issue.updated_at).getTime()) / 86400_000;
  const stalePenalty = isStale ? Math.min(daysStale / READINESS.STALE_WINDOW_DAYS, 1.0) : 0;

  const readiness = Math.max(0, Math.min(1,
    READINESS.PRIORITY_WEIGHT  * priorityScore
    + READINESS.DUE_WEIGHT     * dueUrgency
    - READINESS.BLOCKED_PENALTY * (blocked ? 1.0 : 0.0)
    - READINESS.STALE_PENALTY  * stalePenalty,
  ));

  // next_action_hint
  let hint: string;
  if (blocked) {
    const blockers = db.prepare(`
      SELECT s.seq FROM edges e JOIN issues s ON s.id = e.source_id
       WHERE e.target_id = ? AND e.type = 'blocks' AND e.valid_to IS NULL
         AND s.state NOT IN ('done','canceled') AND s.deleted = 0
       LIMIT 1
    `).get(issue.id) as { seq: number } | undefined;
    hint = blockers ? `unblock:T-${blockers.seq}` : "unblock";
  } else if (isOverdue) {
    hint = "reschedule_or_complete";
  } else if (isSnoozed) {
    hint = `snoozed_until:${issue.snooze_until}`;
  } else if (issue.state === "done" && issue.verify && isVerified === false) {
    hint = "verify";
  } else {
    hint = "start";
  }

  return {
    is_blocked: blocked,
    is_overdue: isOverdue,
    is_stale: isStale,
    is_snoozed: isSnoozed,
    is_verified: isVerified,
    readiness_score: Math.round(readiness * 1000) / 1000,
    next_action_hint: hint,
  };
}

// ─── Issue CRUD ───────────────────────────────────────────────────────────────

/** Shared provenance defaults for CLI calls. Caller passes via CreateIssueOptions. */
export interface WriteOptions extends Provenance {
  op_id?: string;
}

function mergeProvenance(prov?: WriteOptions): { actor: string; reason: string | null; raw_input: string | null; conf: number | null; session_id: string | null; src: Provenance["src"] } {
  return {
    actor:      prov?.actor      ?? "user",
    reason:     prov?.reason     ?? null,
    raw_input:  prov?.raw_input  ?? null,
    conf:       prov?.conf       ?? null,
    session_id: prov?.session_id ?? null,
    src:        prov?.src        ?? null,
  };
}

export function createIssue(input: CreateIssueInput, prov?: WriteOptions): Issue {
  const db = getWriteDb();
  const now = utcNow();
  const id = nanoid();
  const seq = nextSeq(db);
  const opId = prov?.op_id ?? newOpId();
  const p = mergeProvenance(prov);

  // Resolve parent
  let parentId: string | null = null;
  if (input.parent_id) {
    parentId = resolveId(input.parent_id);
    if (!parentId) throw Object.assign(new Error(`Parent issue not found: ${input.parent_id}`), { code: "NOT_FOUND" });
  }

  // RRULE validation
  if (input.rrule) {
    const err = validateRRule(input.rrule);
    if (err) throw Object.assign(new Error(err), { code: "INVALID_ARGS" });
  }

  const doneAt = (input.state === "done" || input.state === "canceled") ? now : null;

  // Derive due_date from due_ts + due_tz if due_date not provided
  let dueDate = input.due_date ?? null;
  if (input.due_ts && !dueDate) {
    dueDate = deriveDueDate(input.due_ts, input.due_tz);
  }

  // CAS description
  let descHash: string | null = null;
  if (input.description) {
    descHash = casWrite(input.description);
  }

  const rowData: Record<string, unknown> = {
    id, seq,
    title:        input.title,
    state:        input.state,
    priority:     input.priority,
    project:      input.project ?? null,
    parent_id:    parentId,
    labels:       JSON.stringify(input.labels),
    attrs:        JSON.stringify(input.attrs),
    field_meta:   "{}",
    start_ts:     input.start_ts    ?? null,
    due_ts:       input.due_ts      ?? null,
    due_tz:       input.due_tz      ?? null,
    due_date:     dueDate,
    rrule:        input.rrule       ?? null,
    snooze_until: input.snooze_until ?? null,
    start_date:   input.start_date  ?? null,
    done_at:      doneAt,
    created_at:   now,
    updated_at:   now,
    desc_hash:    descHash,
    verify:       input.verify ? JSON.stringify(input.verify) : null,
    deleted:      0,
    last_event_seq: 0,
  };

  db.transaction(() => {
    const events = appendEvents(db, [{
      entity:    "issue",
      entity_id: id,
      type:      "create",
      new:       rowData,
      ...p,
    }], opId);
    for (const ev of events) applyEvent(db, ev);
  })();

  return getIssue(id)!;
}

export function getIssue(
  idOrSeq: string,
  includeRelations = false,
  includeSubtasks = false,
  includeDerived = false,
  includeDeleted = false,
): (Issue & { relations?: Edge[]; subtasks?: Issue[]; derived?: DerivedFields }) | null {
  const db = getWriteDb();
  const tbl = includeDeleted ? "issues" : "issues_live";

  let row: Record<string, unknown> | undefined;
  if (/^T-\d+$/.test(idOrSeq)) {
    const s = parseInt(idOrSeq.slice(2), 10);
    row = db.prepare(`SELECT * FROM ${tbl} WHERE seq = ?`).get(s) as Record<string, unknown> | undefined;
  } else {
    row = db.prepare(`SELECT * FROM ${tbl} WHERE id = ?`).get(idOrSeq) as Record<string, unknown> | undefined;
  }
  if (!row) return null;

  const issue = parseIssueRow(row);
  // Attach description from CAS
  const descContent = casRead(issue.desc_hash);
  if (descContent !== null) issue.description = descContent;

  const result: Issue & { relations?: Edge[]; subtasks?: Issue[]; derived?: DerivedFields } = issue;

  if (includeRelations) {
    result.relations = db.prepare(`
      SELECT * FROM edges WHERE (source_id = ? OR target_id = ?) AND valid_to IS NULL
    `).all(issue.id, issue.id) as Edge[];
  }

  if (includeSubtasks) {
    const children = db.prepare("SELECT * FROM issues_live WHERE parent_id = ?").all(issue.id) as Record<string, unknown>[];
    result.subtasks = children.map(parseIssueRow);
  }

  if (includeDerived) {
    result.derived = computeDerived(issue, db);
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
  include_derived?: boolean;
}

export function listIssues(opts: ListIssuesOptions = {}): (Issue & { derived?: DerivedFields })[] {
  const db = getWriteDb();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (opts.state)   { conditions.push("i.state = ?");   params.push(opts.state); }
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
  // Default sort: seq; priority sort falls back to seq for stable ordering
  const sortCol = opts.sort === "priority"
    ? `CASE i.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END, i.due_ts IS NULL, i.due_ts`
    : "i.seq";
  const limitClause = opts.limit ? `LIMIT ${Math.min(opts.limit, 1000)}` : "";

  const rows = db.prepare(`SELECT i.* FROM issues_live i ${where} ORDER BY ${sortCol} ${limitClause}`).all(...params) as Record<string, unknown>[];
  const issues = rows.map(parseIssueRow);

  if (opts.include_derived) {
    return issues.map(i => ({ ...i, derived: computeDerived(i, db) }));
  }
  return issues;
}

export function updateIssue(idOrSeq: string, patch: UpdateIssueInput, prov?: WriteOptions): Issue {
  const id = resolveId(idOrSeq);
  if (!id) throw Object.assign(new Error(`Issue not found: ${idOrSeq}`), { code: "NOT_FOUND" });

  const db = getWriteDb();
  const now = utcNow();
  const opId = prov?.op_id ?? newOpId();
  const p = mergeProvenance(prov);

  const current = db.prepare("SELECT * FROM issues WHERE id = ?").get(id) as Record<string, unknown>;

  // RRULE validation
  if (patch.rrule) {
    const err = validateRRule(patch.rrule);
    if (err) throw Object.assign(new Error(err), { code: "INVALID_ARGS" });
  }

  // Resolve parent_id
  if (patch.parent_id !== undefined && patch.parent_id !== null) {
    const pid = resolveId(patch.parent_id);
    if (!pid) throw Object.assign(new Error(`Parent issue not found: ${patch.parent_id}`), { code: "NOT_FOUND" });
    patch = { ...patch, parent_id: pid };
  }

  const events: EventInput[] = [];

  // Build field-level update events
  const fieldMap: Array<[string, unknown]> = [
    ["title",        patch.title],
    ["state",        patch.state],
    ["priority",     patch.priority],
    ["project",      patch.project],
    ["parent_id",    patch.parent_id],
    ["labels",       patch.labels !== undefined ? JSON.stringify(patch.labels) : undefined],
    ["attrs",        patch.attrs  !== undefined ? JSON.stringify(patch.attrs)  : undefined],
    ["start_ts",     patch.start_ts],
    ["due_ts",       patch.due_ts],
    ["due_tz",       patch.due_tz],
    ["due_date",     patch.due_date],
    ["rrule",        patch.rrule],
    ["snooze_until", patch.snooze_until],
    ["start_date",   patch.start_date],
    ["verify",       patch.verify !== undefined ? (patch.verify === null ? null : JSON.stringify(patch.verify)) : undefined],
  ];

  for (const [field, val] of fieldMap) {
    if (val === undefined) continue;
    const oldVal = current[field];
    const eventType = field === "state" ? "state_change" : "update";
    events.push({
      entity: "issue", entity_id: id,
      type:  eventType,
      field,
      old:   oldVal,
      new:   val,
      ...p,
    });
  }

  // Derive due_date update if due_ts changed
  if (patch.due_ts !== undefined && patch.due_date === undefined) {
    const newDueDate = patch.due_ts === null ? null : deriveDueDate(patch.due_ts, (patch.due_tz ?? current.due_tz) as string | null);
    if (newDueDate !== current.due_date) {
      events.push({
        entity: "issue", entity_id: id,
        type: "update", field: "due_date",
        old: current.due_date, new: newDueDate,
        ...p,
      });
    }
  }

  // Handle done_at state machine as an event
  if (patch.state !== undefined) {
    const wasTerminal = (current.state as string) === "done" || (current.state as string) === "canceled";
    const isTerminal  = patch.state === "done" || patch.state === "canceled";
    if (isTerminal && !wasTerminal) {
      events.push({ entity: "issue", entity_id: id, type: "update", field: "done_at", old: null, new: now, ...p });
    } else if (!isTerminal && wasTerminal) {
      events.push({ entity: "issue", entity_id: id, type: "update", field: "done_at", old: current.done_at, new: null, ...p });
    }
  }

  // Handle description → CAS
  if (patch.description !== undefined) {
    const oldHash = current.desc_hash as string | null;
    const newHash = casWrite(patch.description);
    if (newHash !== oldHash) {
      events.push({
        entity: "issue", entity_id: id,
        type: "description_change",
        old: oldHash,
        new: newHash,
        ...p,
      });
    }
  }

  // updated_at event
  events.push({ entity: "issue", entity_id: id, type: "update", field: "updated_at", old: current.updated_at, new: now, ...p });

  if (events.length === 0) return getIssue(id)!;

  // RRULE: if state→done and issue has rrule, schedule re-open
  let rruleReopenEvents: EventInput[] | null = null;
  if (patch.state === "done") {
    const rrule = (patch.rrule ?? current.rrule) as string | null;
    const dueTsToUse = (patch.due_ts ?? current.due_ts) as string | null;
    if (rrule && dueTsToUse) {
      // Count previous completions
      const completionCount = (db.prepare(`
        SELECT COUNT(*) AS c FROM events
         WHERE entity = 'issue' AND entity_id = ? AND type = 'state_change'
           AND new = '"done"'
      `).get(id) as { c: number }).c + 1; // +1 for the current one

      const nextTs = nextDueTs(dueTsToUse, rrule, completionCount);
      if (nextTs) {
        const nextDate = deriveDueDate(nextTs, (patch.due_tz ?? current.due_tz) as string | null);
        rruleReopenEvents = [
          { entity: "issue", entity_id: id, type: "state_change",   field: "state",   old: "done",  new: "todo",    actor: "system", reason: `rrule reopen` },
          { entity: "issue", entity_id: id, type: "update",         field: "done_at", old: now,     new: null,       actor: "system", reason: `rrule reopen` },
          { entity: "issue", entity_id: id, type: "update",         field: "due_ts",  old: dueTsToUse, new: nextTs, actor: "system", reason: `rrule reopen` },
          { entity: "issue", entity_id: id, type: "update",         field: "due_date", old: current.due_date, new: nextDate, actor: "system", reason: `rrule reopen` },
          { entity: "issue", entity_id: id, type: "update",         field: "updated_at", old: now,  new: now,        actor: "system", reason: `rrule reopen` },
        ];
      }
    }
  }

  db.transaction(() => {
    const appended = appendEvents(db, events, opId);
    for (const ev of appended) applyEvent(db, ev);

    if (rruleReopenEvents) {
      const reopenOpId = newOpId();
      const reopenEvs = appendEvents(db, rruleReopenEvents, reopenOpId);
      for (const ev of reopenEvs) applyEvent(db, ev);
    }
  })();

  return getIssue(id)!;
}

export function deleteIssue(idOrSeq: string, prov?: WriteOptions): void {
  const id = resolveId(idOrSeq);
  if (!id) throw Object.assign(new Error(`Issue not found: ${idOrSeq}`), { code: "NOT_FOUND" });

  const db = getWriteDb();
  const opId = prov?.op_id ?? newOpId();
  const p = mergeProvenance(prov);

  // Reject if has subtasks
  const children = db.prepare("SELECT seq, title FROM issues_live WHERE parent_id = ?").all(id) as { seq: number; title: string }[];
  if (children.length > 0) {
    const list = children.map(c => `T-${c.seq}: ${c.title}`).join(", ");
    throw Object.assign(new Error(`Cannot delete: issue has subtasks: ${list}`), { code: "HAS_SUBTASKS", subtasks: children });
  }

  const snapshot = db.prepare("SELECT * FROM issues WHERE id = ?").get(id) as Record<string, unknown>;

  db.transaction(() => {
    const events = appendEvents(db, [{
      entity: "issue", entity_id: id,
      type: "delete",
      old: snapshot,
      new: null,
      ...p,
    }], opId);
    for (const ev of events) applyEvent(db, ev);
  })();
}

// ─── Batch Update ─────────────────────────────────────────────────────────────

export interface BatchUpdateItem {
  id: string;
  patch: UpdateIssueInput;
}

export function batchUpdateIssues(items: BatchUpdateItem[], prov?: WriteOptions): Issue[] {
  const db = getWriteDb();
  const results: Issue[] = [];

  db.transaction(() => {
    for (const item of items) {
      results.push(updateIssue(item.id, item.patch, prov));
    }
  })();

  return results;
}

// ─── Edges / Links ────────────────────────────────────────────────────────────

export interface LinkOptions extends WriteOptions {
  weight?: number;
  valid_from?: string;
  valid_to?: string;
}

/** Cycle detection: BFS from `proposedTarget` forward through blocks edges.
 *  If we can reach `proposedSource`, adding source→target blocks would create a cycle.
 */
function hasCycle(
  db: ReturnType<typeof getWriteDb>,
  proposedTarget: string,
  proposedSource: string,
): { cycle: boolean; path: string[] } {
  const visited = new Set<string>();
  const queue: Array<{ id: string; path: string[] }> = [{ id: proposedTarget, path: [proposedTarget] }];

  while (queue.length > 0) {
    const { id, path: cur } = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);

    const blocked = db.prepare(`
      SELECT target_id FROM edges
       WHERE source_id = ? AND type = 'blocks' AND valid_to IS NULL
    `).all(id) as { target_id: string }[];

    for (const { target_id } of blocked) {
      if (target_id === proposedSource) return { cycle: true, path: [...cur, target_id] };
      if (!visited.has(target_id)) queue.push({ id: target_id, path: [...cur, target_id] });
    }
  }
  return { cycle: false, path: [] };
}

export function linkIssues(
  sourceIdOrSeq: string,
  targetIdOrSeq: string,
  type: EdgeType,
  opts?: LinkOptions,
): Edge[] {
  const sourceId = resolveId(sourceIdOrSeq);
  if (!sourceId) throw Object.assign(new Error(`Source issue not found: ${sourceIdOrSeq}`), { code: "NOT_FOUND" });

  const targetId = resolveId(targetIdOrSeq);
  if (!targetId) throw Object.assign(new Error(`Target issue not found: ${targetIdOrSeq}`), { code: "NOT_FOUND" });

  const db = getWriteDb();
  const now = utcNow();
  const opId = opts?.op_id ?? newOpId();
  const p = mergeProvenance(opts);

  // Cycle detection only for ordering semantics (blocks)
  if (type === "blocks") {
    const { cycle, path } = hasCycle(db, targetId, sourceId);
    if (cycle) {
      const seqMap = db.prepare("SELECT id, seq FROM issues").all() as { id: string; seq: number }[];
      const seqById = new Map(seqMap.map(r => [r.id, r.seq]));
      const cyclePath = [sourceId, ...path].map(id => `T-${seqById.get(id) ?? id}`).join("→");
      throw Object.assign(new Error(`Cycle detected: ${cyclePath}`), { code: "CYCLE", path: cyclePath });
    }
  }

  const edgeId = nanoid();
  const edgeData: Record<string, unknown> = {
    id:         edgeId,
    source_id:  sourceId,
    target_id:  targetId,
    type,
    weight:     opts?.weight    ?? 1.0,
    valid_from: opts?.valid_from ?? now,
    valid_to:   opts?.valid_to  ?? null,
    created_at: now,
  };

  db.transaction(() => {
    const events = appendEvents(db, [{
      entity:    "edge",
      entity_id: edgeId,
      type:      "link",
      new:       edgeData,
      ...p,
    }], opId);
    for (const ev of events) applyEvent(db, ev);
  })();

  return db.prepare(`
    SELECT * FROM edges
     WHERE (source_id = ? AND target_id = ?) OR (source_id = ? AND target_id = ?)
       AND valid_to IS NULL
  `).all(sourceId, targetId, targetId, sourceId) as Edge[];
}

export function unlinkIssues(
  sourceIdOrSeq: string,
  targetIdOrSeq: string,
  type: EdgeType,
  prov?: WriteOptions,
): void {
  const sourceId = resolveId(sourceIdOrSeq);
  if (!sourceId) throw Object.assign(new Error(`Source issue not found: ${sourceIdOrSeq}`), { code: "NOT_FOUND" });

  const targetId = resolveId(targetIdOrSeq);
  if (!targetId) throw Object.assign(new Error(`Target issue not found: ${targetIdOrSeq}`), { code: "NOT_FOUND" });

  const db = getWriteDb();
  const opId = prov?.op_id ?? newOpId();
  const p = mergeProvenance(prov);

  const now = utcNow();

  // For blocks: directed; for others: remove both directions
  const edges = type === "blocks"
    ? db.prepare("SELECT * FROM edges WHERE source_id = ? AND target_id = ? AND type = ? AND valid_to IS NULL").all(sourceId, targetId, type) as Edge[]
    : db.prepare("SELECT * FROM edges WHERE ((source_id = ? AND target_id = ?) OR (source_id = ? AND target_id = ?)) AND type = ? AND valid_to IS NULL").all(sourceId, targetId, targetId, sourceId, type) as Edge[];

  if (edges.length === 0) return;

  db.transaction(() => {
    for (const edge of edges) {
      const events = appendEvents(db, [{
        entity:    "edge",
        entity_id: edge.id,
        type:      "unlink",
        old:       edge,
        new:       { ...edge, valid_to: now },
        ...p,
      }], opId);
      for (const ev of events) applyEvent(db, ev);
    }
  })();
}

// ─── Dependencies ─────────────────────────────────────────────────────────────

export interface DepNode extends Issue {
  is_blocked: boolean;
}

export function getDeps(idOrSeq: string, edgeType = "blocks"): DepNode[] {
  const id = resolveId(idOrSeq);
  if (!id) throw Object.assign(new Error(`Issue not found: ${idOrSeq}`), { code: "NOT_FOUND" });

  const db = getWriteDb();

  const rows = db.prepare(`
    WITH RECURSIVE deps(id) AS (
      SELECT e.source_id FROM edges e
       WHERE e.target_id = ? AND e.type = ? AND e.valid_to IS NULL
      UNION
      SELECT e.source_id FROM edges e
        JOIN deps d ON e.target_id = d.id
       WHERE e.type = ? AND e.valid_to IS NULL
    )
    SELECT i.* FROM issues_live i WHERE i.id IN (SELECT id FROM deps)
  `).all(id, edgeType, edgeType) as Record<string, unknown>[];

  return rows.map(row => {
    const issue = parseIssueRow(row);
    const isBlocked = db.prepare(`
      SELECT 1 FROM edges e
        JOIN issues s ON s.id = e.source_id
       WHERE e.target_id = ? AND e.type = 'blocks' AND e.valid_to IS NULL
         AND s.state NOT IN ('done','canceled') AND s.deleted = 0
       LIMIT 1
    `).get(issue.id) !== undefined;
    return { ...issue, is_blocked: isBlocked };
  });
}

// ─── Snapshot ─────────────────────────────────────────────────────────────────

export interface SnapshotGroup {
  overdue: (Issue & { derived: DerivedFields })[];
  due_today: (Issue & { derived: DerivedFields })[];
  in_progress: (Issue & { derived: DerivedFields })[];
  actionable: (Issue & { derived: DerivedFields })[];
  blocked: Array<Issue & { derived: DerivedFields; blockers: Issue[] }>;
  stale: (Issue & { derived: DerivedFields })[];
  awaiting_user: (Issue & { derived: DerivedFields })[];
}

export function snapshot(staleDays = 30): SnapshotGroup {
  const db = getWriteDb();
  const now = new Date();
  const nowTs = now.toISOString();
  const todayStr = now.toLocaleDateString("sv-SE");
  const staleThreshold = new Date(now.getTime() - staleDays * 86400_000).toISOString();

  function withDerived(row: Record<string, unknown>): Issue & { derived: DerivedFields } {
    const i = parseIssueRow(row);
    return { ...i, derived: computeDerived(i, db, now) };
  }

  // Overdue: due_ts < now, not done/canceled, not snoozed
  const overdue = (db.prepare(`
    SELECT * FROM issues_live
     WHERE state NOT IN ('done','canceled')
       AND due_ts IS NOT NULL AND due_ts < ?
       AND (snooze_until IS NULL OR snooze_until <= ?)
     ORDER BY due_ts
  `).all(nowTs, nowTs) as Record<string, unknown>[]).map(withDerived);

  // Due today (using due_date for human-readable grouping)
  const due_today = (db.prepare(`
    SELECT * FROM issues_live
     WHERE state NOT IN ('done','canceled')
       AND due_date = ?
       AND (snooze_until IS NULL OR snooze_until <= ?)
     ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END
  `).all(todayStr, nowTs) as Record<string, unknown>[]).map(withDerived);

  // In progress
  const in_progress = (db.prepare(`
    SELECT * FROM issues_live WHERE state = 'in_progress' ORDER BY updated_at DESC
  `).all() as Record<string, unknown>[]).map(withDerived);

  // Actionable: todo/in_progress, not blocked, not snoozed; sorted by readiness_score DESC
  const actionableRows = (db.prepare(`
    SELECT * FROM issues_live i
     WHERE i.state IN ('todo','in_progress')
       AND NOT EXISTS (
         SELECT 1 FROM edges e JOIN issues s ON s.id = e.source_id
          WHERE e.target_id = i.id AND e.type = 'blocks' AND e.valid_to IS NULL
            AND s.state NOT IN ('done','canceled') AND s.deleted = 0
       )
       AND (i.snooze_until IS NULL OR i.snooze_until <= ?)
  `).all(nowTs) as Record<string, unknown>[]).map(withDerived);
  actionableRows.sort((a, b) => b.derived.readiness_score - a.derived.readiness_score);
  const actionable = actionableRows;

  // Blocked
  const blockedRows = db.prepare(`
    SELECT DISTINCT i.* FROM issues_live i
      JOIN edges e ON e.target_id = i.id AND e.type = 'blocks' AND e.valid_to IS NULL
      JOIN issues s ON s.id = e.source_id AND s.state NOT IN ('done','canceled') AND s.deleted = 0
     WHERE i.state NOT IN ('done','canceled')
  `).all() as Record<string, unknown>[];

  const blocked = blockedRows.map(row => {
    const issue = parseIssueRow(row);
    const blockers = (db.prepare(`
      SELECT s.* FROM edges e JOIN issues s ON s.id = e.source_id
       WHERE e.target_id = ? AND e.type = 'blocks' AND e.valid_to IS NULL
         AND s.state NOT IN ('done','canceled') AND s.deleted = 0
    `).all(issue.id) as Record<string, unknown>[]).map(parseIssueRow);
    return { ...issue, derived: computeDerived(issue, db, now), blockers };
  });

  // Stale
  const stale = (db.prepare(`
    SELECT * FROM issues_live
     WHERE state NOT IN ('done','canceled')
       AND updated_at < ?
     ORDER BY updated_at
  `).all(staleThreshold) as Record<string, unknown>[]).map(withDerived);

  // awaiting_user: unfinished issues that are targets of a 'needs' edge from another unfinished issue
  const awaiting_user = (db.prepare(`
    SELECT DISTINCT i.* FROM issues_live i
      JOIN edges e ON e.target_id = i.id AND e.type = 'needs' AND e.valid_to IS NULL
      JOIN issues s ON s.id = e.source_id AND s.state NOT IN ('done','canceled') AND s.deleted = 0
     WHERE i.state NOT IN ('done','canceled')
  `).all() as Record<string, unknown>[]).map(withDerived);

  return { overdue, due_today, in_progress, actionable, blocked, stale, awaiting_user };
}

// ─── Inbox ────────────────────────────────────────────────────────────────────

export function inboxAdd(raw: string, prov?: WriteOptions & { origin?: string }): InboxItem {
  const db = getWriteDb();
  const id = nanoid();
  const now = utcNow();
  const opId = prov?.op_id ?? newOpId();
  const p = mergeProvenance(prov);

  const rowData = {
    id,
    raw,
    status: "pending",
    resolved_issue_id: null,
    origin:     prov?.origin ?? "cli",
    session_id: prov?.session_id ?? null,
    created_at: now,
  };

  db.transaction(() => {
    const events = appendEvents(db, [{
      entity: "inbox", entity_id: id,
      type: "create", new: rowData,
      ...p,
    }], opId);
    for (const ev of events) applyEvent(db, ev);
  })();

  return db.prepare("SELECT * FROM inbox WHERE id = ?").get(id) as InboxItem;
}

export function inboxList(status?: "pending" | "resolved"): InboxItem[] {
  const db = getWriteDb();
  if (status) return db.prepare("SELECT * FROM inbox WHERE status = ? ORDER BY created_at").all(status) as InboxItem[];
  return db.prepare("SELECT * FROM inbox ORDER BY created_at").all() as InboxItem[];
}

export function inboxResolve(id: string, issueIdOrSeq?: string, prov?: WriteOptions): InboxItem {
  const db = getWriteDb();
  const opId = prov?.op_id ?? newOpId();
  const p = mergeProvenance(prov);

  let issueId: string | null = null;
  if (issueIdOrSeq) {
    issueId = resolveId(issueIdOrSeq);
    if (!issueId) throw Object.assign(new Error(`Issue not found: ${issueIdOrSeq}`), { code: "NOT_FOUND" });
  }

  const item = db.prepare("SELECT * FROM inbox WHERE id = ?").get(id) as InboxItem | undefined;
  if (!item) throw Object.assign(new Error(`Inbox item not found: ${id}`), { code: "NOT_FOUND" });

  const newData = { status: "resolved", resolved_issue_id: issueId };

  db.transaction(() => {
    const events = appendEvents(db, [{
      entity: "inbox", entity_id: id,
      type: "resolve",
      old: { status: item.status, resolved_issue_id: item.resolved_issue_id },
      new: newData,
      ...p,
    }], opId);
    for (const ev of events) applyEvent(db, ev);
  })();

  return db.prepare("SELECT * FROM inbox WHERE id = ?").get(id) as InboxItem;
}

// ─── Verify Run ───────────────────────────────────────────────────────────────

export interface VerifyRunInput {
  result: "pass" | "fail";
  evidence?: string;
  cmd?: string;
}

export function recordVerifyRun(idOrSeq: string, input: VerifyRunInput, prov?: WriteOptions): void {
  const id = resolveId(idOrSeq);
  if (!id) throw Object.assign(new Error(`Issue not found: ${idOrSeq}`), { code: "NOT_FOUND" });

  const db = getWriteDb();
  const opId = prov?.op_id ?? newOpId();
  const p = mergeProvenance(prov);

  const evData = {
    result:   input.result,
    evidence: input.evidence ?? null,
    cmd:      input.cmd ?? null,
  };

  db.transaction(() => {
    const events = appendEvents(db, [{
      entity: "issue", entity_id: id,
      type: "verify_run",
      new:  evData,
      ...p,
    }], opId);
    for (const ev of events) applyEvent(db, ev);
  })();
}

// ─── Search ───────────────────────────────────────────────────────────────────

export function searchIssues(q: string): Issue[] {
  const db = getWriteDb();
  const lower = q.toLowerCase();

  const rows = db.prepare(`
    SELECT * FROM issues_live WHERE title LIKE ? ORDER BY seq DESC LIMIT 200
  `).all(`%${q}%`) as Record<string, unknown>[];
  const titleMatches = rows.map(parseIssueRow);
  const titleMatchIds = new Set(titleMatches.map(i => i.id));

  // Also search CAS description files not already matched
  const dir = resolve(DATA_DIR, "descriptions");
  const extraMatches: Issue[] = [];
  if (existsSync(dir)) {
    let files: string[] = [];
    try { files = readdirSync(dir); } catch { /* ignore */ }
    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      const hash = file.slice(0, -3);
      // Find issues referencing this hash
      const refIssues = db.prepare("SELECT * FROM issues_live WHERE desc_hash = ?").all(hash) as Record<string, unknown>[];
      for (const row of refIssues) {
        const issue = parseIssueRow(row);
        if (titleMatchIds.has(issue.id)) continue;
        const content = casRead(hash);
        if (content && content.toLowerCase().includes(lower)) {
          issue.description = content;
          extraMatches.push(issue);
        }
      }
    }
  }

  return [...titleMatches, ...extraMatches];
}

// ─── Query ────────────────────────────────────────────────────────────────────

export function runQuery(sql: string, limit = 200): unknown[] {
  const trimmed = sql.trim();
  const stripped = trimmed.replace(/;$/, "");
  if (stripped.includes(";")) {
    throw Object.assign(new Error("Multiple statements are not allowed"), { code: "INVALID_SQL" });
  }
  if (!/^(SELECT|WITH)\s/i.test(trimmed)) {
    throw Object.assign(new Error("Only SELECT/WITH statements are allowed"), { code: "INVALID_SQL" });
  }
  const actualLimit = Math.min(limit, 1000);
  const db = getReadDb();
  const wrapped = `SELECT * FROM (${stripped}) LIMIT ${actualLimit}`;
  try {
    return db.prepare(wrapped).all();
  } catch (e) {
    throw Object.assign(new Error(`SQL error: ${(e as Error).message}`), { code: "SQL_ERROR" });
  }
}

// ─── GC: clean unreferenced CAS blobs ─────────────────────────────────────────

export function gcDescriptions(): { removed: number; freed_bytes: number } {
  const dir = resolve(DATA_DIR, "descriptions");
  if (!existsSync(dir)) return { removed: 0, freed_bytes: 0 };

  const refs = referencedHashes();
  let removed = 0;
  let freed_bytes = 0;

  let files: string[] = [];
  try { files = readdirSync(dir); } catch { /* ignore */ }

  for (const file of files) {
    if (!file.endsWith(".md")) continue;
    const hash = file.slice(0, -3);
    if (!refs.has(hash)) {
      const p = casPath(hash);
      try {
        try { freed_bytes += statSync(p).size; } catch { /* ignore */ }
        unlinkSync(p);
        removed++;
      } catch { /* ignore */ }
    }
  }

  return { removed, freed_bytes };
}

// ─── Schema output ────────────────────────────────────────────────────────────

export const SCHEMA_DDL = `-- plumb v3 schema (AI-native event-sourced task management)
-- ══════════════════════════════════════════════════════════════════
-- TRUTH: events (append-only); issues/edges/inbox are derived projections.
-- All writes: appendEvents + applyEvent in one transaction.
-- Rebuild: plumb rebuild → replays all events → identical projection.
--
-- TIMESTAMP semantics:
--   *_ts fields: UTC ISO8601 ("YYYY-MM-DDTHH:MM:SS.mmmZ")
--   due_date:    local YYYY-MM-DD (derived from due_ts + due_tz)
--   *_date:      legacy local YYYY-MM-DD (v2.2 compat)
--
-- DERIVED fields (computed on read, NOT stored as authoritative):
--   is_blocked:       edges(type=blocks, valid_to IS NULL, source.state NOT IN done/canceled)
--   is_overdue:       due_ts < NOW AND state NOT IN done/canceled
--   is_stale:         updated_at < NOW-30d AND state NOT IN done/canceled
--   is_snoozed:       snooze_until > NOW
--   is_verified:      latest verify_run event result == 'pass' (null if no verify spec)
--   readiness_score:  0.4*priority_score + 0.4*due_urgency - 0.5*blocked - 0.3*stale
--
-- RRULE subset: FREQ=DAILY|WEEKLY|MONTHLY[;INTERVAL=n][;COUNT=n|;UNTIL=<utc-ts>]
--
-- EDGE TYPES (open vocabulary; only 'blocks' has cycle detection):
--   blocks   – source is prerequisite of target (directed, cycle-checked)
--   relates  – symmetric relation
--   duplicate – symmetric, marks duplicates
--   follows  – loose ordering (no cycle check)
--   part_of  – composition
--   needs    – source needs target resource (awaiting_user group)
--   <any>    – custom, no enforcement
--
-- VERIFY SPEC (issues.verify JSON):
--   {"type":"command","cmd":"pnpm test auth","expect":"exit 0"}
--   {"type":"manual","note":"human review required"}
--
-- PROVENANCE (events):
--   actor: "user" | "agent:<name>" | "system"
--   src:   explicit | inferred | imported | system
--   conf:  0..1 (null = certain/explicit)
--   raw_input: original user utterance that triggered this change
--   session_id: groups all events from one Agent session
--   op_id: idempotency key (same op_id → no-op on retry)

-- Example queries:
-- All open issues by readiness hint:
--   SELECT seq, title, state, priority, due_ts FROM issues_live
--    WHERE state NOT IN ('done','canceled') ORDER BY seq;
--
-- Event history for T-3:
--   SELECT e.* FROM events e JOIN issues i ON i.id = e.entity_id
--    WHERE i.seq = 3 ORDER BY e.seq;
--
-- All edges for T-5:
--   SELECT e.* FROM edges e JOIN issues i ON i.id = e.source_id OR i.id = e.target_id
--    WHERE i.seq = 5 AND e.valid_to IS NULL;
--
-- What changed since yesterday:
--   SELECT * FROM events WHERE ts > datetime('now','-1 day') ORDER BY seq;
`;
