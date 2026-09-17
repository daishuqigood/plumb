/**
 * cli/commands/issue.ts — plumb issue <subcommand>
 */

import { parseArgs } from "node:util";
import {
  createIssue, getIssue, listIssues, updateIssue, deleteIssue, batchUpdateIssues,
  CreateIssueSchema, UpdateIssueSchema,
  type State, type Priority,
} from "../../lib/issues.js";
import { prettyIssue, prettyList } from "../../lib/pretty.js";
import { ok, fail, readStdin } from "../output.js";

export async function issueCommand(argv: string[]): Promise<void> {
  const sub = argv[0];
  const rest = argv.slice(1);

  switch (sub) {
    case "create": return issueCreate(rest);
    case "get":    return issueGet(rest);
    case "list":   return issueList(rest);
    case "update": return issueUpdate(rest);
    case "delete": return issueDelete(rest);
    case "batch-update": return issueBatchUpdate(rest);
    default:
      fail(`Unknown issue subcommand: ${sub ?? "(none)"}. Use: create|get|list|update|delete|batch-update`, "INVALID_ARGS", 2);
  }
}

async function issueCreate(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      title:       { type: "string" },
      state:       { type: "string" },
      priority:    { type: "string" },
      project:     { type: "string" },
      labels:      { type: "string" },
      "start-date":{ type: "string" },
      "due-date":  { type: "string" },
      parent:      { type: "string" },
      description: { type: "string" }, // "-" means read from stdin
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

  const parsed = CreateIssueSchema.safeParse({
    title: values.title,
    state: values.state,
    priority: values.priority,
    project: values.project,
    labels: values.labels ? String(values.labels).split(",").map(s => s.trim()).filter(Boolean) : undefined,
    start_date: values["start-date"],
    due_date: values["due-date"],
    parent_id: values.parent,
    description,
  });

  if (!parsed.success) {
    fail(parsed.error.message, "INVALID_ARGS", 2);
  }

  try {
    const issue = createIssue(parsed.data);
    ok(issue);
  } catch (e: unknown) {
    const err = e as { message: string; code?: string };
    fail(err.message, err.code ?? "ERROR", 3);
  }
}

async function issueGet(argv: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args: argv,
    options: { pretty: { type: "boolean" } },
    allowPositionals: true,
    strict: false,
  });

  const id = positionals[0];
  if (!id) fail("Usage: plumb issue get <idOrSeq>", "INVALID_ARGS", 2);

  const issue = getIssue(id, true, true);
  if (!issue) fail(`Issue not found: ${id}`, "NOT_FOUND", 4);

  if (values.pretty) {
    process.stdout.write(prettyIssue(issue) + "\n");
  } else {
    ok(issue);
  }
}

async function issueList(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      state:       { type: "string" },
      project:     { type: "string" },
      label:       { type: "string" },
      "due-before":{ type: "string" },
      "due-after": { type: "string" },
      q:           { type: "string" },
      limit:       { type: "string" },
      sort:        { type: "string" },
      pretty:      { type: "boolean" },
    },
    strict: false,
  });

  const issues = listIssues({
    state:      values.state as State | undefined,
    project:    values.project as string | undefined,
    label:      values.label as string | undefined,
    due_before: values["due-before"] as string | undefined,
    due_after:  values["due-after"] as string | undefined,
    q:          values.q as string | undefined,
    limit:      values.limit ? parseInt(values.limit as string, 10) : undefined,
    sort:       values.sort as string | undefined,
  });

  if (values.pretty) {
    process.stdout.write(prettyList(issues) + "\n");
  } else {
    ok(issues);
  }
}

async function issueUpdate(argv: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args: argv,
    options: {
      title:       { type: "string" },
      state:       { type: "string" },
      priority:    { type: "string" },
      project:     { type: "string" },
      labels:      { type: "string" },
      "start-date":{ type: "string" },
      "due-date":  { type: "string" },
      parent:      { type: "string" },
      description: { type: "string" },
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

  const patchRaw: Record<string, unknown> = {};
  if (values.title !== undefined)       patchRaw.title       = values.title;
  if (values.state !== undefined)       patchRaw.state       = values.state;
  if (values.priority !== undefined)    patchRaw.priority    = values.priority;
  if (values.project !== undefined)     patchRaw.project     = values.project;
  if (values.labels !== undefined)      patchRaw.labels      = String(values.labels).split(",").map((s: string) => s.trim()).filter(Boolean);
  if (values["start-date"] !== undefined) patchRaw.start_date = values["start-date"];
  if (values["due-date"] !== undefined)   patchRaw.due_date   = values["due-date"];
  if (values.parent !== undefined)      patchRaw.parent_id   = values.parent;
  if (description !== undefined)        patchRaw.description = description;

  const parsed = UpdateIssueSchema.safeParse(patchRaw);
  if (!parsed.success) fail(parsed.error.message, "INVALID_ARGS", 2);

  try {
    const issue = updateIssue(id, parsed.data);
    ok(issue);
  } catch (e: unknown) {
    const err = e as { message: string; code?: string };
    const exitCode = err.code === "NOT_FOUND" ? 4 : 3;
    fail(err.message, err.code ?? "ERROR", exitCode);
  }
}

async function issueDelete(argv: string[]): Promise<void> {
  const { positionals } = parseArgs({
    args: argv,
    options: {},
    allowPositionals: true,
    strict: false,
  });

  const id = positionals[0];
  if (!id) fail("Usage: plumb issue delete <idOrSeq>", "INVALID_ARGS", 2);

  try {
    deleteIssue(id);
    ok({ deleted: id });
  } catch (e: unknown) {
    const err = e as { message: string; code?: string; subtasks?: unknown };
    if (err.code === "NOT_FOUND") fail(err.message, "NOT_FOUND", 4);
    if (err.code === "HAS_SUBTASKS") fail(err.message, "HAS_SUBTASKS", 3, { subtasks: err.subtasks });
    fail(err.message, err.code ?? "ERROR", 3);
  }
}

async function issueBatchUpdate(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: { stdin: { type: "boolean" } },
    strict: false,
  });

  if (!values.stdin) fail("--stdin flag required: plumb issue batch-update --stdin (send JSON array to stdin)", "INVALID_ARGS", 2);

  const raw = await readStdin();
  let items: unknown;
  try {
    items = JSON.parse(raw);
  } catch {
    fail("Invalid JSON on stdin", "INVALID_ARGS", 2);
  }

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
    const results = batchUpdateIssues(validated);
    ok(results);
  } catch (e: unknown) {
    const err = e as { message: string; code?: string };
    const exitCode = err.code === "NOT_FOUND" ? 4 : 3;
    fail(err.message, err.code ?? "ERROR", exitCode);
  }
}
