/**
 * lib/backup.ts — SQLite online backup using VACUUM INTO
 * Triggered by `plumb backup` command; can be scheduled via launchd/cron
 */

import { getWriteDb, DATA_DIR } from "./db.js";
import { resolve } from "node:path";
import { existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";

const BACKUP_DIR = resolve(DATA_DIR, "backups");
const RETAIN_DAYS = 14;

export function runBackup(): { path: string } {
  if (!existsSync(BACKUP_DIR)) mkdirSync(BACKUP_DIR, { recursive: true });

  const db = getWriteDb();
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, ""); // YYYYMMDD
  const backupPath = resolve(BACKUP_DIR, `tasks-${dateStr}.db`);

  // VACUUM INTO creates a consistent copy even in WAL mode
  db.prepare(`VACUUM INTO ?`).run(backupPath);

  // Prune old backups (keep newest 14)
  pruneOldBackups();

  return { path: backupPath };
}

function pruneOldBackups(): void {
  let files: string[];
  try {
    files = readdirSync(BACKUP_DIR)
      .filter(f => /^tasks-\d{8}\.db$/.test(f))
      .sort()
      .reverse(); // newest first
  } catch {
    return;
  }

  // Remove files beyond RETAIN_DAYS
  for (const file of files.slice(RETAIN_DAYS)) {
    try {
      unlinkSync(resolve(BACKUP_DIR, file));
    } catch { /* ignore */ }
  }
}
