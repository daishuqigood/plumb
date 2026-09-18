# plumb

> Version: 3.0.0 | Updated: 2026-09-18

**plumb** (plumb line) is a **personal, local, AI-native task management system** — the event-sourced memory base for your AI Agent. Design principle: the system handles only deterministic storage and constraints; all intelligence is provided externally by an AI Agent (e.g. opencode / workspace).

**v3 highlights**: event sourcing (full history — auditable, undoable, rebuildable), derived executability layer (`readiness_score`, `is_blocked`, `is_overdue`, etc. computed at query time), content-addressed descriptions (CAS), full time model (UTC + IANA timezone + RRULE recurrence), provenance on every field, and structured acceptance criteria (`verify` / `verify_run`).

---

## Table of Contents

1. [Quick Start](#1-quick-start)
2. [Core Concepts](#2-core-concepts)
3. [Issue Management](#3-issue-management)
4. [Relationships & Dependencies](#4-relationships--dependencies)
5. [Inbox — Raw Capture Queue](#5-inbox--raw-capture-queue)
6. [Aggregate Views](#6-aggregate-views)
7. [Event Sourcing — Audit / Undo / Rebuild](#7-event-sourcing--audit--undo--rebuild)
8. [Acceptance Criteria (verify)](#8-acceptance-criteria-verify)
9. [Data Query & Escape Hatch](#9-data-query--escape-hatch)
10. [Data Management](#10-data-management)
11. [Working with AI Agents](#11-working-with-ai-agents)
12. [Exit Codes & Error Handling](#12-exit-codes--error-handling)
13. [Data Model Reference](#13-data-model-reference)
14. [Common Scenario Examples](#14-common-scenario-examples)

---

## 1. Quick Start

### Installation

```bash
# Already installed globally — use directly
plumb --help
plumb version
```

### Your First Issue

```bash
# Create an issue
plumb issue create --title "Finish quarterly report" --priority high --due-date 2026-09-30 --labels work

# List issues
plumb issue list --pretty

# Today's board
plumb board --pretty

# Today's snapshot (7 groups, readiness-sorted)
plumb snapshot --pretty
```

### Output Modes

| Mode | Description | Use case |
|------|-------------|----------|
| Default (JSON) | Structured JSON on stdout | AI Agent consumption, scripting |
| `--pretty` | Human-readable text | Browsing in the terminal |

> **Write commands** (create / update / delete, etc.) always output JSON only — `--pretty` is not supported for them.

---

## 2. Core Concepts

### 2.1 Event Sourcing

In v3 the single source of truth is the **`events` table** (append-only full history). The `issues` table is a rebuildable materialised projection. Every write = append event + update projection, inside one transaction.

- **Audit**: `plumb events T-42` — full history of an issue
- **Undo**: `plumb undo <op_id>` — appends a compensation event (original events are never deleted)
- **Rebuild**: `plumb rebuild` — replays the event stream to reconstruct all projections

### 2.2 Issue Identity

Every issue has two interchangeable IDs — any command accepting `<idOrSeq>` accepts either:

| Type | Example | Description |
|------|---------|-------------|
| Sequence | `T-42` | Short human-readable alias, globally auto-incremented |
| nanoid | `aVozy49e0AdfVyHRGz1Zl` | Internal unique ID |

### 2.3 State

```
backlog → todo → in_progress → done
                             ↘ canceled
```

Transitions in any direction are allowed. `done_at` is written automatically when entering `done` / `canceled` and cleared on exit.

| State | Meaning |
|-------|---------|
| `backlog` | Idea captured, not yet planned |
| `todo` | Planned, not started (default) |
| `in_progress` | In progress |
| `done` | Completed |
| `canceled` | Canceled |

### 2.4 Priority

`urgent` > `high` > `medium` > `low` > `none`

### 2.5 Derived Executability Layer

The following fields are **computed at query time** (never stored as authoritative values) using deterministic formulas:

| Derived field | Definition |
|---------------|------------|
| `is_blocked` | A valid `blocks` edge exists whose source is not done/canceled |
| `is_overdue` | `due_ts` < now and state ∉ {done, canceled} |
| `is_stale` | Not updated for a long time and state ∉ {done, canceled} |
| `is_snoozed` | `snooze_until` > now |
| `is_verified` | Most recent `verify_run` event has `result=pass` (null if no verify defined) |
| `readiness_score` | 0..1 composite score: `priority×0.4 + due_urgency×0.4 − blocked×0.5 − stale×0.3` |
| `next_action_hint` | Derived hint: `blocked` / `reschedule_or_complete` / `verify` / `start`, etc. |

### 2.6 Data Directory

Data directory resolution (highest priority first):

| Priority | Source | Path |
|----------|--------|------|
| 1 | `PLUMB_DIR` env | Any path (test / CI isolation) |
| 2 | XDG default | `$XDG_DATA_HOME/plumb` (fallback: `~/.local/share/plumb`) |

```
~/.local/share/plumb/          # Default live data directory
├── tasks.db                   # SQLite database (WAL mode)
├── descriptions/              # Content-addressed CAS description files
│   └── {sha256prefix}.md      # Named by content hash — deduped naturally
├── files/                     # Manually placed attachments
└── backups/                   # VACUUM INTO backup files
```

> On first run, if a legacy `data/tasks.db` exists at the package root, the entire `data/` directory is automatically migrated to the XDG location.

---

## 3. Issue Management

### 3.1 Create an Issue

```bash
plumb issue create --title <title> [options]
```

**Core fields:**

| Flag | Type | Description |
|------|------|-------------|
| `--title` | string | **Required** |
| `--state` | enum | Initial state, default `todo` |
| `--priority` | enum | Priority, default `none` |
| `--project` | string | Project grouping label |
| `--labels` | string | Comma-separated tags, e.g. `work,q4` |
| `--parent` | idOrSeq | Parent issue ID (creates a sub-issue) |
| `--description -` | stdin | Read Markdown description from stdin |

**v3 time fields (precise timestamps):**

| Flag | Type | Description |
|------|------|-------------|
| `--due-ts` | UTC ISO8601 | Exact deadline, e.g. `2026-09-30T16:00:00.000Z` |
| `--due-tz` | IANA timezone | e.g. `America/New_York` — used for day-boundary calculation |
| `--start-ts` | UTC ISO8601 | Exact start time |
| `--due-date` | YYYY-MM-DD | Local date (auto-converted to `due_ts` using the configured default timezone) |
| `--start-date` | YYYY-MM-DD | Local date (same as above) |
| `--rrule` | RRULE subset | Recurrence rule, e.g. `FREQ=WEEKLY;INTERVAL=1` |
| `--snooze-until` | UTC ISO8601 | Hide from `actionable` until this moment |

**v3 extended fields:**

| Flag | Type | Description |
|------|------|-------------|
| `--attr k=v` | repeatable | Write to the `attrs` JSON (Agent custom dimensions) |
| `--verify '<json>'` | JSON | Acceptance criteria (see §8) |

**v3 Provenance flags (available on all write commands):**

| Flag | Description |
|------|-------------|
| `--actor <who>` | Origin actor, e.g. `user`, `agent:claude` (default: `user`) |
| `--reason <text>` | Reason for the operation (stored in the event's `reason` field) |
| `--conf <0..1>` | Confidence score (used when an Agent infers a value; `1.0` = certain) |
| `--session <id>` | Session ID linking related operations (e.g. a decomposition run) |
| `--op-id <uuid>` | Idempotency key — pass the same value on retry to prevent duplicate writes |
| `--raw-input <text>` | The original user utterance that triggered this operation |

**Examples:**

```bash
# Basic
plumb issue create --title "Fix login page bug"

# Full flags
plumb issue create \
  --title "Q4 technical review" \
  --priority high \
  --due-date 2026-10-15 \
  --labels "work,q4,review" \
  --project tech-review

# Precise UTC timestamp + timezone
plumb issue create \
  --title "Weekly standup" \
  --due-ts "2026-09-19T14:00:00.000Z" \
  --due-tz "America/New_York" \
  --rrule "FREQ=WEEKLY;INTERVAL=1"

# With Markdown description from stdin
cat << 'EOF' | plumb issue create --title "API design doc" --description -
## Goal
Design the REST API for the auth module

## Endpoints
- POST /auth/login
- POST /auth/refresh
- DELETE /auth/logout
EOF

# With provenance (Agent inference, 0.8 confidence)
plumb issue create \
  --title "Prepare presentation slides" \
  --priority high \
  --due-date 2026-09-25 \
  --actor "agent:claude" \
  --conf 0.8 \
  --raw-input "Need presentation slides ready by next Friday, high priority"

# With custom attributes
plumb issue create --title "API design" --attr complexity=high --attr team=backend

# With acceptance criteria
plumb issue create \
  --title "Fix auth bug" \
  --verify '{"type":"command","cmd":"pnpm test auth","expect":"exit 0"}'
```

**Returns:** Full issue JSON object including the assigned `seq` (e.g. `T-1`), `id`, all fields, and derived fields.

---

### 3.2 Get an Issue

```bash
plumb issue get <idOrSeq> [--pretty]
```

v3 returns: description content (resolved from CAS), `attrs`, `field_meta` (provenance snapshot), derived fields (`readiness_score` / `is_blocked` / `is_overdue` / `is_verified`, etc.), `verify` definition, most recent `verify_run` record, relationships, and sub-issues.

```bash
plumb issue get T-42          # JSON (Agent use)
plumb issue get T-42 --pretty # Human-readable
```

---

### 3.3 List Issues

```bash
plumb issue list [filters] [--pretty]
```

| Flag | Description |
|------|-------------|
| `--state <state>` | Filter by state |
| `--project <name>` | Filter by project |
| `--label <tag>` | Filter by label (exact match) |
| `--due-before <date>` | Due date on or before |
| `--due-after <date>` | Due date on or after |
| `--q <keyword>` | Title keyword search |
| `--sort priority` | Sort by priority (default: by seq) |
| `--limit <n>` | Max results (upper bound: 1000) |

```bash
plumb issue list --state todo --pretty
plumb issue list --due-before 2026-09-22 --sort priority --pretty
plumb issue list --project tech-review --state in_progress
plumb issue list --q "report" --pretty
```

---

### 3.4 Update an Issue

```bash
plumb issue update <idOrSeq> [--field value ...]
```

**Patch semantics** — only the fields you pass are updated. All flags from `create` are supported (`--title` / `--state` / `--priority` / `--labels` / `--due-ts` / `--due-tz` / `--due-date` / `--rrule` / `--snooze-until` / `--attr` / `--verify`, etc.) plus all provenance flags.

```bash
plumb issue update T-42 --state in_progress
plumb issue update T-42 --state done               # done_at written automatically
plumb issue update T-42 --priority urgent --due-date 2026-09-20
plumb issue update T-42 --snooze-until "2026-09-21T00:00:00.000Z"
echo "Updated description" | plumb issue update T-42 --description -
plumb issue update T-42 --rrule "FREQ=MONTHLY;INTERVAL=1"

# With provenance (Agent)
plumb issue update T-42 --state done \
  --actor "agent:claude" \
  --reason "All sub-issues completed" \
  --session "sess_abc123"
```

---

### 3.5 Batch Update (Atomic Transaction)

```bash
echo '[...]' | plumb issue batch-update --stdin
```

Accepts a JSON array and executes as a **single transaction** — if any item fails, the entire batch rolls back.

```bash
echo '[
  {"id": "T-1", "patch": {"state": "done"}},
  {"id": "T-2", "patch": {"state": "done"}},
  {"id": "T-3", "patch": {"state": "in_progress"}}
]' | plumb issue batch-update --stdin
```

---

### 3.6 Delete an Issue

```bash
plumb issue delete <idOrSeq>
```

v3 uses a tombstone (`deleted=1`): the projection row is kept to preserve event-sourcing integrity; the `issues_live` view filters it out. Cascade effects: edges are deleted (`ON DELETE CASCADE`), `resolved_issue_id` in inbox is set to NULL.

> Deletion is refused (exit 3) if the issue has sub-issues — detach or delete them first.

```bash
plumb issue delete T-42

# If it has sub-issues:
plumb issue update T-6 --parent ""  # detach sub-issue
plumb issue delete T-5
```

---

### 3.7 Sub-issues

```bash
# Create a sub-issue
plumb issue create --title "Write unit tests" --parent T-10

# View parent issue (includes sub-issue list)
plumb issue get T-10 --pretty

# Make an existing issue a sub-issue
plumb issue update T-15 --parent T-10
```

---

### 3.8 Recurring Issues (RRULE)

When a recurring issue is marked done (`state→done`), the system **automatically advances** `due_ts` and reopens it (`state→todo`, `done_at=null`), appending events to record the transition.

Supported RRULE subset:

| Keyword | Meaning |
|---------|---------|
| `FREQ=DAILY` | Every day |
| `FREQ=WEEKLY;INTERVAL=2` | Every two weeks |
| `FREQ=MONTHLY;INTERVAL=1` | Every month |
| `COUNT=5` | Recur at most 5 times |
| `UNTIL=<UTC-ts>` | Stop recurring after this timestamp |

```bash
# Weekly Monday standup
plumb issue create \
  --title "Monday standup prep" \
  --due-ts "2026-09-21T14:00:00.000Z" \
  --due-tz "America/New_York" \
  --rrule "FREQ=WEEKLY;INTERVAL=1"

# Completing it advances due_ts by 7 days automatically
plumb issue update T-50 --state done
```

---

## 4. Relationships & Dependencies

### 4.1 Relationship Types

v3 uses an **open vocabulary** for edge types. Built-in conventions:

| Type | Direction | Semantics | Cycle check |
|------|-----------|-----------|-------------|
| `blocks` | directed | source **blocks** target | Yes |
| `relates` | symmetric | related to | No |
| `duplicate` | symmetric | duplicate of | No |
| `needs` | directed | source is waiting for target to provide a resource/info | No |
| custom | any | e.g. `follows`, `part_of` | No |

**Direction convention:**
> `plumb link A B --type blocks` = A blocks B = B cannot start until A is done

### 4.2 Create a Relationship

```bash
plumb link <source> <target> --type <type> [options]
```

| Flag | Description |
|------|-------------|
| `--type` | Edge type (default: `relates`) |
| `--weight` | Weight (positive number, default: `1.0`) |
| `--valid-from` | Edge effective time (UTC, default: now) |
| `--valid-to` | Edge expiry time (UTC; null = currently active) |

```bash
# T-2 cannot start until T-1 is done
plumb link T-1 T-2 --type blocks

# Chain: T-1 → T-2 → T-3
plumb link T-1 T-2 --type blocks
plumb link T-2 T-3 --type blocks

# Mark as related
plumb link T-4 T-5 --type relates

# Mark as duplicate
plumb link T-5 T-6 --type duplicate

# Resource request (T-10 needs the user to provide an API key)
plumb issue create --title "Provide OpenAI API Key" --state todo  # T-51
plumb link T-10 T-51 --type needs

# Custom type
plumb link T-7 T-8 --type follows --weight 2.0
```

**Cycle detection for `blocks`:**

```bash
plumb link T-3 T-1 --type blocks
# If T-1→T-2→T-3 already exists, this errors (exit 3):
# stderr: {"error": {"code": "CYCLE", "message": "Cycle detected: T-3→T-1→T-2→T-3"}}
```

### 4.3 Remove a Relationship

```bash
plumb unlink <source> <target> --type <type>
```

v3 implements soft-delete by setting `valid_to` (event-sourced); the `edges` table retains history.

```bash
plumb unlink T-1 T-2 --type blocks
plumb unlink T-4 T-5 --type relates
```

### 4.4 Query the Dependency Tree

```bash
plumb deps <idOrSeq> [--type <type>] [--pretty]
```

Returns all transitive predecessors (recursively expanded) with their current completion state. `--type` filters by edge type (default: `blocks`).

```bash
plumb deps T-3 --pretty
plumb deps T-10 --type needs --pretty   # awaiting_user resources
```

---

## 5. Inbox — Raw Capture Queue

The inbox is a **pure storage queue** for quickly capturing ideas; an Agent later processes them into formal issues. No automatic parsing — raw text is stored verbatim.

### 5.1 Add to Queue

```bash
plumb inbox add "Need presentation slides ready by next Friday, high priority"
echo "Confirm requirements with Alice" | plumb inbox add

# With provenance
plumb inbox add "Urgent: fix login in production" \
  --actor user \
  --session sess_xyz
```

### 5.2 View the Queue

```bash
plumb inbox list [--status pending|resolved] [--pretty]

plumb inbox list --status pending --pretty
plumb inbox list --pretty   # all, including resolved
```

### 5.3 Resolve and Link to an Issue

```bash
plumb inbox resolve <inbox_id> [--issue <idOrSeq>]

# Create the issue first
plumb issue create --title "Prepare slides" --priority high --due-date 2026-09-25

# Mark inbox entry resolved and link it
plumb inbox resolve cxPN3M3VKJln4pGt135VB --issue T-13

# Mark resolved without linking (discard)
plumb inbox resolve yOr4fCNidswcTRDBQQ2gg
```

---

## 6. Aggregate Views

### 6.1 Daily Snapshot

```bash
plumb snapshot [--stale-days <n>] [--pretty]
```

v3 returns **seven groups** of structured data — the core command for daily planning:

| Group | Description |
|-------|-------------|
| `overdue` | Past due date, not finished |
| `due_today` | Due today (respecting `due_tz` day boundary) |
| `in_progress` | Currently in progress |
| `actionable` | Ready to start (no incomplete blockers, sorted by `readiness_score`, snoozed issues excluded) |
| `blocked` | Blocked (includes blocker list) |
| `stale` | Not updated for a long time (default 30 days, configurable) |
| `awaiting_user` | Waiting for user to provide resources (`needs`-edge targets that are not done) |

v3 attaches derived fields to every issue: `readiness_score`, `next_action_hint`, `is_snoozed`, `is_verified`. Issues that are `done` but have an unverified `verify` definition are flagged as `done_unverified` (soft prompt).

```bash
plumb snapshot --pretty
plumb snapshot --stale-days 14 --pretty
plumb snapshot          # JSON for Agent
```

---

### 6.2 Text Kanban Board

```bash
plumb board [--project <name>] [--label <tag>]

plumb board
plumb board --project tech-review
```

Renders a five-column plain-text board: BACKLOG / TODO / IN PROGRESS / DONE / CANCELED.

---

### 6.3 Full-text Search

```bash
plumb search <keyword> [--pretty]
```

Searches both issue **titles** and CAS **description files**. Semantic matching is performed by the Agent pulling the full dataset into its own context (see §11).

```bash
plumb search "report" --pretty
plumb search "auth"
```

---

## 7. Event Sourcing — Audit / Undo / Rebuild

### 7.1 View Entity Event History

```bash
plumb events <idOrSeq> [--limit N] [--entity issue|edge|inbox]
```

Returns the complete event stream for an issue (or edge / inbox entry), including `actor`, `reason`, `raw_input`, `conf`, and `session_id` per event.

```bash
plumb events T-42
plumb events T-42 --limit 10
plumb events abc123 --entity inbox
```

### 7.2 Diff — Changes Since a Point in Time

```bash
plumb diff --since <ts|op_id> [--entity issue|edge|inbox] [--limit N]
```

Cross-entity change list. Answers questions like "what changed since yesterday?" or "who touched what since the last review?".

```bash
plumb diff --since "2026-09-17T00:00:00.000Z"
plumb diff --since op_abc123
plumb diff --since "2026-09-17T00:00:00.000Z" --entity issue
```

### 7.3 Undo an Operation

```bash
plumb undo <op_id>
```

Appends **compensation events** to reverse an operation. Original events are preserved — the audit chain remains complete. Works for create / update / delete / link / unlink.

```bash
# Find the op_id from the event stream
plumb events T-42 | jq '.[0].op_id'

plumb undo op_abc123
```

### 7.4 Rebuild Projections

```bash
plumb rebuild
```

Replays `events` in ascending `seq` order to rebuild the full `issues` / `edges` projections and `field_meta`. Use for: corruption repair, post-schema-upgrade backfill, consistency verification.

```bash
plumb rebuild
# Returns: {"rebuilt": true, "issues": 42, "edges": 15}
```

---

## 8. Acceptance Criteria (verify)

v3 lets you attach **structured acceptance criteria** to issues and record verification evidence, closing the requirement-to-completion loop.

### 8.1 Define Acceptance Criteria

Pass JSON to `--verify`:

```bash
# command type — Agent can run it automatically
plumb issue create \
  --title "Fix auth bug" \
  --verify '{"type":"command","cmd":"pnpm test auth","expect":"exit 0"}'

# manual type — requires human review
plumb issue create \
  --title "Write weekly report" \
  --verify '{"type":"manual","note":"User manually confirms content quality"}'

# Update criteria on an existing issue
plumb issue update T-42 --verify '{"type":"command","cmd":"pnpm build","expect":"exit 0"}'
```

### 8.2 Record a Verification Result

```bash
plumb verify <idOrSeq> --result pass|fail [--evidence -] [--cmd <cmd>]
```

After the Agent runs the verification command externally, it records the result here. `plumb verify` **does not modify** issue state — it only appends a `verify_run` event.

```bash
pnpm test auth && plumb verify T-42 --result pass --cmd "pnpm test auth"
plumb verify T-42 --result fail --cmd "pnpm test auth" --evidence "3 tests failed: auth.spec.ts"
cat test-output.txt | plumb verify T-42 --result pass --evidence -
plumb verify T-42 --result pass --actor user   # manual sign-off
```

### 8.3 Verification Status

- `is_verified=true` — most recent `verify_run` result is `pass`
- `is_verified=false` — most recent `verify_run` result is `fail`
- `is_verified=null` — no `verify` definition (not applicable)

Issues that are `done` with a non-null `verify` but not yet passed are flagged `done_unverified` in snapshot. **Soft gate**: `done` is never hard-blocked by verification (no exit 3) — the daily-review workflow surfaces the prompt instead.

---

## 9. Data Query & Escape Hatch

### 9.1 View Schema

```bash
plumb schema
```

Prints the full DDL (`events` / `issues` / `edges` / `inbox`), field semantics, derived formulas, RRULE subset documentation, and example queries. Run this before writing custom SQL.

### 9.2 Read-only SQL Query

```bash
plumb query "<SQL>" [--limit <n>] [--include-deleted]
```

**Safety constraints:**
- Only `SELECT` / `WITH` statements are allowed
- Reads `issues_live` view by default (tombstones filtered out)
- `--include-deleted` reads the full projection (including deleted issues)
- Results are automatically wrapped in `LIMIT` (default 200, max 1000)

```bash
# All todo issues
plumb query "SELECT seq, title, priority, due_date FROM issues_live WHERE state = 'todo' ORDER BY due_date"

# Issues with the 'work' label (use json_each, not LIKE)
plumb query "SELECT seq, title FROM issues_live WHERE EXISTS (SELECT 1 FROM json_each(labels) je WHERE je.value = 'work')"

# Read attrs for an issue
plumb query "SELECT seq, attrs FROM issues_live WHERE seq = 42"

# Read field_meta (provenance)
plumb query "SELECT seq, field_meta FROM issues_live WHERE seq = 42"

# Query the event stream directly
plumb query "SELECT ts, type, field, old, new, actor, reason FROM events WHERE entity_id = (SELECT id FROM issues WHERE seq = 42) ORDER BY seq"

# Count issues by state
plumb query "SELECT state, COUNT(*) as count FROM issues_live GROUP BY state ORDER BY count DESC"

# Find all incomplete issues that are blocking others
plumb query "
  SELECT DISTINCT i.seq, i.title, i.state
  FROM issues_live i
  JOIN edges e ON e.source_id = i.id AND e.type = 'blocks' AND e.valid_to IS NULL
  WHERE i.state NOT IN ('done', 'canceled')
"

plumb query "SELECT * FROM issues_live ORDER BY created_at DESC" --limit 10
```

---

## 10. Data Management

### 10.1 Backup

```bash
plumb backup
```

Creates an **online consistent backup** using SQLite `VACUUM INTO` (safe in WAL mode).

- Backup path: `<data_dir>/backups/tasks-YYYYMMDD.db`
- Automatically retains the most recent **14 backups**; older ones are pruned

```bash
plumb backup
# Returns: {"path": "/home/user/.local/share/plumb/backups/tasks-20260918.db"}
```

### 10.2 Migrate to a New Machine

```bash
# Copy the XDG data directory
cp -r ~/.local/share/plumb/ /new-machine/path/

# Verify
plumb issue list --pretty
```

### 10.3 GC — Clean Up Orphan CAS Blobs

```bash
plumb gc
```

Removes `.md` files in `descriptions/` that are not referenced by any issue's `desc_hash` (garbage collection for the content-addressed store).

```bash
plumb gc
# Returns: {"deleted_blobs": 3, "freed_bytes": 1024}
```

### 10.4 Reading Description Files Directly

Descriptions are stored as hash-named Markdown files and can be read directly, but writes must go through plumb to maintain CAS consistency:

```bash
# Read description via JSON output
plumb issue get T-42 | jq -r '.desc'

# Update via command
echo "Updated description" | plumb issue update T-42 --description -
cat design.md | plumb issue update T-42 --description -
```

---

## 11. Working with AI Agents

plumb is designed **Agent-first**: Agents consume JSON output for precise processing; humans use `--pretty` for browsing.

### 11.1 Loading the Skill in opencode / workspace

The plumb skill is installed at `~/.config/opencode/skills/plumb/` (or `~/.agents/skills/plumb/`). Just describe what you need in natural language:

```
"Plan my day"
"Process my inbox"
"Triage all overdue tasks"
"Break down requirement X into sub-issues with dependency chain and acceptance criteria"
```

### 11.2 Core Workflows

**Morning planning (daily-review):**
```
User  → Agent: "What should I work on today?"
Agent → plumb snapshot     → analyse 7 groups (readiness_score, done_unverified)
Agent → User:  recommend today's tasks (readiness-sorted), surface unverified done items
User  → Agent: confirm / adjust
Agent → plumb issue batch-update --stdin
```

**Requirement execution loop (requirement-loop):**
```
User  → Agent: "Implement user authentication"
Agent → plumb inbox add (raw utterance)
Agent → issue create (parent + sub-issues + blocks chain)
        all with --session <sid> --raw-input "<utterance>"
Agent → create supply issues for resource gaps + link --type needs
Agent → plumb snapshot shows awaiting_user group
User  → provides resources → resolves supply issues
Agent → execute by readiness order
Agent → run test && plumb verify T-N --result pass
Agent → state→done
Agent → plumb diff --since <sid> → closure report
```

**Audit trail:**
```
User  → Agent: "What changed since last review?"
Agent → plumb diff --since 2026-09-15T00:00:00Z
Agent → summarise changes, make recommendations
```

**Undo a mistake:**
```
User  → Agent: "That last operation was wrong, undo it"
Agent → plumb events T-N --limit 1 → get most recent op_id
Agent → plumb undo <op_id>
```

**Semantic dedup:**
```
Before creating a new issue:
Agent → plumb query "SELECT seq, title FROM issues_live WHERE state NOT IN ('done','canceled')"
Agent → matches semantically similar issues in its own context
Agent → if similar found → create duplicate edge or append to existing issue
```

### 11.3 Direct Manual Use

```bash
plumb issue list --state in_progress --pretty
plumb board --pretty
plumb snapshot --pretty
plumb inbox add "Remember to reply to the PR review tomorrow morning"
plumb events T-42 --pretty
pnpm build && plumb verify T-50 --result pass
```

---

## 12. Exit Codes & Error Handling

| Exit code | Meaning | Typical scenario |
|-----------|---------|-----------------|
| `0` | Success | — |
| `2` | Invalid arguments / illegal SQL | Missing required flag, misspelled state value, passing an UPDATE statement |
| `3` | Business conflict | Cycle detected in `blocks`, delete refused due to sub-issues, batch-update partial failure, undo of already-undone operation |
| `4` | Resource not found | Querying / updating a non-existent `T-N`, undoing a non-existent `op_id` |

All errors go to **stderr** as JSON:

```json
{
  "error": {
    "code": "CYCLE",
    "message": "Cycle detected: T-3→T-1→T-2→T-3",
    "cycle_path": "T-3→T-1→T-2→T-3"
  }
}
```

---

## 13. Data Model Reference

### Core Schema (v3)

```sql
-- Single source of truth: append-only event log
events (
  id          TEXT    -- nanoid primary key
  seq         INTEGER -- monotonically increasing, replay order
  ts          TEXT    -- UTC ISO8601
  entity      TEXT    -- issue|edge|inbox
  entity_id   TEXT    -- primary key of the referenced entity
  type        TEXT    -- create|update|state_change|description_change|delete|link|unlink|resolve|verify_run
  field       TEXT    -- field name for update events
  old         TEXT    -- JSON-encoded previous value
  new         TEXT    -- JSON-encoded new value
  actor       TEXT    -- user|agent:<name>|system
  reason      TEXT    -- free-text reason for the change
  raw_input   TEXT    -- original user utterance that triggered this operation
  conf        REAL    -- 0..1 confidence; null = explicit/certain
  session_id  TEXT    -- associated session
  op_id       TEXT    -- idempotency key
)

-- Projection: current state (rebuildable from events)
issues (
  id          TEXT    -- nanoid primary key
  seq         INTEGER -- T-N human alias
  title       TEXT
  state       TEXT    -- backlog|todo|in_progress|done|canceled
  priority    TEXT    -- urgent|high|medium|low|none
  project     TEXT    -- optional grouping
  parent_id   TEXT    -- parent issue id
  labels      TEXT    -- JSON array e.g. ["work","q4"]
  attrs       TEXT    -- open attributes JSON (Agent custom dimensions)
  field_meta  TEXT    -- per-field provenance snapshot JSON
  start_ts    TEXT    -- UTC precise start time
  due_ts      TEXT    -- UTC precise deadline
  due_tz      TEXT    -- IANA timezone (e.g. America/New_York)
  due_date    TEXT    -- derived local YYYY-MM-DD (human-readable / compat)
  rrule       TEXT    -- recurrence rule subset
  snooze_until TEXT   -- UTC; hide from actionable until this time
  done_at     TEXT    -- UTC, maintained automatically
  created_at  TEXT    -- UTC ISO8601
  updated_at  TEXT    -- UTC ISO8601
  desc_hash   TEXT    -- CAS pointer: descriptions/{hash}.md
  verify      TEXT    -- acceptance criteria JSON (type: command|manual)
  deleted     INTEGER -- tombstone (0/1); filtered by issues_live view
)

-- Default read path: tombstones excluded
issues_live AS SELECT * FROM issues WHERE deleted = 0

-- Graph edges (open type / weighted / time-bounded)
edges (
  id          TEXT    -- nanoid primary key
  source_id   TEXT    -- source issue
  target_id   TEXT    -- target issue
  type        TEXT    -- open vocabulary: blocks|relates|duplicate|needs|...
  weight      REAL    -- default 1.0
  valid_from  TEXT    -- UTC, effective time
  valid_to    TEXT    -- UTC, expiry time (null = currently active)
  created_at  TEXT
)

-- Raw capture queue
inbox (
  id                 TEXT    -- nanoid
  raw                TEXT    -- raw text
  status             TEXT    -- pending|resolved
  resolved_issue_id  TEXT    -- linked issue id (optional)
  origin             TEXT    -- cli|voice|paste|import
  session_id         TEXT
  created_at         TEXT
)
```

### Key Rules

- **`blocks` direction**: `(source_id, target_id, 'blocks')` = source blocks target
  - "B waits for A" → `plumb link A B --type blocks` (A is source)
- **`relates` / `duplicate`**: symmetric — queries match both directions
- **`labels`**: JSON array — use `json_each(labels)` in queries, never `LIKE '%tag%'`
- **Timestamps**: `created_at` / `updated_at` / `done_at` / `due_ts` / `start_ts` are all UTC ISO8601; `due_date` is derived local `YYYY-MM-DD`
- **Default read path uses `issues_live`** view — deleted issues are filtered out

---

## 14. Common Scenario Examples

### Scenario 1: Full Issue Lifecycle with Verification

```bash
# 1. Create with acceptance criteria
plumb issue create \
  --title "Refactor auth module" \
  --priority high \
  --due-date 2026-10-31 \
  --labels "work,backend" \
  --verify '{"type":"command","cmd":"pnpm test auth","expect":"exit 0"}'

# 2. Decompose into sub-issues with blocks dependency
plumb issue create --title "Write unit tests" --parent T-20   # T-21
plumb issue create --title "Update API docs"  --parent T-20   # T-22
plumb link T-21 T-22 --type blocks  # tests first, then docs

# 3. Start work
plumb issue update T-20 --state in_progress

# 4. Complete sub-issues with verification
pnpm test auth && plumb verify T-21 --result pass
plumb issue update T-21 --state done
plumb issue update T-22 --state done

# 5. Verify and complete parent
pnpm test auth && plumb verify T-20 --result pass --cmd "pnpm test auth"
plumb issue update T-20 --state done
```

### Scenario 2: Requirement Execution Loop

```bash
# 1. Capture raw requirement
plumb inbox add "Implement OAuth2 login with Google and GitHub, ship by end of month"

# 2. Agent decomposes (with session + raw_input)
SID="sess_$(date +%s)"
plumb issue create --title "OAuth2 login (main)" --priority high \
  --session "$SID" --raw-input "Implement OAuth2 login with Google and GitHub, ship by end of month"

plumb issue create --title "Google OAuth integration" --parent T-60 \
  --verify '{"type":"command","cmd":"pnpm test oauth-google","expect":"exit 0"}' \
  --session "$SID"

plumb issue create --title "GitHub OAuth integration" --parent T-60 \
  --verify '{"type":"command","cmd":"pnpm test oauth-github","expect":"exit 0"}' \
  --session "$SID"

# 3. Resource request (needs user to supply Client ID/Secret)
plumb issue create --title "Provide Google OAuth Client ID/Secret" --state todo  # T-63
plumb link T-61 T-63 --type needs

# 4. Review awaiting_user group (7th snapshot group)
plumb snapshot --pretty

# 5. User provides credentials → resolve supply issue
plumb issue update T-63 --state done

# 6. Execute and verify
pnpm test oauth-google && plumb verify T-61 --result pass
plumb issue update T-61 --state done

# 7. Audit report
plumb diff --since "$SID"
```

### Scenario 3: Undo a Mistake

```bash
# Accidentally marked done
plumb issue update T-42 --state done

# Get the op_id of the last event
OP=$(plumb events T-42 --limit 1 | jq -r '.[0].op_id')

# Undo
plumb undo "$OP"

# Confirm restored
plumb issue get T-42 --pretty
```

### Scenario 4: Recurring Issue

```bash
# Weekly Friday report
plumb issue create \
  --title "Write weekly report" \
  --priority medium \
  --due-ts "2026-09-19T08:00:00.000Z" \
  --due-tz "America/New_York" \
  --rrule "FREQ=WEEKLY;INTERVAL=1" \
  --verify '{"type":"manual","note":"Check report content is complete"}'

# Completing it advances due_ts by 7 days automatically
plumb issue update T-70 --state done
```

### Scenario 5: Custom SQL Analytics

```bash
# Issues completed this month
plumb query "SELECT COUNT(*) FROM issues_live WHERE state = 'done' AND done_at >= '2026-09-01'"

# Distribution by priority and state
plumb query "SELECT priority, state, COUNT(*) FROM issues_live GROUP BY priority, state ORDER BY priority"

# Done but unverified issues
plumb query "
  SELECT i.seq, i.title, e.new
  FROM issues_live i
  LEFT JOIN (
    SELECT entity_id, new, ROW_NUMBER() OVER (PARTITION BY entity_id ORDER BY seq DESC) rn
    FROM events WHERE type = 'verify_run'
  ) e ON e.entity_id = i.id AND e.rn = 1
  WHERE i.state = 'done'
    AND i.verify IS NOT NULL
    AND (e.new IS NULL OR json_extract(e.new, '$.result') != 'pass')
"

# Top 10 most actionable issues (readiness approximation)
plumb query "
  SELECT seq, title, priority, due_date
  FROM issues_live
  WHERE state IN ('todo','in_progress')
  ORDER BY
    CASE priority WHEN 'urgent' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low' THEN 1 ELSE 0 END DESC,
    due_date ASC NULLS LAST
  LIMIT 10
"
```

---

## Appendix: Command Reference

| Command | Description |
|---------|-------------|
| `plumb issue create` | Create an issue |
| `plumb issue get <id>` | Get issue details (with derived fields / verify / field_meta) |
| `plumb issue list` | List issues |
| `plumb issue update <id>` | Update issue fields (patch semantics) |
| `plumb issue delete <id>` | Delete an issue (tombstone) |
| `plumb issue batch-update --stdin` | Batch update (atomic transaction) |
| `plumb link <src> <tgt> --type <t>` | Create a relationship (open vocabulary) |
| `plumb unlink <src> <tgt> --type <t>` | Remove a relationship (soft-delete) |
| `plumb deps <id> [--type <t>]` | Query dependency tree (type-filterable) |
| `plumb snapshot` | Daily 7-group summary (readiness / awaiting_user / done_unverified) |
| `plumb board` | Five-column text kanban board |
| `plumb search <q>` | Full-text search (title + CAS descriptions) |
| `plumb inbox add` | Add to raw capture queue |
| `plumb inbox list` | View inbox |
| `plumb inbox resolve <id>` | Resolve an inbox entry |
| `plumb events <id>` | View entity event history |
| `plumb diff --since <ts\|op_id>` | Changes since a point in time |
| `plumb undo <op_id>` | Undo an operation (compensation event) |
| `plumb rebuild` | Rebuild projections from event stream |
| `plumb verify <id> --result pass\|fail` | Record verification result (verify_run event) |
| `plumb gc` | Clean up orphan CAS blobs |
| `plumb query "<sql>"` | Read-only SQL query (default: issues_live) |
| `plumb schema` | View database schema (with event semantics / derived formulas) |
| `plumb backup` | Create database backup (VACUUM INTO) |
| `plumb version` | Print version |
| `plumb --help` | Show help |
