#!/usr/bin/env node
/**
 * cli/plumb.ts — plumb CLI entry point (v3)
 */

import { issueCommand }    from "./commands/issue.js";
import { linkCommand, unlinkCommand } from "./commands/link.js";
import { depsCommand }     from "./commands/deps.js";
import { snapshotCommand } from "./commands/snapshot.js";
import { inboxCommand }    from "./commands/inbox.js";
import { queryCommand }    from "./commands/query.js";
import { schemaCommand }   from "./commands/schema.js";
import { boardCommand }    from "./commands/board.js";
import { searchCommand }   from "./commands/search.js";
import { backupCommand }   from "./commands/backup.js";
import { eventsCommand, diffCommand, undoCommand, rebuildCommand } from "./commands/events.js";
import { verifyCommand }   from "./commands/verify.js";
import { gcCommand }       from "./commands/gc.js";

const VERSION = "3.0.0";

const HELP = `
plumb — Agent-native event-sourced task management
Version: ${VERSION}

Usage: plumb <command> [options]

Issue commands:
  issue create     Create a new issue
  issue get        Get issue details (--derived for readiness/is_blocked/etc.)
  issue list       List/filter issues (--derived for computed fields)
  issue update     Update an issue (patch semantics)
  issue delete     Soft-delete an issue (tombstone)
  issue batch-update  Batch update issues (--stdin JSON array)

Relation commands:
  link             Link two issues (--type <any>, default: relates)
  unlink           Remove a link between two issues
  deps             Show dependency tree for an issue

Event-sourcing commands:
  events <id>      Show event history for an entity
  diff             Show changes since a timestamp/seq/op_id (--since <ts|op_id>)
  undo <op_id>     Append compensating events to undo an operation
  rebuild          Replay all events to rebuild projections (repair/upgrade)

Views:
  snapshot         Today's structured summary (7 groups incl. awaiting_user)
  board            Text kanban board (5 columns)
  search           Full-text search issues (title + description)

Inbox:
  inbox add        Add raw text to inbox queue
  inbox list       List inbox items
  inbox resolve    Mark inbox item as resolved

Verification (§8.5):
  verify <id>      Record verify_run event --result pass|fail [--evidence -] [--cmd]

Maintenance:
  gc               Remove unreferenced CAS description blobs
  backup           Create a backup (VACUUM INTO)
  query            Run read-only SQL query (SELECT/WITH only)
  schema           Show DDL + field semantics + example queries

Global flags (all write commands):
  --actor <name>      Who made this change (default: user)
  --reason <text>     Why this change was made
  --conf <0..1>       Confidence (null = explicit/certain)
  --session <id>      Session ID grouping (for audit trail)
  --op-id <id>        Idempotency key (same id = no-op on retry)
  --raw-input <text>  Original user utterance triggering this change

Exit codes:
  0  success
  2  invalid arguments / rejected SQL
  3  business conflict (cycle, has-subtasks, already-undone, etc.)
  4  resource not found
`.trim();

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const rest = args.slice(1);

  switch (cmd) {
    case "issue":    return issueCommand(rest);
    case "link":     return linkCommand(rest);
    case "unlink":   return unlinkCommand(rest);
    case "deps":     return depsCommand(rest);
    case "snapshot": return snapshotCommand(rest);
    case "board":    return boardCommand(rest);
    case "search":   return searchCommand(rest);
    case "inbox":    return inboxCommand(rest);
    case "query":    return queryCommand(rest);
    case "schema":   return schemaCommand(rest);
    case "backup":   return backupCommand(rest);
    case "events":   return eventsCommand(rest);
    case "diff":     return diffCommand(rest);
    case "undo":     return undoCommand(rest);
    case "rebuild":  return rebuildCommand(rest);
    case "verify":   return verifyCommand(rest);
    case "gc":       return gcCommand(rest);
    case "version":
    case "--version":
      process.stdout.write(VERSION + "\n");
      return;
    case "--help":
    case "help":
    case undefined:
      process.stdout.write(HELP + "\n");
      return;
    default:
      process.stderr.write(`Unknown command: ${cmd}\n\n${HELP}\n`);
      process.exit(2);
  }
}

main().catch(e => {
  process.stderr.write(JSON.stringify({ error: { code: "FATAL", message: String(e?.message ?? e) } }, null, 2) + "\n");
  process.exit(1);
});
