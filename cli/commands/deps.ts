/**
 * cli/commands/deps.ts — plumb deps <idOrSeq>
 */

import { parseArgs } from "node:util";
import { getDeps } from "../../lib/issues.js";
import { ok, fail } from "../output.js";

export async function depsCommand(argv: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args: argv,
    options: { pretty: { type: "boolean" } },
    allowPositionals: true,
    strict: false,
  });

  const id = positionals[0];
  if (!id) fail("Usage: plumb deps <idOrSeq>", "INVALID_ARGS", 2);

  try {
    const deps = getDeps(id);
    if (values.pretty) {
      if (deps.length === 0) {
        process.stdout.write("(no blocking dependencies)\n");
      } else {
        process.stdout.write(`Dependencies for ${id}:\n`);
        for (const d of deps) {
          const blocked = d.is_blocked ? " [BLOCKED]" : "";
          process.stdout.write(`  T-${d.seq} [${d.state}] ${d.title}${blocked}\n`);
        }
      }
    } else {
      ok(deps);
    }
  } catch (e: unknown) {
    const err = e as { message: string; code?: string };
    if (err.code === "NOT_FOUND") fail(err.message, "NOT_FOUND", 4);
    fail(err.message, err.code ?? "ERROR", 3);
  }
}
