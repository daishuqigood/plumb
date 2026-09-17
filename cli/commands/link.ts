/**
 * cli/commands/link.ts — plumb link / unlink
 */

import { parseArgs } from "node:util";
import { linkIssues, unlinkIssues, LinkTypeSchema, type LinkType } from "../../lib/issues.js";
import { ok, fail } from "../output.js";

export async function linkCommand(argv: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args: argv,
    options: { type: { type: "string" } },
    allowPositionals: true,
    strict: false,
  });

  const [source, target] = positionals;
  if (!source || !target) fail("Usage: plumb link <source> <target> --type blocks|relates|duplicate", "INVALID_ARGS", 2);

  const typeStr = values.type;
  if (!typeStr) fail("--type is required", "INVALID_ARGS", 2);
  const parsed = LinkTypeSchema.safeParse(typeStr);
  if (!parsed.success) fail("--type must be blocks|relates|duplicate", "INVALID_ARGS", 2);

  try {
    const links = linkIssues(source, target, parsed.data as LinkType);
    ok(links);
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
    options: { type: { type: "string" } },
    allowPositionals: true,
    strict: false,
  });

  const [source, target] = positionals;
  if (!source || !target) fail("Usage: plumb unlink <source> <target> --type blocks|relates|duplicate", "INVALID_ARGS", 2);

  const typeStr = values.type;
  if (!typeStr) fail("--type is required", "INVALID_ARGS", 2);
  const parsed = LinkTypeSchema.safeParse(typeStr);
  if (!parsed.success) fail("--type must be blocks|relates|duplicate", "INVALID_ARGS", 2);

  try {
    unlinkIssues(source, target, parsed.data as LinkType);
    ok({ unlinked: true, source, target, type: parsed.data });
  } catch (e: unknown) {
    const err = e as { message: string; code?: string };
    if (err.code === "NOT_FOUND") fail(err.message, "NOT_FOUND", 4);
    fail(err.message, err.code ?? "ERROR", 3);
  }
}
