PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS issues (
  id         TEXT PRIMARY KEY,
  seq        INTEGER UNIQUE NOT NULL,
  title      TEXT NOT NULL,
  state      TEXT NOT NULL DEFAULT 'todo'
             CHECK (state IN ('backlog','todo','in_progress','done','canceled')),
  priority   TEXT NOT NULL DEFAULT 'none'
             CHECK (priority IN ('urgent','high','medium','low','none')),
  project    TEXT,
  parent_id  TEXT REFERENCES issues(id) ON DELETE SET NULL,
  labels     TEXT NOT NULL DEFAULT '[]',
  start_date TEXT,
  due_date   TEXT,
  done_at    TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS issue_links (
  source_id  TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  target_id  TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  type       TEXT NOT NULL DEFAULT 'relates'
             CHECK (type IN ('blocks','relates','duplicate')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (source_id, target_id, type)
);

CREATE TABLE IF NOT EXISTS inbox (
  id                 TEXT PRIMARY KEY,
  raw                TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','resolved')),
  resolved_issue_id  TEXT REFERENCES issues(id) ON DELETE SET NULL,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS seq (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  n  INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO seq (id, n) VALUES (1, 0);

CREATE INDEX IF NOT EXISTS idx_issues_state   ON issues(state);
CREATE INDEX IF NOT EXISTS idx_issues_due     ON issues(due_date);
CREATE INDEX IF NOT EXISTS idx_issues_project ON issues(project);
CREATE INDEX IF NOT EXISTS idx_issues_parent  ON issues(parent_id);
CREATE INDEX IF NOT EXISTS idx_links_target   ON issue_links(type, target_id);
CREATE INDEX IF NOT EXISTS idx_inbox_status   ON inbox(status);
