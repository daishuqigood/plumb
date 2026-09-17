/**
 * cli/commands/backup.ts — plumb backup
 * Triggers VACUUM INTO backup
 */

import { runBackup } from "../../lib/backup.js";
import { ok, fail } from "../output.js";

export async function backupCommand(_argv: string[]): Promise<void> {
  try {
    const result = runBackup();
    ok(result);
  } catch (e: unknown) {
    const err = e as { message: string; code?: string };
    fail(err.message, err.code ?? "ERROR", 3);
  }
}
