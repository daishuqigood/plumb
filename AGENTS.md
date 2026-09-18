# AGENTS.md

plumb v3 — AI-native event-sourced task management CLI (TypeScript, ESM, SQLite via better-sqlite3). Single user, local only, no server. The system is deliberately deterministic; all intelligence is expected from the agent, not the code.

## Commands

- `pnpm dev <args>` — run CLI from source via tsx, e.g. `pnpm dev issue list --pretty`
- `pnpm typecheck` — `tsc --noEmit`
- `pnpm build` — tsc + `cp lib/schema.sql dist/lib/schema.sql`. The cp matters: `lib/db.ts` loads `schema.sql` at runtime relative to itself, so dist without the copied schema breaks prod.
- `pnpm test` — vitest run. **No test files exist yet**, so this exits 1 with "No test files found" — that is expected, not a regression.
- No lint config, no CI.

Use pnpm only (pnpm-lock.yaml). better-sqlite3 is a native module; its install script is allow-listed in `pnpm-workspace.yaml` (`allowBuilds`). If pnpm fails with `ERR_PNPM_IGNORED_BUILDS`, that file is the place to fix it.

## Data directory (v3)

Data directory resolution priority (§3.1 of `docs/plumb-v3-ai-native.md`):
1. `PLUMB_DIR` env var → `$PLUMB_DIR/data/` (test/scratch; CI; `mktemp -d`)
2. XDG: `$XDG_DATA_HOME/plumb/data/` (fallback: `~/.local/share/plumb/data/`)

```bash
# Test against scratch data (never touches live data):
PLUMB_DIR=$(mktemp -d) pnpm dev issue create --title "x"
```

On first run to XDG dir: if `data/tasks.db` exists in the package root, it is automatically migrated (copied) to the XDG dir with a stderr notice. Repo `data/` is only used when `PLUMB_DIR` explicitly points to it.

## Live install

`plumb` on PATH is `/usr/local/bin/plumb` → `/Users/daisq1/work/project/plane/plumb/bin/plumb.mjs` — a **full copy of this repo** with its own `dist/` and its own data. Editing code here does not change the globally installed command until synced/rebuilt in that copy.

## Architecture (v3)

**Core invariant**: all writes = `appendEvents + applyEvent` in one transaction. Events are the truth; `issues`/`edges`/`inbox` are projections.

- `bin/plumb.mjs` — entry wrapper: dist build if present, else tsx on source
- `cli/plumb.ts` — thin subcommand dispatcher → `cli/commands/*.ts`
- `lib/db.ts` — singleton connections: write conn (WAL, foreign_keys, busy_timeout, runs `schema.sql` as idempotent migration on open); XDG directory resolution + one-time legacy migration
- `lib/events.ts` — event-sourcing engine: `appendEvents`, `applyEvent`, `rebuild`, `undoOp`, `diffSince`, `getEvents`
- `lib/issues.ts` — domain logic: all CRUD + link/unlink + snapshot + inbox + verify, all going through events engine; CAS description (sha256 hash); derived computability layer (readiness_score, is_blocked, etc.)
- `lib/rrule.ts` — RRULE subset (DAILY/WEEKLY/MONTHLY + INTERVAL + COUNT/UNTIL, ~60 lines, no deps)
- `lib/pretty.ts` / `lib/backup.ts` — formatting + backup utilities
- `lib/schema.sql` — v3 DDL: events, event_seq, issues, issues_live (view), edges, issue_links (compat view), inbox, seq, meta

## ESM conventions

`"type": "module"` + NodeNext: relative imports in `.ts` source must use explicit `.js` extensions (existing code does; keep it).

## Domain invariants (enforced in lib/)

- Issues have a nanoid primary key plus human-facing seq (`T-N`); every command accepts either.
- `plumb link A B --type blocks` means A blocks B (A is the prerequisite). Cycle detection rejects closing a loop (blocks only; open types are unchecked).
- `labels` is a JSON-array TEXT column — filter with `json_each(labels)`, never `LIKE`.
- `created_at/updated_at/done_at/due_ts/start_ts` are UTC ISO8601.
- `due_date`/`start_date` are local `YYYY-MM-DD` (due_date derived from due_ts + due_tz when not explicit).
- `issues.deleted = 1` is a tombstone; `issues_live` view filters it out. `plumb issue list` always reads `issues_live`.
- `verify` column: JSON `{"type":"command","cmd":...}` or `{"type":"manual"}`. `is_verified` derived from latest `verify_run` event.
- CAS descriptions: `data/descriptions/{sha256_first32hex}.md`. `issues.desc_hash` points to current version.
- `field_meta`: per-field provenance cache (actor/src/conf/ts/raw_input). Rebuilt by `plumb rebuild`.
- Exit codes: 2 invalid args/SQL, 3 business conflict (cycle, has-subtasks, already-undone), 4 not found.
- `plumb query` is the read-only SQL escape hatch (SELECT/WITH only, single statement). Default reads from `issues_live`.

## Provenance flags (all write commands)

Every write command accepts:
- `--actor <name>` — who made this change (default: "user"; Agent should pass "agent:<name>")
- `--reason <text>` — why this change was made
- `--conf <0..1>` — confidence (omit = explicit/certain; <1 = inferred)
- `--session <id>` — session ID grouping (for audit trail / `plumb diff --since`)
- `--op-id <id>` — idempotency key (same id on retry = no-op, returns original result)
- `--raw-input <text>` — original user utterance that triggered this change

## New v3 commands

- `plumb events <idOrSeq> [--limit N]` — event history for an issue
- `plumb diff --since <ts|op_id> [--since-seq N] [--entity issue|edge|inbox]` — changes since anchor
- `plumb undo <op_id>` — append compensating events (originals preserved)
- `plumb rebuild` — replay all events to rebuild projections (deterministic)
- `plumb verify <idOrSeq> --result pass|fail [--evidence -] [--cmd]` — record verify_run event
- `plumb gc` — remove unreferenced CAS description blobs

## Docs & skills

- `docs/usage.md` — full CLI reference (Chinese)
- `docs/plumb-v3-ai-native.md` — v3 design RFC (gitignored; do not commit)
- `docs/plumb-prd.md` — v2.2 design PRD (gitignored; do not commit)
- `skills/plumb/SKILL.md` — agent-facing workflows; a copy is installed at `~/.config/opencode/skills/plumb/` — keep them in sync when editing
