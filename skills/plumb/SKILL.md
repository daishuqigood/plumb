---
name: plumb
description: Personal local task management via the plumb CLI. Covers daily-review, inbox-triage, and weekly-cleanup workflows. Use when managing tasks, planning the day, triaging inbox items, or running dependency queries with the plumb command.
compatibility: opencode
---

# plumb — Agent Skill: Task Management Workflows

> **For AI Agents using the `plumb` CLI**
> Load this file before orchestrating plumb commands for complex workflows.

## Overview

`plumb` is a deterministic task management CLI. All intelligence (parsing, reasoning, recommendations) is **your responsibility as the Agent**. The system provides atomic primitives; you compose them.

**Core contract:**
- Write operations: always output JSON to stdout
- Read operations: add `--pretty` for human-readable output
- Errors: JSON on stderr, exit codes 2 (invalid args) / 3 (business conflict) / 4 (not found)
- `idOrSeq`: accept `T-42` (seq) or nanoid directly

---

## Workflow: daily-review (FR-530)

**Trigger:** User says "今天干什么" / "review my tasks" / "morning review"

```
Step 1: Get full picture (1 round-trip)
  plumb snapshot --stale-days 30

Step 2: Parse the 6 groups from JSON output:
  - overdue:     past due, not done — these are URGENT
  - due_today:   due today — need attention today
  - in_progress: currently being worked on
  - actionable:  ready to start (no unfinished blockers), sorted by priority+due
  - blocked:     waiting on prerequisites (with blocker list)
  - stale:       not touched in 30+ days

Step 3: Reason and generate suggestions:
  - Surface overdue issues first (ask user to update due dates or mark done)
  - Recommend top 3 from actionable (already sorted by priority+due)
  - Note any blocked issues and their blockers
  - Flag stale items as candidates for cleanup

Step 4: Present natural-language summary to user

Step 5: After user confirms, execute updates:
  plumb issue batch-update --stdin
  (send JSON array: [{"id": "T-1", "patch": {"state": "in_progress"}}, ...])
```

**Example snapshot output shape:**
```json
{
  "overdue": [...],
  "due_today": [...],
  "in_progress": [...],
  "actionable": [...],
  "blocked": [{"id": "...", "blockers": [...], ...}],
  "stale": [...]
}
```

---

## Workflow: inbox-triage (FR-532)

**Trigger:** User asks to process inbox / "process my captures" / "triage inbox"

```
Step 1: Get all pending inbox items
  plumb inbox list --status pending

Step 2: For each item in the JSON array:
  a. Parse the raw text — extract: title, priority, due_date, labels, project
  b. Ask user to confirm if ambiguous (or proceed silently if clear)
  c. Create the issue:
     plumb issue create --title "..." --priority high --due-date 2026-09-20 --labels work
  d. Link inbox item to the created issue:
     plumb inbox resolve <inbox_id> --issue T-<seq>

Step 3: Report summary: N items processed, N issues created
```

**Parsing heuristics to apply:**
- "高优/urgent/urgent/ASAP" → priority: urgent
- "下周三/next Wednesday" → calculate absolute date (YYYY-MM-DD)
- "#work #personal" or "标签:work" → labels array
- "项目:Q4" → project field
- Imperative verb phrases → title (keep concise, ≤80 chars)

---

## Workflow: weekly-cleanup (FR-531)

**Trigger:** User asks "clean up tasks" / "weekly review" / "prune old tasks"

```
Step 1: Find stale issues (not touched in 30+ days)
  plumb snapshot --stale-days 30
  (use the stale[] group)

Step 2: Find old completed/canceled duplicates
  plumb query "SELECT i.seq, i.title, i.state, i.updated_at FROM issues i WHERE i.state IN ('done','canceled') AND i.updated_at < date('now', '-60 days') ORDER BY i.updated_at LIMIT 50"

Step 3: Present findings to user:
  - Stale backlog items: suggest deleting or marking canceled
  - Old completed items: can be left (they're historical record) unless user wants cleanup
  - Duplicate issues: suggest deleting the duplicate, keeping canonical

Step 4: Execute user-approved cleanups:
  - For bulk state changes: plumb issue batch-update --stdin
  - For deletions: plumb issue delete T-N (note: must delete subtasks first)
```

**Safety rules:**
- Never auto-delete without explicit user confirmation
- Check for subtasks before attempting delete (system will reject with exit 3)
- Prefer canceling over deleting for historical record

---

## Atomic Command Reference

### Issue management
```bash
# Create
plumb issue create --title "Task title" --priority high --due-date 2026-09-20 --labels work,q4

# Read
plumb issue get T-42 --pretty
plumb issue list --state todo --label work --sort priority --pretty

# Update (patch semantics — only provided fields change)
plumb issue update T-42 --state in_progress
plumb issue update T-42 --due-date 2026-09-25 --priority urgent

# Description via stdin (avoids shell escaping issues)
echo "Detailed markdown content" | plumb issue create --title "With desc" --description -
echo "Updated notes" | plumb issue update T-42 --description -

# Batch (single transaction — all-or-nothing)
echo '[{"id":"T-1","patch":{"state":"done"}},{"id":"T-2","patch":{"state":"in_progress"}}]' | plumb issue batch-update --stdin

# Delete (rejects if has subtasks)
plumb issue delete T-42
```

### Dependencies
```bash
# A blocks B (A is prerequisite of B)
plumb link T-1 T-2 --type blocks

# Symmetric relationships
plumb link T-3 T-4 --type relates
plumb link T-5 T-6 --type duplicate

# Remove link
plumb unlink T-1 T-2 --type blocks

# View dependency tree
plumb deps T-2 --pretty
```

### Capture & triage
```bash
# Quick capture
echo "Quick idea to process later" | plumb inbox add

# Or with positional arg
plumb inbox add "Remember to do X"

# List pending
plumb inbox list --status pending --pretty

# Mark resolved (with link to created issue)
plumb inbox resolve <inbox_id> --issue T-42
```

### Views
```bash
# Today's structured summary
plumb snapshot --pretty
plumb snapshot --stale-days 14

# Text kanban board
plumb board --pretty
plumb board --project myproject --pretty

# Full-text search
plumb search "quarterly report" --pretty
```

### Data access
```bash
# Read-only SQL escape hatch (SELECT/WITH only, max 1000 rows)
plumb query "SELECT seq, title, state, due_date FROM issues WHERE state = 'todo' ORDER BY due_date LIMIT 20"
plumb query "SELECT * FROM issues WHERE json_array_length(labels) > 0"

# Schema reference (read before writing complex queries)
plumb schema
```

---

## Error Handling

| Exit Code | Meaning | Action |
|-----------|---------|--------|
| 0 | Success | Continue |
| 2 | Invalid arguments / rejected SQL | Fix the command |
| 3 | Business conflict | Cycle detected, has subtasks, etc. |
| 4 | Resource not found | Check the ID exists |

**Cycle detection example (exit 3):**
```bash
plumb link C A --type blocks
# stderr: {"error": {"code": "CYCLE", "message": "Cycle detected: T-3→T-1→T-2→T-3", "cycle_path": "T-3→T-1→T-2→T-3"}}
```
→ Explain to user why the link would create a cycle, suggest using `relates` instead.

**Has-subtasks deletion (exit 3):**
```bash
plumb issue delete T-5
# stderr: {"error": {"code": "HAS_SUBTASKS", "message": "Cannot delete: issue has subtasks: T-6: Subtask A"}}
```
→ First delete or reparent subtasks, then delete the parent.

---

## Data Model Quick Reference

```
issues: id(nanoid) | seq(T-N) | title | state | priority | project | parent_id | labels(JSON[]) | start_date | due_date | done_at | created_at | updated_at

issue_links: source_id → target_id, type(blocks|relates|duplicate)
  blocks: source BLOCKS target (source=prerequisite, target=blocked)
  relates/duplicate: symmetric

inbox: id | raw | status(pending|resolved) | resolved_issue_id | created_at

Priority order: urgent > high > medium > low > none
States: backlog | todo | in_progress | done | canceled
```

---

## Tips for Agents

1. **Use `plumb snapshot` for any daily review** — 1 round-trip returns everything needed
2. **Use `plumb schema` before writing custom queries** — get the full DDL and field semantics
3. **Prefer `batch-update` over multiple `update` calls** — single transaction, atomic
4. **Labels are JSON arrays** — use `json_each` in queries, not LIKE '%label%'
5. **`done_at` is automatic** — set by system when state→done/canceled; no need to set manually
6. **Date format**: `start_date/due_date` = local `YYYY-MM-DD`; timestamps = UTC ISO8601
7. **The `data/` directory is the backup** — `data/tasks.db` + `data/descriptions/*.md` is the full state
