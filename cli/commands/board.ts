/**
 * cli/commands/board.ts — plumb board [--project --label]
 * Pure text five-column kanban board (always human-readable)
 */

import { parseArgs } from "node:util";
import { listIssues, type State } from "../../lib/issues.js";
import { prettyBoard } from "../../lib/pretty.js";
import { fail } from "../output.js";

const STATES: State[] = ["backlog", "todo", "in_progress", "done", "canceled"];

export async function boardCommand(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      project: { type: "string" },
      label:   { type: "string" },
    },
    strict: false,
  });

  try {
    const issuesByState = new Map<string, ReturnType<typeof listIssues>>();
    for (const state of STATES) {
      issuesByState.set(state, listIssues({
        state,
        project: values.project as string | undefined,
        label:   values.label as string | undefined,
      }));
    }
    process.stdout.write(prettyBoard(issuesByState) + "\n");
  } catch (e: unknown) {
    const err = e as { message: string; code?: string };
    fail(err.message, err.code ?? "ERROR", 3);
  }
}
