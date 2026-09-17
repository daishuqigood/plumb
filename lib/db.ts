import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Data directory: resolved relative to this file's location (plumb/lib/ -> plumb/data/)
// If PLUMB_DIR env var is set (e.g. by the bin wrapper), use that as the package root
const PKG_DIR = process.env.PLUMB_DIR ?? resolve(__dirname, "..");
const DATA_DIR = resolve(PKG_DIR, "data");
const DB_PATH = resolve(DATA_DIR, "tasks.db");

// Ensure data directories exist
function ensureDataDirs() {
  for (const dir of [DATA_DIR, resolve(DATA_DIR, "descriptions"), resolve(DATA_DIR, "files"), resolve(DATA_DIR, "backups")]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

let _writeDb: Database.Database | null = null;
let _readDb: Database.Database | null = null;

/** Singleton write connection with WAL mode and busy_timeout */
export function getWriteDb(): Database.Database {
  if (_writeDb) return _writeDb;
  ensureDataDirs();
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
  ensureDataDirs();
  const db = new Database(DB_PATH, { readonly: true });
  db.pragma("query_only = ON");
  _readDb = db;
  return db;
}

/** Run schema migrations on the write connection */
function migrate(db: Database.Database): void {
  const schemaSql = readFileSync(resolve(__dirname, "schema.sql"), "utf8");
  db.exec(schemaSql);
}

/** Exported data directory path for use in lib/issues.ts and lib/backup.ts */
export { DATA_DIR, DB_PATH };
