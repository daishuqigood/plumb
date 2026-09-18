import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, existsSync, cpSync } from "node:fs";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Data directory resolution (§3.1) ────────────────────────────────────────
//
// Priority:
//   1. PLUMB_DIR env var (test/scratch; e.g. `PLUMB_DIR=$(mktemp -d) pnpm dev ...`)
//   2. XDG_DATA_HOME/plumb  (or ~/.local/share/plumb if XDG unset)
//
// On first run: if target DB doesn't exist but legacy data/ does, migrate it.

function resolveDataDir(): string {
  // Priority 1: explicit env override
  if (process.env.PLUMB_DIR) {
    return resolve(process.env.PLUMB_DIR, "data");
  }

  // Priority 2: XDG global dir
  const xdgBase = process.env.XDG_DATA_HOME ?? resolve(homedir(), ".local", "share");
  return resolve(xdgBase, "plumb", "data");
}

/** Subdirectory for CAS descriptions, backups, files */
function ensureDataDirs(dataDir: string): void {
  for (const sub of ["", "descriptions", "files", "backups"]) {
    const d = sub ? resolve(dataDir, sub) : dataDir;
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
  }
}

/**
 * One-time migration: if XDG target has no DB but package root has data/tasks.db,
 * copy the entire data/ directory. Runs at most once per process start.
 */
function maybeMigrateFromLegacy(targetDataDir: string): void {
  const targetDb = resolve(targetDataDir, "tasks.db");
  if (existsSync(targetDb)) return; // already migrated or fresh install

  // Look for legacy data dir relative to this file's package root
  const legacyDataDir = resolve(__dirname, "..", "data");
  const legacyDb = resolve(legacyDataDir, "tasks.db");
  if (!existsSync(legacyDb)) return; // no legacy data to migrate

  // Skip if PLUMB_DIR is explicitly pointing at the legacy dir (dev mode)
  if (process.env.PLUMB_DIR) return;

  try {
    ensureDataDirs(targetDataDir);
    cpSync(legacyDataDir, targetDataDir, { recursive: true });
    process.stderr.write(
      `[plumb] Migrated data from ${legacyDataDir} → ${targetDataDir}\n` +
      `[plumb] Future runs will use ${targetDataDir}. The legacy data/ directory is no longer read.\n`
    );
  } catch (e) {
    process.stderr.write(`[plumb] Warning: failed to migrate legacy data: ${(e as Error).message}\n`);
  }
}

const DATA_DIR = resolveDataDir();
const DB_PATH  = resolve(DATA_DIR, "tasks.db");

// Run migration before first DB open
maybeMigrateFromLegacy(DATA_DIR);
ensureDataDirs(DATA_DIR);

let _writeDb: Database.Database | null = null;
let _readDb:  Database.Database | null = null;

/** Singleton write connection with WAL mode and busy_timeout */
export function getWriteDb(): Database.Database {
  if (_writeDb) return _writeDb;
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  _writeDb = db;
  return db;
}

/** Singleton read-only connection (PRAGMA query_only) */
export function getReadDb(): Database.Database {
  if (_readDb) return _readDb;
  const db = new Database(DB_PATH, { readonly: true });
  db.pragma("query_only = ON");
  _readDb = db;
  return db;
}

/** Run schema migrations (idempotent) */
function migrate(db: Database.Database): void {
  const schemaSql = readFileSync(resolve(__dirname, "schema.sql"), "utf8");
  db.exec(schemaSql);
  ensureColumns(db);
}

/**
 * Guarded column migration for pre-v3 databases.
 * ALTER TABLE ADD COLUMN for any missing columns (all nullable or with defaults).
 */
function ensureColumns(db: Database.Database): void {
  const ensure = (table: string, columns: Array<[string, string]>) => {
    const existing = new Set(
      (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(r => r.name)
    );
    for (const [name, ddl] of columns) {
      if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
    }
  };

  ensure("issues", [
    ["attrs",          "TEXT NOT NULL DEFAULT '{}'"],
    ["field_meta",     "TEXT NOT NULL DEFAULT '{}'"],
    ["start_ts",       "TEXT"],
    ["due_ts",         "TEXT"],
    ["due_tz",         "TEXT"],
    ["rrule",          "TEXT"],
    ["snooze_until",   "TEXT"],
    ["desc_hash",      "TEXT"],
    ["verify",         "TEXT"],
    ["deleted",        "INTEGER NOT NULL DEFAULT 0"],
    ["last_event_seq", "INTEGER NOT NULL DEFAULT 0"],
  ]);

  ensure("inbox", [
    ["origin",     "TEXT"],
    ["session_id", "TEXT"],
  ]);
}

/** Exported paths for use in lib/issues.ts and lib/backup.ts */
export { DATA_DIR, DB_PATH };
