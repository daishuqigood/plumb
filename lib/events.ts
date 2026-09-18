/**
 * lib/events.ts — 事件溯源引擎（v3 核心）
 *
 * events 表是唯一真相；issues/edges/inbox 是可由事件重放重建的物化投影。
 * 本模块提供：
 *   - appendEvents: 单事务内分配 seq/id、幂等检查(op_id)、落库
 *   - applyEvent:   把单条事件应用到投影（写路径与 rebuild 共用，保证一致）
 *   - rebuild:      清空投影 → 按 seq 重放全部事件
 *   - undoOp:       读某 op_id 的事件 → 生成补偿事件（不删原事件）
 *   - diffSince:    自某时刻/seq/op_id 以来的变更
 *   - getEvents:    某实体历史
 *
 * 确定性保证：相同事件流必得相同投影（无随机、无外部调用）。
 */

import { nanoid } from "nanoid";
import type Database from "better-sqlite3";

// ─── Types ────────────────────────────────────────────────────────────────────

export type EntityType = "issue" | "edge" | "inbox";
export type EventType =
  | "create" | "update" | "state_change" | "description_change"
  | "delete" | "link" | "unlink" | "resolve" | "verify_run";
export type ProvenanceSrc = "explicit" | "inferred" | "imported" | "system";

export interface Event {
  id: string;
  seq: number;
  ts: string;
  entity: EntityType;
  entity_id: string;
  type: EventType;
  field: string | null;
  old: string | null;   // JSON-encoded
  new: string | null;   // JSON-encoded
  src: ProvenanceSrc | null;
  actor: string;
  reason: string | null;
  raw_input: string | null;
  conf: number | null;
  session_id: string | null;
  op_id: string | null;
}

/** Caller-facing input for appending an event (seq/id/ts assigned by the engine). */
export interface EventInput {
  entity: EntityType;
  entity_id: string;
  type: EventType;
  field?: string | null;
  old?: unknown;
  new?: unknown;
  src?: ProvenanceSrc | null;
  actor?: string;
  reason?: string | null;
  raw_input?: string | null;
  conf?: number | null;
  session_id?: string | null;
  ts?: string;          // override (used by migration to preserve original created_at)
}

export interface Provenance {
  actor?: string;
  reason?: string | null;
  raw_input?: string | null;
  conf?: number | null;
  session_id?: string | null;
  src?: ProvenanceSrc | null;
  op_id?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function utcNow(): string {
  return new Date().toISOString();
}

export function newOpId(): string {
  return nanoid();
}

function nextEventSeq(db: Database.Database): number {
  db.prepare("UPDATE event_seq SET n = n + 1 WHERE id = 1").run();
  const row = db.prepare("SELECT n FROM event_seq WHERE id = 1").get() as { n: number };
  return row.n;
}

function encode(v: unknown): string | null {
  return v === undefined ? null : JSON.stringify(v);
}

function decode<T = unknown>(s: string | null): T | null {
  return s === null ? null : (JSON.parse(s) as T);
}

/** Derive provenance src when not explicitly provided. */
function deriveSrc(actor: string, conf: number | null): ProvenanceSrc {
  if (conf !== null && conf < 1) return "inferred";
  if (actor === "user") return "explicit";
  if (actor === "system") return "system";
  return "explicit";
}

// ─── Append ───────────────────────────────────────────────────────────────────

/**
 * Append a batch of events sharing one op_id, inside the caller's transaction.
 * Idempotency: if op_id already has events, returns them without appending.
 * Does NOT apply to projection — caller must applyEvent() each (or use commitWrite).
 */
export function appendEvents(db: Database.Database, inputs: EventInput[], opId: string): Event[] {
  // Idempotency guard: op already recorded → no-op
  const existing = db.prepare("SELECT * FROM events WHERE op_id = ? ORDER BY seq").all(opId) as Event[];
  if (existing.length > 0) return existing;

  const ts = utcNow();
  const inserted: Event[] = [];
  const stmt = db.prepare(`
    INSERT INTO events (id, seq, ts, entity, entity_id, type, field, old, new, src, actor, reason, raw_input, conf, session_id, op_id)
    VALUES (@id, @seq, @ts, @entity, @entity_id, @type, @field, @old, @new, @src, @actor, @reason, @raw_input, @conf, @session_id, @op_id)
  `);
  for (const inp of inputs) {
    const seq = nextEventSeq(db);
    const ev: Event = {
      id: nanoid(),
      seq,
      ts: inp.ts ?? ts,
      entity: inp.entity,
      entity_id: inp.entity_id,
      type: inp.type,
      field: inp.field ?? null,
      old: encode(inp.old),
      new: encode(inp.new),
      src: inp.src ?? deriveSrc(inp.actor ?? "user", inp.conf ?? null),
      actor: inp.actor ?? "user",
      reason: inp.reason ?? null,
      raw_input: inp.raw_input ?? null,
      conf: inp.conf ?? null,
      session_id: inp.session_id ?? null,
      op_id: opId,
    };
    stmt.run(ev);
    inserted.push(ev);
  }
  return inserted;
}

// ─── Apply (projection) ───────────────────────────────────────────────────────

/** Materialize per-field provenance into issues.field_meta from an event. */
function materializeFieldMeta(db: Database.Database, issueId: string, ev: Event, field: string): void {
  const row = db.prepare("SELECT field_meta FROM issues WHERE id = ?").get(issueId) as { field_meta: string } | undefined;
  if (!row) return;
  const meta = JSON.parse(row.field_meta ?? "{}") as Record<string, unknown>;
  meta[field] = {
    src: ev.src ?? deriveSrc(ev.actor, ev.conf),
    conf: ev.conf ?? 1.0,
    raw: ev.raw_input ?? undefined,
    actor: ev.actor,
    ts: ev.ts,
  };
  db.prepare("UPDATE issues SET field_meta = ? WHERE id = ?").run(JSON.stringify(meta), issueId);
}

/** Bump the projection watermark for an issue. */
function bumpWatermark(db: Database.Database, issueId: string, seq: number): void {
  db.prepare("UPDATE issues SET last_event_seq = ? WHERE id = ? AND last_event_seq < ?").run(seq, issueId, seq);
}

/**
 * Apply a single event to the projection. Pure DB mutation; deterministic.
 * Used by both the live write path and rebuild(), guaranteeing identical results.
 */
export function applyEvent(db: Database.Database, ev: Event): void {
  switch (ev.entity) {
    case "issue": return applyIssueEvent(db, ev);
    case "edge":  return applyEdgeEvent(db, ev);
    case "inbox": return applyInboxEvent(db, ev);
  }
}

function applyIssueEvent(db: Database.Database, ev: Event): void {
  const id = ev.entity_id;

  if (ev.type === "create") {
    const data = decode<Record<string, unknown>>(ev.new) ?? {};
    const cols = Object.keys(data);
    const placeholders = cols.map(() => "?").join(", ");
    db.prepare(
      `INSERT OR REPLACE INTO issues (${cols.join(", ")}) VALUES (${placeholders})`
    ).run(...cols.map(c => data[c]));
    // Materialize provenance for every field carried by the create payload
    const meta: Record<string, unknown> = {};
    for (const f of cols) {
      meta[f] = {
        src: ev.src ?? deriveSrc(ev.actor, ev.conf),
        conf: ev.conf ?? 1.0,
        raw: ev.raw_input ?? undefined,
        actor: ev.actor,
        ts: ev.ts,
      };
    }
    db.prepare("UPDATE issues SET field_meta = ? WHERE id = ?").run(JSON.stringify(meta), id);
    bumpWatermark(db, id, ev.seq);
    return;
  }

  if (ev.type === "delete") {
    db.prepare("UPDATE issues SET deleted = 1, updated_at = ? WHERE id = ?").run(ev.ts, id);
    bumpWatermark(db, id, ev.seq);
    return;
  }

  if (ev.type === "description_change") {
    const hash = decode<string | null>(ev.new);
    db.prepare("UPDATE issues SET desc_hash = ?, updated_at = ? WHERE id = ?").run(hash, ev.ts, id);
    materializeFieldMeta(db, id, ev, "description");
    bumpWatermark(db, id, ev.seq);
    return;
  }

  if (ev.type === "state_change" || (ev.type === "update" && ev.field === "state")) {
    const newState = decode<string>(ev.new);
    const cur = db.prepare("SELECT state, done_at FROM issues WHERE id = ?").get(id) as { state: string; done_at: string | null } | undefined;
    if (cur) {
      const wasTerminal = cur.state === "done" || cur.state === "canceled";
      const isTerminal = newState === "done" || newState === "canceled";
      let doneAt = cur.done_at;
      if (isTerminal && !wasTerminal) doneAt = ev.ts;
      else if (!isTerminal && wasTerminal) doneAt = null;
      db.prepare("UPDATE issues SET state = ?, done_at = ?, updated_at = ? WHERE id = ?")
        .run(newState, doneAt, ev.ts, id);
    }
    materializeFieldMeta(db, id, ev, "state");
    bumpWatermark(db, id, ev.seq);
    return;
  }

  if (ev.type === "update" && ev.field) {
    const val = decode(ev.new);
    db.prepare(`UPDATE issues SET ${ev.field} = ?, updated_at = ? WHERE id = ?`).run(val, ev.ts, id);
    materializeFieldMeta(db, id, ev, ev.field);
    bumpWatermark(db, id, ev.seq);
    return;
  }
}

function applyEdgeEvent(db: Database.Database, ev: Event): void {
  if (ev.type === "link") {
    const data = decode<Record<string, unknown>>(ev.new) ?? {};
    const cols = Object.keys(data);
    db.prepare(
      `INSERT OR REPLACE INTO edges (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`
    ).run(...cols.map(c => data[c]));
    return;
  }
  if (ev.type === "unlink") {
    const data = decode<{ source_id: string; target_id: string; type: string }>(ev.old) ?? (decode(ev.new) as { source_id: string; target_id: string; type: string });
    if (data) {
      db.prepare("DELETE FROM edges WHERE source_id = ? AND target_id = ? AND type = ?")
        .run(data.source_id, data.target_id, data.type);
    }
    return;
  }
}

function applyInboxEvent(db: Database.Database, ev: Event): void {
  const id = ev.entity_id;
  if (ev.type === "create") {
    const data = decode<Record<string, unknown>>(ev.new) ?? {};
    const cols = Object.keys(data);
    db.prepare(
      `INSERT OR REPLACE INTO inbox (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`
    ).run(...cols.map(c => data[c]));
    return;
  }
  if (ev.type === "resolve") {
    const data = decode<{ status: string; resolved_issue_id: string | null }>(ev.new) ?? { status: "resolved", resolved_issue_id: null };
    db.prepare("UPDATE inbox SET status = ?, resolved_issue_id = ? WHERE id = ?")
      .run(data.status, data.resolved_issue_id, id);
    return;
  }
}

// ─── Rebuild ──────────────────────────────────────────────────────────────────

/**
 * Reconstruct the entire projection from the event log.
 * Deterministic: same events → same projection. Used for repair / verification / upgrade backfill.
 */
export function rebuild(db: Database.Database): { events: number; issues: number; edges: number } {
  return db.transaction(() => {
    db.exec("DELETE FROM edges");
    db.exec("DELETE FROM issues");
    db.exec("DELETE FROM inbox");
    // Reset seq counters to max recorded in events so future发号 continues correctly
    const all = db.prepare("SELECT * FROM events ORDER BY seq ASC").all() as Event[];
    for (const ev of all) applyEvent(db, ev);

    // Restore seq counter from the max issue seq present in the projection
    const maxSeq = db.prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM issues").get() as { m: number };
    db.prepare("UPDATE seq SET n = ? WHERE id = 1").run(maxSeq.m);
    // Restore event_seq counter
    const maxEv = db.prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM events").get() as { m: number };
    db.prepare("UPDATE event_seq SET n = ? WHERE id = 1").run(maxEv.m);

    const issues = (db.prepare("SELECT COUNT(*) AS c FROM issues").get() as { c: number }).c;
    const edges = (db.prepare("SELECT COUNT(*) AS c FROM edges").get() as { c: number }).c;
    return { events: all.length, issues, edges };
  })();
}

// ─── Undo (compensating events) ───────────────────────────────────────────────

/**
 * Undo a logical operation by appending compensating events (originals are kept).
 * Inverse rules: create↔delete, update old↔new, link↔unlink, resolve→pending.
 * Returns the compensating events appended.
 */
export function undoOp(db: Database.Database, opId: string, actor = "system"): Event[] {
  const originals = db.prepare("SELECT * FROM events WHERE op_id = ? ORDER BY seq DESC").all(opId) as Event[];
  if (originals.length === 0) {
    throw Object.assign(new Error(`No events found for op_id: ${opId}`), { code: "NOT_FOUND" });
  }
  // Already undone?
  const undoReason = `undo ${opId}`;
  const already = db.prepare("SELECT COUNT(*) AS c FROM events WHERE reason = ?").get(undoReason) as { c: number };
  if (already.c > 0) {
    throw Object.assign(new Error(`op_id already undone: ${opId}`), { code: "ALREADY_UNDONE" });
  }

  const undoOpId = newOpId();
  const compensations: EventInput[] = [];

  // Iterate newest-first so inverses apply in reverse order
  for (const ev of originals) {
    const base = { actor, reason: undoReason, session_id: ev.session_id };
    switch (ev.type) {
      case "create":
        if (ev.entity === "issue") compensations.push({ ...base, entity: "issue", entity_id: ev.entity_id, type: "delete", old: decode(ev.new), new: null });
        else if (ev.entity === "inbox") compensations.push({ ...base, entity: "inbox", entity_id: ev.entity_id, type: "delete", old: decode(ev.new), new: null });
        break;
      case "delete":
        // Re-create from the tombstoned snapshot stored in old
        compensations.push({ ...base, entity: ev.entity, entity_id: ev.entity_id, type: "create", old: null, new: decode(ev.old) });
        break;
      case "update":
      case "state_change":
        compensations.push({ ...base, entity: ev.entity, entity_id: ev.entity_id, type: ev.type, field: ev.field, old: decode(ev.new), new: decode(ev.old) });
        break;
      case "description_change":
        compensations.push({ ...base, entity: "issue", entity_id: ev.entity_id, type: "description_change", old: decode(ev.new), new: decode(ev.old) });
        break;
      case "link":
        compensations.push({ ...base, entity: "edge", entity_id: ev.entity_id, type: "unlink", old: decode(ev.new), new: null });
        break;
      case "unlink":
        compensations.push({ ...base, entity: "edge", entity_id: ev.entity_id, type: "link", old: null, new: decode(ev.old) });
        break;
      case "resolve":
        compensations.push({ ...base, entity: "inbox", entity_id: ev.entity_id, type: "resolve", old: decode(ev.new), new: { status: "pending", resolved_issue_id: null } });
        break;
    }
  }

  return db.transaction(() => {
    const appended = appendEvents(db, compensations, undoOpId);
    for (const ev of appended) applyEvent(db, ev);
    return appended;
  })();
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export function getEvents(db: Database.Database, entity: EntityType, entityId: string, limit = 200): Event[] {
  return db.prepare(
    "SELECT * FROM events WHERE entity = ? AND entity_id = ? ORDER BY seq DESC LIMIT ?"
  ).all(entity, entityId, Math.min(limit, 1000)) as Event[];
}

export interface DiffSince {
  ts?: string;
  seq?: number;
  op_id?: string;
  entity?: EntityType;
}

/** Events since a timestamp / seq / op_id (exclusive). At least one anchor required. */
export function diffSince(db: Database.Database, since: DiffSince, limit = 500): Event[] {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (since.seq !== undefined) { conds.push("seq > ?"); params.push(since.seq); }
  else if (since.ts) { conds.push("ts > ?"); params.push(since.ts); }
  else if (since.op_id) {
    conds.push("seq > (SELECT COALESCE(MAX(seq),0) FROM events WHERE op_id = ?)");
    params.push(since.op_id);
  } else {
    throw Object.assign(new Error("diff requires one of: --since-ts, --since-seq, --since-op"), { code: "INVALID_ARGS" });
  }
  if (since.entity) { conds.push("entity = ?"); params.push(since.entity); }
  params.push(Math.min(limit, 1000));
  return db.prepare(`SELECT * FROM events WHERE ${conds.join(" AND ")} ORDER BY seq ASC LIMIT ?`).all(...params) as Event[];
}
