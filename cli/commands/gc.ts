/**
 * cli/commands/gc.ts — plumb gc
 *
 * Removes CAS description blobs (data/descriptions/{hash}.md) that are no longer
 * referenced by any issue's desc_hash. Safe to run at any time.
 */

import { gcDescriptions } from "../../lib/issues.js";
import { ok, fail } from "../output.js";

export async function gcCommand(_argv: string[]): Promise<void> {
  try {
    const stats = gcDescriptions();
    ok({ ...stats, message: `Removed ${stats.removed} unreferenced description blob(s) (${(stats.freed_bytes / 1024).toFixed(1)} KB freed)` });
  } catch (e: unknown) {
    const err = e as { message: string; code?: string };
    fail(err.message, err.code ?? "ERROR", 3);
  }
}
