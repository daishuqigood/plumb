/**
 * cli/commands/schema.ts — plumb schema
 * Outputs DDL + field semantics + example queries
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SCHEMA_DDL } from "../../lib/issues.js";
import { ok, fail } from "../output.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function schemaCommand(argv: string[]): Promise<void> {
  // Determine if --json flag requested (default is human-readable for this command)
  const jsonMode = argv.includes("--json");

  try {
    const schemaSqlPath = resolve(__dirname, "../../lib/schema.sql");
    const ddl = readFileSync(schemaSqlPath, "utf8");

    if (jsonMode) {
      ok({ ddl, semantics: SCHEMA_DDL });
    } else {
      process.stdout.write("=== DDL ===\n");
      process.stdout.write(ddl + "\n");
      process.stdout.write("\n=== Field Semantics & Example Queries ===\n");
      process.stdout.write(SCHEMA_DDL + "\n");
    }
  } catch (e: unknown) {
    const err = e as { message: string };
    fail(err.message, "ERROR", 3);
  }
}
