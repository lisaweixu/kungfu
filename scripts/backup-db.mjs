/**
 * Safe SQLite backup using Node's online backup API (consistent snapshot with WAL).
 *
 * Usage:
 *   npm run backup-db -- <path\to\file.db>
 *   npm run backup-db -- <folder>              → writes kungfu-backup-<timestamp>.db inside
 *
 * Or set KUNGFU_BACKUP_DIR to a folder (another drive, OneDrive, NAS path, etc.):
 *   set KUNGFU_BACKUP_DIR=D:\Backups\KungFu
 *   npm run backup-db
 *
 * Safe while the dev server is running; uses a read-only connection to the live DB.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { backup, DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const dbPath = path.join(root, 'data', 'kungfu.db');

function localTimestampForFilename() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function printUsage() {
  console.error(`KungFu database backup

  npm run backup-db -- <destination.db>
  npm run backup-db -- <destination-folder>

  Or set environment variable KUNGFU_BACKUP_DIR to a folder, then:
  npm run backup-db

Examples (PowerShell):
  npm run backup-db -- "D:\\Backups\\kungfu.db"
  npm run backup-db -- "D:\\Backups\\KungFu"
  $env:KUNGFU_BACKUP_DIR = "D:\\Backups\\KungFu"; npm run backup-db
`);
}

function resolveOutPath() {
  const arg = process.argv[2]?.trim();
  const envDir = process.env.KUNGFU_BACKUP_DIR?.trim();

  if (arg) {
    const resolved = path.resolve(process.cwd(), arg);
    if (fs.existsSync(resolved)) {
      const st = fs.statSync(resolved);
      if (st.isDirectory()) {
        return path.join(resolved, `kungfu-backup-${localTimestampForFilename()}.db`);
      }
    }
    return resolved;
  }

  if (envDir) {
    const dir = path.resolve(envDir);
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, `kungfu-backup-${localTimestampForFilename()}.db`);
  }

  return null;
}

async function main() {
  const outPath = resolveOutPath();
  if (!outPath) {
    printUsage();
    process.exit(1);
  }

  if (!fs.existsSync(dbPath)) {
    console.error(`Source database not found:\n  ${dbPath}`);
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const src = new DatabaseSync(dbPath, { readOnly: true });
  try {
    await backup(src, outPath);
  } finally {
    src.close();
  }

  const bytes = fs.statSync(outPath).size;
  console.log(`Backup OK (${bytes} bytes)\n  ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
