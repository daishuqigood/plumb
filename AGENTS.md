# AGENTS.md

plumb — personal local AI-native task-management CLI (TypeScript, ESM, SQLite via better-sqlite3). Single user, local only, no server. The system is deliberately deterministic; all intelligence is expected from the agent, not the code.

## Commands

- `pnpm dev <args>` — run CLI from source via tsx, e.g. `pnpm dev issue list --pretty`
- `pnpm typecheck` — `tsc --noEmit`
- `pnpm build` — tsc + `cp lib/schema.sql dist/lib/schema.sql`. The cp matters: `lib/db.ts` loads `schema.sql` at runtime relative to itself, so dist without the copied schema breaks prod.
- `pnpm test` — vitest run. **No test files exist yet**, so this exits 1 with "No test files found" — that is expected, not a regression.
- No lint config, no CI.

Use pnpm only (pnpm-lock.yaml). better-sqlite3 is a native module; its install script is allow-listed in `pnpm-workspace.yaml` (`allowBuilds`). If pnpm fails with `ERR_PNPM_IGNORED_BUILDS`, that file is the place to fix it.

## Data directory isolation

`bin/plumb.mjs` sets `PLUMB_DIR` to the package root; `lib/db.ts` resolves `data/` from `PLUMB_DIR` (fallback: parent of the file). To test against scratch data:

```bash
PLUMB_DIR=$(mktemp -d) pnpm dev issue create --title "x"
```

Without `PLUMB_DIR`, `pnpm dev` reads/writes the repo's real `data/` — gitignored live user data; never delete or commit it. WAL sidecar files (`tasks.db-wal/-shm`) are normal.

## Live install is a separate copy

`plumb` on PATH is `/usr/local/bin/plumb` → `/Users/daisq1/work/project/plane/plumb/bin/plumb.mjs` — a **full copy of this repo** with its own `dist/` and its own `data/`. Editing code here does not change the globally installed command or its database until synced/rebuilt in that copy. The wrapper prefers `dist/cli/plumb.js` when it exists, so rebuild before bin-path changes are visible.

## Architecture

- `bin/plumb.mjs` — entry wrapper: dist build if present, else tsx on source
- `cli/plumb.ts` — thin subcommand dispatcher → `cli/commands/*.ts` (one file per command group)
- `lib/db.ts` — singleton connections: write conn (WAL, foreign_keys, busy_timeout, runs `schema.sql` as idempotent migration on open) and separate read-only conn (`query_only` pragma) used by `plumb query`
- `lib/issues.ts` / `backup.ts` / `pretty.ts` — domain logic; task descriptions live as Markdown at `data/descriptions/{id}.md`
- Version string is duplicated in `package.json` and `cli/plumb.ts` — update both.

## ESM conventions

`"type": "module"` + NodeNext: relative imports in `.ts` source must use explicit `.js` extensions (existing code does; keep it).

## Domain invariants (enforced in lib/)

- Issues have a nanoid primary key plus human-facing seq (`T-N`); every command accepts either.
- `plumb link A B --type blocks` means A blocks B (A is the prerequisite). Cycle detection rejects closing a loop.
- `labels` is a JSON-array TEXT column — filter with `json_each(labels)`, never `LIKE`.
- `created_at/updated_at/done_at` are UTC ISO8601; `start_date/due_date` are local `YYYY-MM-DD`.
- Exit codes: 2 invalid args/SQL, 3 business conflict (cycle, deleting an issue with subtasks, batch failure), 4 not found. Errors are JSON on stderr.
- `plumb query` is the read-only SQL escape hatch (SELECT/WITH only, single statement).

## Docs & skills

- `docs/usage.md` — full CLI reference (Chinese)
- `docs/plumb-prd.md` — design PRD, **gitignored on purpose**; do not commit
- `skills/plumb/SKILL.md` — agent-facing workflows; a copy is installed at `~/.config/opencode/skills/plumb/` — keep them in sync when editing
