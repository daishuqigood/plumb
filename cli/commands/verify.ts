/**
 * cli/commands/verify.ts — plumb verify <idOrSeq> --result pass|fail [--evidence -] [--cmd <cmd>]
 *
 * Records a verify_run event (§8.5.3). Does NOT modify the issue state.
 * Agent runs the verify command externally and passes result here.
 */

import { parseArgs } from "node:util";
import { recordVerifyRun, type WriteOptions } from "../../lib/issues.js";
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

export async function verifyCommand(argv: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args: argv,
    options: {
      result:   { type: "string" },
      evidence: { type: "string" }, // "-" means read from stdin
      cmd:      { type: "string" },
      ...PROV_OPTIONS,
    },
    allowPositionals: true,
    strict: false,
  });

  const idOrSeq = positionals[0];
  if (!idOrSeq) fail("Usage: plumb verify <idOrSeq> --result pass|fail [--evidence -] [--cmd <cmd>]", "INVALID_ARGS", 2);

  const result = values.result as string | undefined;
  if (!result || !["pass", "fail"].includes(result)) {
    fail("--result must be pass|fail", "INVALID_ARGS", 2);
  }

  let evidence: string | undefined;
  if (values.evidence === "-") {
    evidence = await readStdin();
  } else if (values.evidence) {
    evidence = values.evidence as string;
  }

  try {
    recordVerifyRun(idOrSeq, {
      result: result as "pass" | "fail",
      evidence,
      cmd: values.cmd as string | undefined,
    }, extractProv(values as Record<string, unknown>));
    ok({ verified: idOrSeq, result });
  } catch (e: unknown) {
    const err = e as { message: string; code?: string };
    if (err.code === "NOT_FOUND") fail(err.message, "NOT_FOUND", 4);
    fail(err.message, err.code ?? "ERROR", 3);
  }
}
