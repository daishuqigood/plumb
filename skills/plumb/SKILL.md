---
name: plumb
description: Personal local AI-native task management via the plumb v3 CLI. Covers daily-review, inbox-triage, weekly-cleanup, audit-trail, undo-mistake, semantic-dedup, and requirement-loop workflows. Use when managing tasks, planning the day, triaging inbox, running dependency queries, reviewing event history, or orchestrating a full requirement-execution loop with the plumb command.
compatibility: opencode
---

# plumb v3 — Agent Skill: AI-Native Task Management Workflows

> **For AI Agents using the `plumb` CLI**
> Load this file before orchestrating complex plumb workflows.

## Core Contract

`plumb` is a **deterministic event-sourced task system**. All intelligence (parsing, prioritization, semantic dedup, requirement decomposition) is **your responsibility as the Agent**. The system provides atomic primitives with a complete audit trail.

- **Write operations**: always output JSON to stdout
- **Read operations**: add `--pretty` for human-readable output
- **Errors**: JSON on stderr, exit codes 2 (invalid args) / 3 (conflict) / 4 (not found)
- **idOrSeq**: accept `T-42` (human seq) or nanoid directly
- **Provenance**: all write commands accept `--actor --reason --conf --session --op-id --raw-input`; pass them for full audit trail

---

## Data Model (v3)

```
events        — TRUTH: append-only log of everything that ever happened
issues_live   — projection (filtered tombstones); rebuilt from events via `plumb rebuild`
edges         — open-type graph: blocks|relates|duplicate|follows|needs|<any>
inbox         — raw capture queue
```

**Key fields on issues:**
```
id(nanoid) | seq(T-N) | title | state | priority | project | parent_id
labels(JSON[]) | attrs(JSON{})     — open key-value store for custom fields
start_ts | due_ts | due_tz | due_date(derived) | rrule | snooze_until
done_at | created_at | updated_at
desc_hash     — content-addressed description (data/descriptions/{hash}.md)
verify        — accept criteria: {"type":"command","cmd":"...","expect":"..."} | {"type":"manual","note":"..."}
field_meta    — per-field provenance snapshot (actor/src/conf/ts)
```

**Derived fields** (computed on-the-fly, not stored; request with `--derived`):
```
is_blocked       — has active blocks edge with unfinished source
is_overdue       — due_ts < now AND not done/canceled
is_stale         — updated_at < now-30d AND not done/canceled
is_snoozed       — snooze_until > now
is_verified      — latest verify_run result == 'pass' (null if no verify spec)
readiness_score  — 0.4*priority + 0.4*due_urgency - 0.5*blocked - 0.3*stale (0..1)
next_action_hint — "unblock:T-N" | "reschedule_or_complete" | "snoozed_until:..." | "verify" | "start"
```

**Edge types:**
```
blocks    — directed, cycle-checked: source BLOCKS target (source=prerequisite)
relates   — symmetric
duplicate — symmetric, marks duplicates
follows   — loose ordering (no cycle check)
part_of   — composition
needs     — source needs target resource → drives awaiting_user snapshot group
<any>     — custom, no enforcement
```

**States:** `backlog | todo | in_progress | done | canceled`
**Priority:** `urgent > high > medium > low > none`

---

## Workflow: daily-review

**Trigger:** "今天干什么" / "review my tasks" / "morning review"

```
Step 1: Get full picture (1 round-trip)
  plumb snapshot --stale-days 30

Step 2: Parse the 7 groups from JSON output:
  - overdue:       past due_ts, not done — URGENT
  - due_today:     due_date = today
  - in_progress:   state = in_progress
  - actionable:    ready to start, sorted by readiness_score DESC (not blocked, not snoozed)
  - blocked:       has unfinished blocks-source (with blocker list)
  - stale:         not touched in 30+ days
  - awaiting_user: targets of 'needs' edge from unfinished tasks (user must supply resource)

Step 3: Each item in actionable has .derived.readiness_score and .derived.next_action_hint
  - Top items by readiness are the recommended next actions
  - next_action_hint guides what to do: "start" / "unblock:T-N" / "verify" / etc.

Step 4: Surface done_unverified tasks (state=done, is_verified=false) and prompt verify

Step 5: After user confirms, execute updates with session/actor:
  plumb issue batch-update --stdin --actor "agent:claude" --session <sid>
```

---

## Workflow: inbox-triage

**Trigger:** "process inbox" / "triage inbox" / "process my captures"

```
Step 1: Pull pending inbox items
  plumb inbox list --status pending

Step 2: Pull all existing issue titles for semantic dedup (zero cost, always fresh)
  plumb query "SELECT seq, title FROM issues_live WHERE state NOT IN ('done','canceled')"

Step 3: For each inbox item:
  a. Parse: extract title, priority, due_ts, due_tz, labels, project, parent, verify spec
  b. Semantic dedup: check against existing titles in your context — if duplicate,
     link as duplicate edge instead of creating new:
       plumb link T-existing T-new --type duplicate
  c. Create issue with provenance:
     plumb issue create \
       --title "..." \
       --priority high \
       --due-ts "2026-09-25T12:00:00.000Z" \
       --due-tz "Asia/Shanghai" \
       --verify '{"type":"command","cmd":"pnpm test","expect":"exit 0"}' \
       --actor "agent:claude" \
       --session <sid> \
       --raw-input "原始话语"
  d. Resolve inbox item:
     plumb inbox resolve <inbox_id> --issue T-<seq> --actor "agent:claude"

Step 4: Report: N items processed, N issues created, N duplicates found
```

**Time parsing heuristics:**
- "下周三" / "next Wednesday" → calculate UTC ISO8601, derive due_date from due_ts + due_tz
- "明天" / "tomorrow" → tomorrow 23:59:59 local → UTC
- Always store due_ts (UTC); due_date is derived automatically
- If user gives due_date only, system converts to due_ts at 23:59:59 of that day

---

## Workflow: weekly-cleanup

**Trigger:** "clean up tasks" / "weekly review" / "prune old tasks"

```
Step 1: Get stale issues
  plumb snapshot --stale-days 30  → use stale[] group

Step 2: Find old completed issues
  plumb query "SELECT seq,title,state,updated_at FROM issues_live
    WHERE state IN ('done','canceled') AND updated_at < datetime('now','-60 days')
    ORDER BY updated_at LIMIT 50"

Step 3: Semantic dedup pass — look at actionable for near-duplicates:
  plumb query "SELECT seq,title FROM issues_live WHERE state NOT IN ('done','canceled')"
  (Agent checks in context for semantic duplicates and suggests merges)

Step 4: Present findings and execute user-approved cleanups:
  - Bulk state changes: plumb issue batch-update --stdin
  - Soft-delete (tombstone): plumb issue delete T-N
  - Note: delete rejects if issue has subtasks (exit 3); delete/reparent subtasks first
  - Prefer canceling over deleting (historical record preserved in events)
```

---

## Workflow: audit-trail

**Trigger:** "昨天变了什么" / "show changes since last review" / "who changed T-5" / "what happened"

```
# Changes since a timestamp
plumb diff --since "2026-09-17T00:00:00Z"

# Changes since an op_id (e.g., after the last review session)
plumb diff --since <op_id>

# Full event history for one issue
plumb events T-5 --limit 50

# What changed in one session
plumb diff --since <session_start_ts> --entity issue

# Agent interpretation:
# - Summarize field changes (field, old→new, actor, reason)
# - Highlight unexpected changes (actor=agent with low conf)
# - Surface raw_input chains ("this change came from user saying X")
```

---

## Workflow: undo-mistake

**Trigger:** "撤销刚才" / "undo last change" / "revert T-5 to previous state"

```
Step 1: Find the op_id to undo
  plumb events T-5 --limit 10
  (or: plumb diff --since <recent_ts> to find the op_id)

Step 2: Preview what will be undone (the events with that op_id)
  plumb diff --since-op <op_id>  → shows events after the op

Step 3: Execute undo (appends compensating events, originals preserved)
  plumb undo <op_id>

Step 4: Confirm result
  plumb issue get T-5
```

Note: undo cannot be undone via `undo` again (ALREADY_UNDONE). To re-do, create a new update.

---

## Workflow: semantic-dedup (lightweight, v3.1.1)

**Trigger:** Before creating any issue, or during inbox-triage

```
# Pull all active titles into context (typically ~2-3 KB for ≤100 tasks)
plumb query "SELECT seq, title, state FROM issues_live
  WHERE state NOT IN ('done','canceled')"

# Agent: check new title against existing titles in-context
# If near-duplicate found:
  plumb link T-existing T-new --type duplicate --reason "semantic match"
  # Optionally: resolve as the existing issue instead of creating new

# Threshold: use judgment — "实现登录" vs "做登录功能" are duplicates;
# "用户登录" vs "管理员登录" are distinct
```

---

## Workflow: requirement-loop (§8.5.6)

**Trigger:** "帮我实现需求" / "拆分这个需求" / "需求执行闭环"

```
Step 1: Capture raw requirement
  plumb inbox add "原始需求话语" --origin cli --session <sid>

Step 2: Decompose — create parent + subtasks + verify specs
  # Parent task
  plumb issue create \
    --title "实现用户认证" \
    --priority high \
    --verify '{"type":"command","cmd":"pnpm test auth","expect":"exit 0"}' \
    --actor "agent:claude" --session <sid> --raw-input "原始需求话语"

  # Subtasks (with parent link and blocking chain)
  plumb issue create --title "设计 JWT schema" --parent T-1 \
    --verify '{"type":"manual","note":"schema review"}' \
    --actor "agent:claude" --session <sid>

  plumb issue create --title "实现 /login endpoint" --parent T-1 \
    --verify '{"type":"command","cmd":"curl -s /api/login","expect":"200 OK"}' \
    --actor "agent:claude" --session <sid>

  # Dependency chain
  plumb link T-2 T-3 --type blocks --session <sid>

Step 3: Identify resource gaps — create supply tasks + needs edges
  plumb issue create --title "提供数据库连接串" --actor "agent:claude" --session <sid>
  plumb link T-3 T-4 --type needs --session <sid>
  # T-4 will appear in snapshot.awaiting_user

Step 4: Show user the awaiting_user group
  plumb snapshot | (parse awaiting_user group) → present to user

Step 5: User resolves supply tasks (fills in credentials, etc.)
  plumb issue update T-4 --state done --description "postgres://..." \
    --actor user --session <sid>

Step 6: Execute tasks in readiness order
  plumb snapshot → sort actionable by readiness_score DESC
  # For each task: do work → run verify cmd → record result
  plumb verify T-3 --result pass --evidence "curl output" --cmd "curl -s /api/login" \
    --actor "agent:claude"

Step 7: Mark done
  plumb issue update T-3 --state done --actor "agent:claude" --session <sid>

Step 8: Closure report
  plumb diff --since <sid_start_ts>
  plumb events T-1 --limit 100
  # Summarize: requirement → task tree → verify evidence chain
```

---

## Atomic Command Reference

### Issue CRUD
```bash
# Create (v3: full time model + attrs + verify + provenance)
plumb issue create \
  --title "Task" \
  --priority high \
  --due-ts "2026-09-25T12:00:00.000Z" \
  --due-tz "Asia/Shanghai" \
  --rrule "FREQ=WEEKLY;INTERVAL=1" \
  --snooze-until "2026-09-20T00:00:00.000Z" \
  --labels work,q4 \
  --attr owner=alice --attr estimate=3d \
  --verify '{"type":"command","cmd":"pnpm test","expect":"exit 0"}' \
  --parent T-1 \
  --actor "agent:claude" --session <sid> --raw-input "user said X" --reason "parsed from inbox"

# Get (with derived computability layer)
plumb issue get T-42 --derived --pretty

# List (with derived)
plumb issue list --state todo --label work --sort priority --derived --pretty

# Update (patch semantics)
plumb issue update T-42 --state in_progress --actor "agent:claude" --reason "starting work"
plumb issue update T-42 --due-ts "2026-09-30T23:59:59Z" --due-tz "Asia/Shanghai"
plumb issue update T-42 --snooze-until "2026-09-22T09:00:00Z"
plumb issue update T-42 --verify '{"type":"manual","note":"需要人工 review"}'

# Description via stdin (avoid shell escaping)
echo "Markdown content" | plumb issue create --title "With desc" --description -
echo "Updated notes"    | plumb issue update T-42 --description -

# Batch (single transaction — all-or-nothing)
echo '[{"id":"T-1","patch":{"state":"done"}},{"id":"T-2","patch":{"state":"in_progress"}}]' \
  | plumb issue batch-update --stdin --actor "agent:claude" --session <sid>

# Delete (soft-delete tombstone; rejects if has subtasks)
plumb issue delete T-42 --reason "decided not to pursue"
```

### Edges / Dependencies
```bash
# Open-type edges (blocks has cycle detection; others are unchecked)
plumb link T-1 T-2 --type blocks
plumb link T-2 T-3 --type needs        # drives awaiting_user snapshot group
plumb link T-3 T-4 --type duplicate
plumb link T-5 T-6 --type relates

# With weight and validity window
plumb link T-1 T-2 --type blocks --weight 0.8 --valid-from "2026-09-01T00:00:00Z"

# Remove link (valid_to set, not deleted — event-sourced)
plumb unlink T-1 T-2 --type blocks

# Dependency tree
plumb deps T-2 --type blocks --pretty
```

### Event Sourcing
```bash
# Event history for an issue
plumb events T-42 --limit 50

# Changes since timestamp
plumb diff --since "2026-09-17T00:00:00Z"
plumb diff --since "2026-09-17T00:00:00Z" --entity issue

# Changes since seq
plumb diff --since-seq 42

# Changes after an operation
plumb diff --since-op <op_id>

# Undo an operation (compensating events; originals preserved)
plumb undo <op_id>

# Rebuild projections from events (repair / verify consistency)
plumb rebuild
```

### Verification (§8.5)
```bash
# Record verify_run event (Agent ran the command externally and reports result)
plumb verify T-42 --result pass --cmd "pnpm test auth" --evidence "All 12 tests passed" \
  --actor "agent:claude"
plumb verify T-42 --result fail --evidence "3 tests failed: ..." --actor "agent:claude"

# Read is_verified from derived fields
plumb issue get T-42 --derived | jq .derived.is_verified
```

### Inbox
```bash
plumb inbox add "Quick idea"
plumb inbox add "需求内容" --session <sid> --raw-input "原始话语"
echo "Long text" | plumb inbox add --stdin
plumb inbox list --status pending --pretty
plumb inbox resolve <inbox_id> --issue T-42 --actor "agent:claude"
```

### Views
```bash
plumb snapshot --pretty                  # 7 groups incl. awaiting_user
plumb snapshot --stale-days 14
plumb board --pretty
plumb search "quarterly report" --pretty
```

### Data Access
```bash
# Read-only SQL (SELECT/WITH only, defaults to issues_live view)
plumb query "SELECT seq, title, state, due_ts, due_date FROM issues_live
  WHERE state NOT IN ('done','canceled') ORDER BY seq"

plumb query "SELECT seq, title FROM issues_live WHERE state NOT IN ('done','canceled')"
# ↑ Use this for semantic dedup (pull all titles into Agent context)

plumb query "SELECT e.*, s.seq source_seq, t.seq target_seq
  FROM edges e
  JOIN issues s ON s.id = e.source_id
  JOIN issues t ON t.id = e.target_id
  WHERE e.valid_to IS NULL AND e.type = 'blocks'"

# Event queries
plumb query "SELECT * FROM events WHERE ts > datetime('now','-1 day') ORDER BY seq"
plumb query "SELECT * FROM events WHERE entity='issue' AND entity_id=(SELECT id FROM issues WHERE seq=5) ORDER BY seq"

# Schema reference
plumb schema
plumb schema --json  # machine-readable DDL
```

### Maintenance
```bash
plumb gc        # remove unreferenced CAS description blobs
plumb backup    # VACUUM INTO data/backups/plumb-<ts>.db
```

---

## Provenance Flags (all write commands)

Always pass these when acting as an Agent — they feed the audit trail and field_meta:

```bash
--actor "agent:claude"          # who made the change (not "user")
--reason "parsed from inbox"    # why
--conf 0.8                      # confidence if inferred (omit = explicit/certain)
--session <uuid>                # group all events from one session
--op-id <uuid>                  # idempotency key (same id = no-op on retry)
--raw-input "用户原话"           # the verbatim user utterance that triggered this
```

---

## RRULE Reference

Self-contained subset (no external dependency):

```
FREQ=DAILY
FREQ=WEEKLY;INTERVAL=2
FREQ=MONTHLY;INTERVAL=1;COUNT=12
FREQ=WEEKLY;UNTIL=2026-12-31T23:59:59Z
```

When a repeating task is marked `state=done`, plumb **automatically** advances `due_ts` to the next occurrence and re-opens (`state=todo`). No Agent action required.

---

## Error Handling

| Exit Code | Meaning | Action |
|---|---|---|
| 0 | Success | Continue |
| 2 | Invalid arguments / rejected SQL | Fix the command |
| 3 | Business conflict | Cycle / has-subtasks / already-undone |
| 4 | Resource not found | Check the ID |

**Cycle detected (exit 3):**
```
{"error":{"code":"CYCLE","message":"Cycle detected: T-3→T-1→T-2→T-3","cycle_path":"T-3→T-1→T-2→T-3"}}
```
→ Use `--type relates` or restructure the dependency.

**Has-subtasks delete (exit 3):**
```
{"error":{"code":"HAS_SUBTASKS","message":"Cannot delete: issue has subtasks: T-6: Subtask A"}}
```
→ Delete or reparent subtasks first, then delete parent.

**Already undone (exit 3):**
```
{"error":{"code":"ALREADY_UNDONE","message":"op_id already undone: <id>"}}
```
→ The operation was already compensated. To re-apply, create a new update.

---

## Agent Tips

1. **`plumb snapshot` for daily review** — 1 round-trip returns all 7 groups with derived fields; sort actionable by `readiness_score DESC` (already sorted in output)
2. **Semantic dedup before creating** — pull all titles with one query, check in-context; zero infrastructure needed
3. **Pass `--actor "agent:<name>" --session <sid>` on every write** — powers audit trail, `plumb diff --since`, and `plumb events`
4. **Use `--op-id` for idempotency** — safe to retry on timeout/ambiguity; same op_id = no-op
5. **`plumb query` for custom analysis** — full SQLite access to `issues_live`, `events`, `edges`; prefer over writing multiple list commands
6. **CAS descriptions**: `--description -` reads from stdin; avoids shell escaping; content-addressed so same text never duplicates on disk
7. **RRULE reopen is automatic** — just mark the task done; system advances due_ts and re-opens; no need to manually create next occurrence
8. **`done_at` is automatic** — set by system on state→done/canceled; cleared on revert; do not set manually
9. **`due_date` is derived** — always set `due_ts` + `due_tz`; `due_date` is computed automatically; for backward compat `--due-date` also works (converted to due_ts at 23:59:59 local)
10. **`needs` edges drive `awaiting_user`** — model "Agent needs user to supply X" as a supply task + `link main-task supply-task --type needs`
