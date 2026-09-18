/**
 * cli/commands/issue.ts — plumb issue <subcommand> (v3)
 *
 * 新增 v3 flags:
 *   --actor, --reason, --conf, --session, --op-id, --raw-input (provenance)
 *   --start-ts, --due-ts, --due-tz, --rrule, --snooze-until (time model)
 *   --attr k=v (repeatable, writes attrs)
 *   --verify '<json>' (verify spec)
 *   --derived (attach readiness/is_blocked/etc. to output)
 */

import { parseArgs } from "node:util";
import {
  createIssue, getIssue, listIssues, updateIssue, deleteIssue, batchUpdateIssues,
  CreateIssueSchema, UpdateIssueSchema,
  type State, type Priority, type WriteOptions,
} from "../../lib/issues.js";
import { prettyIssue, prettyList } from "../../lib/pretty.js";
import { ok, fail, readStdin } from "../output.js";

// ─── Shared provenance options ────────────────────────────────────────────────

const PROV_OPTIONS = {
  actor:       { type: "string" as const },
  reason:      { type: "string" as const },
  conf:        { type: "string" as const },
  session:     { type: "string" as const },
  "op-id":     { type: "string" as const },
  "raw-input": { type: "string" as const },
} as const;

function extractProv(values: Record<string, unknown>): WriteOptions {
  const prov: WriteOptions = {};
  if (values.actor)        prov.actor      = values.actor as string;
  if (values.reason)       prov.reason     = values.reason as string;
  if (values.conf)         prov.conf       = parseFloat(values.conf as string);
  if (values.session)      prov.session_id = values.session as string;
  if (values["op-id"])     prov.op_id      = values["op-id"] as string;
  if (values["raw-input"]) prov.raw_input  = values["raw-input"] as string;
  return prov;
}

/** Parse --attr k=v flags (may be string or string[] from parseArgs) */
function parseAttrs(attrRaw: unknown): Record<string, unknown> {
  if (!attrRaw) return {};
  const items = Array.isArray(attrRaw) ? attrRaw : [attrRaw];
  const result: Record<string, unknown> = {};
  for (const item of items as string[]) {
    const eq = item.indexOf("=");
    if (eq < 0) continue;
    const k = item.slice(0, eq);
    const v = item.slice(eq + 1);
    // Try to parse as JSON, fall back to string
    try { result[k] = JSON.parse(v); } catch { result[k] = v; }
  }
  return result;
}

// ─── Dispatcher ───────────────────────────────────────────────────────────────

export async function issueCommand(argv: string[]): Promise<void> {
  const sub = argv[0];
  const rest = argv.slice(1);

  switch (sub) {
    case "create":       return issueCreate(rest);
    case "get":          return issueGet(rest);
    case "list":         return issueList(rest);
    case "update":       return issueUpdate(rest);
    case "delete":       return issueDelete(rest);
    case "batch-update": return issueBatchUpdate(rest);
    default:
      fail(`Unknown issue subcommand: ${sub ?? "(none)"}. Use: create|get|list|update|delete|batch-update`, "INVALID_ARGS", 2);
  }
}

// ─── create ───────────────────────────────────────────────────────────────────

async function issueCreate(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      title:          { type: "string" },
      state:          { type: "string" },
      priority:       { type: "string" },
      project:        { type: "string" },
      labels:         { type: "string" },
      "start-date":   { type: "string" },
      "due-date":     { type: "string" },
      "start-ts":     { type: "string" },
      "due-ts":       { type: "string" },
      "due-tz":       { type: "string" },
      "rrule":        { type: "string" },
      "snooze-until": { type: "string" },
      parent:         { type: "string" },
      description:    { type: "string" },
      attr:           { type: "string", multiple: true },
      verify:         { type: "string" },
      ...PROV_OPTIONS,
    },
    strict: false,
  });

  if (!values.title) fail("--title is required", "INVALID_ARGS", 2);

  let description: string | undefined;
  if (values.description === "-") {
    description = await readStdin();
  } else if (values.description) {
    description = values.description as string;
  }

  let verifySpec: unknown;
  if (values.verify) {
    try { verifySpec = JSON.parse(values.verify as string); }
    catch { fail("--verify must be valid JSON", "INVALID_ARGS", 2); }
  }

  const attrs = parseAttrs(values.attr);

  const parsed = CreateIssueSchema.safeParse({
    title:        values.title,
    state:        values.state,
    priority:     values.priority,
    project:      values.project,
    labels:       values.labels ? String(values.labels).split(",").map(s => s.trim()).filter(Boolean) : undefined,
    attrs:        Object.keys(attrs).length > 0 ? attrs : undefined,
    start_date:   values["start-date"],
    due_date:     values["due-date"],
    start_ts:     values["start-ts"],
    due_ts:       values["due-ts"],
    due_tz:       values["due-tz"],
    rrule:        values.rrule,
    snooze_until: values["snooze-until"],
    parent_id:    values.parent,
    description,
    verify:       verifySpec,
  });

  if (!parsed.success) fail(parsed.error.message, "INVALID_ARGS", 2);

  try {
    const issue = createIssue(parsed.data, extractProv(values as Record<string, unknown>));
    ok(issue);
  } catch (e: unknown) {
    const err = e as { message: string; code?: string };
    fail(err.message, err.code ?? "ERROR", 3);
  }
}

// ─── get ──────────────────────────────────────────────────────────────────────

async function issueGet(argv: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args: argv,
    options: {
      pretty:  { type: "boolean" },
      derived: { type: "boolean" },
    },
    allowPositionals: true,
    strict: false,
  });

  const id = positionals[0];
  if (!id) fail("Usage: plumb issue get <idOrSeq>", "INVALID_ARGS", 2);

  const issue = getIssue(id, true, true, !!values.derived);
  if (!issue) fail(`Issue not found: ${id}`, "NOT_FOUND", 4);

  if (values.pretty) {
    process.stdout.write(prettyIssue(issue) + "\n");
  } else {
    ok(issue);
  }
}

// ─── list ─────────────────────────────────────────────────────────────────────

async function issueList(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      state:        { type: "string" },
      project:      { type: "string" },
      label:        { type: "string" },
      "due-before": { type: "string" },
      "due-after":  { type: "string" },
      q:            { type: "string" },
      limit:        { type: "string" },
      sort:         { type: "string" },
      derived:      { type: "boolean" },
      pretty:       { type: "boolean" },
    },
    strict: false,
  });

  const issues = listIssues({
    state:          values.state as State | undefined,
    project:        values.project as string | undefined,
    label:          values.label as string | undefined,
    due_before:     values["due-before"] as string | undefined,
    due_after:      values["due-after"] as string | undefined,
    q:              values.q as string | undefined,
    limit:          values.limit ? parseInt(values.limit as string, 10) : undefined,
    sort:           values.sort as string | undefined,
    include_derived: !!values.derived,
  });

  if (values.pretty) {
    process.stdout.write(prettyList(issues) + "\n");
  } else {
    ok(issues);
  }
}

// ─── update ───────────────────────────────────────────────────────────────────

async function issueUpdate(argv: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args: argv,
    options: {
      title:          { type: "string" },
      state:          { type: "string" },
      priority:       { type: "string" },
      project:        { type: "string" },
      labels:         { type: "string" },
      "start-date":   { type: "string" },
      "due-date":     { type: "string" },
      "start-ts":     { type: "string" },
      "due-ts":       { type: "string" },
      "due-tz":       { type: "string" },
      rrule:          { type: "string" },
      "snooze-until": { type: "string" },
      parent:         { type: "string" },
      description:    { type: "string" },
      attr:           { type: "string", multiple: true },
      verify:         { type: "string" },
      ...PROV_OPTIONS,
    },
    allowPositionals: true,
    strict: false,
  });

  const id = positionals[0];
  if (!id) fail("Usage: plumb issue update <idOrSeq> [--field value ...]", "INVALID_ARGS", 2);

  let description: string | undefined;
  if (values.description === "-") {
    description = await readStdin();
  } else if (values.description) {
    description = values.description as string;
  }

  let verifySpec: unknown;
  if (values.verify !== undefined) {
    if (values.verify === "null" || values.verify === "") {
      verifySpec = null;
    } else {
      try { verifySpec = JSON.parse(values.verify as string); }
      catch { fail("--verify must be valid JSON or 'null'", "INVALID_ARGS", 2); }
    }
  }

  const attrs = parseAttrs(values.attr);

  const patchRaw: Record<string, unknown> = {};
  if (values.title !== undefined)          patchRaw.title        = values.title;
  if (values.state !== undefined)          patchRaw.state        = values.state;
  if (values.priority !== undefined)       patchRaw.priority     = values.priority;
  if (values.project !== undefined)        patchRaw.project      = values.project;
  if (values.labels !== undefined)         patchRaw.labels       = String(values.labels).split(",").map((s: string) => s.trim()).filter(Boolean);
  if (Object.keys(attrs).length > 0)       patchRaw.attrs        = attrs;
  if (values["start-date"] !== undefined)  patchRaw.start_date   = values["start-date"];
  if (values["due-date"] !== undefined)    patchRaw.due_date     = values["due-date"];
  if (values["start-ts"] !== undefined)    patchRaw.start_ts     = values["start-ts"];
  if (values["due-ts"] !== undefined)      patchRaw.due_ts       = values["due-ts"];
  if (values["due-tz"] !== undefined)      patchRaw.due_tz       = values["due-tz"];
  if (values.rrule !== undefined)          patchRaw.rrule        = values.rrule;
  if (values["snooze-until"] !== undefined) patchRaw.snooze_until = values["snooze-until"];
  if (values.parent !== undefined)         patchRaw.parent_id    = values.parent;
  if (description !== undefined)           patchRaw.description  = description;
  if (verifySpec !== undefined)            patchRaw.verify       = verifySpec;

  const parsed = UpdateIssueSchema.safeParse(patchRaw);
  if (!parsed.success) fail(parsed.error.message, "INVALID_ARGS", 2);

  try {
    const issue = updateIssue(id, parsed.data, extractProv(values as Record<string, unknown>));
    ok(issue);
  } catch (e: unknown) {
    const err = e as { message: string; code?: string };
    const exitCode = err.code === "NOT_FOUND" ? 4 : 3;
    fail(err.message, err.code ?? "ERROR", exitCode);
  }
}

// ─── delete ───────────────────────────────────────────────────────────────────

async function issueDelete(argv: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args: argv,
    options: { ...PROV_OPTIONS },
    allowPositionals: true,
    strict: false,
  });

  const id = positionals[0];
  if (!id) fail("Usage: plumb issue delete <idOrSeq>", "INVALID_ARGS", 2);

  try {
    deleteIssue(id, extractProv(values as Record<string, unknown>));
    ok({ deleted: id });
  } catch (e: unknown) {
    const err = e as { message: string; code?: string; subtasks?: unknown };
    if (err.code === "NOT_FOUND") fail(err.message, "NOT_FOUND", 4);
    if (err.code === "HAS_SUBTASKS") fail(err.message, "HAS_SUBTASKS", 3, { subtasks: err.subtasks });
    fail(err.message, err.code ?? "ERROR", 3);
  }
}

// ─── batch-update ─────────────────────────────────────────────────────────────

async function issueBatchUpdate(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      stdin: { type: "boolean" },
      ...PROV_OPTIONS,
    },
    strict: false,
  });

  if (!values.stdin) fail("--stdin flag required: plumb issue batch-update --stdin (send JSON array to stdin)", "INVALID_ARGS", 2);

  const raw = await readStdin();
  let items: unknown;
  try { items = JSON.parse(raw); }
  catch { fail("Invalid JSON on stdin", "INVALID_ARGS", 2); }

  if (!Array.isArray(items)) fail("stdin must be a JSON array of {id, patch} objects", "INVALID_ARGS", 2);

  const validated = [];
  for (let i = 0; i < (items as unknown[]).length; i++) {
    const item = (items as unknown[])[i] as Record<string, unknown>;
    if (!item.id || typeof item.id !== "string") fail(`Item[${i}] missing id`, "INVALID_ARGS", 2);
    const parsed = UpdateIssueSchema.safeParse(item.patch);
    if (!parsed.success) fail(`Item[${i}] patch invalid: ${parsed.error.message}`, "INVALID_ARGS", 2);
    validated.push({ id: item.id as string, patch: parsed.data });
  }

  try {
    const results = batchUpdateIssues(validated, extractProv(values as Record<string, unknown>));
    ok(results);
  } catch (e: unknown) {
    const err = e as { message: string; code?: string };
    const exitCode = err.code === "NOT_FOUND" ? 4 : 3;
    fail(err.message, err.code ?? "ERROR", exitCode);
  }
}
