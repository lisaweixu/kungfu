import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('./data/kungfu.db');
const raw = process.argv[2]?.trim();
const pattern = raw ? `%${raw}%` : '%';

const classes = db
  .prepare('SELECT id, name FROM class_types WHERE name LIKE ?')
  .all(pattern);

console.log('class:', classes);

for (const c of classes) {
  const n = db
    .prepare('SELECT COUNT(*) AS n FROM ledger WHERE class_id = ?')
    .get(c.id).n;
  console.log('ledger rows for class_id', c.id, ':', n);
}

db.close();