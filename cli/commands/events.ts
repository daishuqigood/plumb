/**
 * cli/commands/events.ts — plumb events / diff / undo / rebuild
 *
 * events <idOrSeq> [--limit N] [--entity issue|edge|inbox]
 * diff --since <ts|op_id> [--since-seq N] [--entity issue|edge|inbox] [--limit N]
 * undo <op_id>
 * rebuild
 */

import { parseArgs } from "node:util";
import { getWriteDb } from "../../lib/db.js";
import {
  getEvents, diffSince, undoOp, rebuild,
  type EntityType,
} from "../../lib/events.js";
import { resolveId } from "../../lib/issues.js";
import { ok, fail } from "../output.js";

// ─── events ───────────────────────────────────────────────────────────────────

export async function eventsCommand(argv: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args: argv,
    options: {
      limit:  { type: "string" },
      entity: { type: "string" },
    },
    allowPositionals: true,
    strict: false,
  });

  const idOrSeq = positionals[0];
  if (!idOrSeq) fail("Usage: plumb events <idOrSeq> [--limit N] [--entity issue|edge|inbox]", "INVALID_ARGS", 2);

  const entityType = (values.entity ?? "issue") as EntityType;
  if (!["issue", "edge", "inbox"].includes(entityType)) {
    fail("--entity must be issue|edge|inbox", "INVALID_ARGS", 2);
  }

  const limit = values.limit ? parseInt(values.limit as string, 10) : 200;

  // Resolve entity id
  let entityId: string;
  if (entityType === "issue") {
    const resolved = resolveId(idOrSeq, true);
    if (!resolved) fail(`Issue not found: ${idOrSeq}`, "NOT_FOUND", 4);
    entityId = resolved as string;
  } else {
    entityId = idOrSeq;
  }

  const db = getWriteDb();
  const events = getEvents(db, entityType, entityId, limit);
  ok(events);
}

// ─── diff ─────────────────────────────────────────────────────────────────────

export async function diffCommand(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      since:       { type: "string" },  // timestamp or op_id
      "since-seq": { type: "string" },
      "since-op":  { type: "string" },
      entity:      { type: "string" },
      limit:       { type: "string" },
    },
    strict: false,
  });

  const limit = values.limit ? parseInt(values.limit as string, 10) : 500;

  const db = getWriteDb();

  try {
    const entityType = values.entity as EntityType | undefined;
    if (entityType && !["issue", "edge", "inbox"].includes(entityType)) {
      fail("--entity must be issue|edge|inbox", "INVALID_ARGS", 2);
    }

    let sinceParam: Parameters<typeof diffSince>[1];

    if (values["since-seq"]) {
      sinceParam = { seq: parseInt(values["since-seq"] as string, 10), entity: entityType };
    } else if (values["since-op"]) {
      sinceParam = { op_id: values["since-op"] as string, entity: entityType };
    } else if (values.since) {
      // Auto-detect: if it looks like a timestamp (contains T or -), treat as ts; else op_id
      const s = values.since as string;
      if (/^\d{4}-|\d{4}T/.test(s)) {
        sinceParam = { ts: s, entity: entityType };
      } else {
        sinceParam = { op_id: s, entity: entityType };
      }
    } else {
      fail("--since <ts|op_id>, --since-seq <N>, or --since-op <op_id> required", "INVALID_ARGS", 2);
    }

    const events = diffSince(db, sinceParam, limit);
    ok(events);
  } catch (e: unknown) {
    const err = e as { message: string; code?: string };
    fail(err.message, err.code ?? "ERROR", 3);
  }
}

// ─── undo ─────────────────────────────────────────────────────────────────────

export async function undoCommand(argv: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args: argv,
    options: {
      actor: { type: "string" },
    },
    allowPositionals: true,
    strict: false,
  });

  const opId = positionals[0];
  if (!opId) fail("Usage: plumb undo <op_id>", "INVALID_ARGS", 2);

  const db = getWriteDb();
  try {
    const compensations = undoOp(db, opId, values.actor as string | undefined ?? "user");
    ok({ undone: opId, compensation_events: compensations.length, events: compensations });
  } catch (e: unknown) {
    const err = e as { message: string; code?: string };
    if (err.code === "NOT_FOUND") fail(err.message, "NOT_FOUND", 4);
    if (err.code === "ALREADY_UNDONE") fail(err.message, "ALREADY_UNDONE", 3);
    fail(err.message, err.code ?? "ERROR", 3);
  }
}

// ─── rebuild ──────────────────────────────────────────────────────────────────

export async function rebuildCommand(_argv: string[]): Promise<void> {
  const db = getWriteDb();
  try {
    const stats = rebuild(db);
    ok({ rebuilt: true, ...stats });
  } catch (e: unknown) {
    const err = e as { message: string; code?: string };
    fail(err.message, err.code ?? "ERROR", 3);
  }
}
