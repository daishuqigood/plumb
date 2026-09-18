/**
 * cli/commands/link.ts — plumb link / unlink (v3)
 *
 * link now supports:
 *   --type <any-string>  (open vocabulary, defaults cycle-check for 'blocks')
 *   --weight <float>
 *   --valid-from <utc-ts>
 *   --valid-to <utc-ts>
 *   --actor/--reason/--conf/--session/--op-id/--raw-input (provenance)
 */

import { parseArgs } from "node:util";
import { linkIssues, unlinkIssues, type WriteOptions } from "../../lib/issues.js";
import { ok, fail } from "../output.js";

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

export async function linkCommand(argv: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args: argv,
    options: {
      type:         { type: "string" },
      weight:       { type: "string" },
      "valid-from": { type: "string" },
      "valid-to":   { type: "string" },
      ...PROV_OPTIONS,
    },
    allowPositionals: true,
    strict: false,
  });

  const [sourceRaw, targetRaw] = positionals;
  if (!sourceRaw || !targetRaw) fail("Usage: plumb link <source> <target> --type <type>", "INVALID_ARGS", 2);
  const source = sourceRaw as string;
  const target = targetRaw as string;

  const typeStr = values.type ? String(values.type) : "relates";

  const weight = values.weight ? parseFloat(String(values.weight)) : undefined;
  if (weight !== undefined && (isNaN(weight) || weight <= 0)) {
    fail("--weight must be a positive number", "INVALID_ARGS", 2);
  }

  try {
    const edges = linkIssues(source, target, typeStr, {
      ...extractProv(values as Record<string, unknown>),
      weight,
      valid_from: values["valid-from"] as string | undefined,
      valid_to:   values["valid-to"]   as string | undefined,
    });
    ok(edges);
  } catch (e: unknown) {
    const err = e as { message: string; code?: string; path?: string };
    if (err.code === "NOT_FOUND") fail(err.message, "NOT_FOUND", 4);
    if (err.code === "CYCLE") fail(err.message, "CYCLE", 3, { cycle_path: err.path });
    fail(err.message, err.code ?? "ERROR", 3);
  }
}

export async function unlinkCommand(argv: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args: argv,
    options: {
      type: { type: "string" },
      ...PROV_OPTIONS,
    },
    allowPositionals: true,
    strict: false,
  });

  const [sourceRaw2, targetRaw2] = positionals;
  if (!sourceRaw2 || !targetRaw2) fail("Usage: plumb unlink <source> <target> --type <type>", "INVALID_ARGS", 2);
  const source2 = sourceRaw2 as string;
  const target2 = targetRaw2 as string;

  const typeStr = values.type ? String(values.type) : "relates";

  try {
    unlinkIssues(source2, target2, typeStr, extractProv(values as Record<string, unknown>));
    ok({ unlinked: true, source: source2, target: target2, type: typeStr });
  } catch (e: unknown) {
    const err = e as { message: string; code?: string };
    if (err.code === "NOT_FOUND") fail(err.message, "NOT_FOUND", 4);
    fail(err.message, err.code ?? "ERROR", 3);
  }
}
