PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ══════════════════════════════════════════════════════════════
-- v3: 唯一真相 — append-only 事件日志
-- ══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS events (
  id          TEXT PRIMARY KEY,
  seq         INTEGER UNIQUE NOT NULL,
  ts          TEXT NOT NULL,
  entity      TEXT NOT NULL CHECK (entity IN ('issue','edge','inbox')),
  entity_id   TEXT NOT NULL,
  type        TEXT NOT NULL,
  field       TEXT,
  old         TEXT,
  new         TEXT,
  src         TEXT,
  actor       TEXT NOT NULL DEFAULT 'user',
  reason      TEXT,
  raw_input   TEXT,
  conf        REAL,
  session_id  TEXT,
  op_id       TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_entity ON events(entity, entity_id, seq);
CREATE INDEX IF NOT EXISTS idx_events_op     ON events(op_id);

CREATE TABLE IF NOT EXISTS event_seq (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  n  INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO event_seq (id, n) VALUES (1, 0);

-- ══════════════════════════════════════════════════════════════
-- 投影：issues 当前态（可由 events 重放重建）
-- 新库直接建全列；旧库由 db.ts 的 ensureColumns 守卫式补列
-- ══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS issues (
  id          TEXT PRIMARY KEY,
  seq         INTEGER UNIQUE NOT NULL,
  title       TEXT NOT NULL,
  state       TEXT NOT NULL DEFAULT 'todo'
              CHECK (state IN ('backlog','todo','in_progress','done','canceled')),
  priority    TEXT NOT NULL DEFAULT 'none'
              CHECK (priority IN ('urgent','high','medium','low','none')),
  project     TEXT,
  parent_id   TEXT REFERENCES issues(id) ON DELETE SET NULL,
  labels      TEXT NOT NULL DEFAULT '[]',
  attrs       TEXT NOT NULL DEFAULT '{}',
  field_meta  TEXT NOT NULL DEFAULT '{}',
  start_ts    TEXT,
  due_ts      TEXT,
  due_tz      TEXT,
  due_date    TEXT,
  rrule       TEXT,
  snooze_until TEXT,
  start_date  TEXT,
  done_at     TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  desc_hash   TEXT,
  verify      TEXT,                         -- 验收标准 JSON：{"type":"command","cmd":...,"expect":...} 或 {"type":"manual","note":...}
  deleted     INTEGER NOT NULL DEFAULT 0,
  last_event_seq INTEGER NOT NULL DEFAULT 0
);

CREATE VIEW IF NOT EXISTS issues_live AS
  SELECT * FROM issues WHERE deleted = 0;

-- ══════════════════════════════════════════════════════════════
-- 图优先边：开放类型 / 带权重 / 带时效（事件溯源）
-- ══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS edges (
  id          TEXT PRIMARY KEY,
  source_id   TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  target_id   TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,
  weight      REAL NOT NULL DEFAULT 1.0,
  valid_from  TEXT NOT NULL,
  valid_to    TEXT,
  created_at  TEXT NOT NULL,
  UNIQUE (source_id, target_id, type)
);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(type, target_id);
CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(type, source_id);

-- 兼容视图：v2.2 的 issue_links 语义（blocks/relates/duplicate）映射到 edges
CREATE VIEW IF NOT EXISTS issue_links AS
  SELECT source_id, target_id, type, created_at FROM edges
   WHERE type IN ('blocks','relates','duplicate') AND valid_to IS NULL;

-- ══════════════════════════════════════════════════════════════
-- inbox：原始捕获队列（带来源）
-- ══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS inbox (
  id                 TEXT PRIMARY KEY,
  raw                TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','resolved')),
  resolved_issue_id  TEXT REFERENCES issues(id) ON DELETE SET NULL,
  origin             TEXT,
  session_id         TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_inbox_status ON inbox(status);

-- ══════════════════════════════════════════════════════════════
-- seq：T-N 人类别名发号器
-- ══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS seq (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  n  INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO seq (id, n) VALUES (1, 0);

-- ══════════════════════════════════════════════════════════════
-- meta：schema 版本标记
-- ══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
INSERT OR IGNORE INTO meta (k, v) VALUES ('schema_version', '3');

CREATE INDEX IF NOT EXISTS idx_issues_state   ON issues(state);
CREATE INDEX IF NOT EXISTS idx_issues_due     ON issues(due_ts);
CREATE INDEX IF NOT EXISTS idx_issues_project ON issues(project);
CREATE INDEX IF NOT EXISTS idx_issues_parent  ON issues(parent_id);
