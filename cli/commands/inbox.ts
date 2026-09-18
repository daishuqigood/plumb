/**
 * cli/commands/inbox.ts — plumb inbox add|list|resolve (v3)
 */

import { parseArgs } from "node:util";
import { inboxAdd, inboxList, inboxResolve, type WriteOptions } from "../../lib/issues.js";
import { ok, fail, readStdin } from "../output.js";

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

export async function inboxCommand(argv: string[]): Promise<void> {
  const sub = argv[0];
  const rest = argv.slice(1);

  switch (sub) {
    case "add":     return inboxAdd_cmd(rest);
    case "list":    return inboxList_cmd(rest);
    case "resolve": return inboxResolve_cmd(rest);
    default:
      fail(`Unknown inbox subcommand: ${sub ?? "(none)"}. Use: add|list|resolve`, "INVALID_ARGS", 2);
  }
}

async function inboxAdd_cmd(argv: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args: argv,
    options: {
      stdin:  { type: "boolean" },
      origin: { type: "string" },
      ...PROV_OPTIONS,
    },
    allowPositionals: true,
    strict: false,
  });

  let raw: string;
  if (values.stdin || positionals.length === 0) {
    raw = (await readStdin()).trim();
  } else {
    raw = positionals.join(" ");
  }

  if (!raw) fail("Inbox item text is required (pass as argument or via stdin)", "INVALID_ARGS", 2);

  const prov = extractProv(values as Record<string, unknown>);
  const item = inboxAdd(raw, { ...prov, origin: values.origin as string | undefined });
  ok(item);
}

async function inboxList_cmd(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      status: { type: "string" },
      pretty: { type: "boolean" },
    },
    strict: false,
  });

  const status = values.status as "pending" | "resolved" | undefined;
  if (status && !["pending", "resolved"].includes(status)) {
    fail("--status must be pending|resolved", "INVALID_ARGS", 2);
  }

  const items = inboxList(status);

  if (values.pretty) {
    if (items.length === 0) {
      process.stdout.write("(inbox empty)\n");
    } else {
      for (const item of items) {
        const linked = item.resolved_issue_id ? ` → ${item.resolved_issue_id}` : "";
        process.stdout.write(`[${item.status}] ${item.id} ${item.created_at}${linked}\n  ${item.raw}\n`);
      }
    }
  } else {
    ok(items);
  }
}

async function inboxResolve_cmd(argv: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args: argv,
    options: {
      issue: { type: "string" },
      ...PROV_OPTIONS,
    },
    allowPositionals: true,
    strict: false,
  });

  const id = positionals[0];
  if (!id) fail("Usage: plumb inbox resolve <id> [--issue <idOrSeq>]", "INVALID_ARGS", 2);

  try {
    const item = inboxResolve(id as string, values.issue as string | undefined, extractProv(values as Record<string, unknown>));
    ok(item);
  } catch (e: unknown) {
    const err = e as { message: string; code?: string };
    if (err.code === "NOT_FOUND") fail(err.message, "NOT_FOUND", 4);
    fail(err.message, err.code ?? "ERROR", 3);
  }
}
