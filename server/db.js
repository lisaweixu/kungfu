import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const dataDir = path.join(root, 'data');

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'kungfu.db');
const db = new DatabaseSync(dbPath, { enableForeignKeyConstraints: true });

db.exec('PRAGMA journal_mode = WAL;');

db.exec(`
  CREATE TABLE IF NOT EXISTS members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    age INTEGER,
    phone TEXT,
    email TEXT,
    notes TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS class_types (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    sort_order INTEGER NOT NULL UNIQUE
  );

  CREATE TABLE IF NOT EXISTS ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id INTEGER NOT NULL,
    delta INTEGER NOT NULL,
    kind TEXT NOT NULL,
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    class_id INTEGER NOT NULL DEFAULT 1,
    FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_ledger_member ON ledger(member_id);
`);

const ledgerColumns = db.prepare('PRAGMA table_info(ledger)').all();
if (!ledgerColumns.some((c) => c.name === 'class_id')) {
  db.exec('ALTER TABLE ledger ADD COLUMN class_id INTEGER NOT NULL DEFAULT 1');
}

const memberColumns = db.prepare('PRAGMA table_info(members)').all();
if (!memberColumns.some((c) => c.name === 'age')) {
  db.exec('ALTER TABLE members ADD COLUMN age INTEGER');
}
if (!memberColumns.some((c) => c.name === 'email')) {
  db.exec('ALTER TABLE members ADD COLUMN email TEXT');
}

db.exec('CREATE INDEX IF NOT EXISTS idx_ledger_class ON ledger(class_id)');

const CLASS_SEED = [
  [1, '长拳 Long Fist', 1],
  [2, '南拳 Southern Fist', 2],
  [3, '太极 Tai Chi', 3],
  [4, '咏春 Wing Chun', 4],
  [5, '擒拿 Chin Na', 5],
  [6, '器械 Weapons', 6],
  [7, '对练 Partner drills', 7],
  [8, '体能 Conditioning', 8],
  [9, '少儿 Kids', 9],
  [10, '推手 Push hands', 10],
];

const insertClass = db.prepare(
  'INSERT OR IGNORE INTO class_types (id, name, sort_order) VALUES (?, ?, ?)'
);
const existingClassTypeCount = db.prepare('SELECT COUNT(*) AS n FROM class_types').get().n;
if (existingClassTypeCount === 0) {
  for (const row of CLASS_SEED) {
    insertClass.run(row[0], row[1], row[2]);
  }
}

function listClassTypes() {
  return db.prepare('SELECT id, name, sort_order FROM class_types ORDER BY sort_order').all();
}

/** Appends a new class type; `sort_order` is max existing + 1. */
function addClassType(name) {
  const maxRow = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM class_types').get();
  const sortOrder = (maxRow?.m ?? 0) + 1;
  const info = db
    .prepare('INSERT INTO class_types (name, sort_order) VALUES (?, ?)')
    .run(name, sortOrder);
  return Number(info.lastInsertRowid);
}

/**
 * Removes a class type only if unused in ledger and not the last remaining type.
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
function deleteClassTypeById(rawId) {
  const id = Number(rawId);
  if (!Number.isInteger(id) || id < 1) {
    return { ok: false, error: 'Invalid id' };
  }
  const existing = db.prepare('SELECT id FROM class_types WHERE id = ?').get(id);
  if (!existing) {
    return { ok: false, error: 'Not found' };
  }
  const total = db.prepare('SELECT COUNT(*) AS n FROM class_types').get().n;
  if (total <= 1) {
    return { ok: false, error: 'Cannot remove the last class type' };
  }
  const used = db.prepare('SELECT COUNT(*) AS n FROM ledger WHERE class_id = ?').get(id).n;
  if (used > 0) {
    return {
      ok: false,
      error:
        'This class has credits or attendance history. Remove is blocked to keep records consistent.',
    };
  }
  db.prepare('DELETE FROM class_types WHERE id = ?').run(id);
  return { ok: true };
}

function balanceForMemberId(memberId) {
  const row = db
    .prepare('SELECT COALESCE(SUM(delta), 0) AS b FROM ledger WHERE member_id = ?')
    .get(memberId);
  return row?.b ?? 0;
}

function balanceForMemberClass(memberId, classId) {
  const row = db
    .prepare(
      'SELECT COALESCE(SUM(delta), 0) AS b FROM ledger WHERE member_id = ? AND class_id = ?'
    )
    .get(memberId, classId);
  return row?.b ?? 0;
}

function balancesForMember(memberId) {
  const types = listClassTypes();
  const stmt = db.prepare(
    'SELECT COALESCE(SUM(delta), 0) AS b FROM ledger WHERE member_id = ? AND class_id = ?'
  );
  return types.map((t) => ({
    classId: t.id,
    name: t.name,
    balance: stmt.get(memberId, t.id).b,
  }));
}

/** All members with per-class balance and attendance (visit) totals for the summary page. */
function getClubSummary() {
  const types = listClassTypes();
  const members = db
    .prepare(
      `SELECT id, name, age, phone, email, active FROM members ORDER BY active DESC, name COLLATE NOCASE`
    )
    .all();

  const balanceRows = db
    .prepare(
      `SELECT member_id, class_id, COALESCE(SUM(delta), 0) AS balance
       FROM ledger
       GROUP BY member_id, class_id`
    )
    .all();

  const visitRows = db
    .prepare(
      `SELECT member_id, class_id, COALESCE(SUM(ABS(delta)), 0) AS visits
       FROM ledger
       WHERE kind = 'attendance'
       GROUP BY member_id, class_id`
    )
    .all();

  const key = (memberId, classId) => `${memberId}\0${classId}`;
  const balMap = new Map();
  for (const r of balanceRows) {
    balMap.set(key(r.member_id, r.class_id), r.balance);
  }
  const visMap = new Map();
  for (const r of visitRows) {
    visMap.set(key(r.member_id, r.class_id), r.visits);
  }

  const memberPayload = members.map((m) => {
    const byClass = types.map((t) => {
      const k = key(m.id, t.id);
      return {
        classId: t.id,
        name: t.name,
        balance: balMap.get(k) ?? 0,
        visits: visMap.get(k) ?? 0,
      };
    });
    const balanceTotal = byClass.reduce((s, x) => s + x.balance, 0);
    return {
      id: m.id,
      name: m.name,
      age: m.age,
      phone: m.phone,
      email: m.email,
      active: Boolean(m.active),
      balanceTotal,
      byClass,
    };
  });

  return {
    classTypes: types.map((t) => ({
      id: t.id,
      name: t.name,
      sortOrder: t.sort_order,
    })),
    members: memberPayload,
  };
}

export {
  db,
  balanceForMemberId,
  balanceForMemberClass,
  balancesForMember,
  listClassTypes,
  addClassType,
  deleteClassTypeById,
  getClubSummary,
};
