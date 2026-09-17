/**
 * cli/commands/search.ts — plumb search <q>
 */

import { parseArgs } from "node:util";
import { searchIssues } from "../../lib/issues.js";
import { prettyList } from "../../lib/pretty.js";
import { ok, fail } from "../output.js";

export async function searchCommand(argv: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args: argv,
    options: { pretty: { type: "boolean" } },
    allowPositionals: true,
    strict: false,
  });

  const q = positionals.join(" ");
  if (!q.trim()) fail("Usage: plumb search <query>", "INVALID_ARGS", 2);

  try {
    const results = searchIssues(q);
    if (values.pretty) {
      process.stdout.write(prettyList(results) + "\n");
    } else {
      ok(results);
    }
  } catch (e: unknown) {
    const err = e as { message: string; code?: string };
    fail(err.message, err.code ?? "ERROR", 3);
  }
}
