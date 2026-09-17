#!/usr/bin/env node
/**
 * cli/plumb.ts — plumb CLI entry point
 * Thin shell: parses top-level subcommand, delegates to commands/
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

const VERSION = "1.0.0";

const HELP = `
plumb — Personal local AI-native task management system
Version: ${VERSION}

Usage: plumb <command> [options]

Commands:
  issue create     Create a new issue
  issue get        Get issue details
  issue list       List/filter issues
  issue update     Update an issue (patch semantics)
  issue delete     Delete an issue (hard delete)
  issue batch-update  Batch update issues (--stdin JSON array)

  link             Link two issues (--type blocks|relates|duplicate)
  unlink           Remove a link between two issues
  deps             Show dependency tree for an issue

  snapshot         Today's structured summary (6 groups)
  board            Text kanban board (5 columns)
  search           Full-text search issues

  inbox add        Add raw text to inbox queue
  inbox list       List inbox items
  inbox resolve    Mark inbox item as resolved

  query            Run read-only SQL query (SELECT/WITH only)
  schema           Show DDL + field semantics + example queries
  backup           Create a backup (VACUUM INTO)
  version          Show version

Global flags:
  --pretty         Human-readable output (read-only commands only)

Exit codes:
  0  success
  2  invalid arguments / rejected SQL
  3  business conflict (cycle, has-subtasks, etc.)
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
    case "version":
      process.stdout.write(VERSION + "\n");
      return;
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
