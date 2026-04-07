import { DatabaseSync } from 'node:sqlite';

const id = Number(process.argv[2]);
if (!Number.isInteger(id) || id < 1) {
  console.error('Usage: node ./scripts/purge-class.mjs <classId>');
  process.exit(1);
}

const db = new DatabaseSync('./data/kungfu.db');

try {
  const klass = db.prepare('SELECT id, name FROM class_types WHERE id = ?').get(id);
  if (!klass) {
    console.error(`Class id ${id} not found.`);
    process.exit(1);
  }

  const totalClasses = db.prepare('SELECT COUNT(*) AS n FROM class_types').get().n;
  if (totalClasses <= 1) {
    console.error('Cannot purge the last remaining class type.');
    process.exit(1);
  }

  const before = db
    .prepare('SELECT COUNT(*) AS n FROM ledger WHERE class_id = ?')
    .get(id).n;

  db.exec('BEGIN');
  db.prepare('DELETE FROM ledger WHERE class_id = ?').run(id);
  db.prepare('DELETE FROM class_types WHERE id = ?').run(id);
  db.exec('COMMIT');

  console.log(`Purged class id=${id} (${klass.name}).`);
  console.log(`Deleted ledger rows: ${before}`);
} catch (err) {
  try {
    db.exec('ROLLBACK');
  } catch {}
  console.error(err?.message || err);
  process.exit(1);
} finally {
  db.close();
}
