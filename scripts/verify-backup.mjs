/**
 * Verify a KungFu SQLite backup file is readable and internally consistent.
 *
 * Usage:
 *   npm run verify-backup -- "D:\Backups\KungFu\kungfu-backup-2026-04-22T031500.db"
 *   npm run verify-backup -- "D:\Backups\KungFu"     # verifies the newest *.db in that folder
 *
 * Exits 0 on success, non-zero on any problem.
 */
import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';

function die(msg, code = 1) {
  console.error(`FAIL: ${msg}`);
  process.exit(code);
}

function pickFile(arg) {
  if (!arg) {
    console.error(
      'Usage: npm run verify-backup -- <file.db|folder>\n' +
        '       (folder picks the newest *.db inside it)'
    );
    process.exit(2);
  }
  const resolved = path.resolve(process.cwd(), arg);
  if (!fs.existsSync(resolved)) die(`Not found: ${resolved}`);
  const st = fs.statSync(resolved);
  if (st.isFile()) return resolved;
  if (st.isDirectory()) {
    const candidates = fs
      .readdirSync(resolved)
      .filter((n) => n.toLowerCase().endsWith('.db'))
      .map((n) => {
        const p = path.join(resolved, n);
        return { p, mtime: fs.statSync(p).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    if (!candidates.length) die(`No .db files in folder: ${resolved}`);
    return candidates[0].p;
  }
  die(`Not a file or folder: ${resolved}`);
}

const file = pickFile(process.argv[2]);
const size = fs.statSync(file).size;

console.log(`Verifying: ${file}`);
console.log(`  size: ${size.toLocaleString()} bytes`);

if (size === 0) die('File is 0 bytes.');

let db;
try {
  db = new DatabaseSync(file, { readOnly: true });
} catch (e) {
  die(`Cannot open as SQLite: ${e.message}`);
}

try {
  const header = db.prepare('PRAGMA schema_version').get();
  if (!header || typeof header.schema_version !== 'number') {
    die('Could not read schema_version (file is not a valid SQLite DB?).');
  }
  console.log(`  schema_version: ${header.schema_version}`);

  const integrity = db.prepare('PRAGMA integrity_check').all();
  const joined = integrity.map((r) => r.integrity_check).join('; ');
  if (joined.trim() !== 'ok') die(`integrity_check failed: ${joined}`);
  console.log('  integrity_check: ok');

  const fk = db.prepare('PRAGMA foreign_key_check').all();
  if (fk.length) die(`foreign_key_check failed: ${JSON.stringify(fk)}`);
  console.log('  foreign_key_check: ok');

  const required = ['members', 'ledger', 'class_types'];
  const existing = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((r) => r.name);
  const missing = required.filter((t) => !existing.includes(t));
  if (missing.length) die(`Missing tables: ${missing.join(', ')}`);
  console.log(`  tables: ${existing.join(', ')}`);

  const counts = {};
  for (const t of required) {
    counts[t] = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
  }
  console.log(
    `  rows: members=${counts.members}, ledger=${counts.ledger}, class_types=${counts.class_types}`
  );

  const sumRow = db.prepare('SELECT COALESCE(SUM(delta),0) AS total FROM ledger').get();
  console.log(`  ledger SUM(delta): ${sumRow.total}`);

  const mismatch = db
    .prepare(
      `SELECT l.id, l.member_id, l.class_id FROM ledger l
       LEFT JOIN members m ON m.id = l.member_id
       LEFT JOIN class_types c ON c.id = l.class_id
       WHERE m.id IS NULL OR c.id IS NULL
       LIMIT 5`
    )
    .all();
  if (mismatch.length) {
    die(
      `Orphan ledger rows (no matching member/class): ${JSON.stringify(mismatch)}`
    );
  }
  console.log('  referential check: ok');
} finally {
  db.close();
}

console.log('OK: backup looks healthy.');
