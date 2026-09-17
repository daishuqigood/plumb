/**
 * cli/commands/snapshot.ts — plumb snapshot [--stale-days N]
 */

import { parseArgs } from "node:util";
import { snapshot } from "../../lib/issues.js";
import { prettySnapshot } from "../../lib/pretty.js";
import { ok, fail } from "../output.js";

export async function snapshotCommand(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      "stale-days": { type: "string" },
      pretty: { type: "boolean" },
    },
    strict: false,
  });

  const staleDays = values["stale-days"] ? parseInt(values["stale-days"] as string, 10) : 30;
  if (isNaN(staleDays) || staleDays < 1) fail("--stale-days must be a positive integer", "INVALID_ARGS", 2);

  try {
    const snap = snapshot(staleDays);
    if (values.pretty) {
      process.stdout.write(prettySnapshot(snap) + "\n");
    } else {
      ok(snap);
    }
  } catch (e: unknown) {
    const err = e as { message: string; code?: string };
    fail(err.message, err.code ?? "ERROR", 3);
  }
}
