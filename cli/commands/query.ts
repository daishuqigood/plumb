/**
 * cli/commands/query.ts — plumb query "<sql>"
 * Read-only escape hatch: only SELECT/WITH, wrapped with LIMIT
 */

import { parseArgs } from "node:util";
import { runQuery } from "../../lib/issues.js";
import { ok, fail } from "../output.js";

export async function queryCommand(argv: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args: argv,
    options: { limit: { type: "string" } },
    allowPositionals: true,
    strict: false,
  });

  const sql = positionals.join(" ");
  if (!sql.trim()) fail("Usage: plumb query \"<sql>\"", "INVALID_ARGS", 2);

  const limit = values.limit ? parseInt(values.limit as string, 10) : 200;
  if (isNaN(limit) || limit < 1 || limit > 1000) fail("--limit must be between 1 and 1000", "INVALID_ARGS", 2);

  try {
    const rows = runQuery(sql, limit);
    ok(rows);
  } catch (e: unknown) {
    const err = e as { message: string; code?: string };
    if (err.code === "INVALID_SQL") fail(err.message, "INVALID_SQL", 2);
    if (err.code === "SQL_ERROR") fail(err.message, "SQL_ERROR", 3);
    fail(err.message, err.code ?? "ERROR", 3);
  }
}
