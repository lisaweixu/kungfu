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

const dbPath = process.env.KUNGFU_DB_PATH || path.join(dataDir, 'kungfu.db');
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

  CREATE TABLE IF NOT EXISTS credit_batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id INTEGER NOT NULL,
    class_id INTEGER NOT NULL,
    quantity INTEGER NOT NULL,
    used INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    note TEXT,
    source_ledger_id INTEGER,
    FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE,
    FOREIGN KEY (class_id) REFERENCES class_types(id),
    FOREIGN KEY (source_ledger_id) REFERENCES ledger(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_batches_member_class ON credit_batches(member_id, class_id);
  CREATE INDEX IF NOT EXISTS idx_batches_expires ON credit_batches(expires_at);

  CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    owner_name TEXT,
    owner_email TEXT,
    smtp_host TEXT,
    smtp_port INTEGER,
    smtp_user TEXT,
    smtp_pass TEXT,
    smtp_secure INTEGER NOT NULL DEFAULT 1,
    default_validity_months INTEGER NOT NULL DEFAULT 12,
    reminders_enabled INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  INSERT OR IGNORE INTO settings (id) VALUES (1);

  CREATE TABLE IF NOT EXISTS class_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    class_id INTEGER,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    recipient_count INTEGER NOT NULL,
    recipient_emails TEXT NOT NULL,
    sent_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (class_id) REFERENCES class_types(id)
  );

  CREATE TABLE IF NOT EXISTS reminders_sent (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id INTEGER NOT NULL,
    class_id INTEGER NOT NULL,
    trigger_kind TEXT NOT NULL,
    trigger_key TEXT NOT NULL,
    sent_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (member_id, class_id, trigger_kind, trigger_key),
    FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE,
    FOREIGN KEY (class_id) REFERENCES class_types(id) ON DELETE CASCADE
  );
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

/** Older DBs had class_messages.class_id NOT NULL; club-wide emails need NULL. */
function migrateClassMessagesNullableClassId() {
  const cols = db.prepare('PRAGMA table_info(class_messages)').all();
  if (!cols.length) return;
  const cid = cols.find((c) => c.name === 'class_id');
  if (!cid || cid.notnull === 0) return;
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec(`
    CREATE TABLE class_messages_mig (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      class_id INTEGER,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      recipient_count INTEGER NOT NULL,
      recipient_emails TEXT NOT NULL,
      sent_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (class_id) REFERENCES class_types(id)
    );
    INSERT INTO class_messages_mig (id, class_id, subject, body, recipient_count, recipient_emails, sent_at)
      SELECT id, class_id, subject, body, recipient_count, recipient_emails, sent_at FROM class_messages;
    DROP TABLE class_messages;
    ALTER TABLE class_messages_mig RENAME TO class_messages;
  `);
  db.exec('PRAGMA foreign_keys = ON');
}

migrateClassMessagesNullableClassId();

/** Local YYYY-MM-DD (matches SQLite's date('now', 'localtime')). */
function localDateIso(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

migrateLedgerToBatchesIfNeeded();

/**
 * One-time migration: convert existing ledger purchase/attendance rows into credit_batches.
 * Runs only when ledger has rows but credit_batches is empty.
 * Existing purchases become batches that expire 2 days from now (so reminders can be tested).
 * Existing attendances are FIFO-consumed against those batches.
 */
function migrateLedgerToBatchesIfNeeded() {
  const ledgerCount = db.prepare('SELECT COUNT(*) AS n FROM ledger').get().n;
  const batchCount = db.prepare('SELECT COUNT(*) AS n FROM credit_batches').get().n;
  if (batchCount > 0 || ledgerCount === 0) return;

  const expiresAt = (() => {
    const d = new Date();
    d.setDate(d.getDate() + 2);
    return localDateIso(d);
  })();

  const insertBatch = db.prepare(
    `INSERT INTO credit_batches
       (member_id, class_id, quantity, used, expires_at, created_at, note, source_ledger_id)
     VALUES (?, ?, ?, 0, ?, ?, ?, ?)`
  );
  const updateUsed = db.prepare(
    'UPDATE credit_batches SET used = ? WHERE id = ?'
  );
  const pickFifo = db.prepare(
    `SELECT id, quantity, used FROM credit_batches
     WHERE member_id = ? AND class_id = ? AND quantity > used
     ORDER BY (expires_at IS NULL), expires_at ASC, created_at ASC, id ASC`
  );

  const ledgerRows = db
    .prepare('SELECT id, member_id, class_id, delta, kind, note, created_at FROM ledger ORDER BY id ASC')
    .all();

  const tx = db.prepare('BEGIN');
  const commit = db.prepare('COMMIT');
  const rollback = db.prepare('ROLLBACK');
  tx.run();
  try {
    for (const row of ledgerRows) {
      if (row.delta > 0) {
        insertBatch.run(
          row.member_id,
          row.class_id,
          row.delta,
          expiresAt,
          row.created_at,
          row.note,
          row.id
        );
      } else if (row.delta < 0) {
        let need = -row.delta;
        const candidates = pickFifo.all(row.member_id, row.class_id);
        for (const b of candidates) {
          if (need <= 0) break;
          const free = b.quantity - b.used;
          const take = Math.min(free, need);
          updateUsed.run(b.used + take, b.id);
          need -= take;
        }
      }
    }
    commit.run();
  } catch (err) {
    rollback.run();
    throw err;
  }
}

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

/**
 * Sums remaining (quantity - used) across all non-expired batches.
 * A batch is non-expired if expires_at IS NULL or expires_at >= today.
 */
function balanceForMemberId(memberId) {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(quantity - used), 0) AS b FROM credit_batches
       WHERE member_id = ?
         AND (expires_at IS NULL OR expires_at >= date('now', 'localtime'))`
    )
    .get(memberId);
  return row?.b ?? 0;
}

function balanceForMemberClass(memberId, classId) {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(quantity - used), 0) AS b FROM credit_batches
       WHERE member_id = ? AND class_id = ?
         AND (expires_at IS NULL OR expires_at >= date('now', 'localtime'))`
    )
    .get(memberId, classId);
  return row?.b ?? 0;
}

function balancesForMember(memberId) {
  const types = listClassTypes();
  const stmt = db.prepare(
    `SELECT COALESCE(SUM(quantity - used), 0) AS b FROM credit_batches
     WHERE member_id = ? AND class_id = ?
       AND (expires_at IS NULL OR expires_at >= date('now', 'localtime'))`
  );
  return types.map((t) => ({
    classId: t.id,
    name: t.name,
    balance: stmt.get(memberId, t.id).b,
  }));
}

/** Returns all non-expired batches with credits left for a member, ordered by FIFO. */
function activeBatchesForMember(memberId) {
  return db
    .prepare(
      `SELECT id, member_id, class_id, quantity, used, expires_at, created_at, note
       FROM credit_batches
       WHERE member_id = ?
         AND quantity > used
         AND (expires_at IS NULL OR expires_at >= date('now', 'localtime'))
       ORDER BY (expires_at IS NULL), expires_at ASC, created_at ASC, id ASC`
    )
    .all(memberId);
}

/**
 * Records a purchase: inserts ledger row + a new credit_batch.
 * @param {number} memberId
 * @param {number} classId
 * @param {number} quantity Positive integer.
 * @param {string|null} expiresAt ISO date 'YYYY-MM-DD', or null for no expiry.
 * @param {string|null} note
 */
function recordPurchase(memberId, classId, quantity, expiresAt, note) {
  const tx = db.prepare('BEGIN');
  const commit = db.prepare('COMMIT');
  const rollback = db.prepare('ROLLBACK');
  tx.run();
  try {
    const ledgerInfo = db
      .prepare('INSERT INTO ledger (member_id, delta, kind, note, class_id) VALUES (?, ?, ?, ?, ?)')
      .run(memberId, quantity, 'purchase', note || null, classId);
    const ledgerId = Number(ledgerInfo.lastInsertRowid);
    db.prepare(
      `INSERT INTO credit_batches
         (member_id, class_id, quantity, used, expires_at, note, source_ledger_id)
       VALUES (?, ?, ?, 0, ?, ?, ?)`
    ).run(memberId, classId, quantity, expiresAt || null, note || null, ledgerId);
    db.prepare(
      `DELETE FROM reminders_sent
       WHERE member_id = ? AND class_id = ? AND trigger_kind = 'low_balance'`
    ).run(memberId, classId);
    commit.run();
    return { ledgerId };
  } catch (err) {
    rollback.run();
    throw err;
  }
}

/**
 * Records attendance: FIFO-consumes from non-expired batches, inserts a single ledger row.
 * @returns {{ ok: true } | { ok: false, error: string, balance: number }}
 */
function recordAttendance(memberId, classId, count, note) {
  const balance = balanceForMemberClass(memberId, classId);
  if (balance < count) {
    return { ok: false, error: 'Not enough credits for this class', balance };
  }
  const tx = db.prepare('BEGIN');
  const commit = db.prepare('COMMIT');
  const rollback = db.prepare('ROLLBACK');
  tx.run();
  try {
    const batches = db
      .prepare(
        `SELECT id, quantity, used FROM credit_batches
         WHERE member_id = ? AND class_id = ?
           AND quantity > used
           AND (expires_at IS NULL OR expires_at >= date('now', 'localtime'))
         ORDER BY (expires_at IS NULL), expires_at ASC, created_at ASC, id ASC`
      )
      .all(memberId, classId);
    let need = count;
    const update = db.prepare('UPDATE credit_batches SET used = ? WHERE id = ?');
    for (const b of batches) {
      if (need <= 0) break;
      const free = b.quantity - b.used;
      const take = Math.min(free, need);
      update.run(b.used + take, b.id);
      need -= take;
    }
    if (need > 0) throw new Error('Insufficient batches (race condition)');
    db.prepare(
      'INSERT INTO ledger (member_id, delta, kind, note, class_id) VALUES (?, ?, ?, ?, ?)'
    ).run(memberId, -count, 'attendance', note || null, classId);
    commit.run();
    return { ok: true };
  } catch (err) {
    rollback.run();
    throw err;
  }
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
      `SELECT member_id, class_id, COALESCE(SUM(quantity - used), 0) AS balance
       FROM credit_batches
       WHERE expires_at IS NULL OR expires_at >= date('now', 'localtime')
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

/**
 * Returns the list of members who currently have a non-zero, non-expired balance
 * in the given class AND a non-empty email AND are active.
 * Used as the recipient list for "Email this class" (cancellation messages).
 */
/**
 * Returns members whose remaining credits in some class are at one of the configured
 * low-balance thresholds (2, 1, 0) and who have NOT yet been reminded for that
 * (class, threshold) since their last purchase.
 *
 * Only returns rows for members who:
 *   - are active, have an email, AND have ever held a credit batch in that class
 *     (so brand-new members aren't spammed with "0 credits in Wing Chun")
 *
 * @returns {Array<{
 *   memberId: number, memberName: string, memberEmail: string,
 *   classId: number, className: string, balance: number
 * }>}
 */
function findLowBalanceTriggers() {
  return db
    .prepare(
      `SELECT
         m.id   AS memberId,
         m.name AS memberName,
         m.email AS memberEmail,
         c.id   AS classId,
         c.name AS className,
         COALESCE(SUM(CASE
           WHEN b.expires_at IS NULL OR b.expires_at >= date('now', 'localtime')
           THEN b.quantity - b.used
           ELSE 0
         END), 0) AS balance
       FROM members m
       CROSS JOIN class_types c
       LEFT JOIN credit_batches b ON b.member_id = m.id AND b.class_id = c.id
       WHERE m.active = 1
         AND m.email IS NOT NULL
         AND TRIM(m.email) <> ''
         AND EXISTS (
           SELECT 1 FROM credit_batches bb
           WHERE bb.member_id = m.id AND bb.class_id = c.id
         )
       GROUP BY m.id, c.id
       HAVING balance IN (0, 1, 2)
          AND NOT EXISTS (
            SELECT 1 FROM reminders_sent rs
            WHERE rs.member_id = m.id
              AND rs.class_id = c.id
              AND rs.trigger_kind = 'low_balance'
              AND rs.trigger_key = CAST(balance AS TEXT)
          )
       ORDER BY m.name COLLATE NOCASE, c.name COLLATE NOCASE`
    )
    .all();
}

/**
 * Returns one row per credit batch that needs an expiry reminder right now.
 *
 * Logic:
 *   For each batch belonging to an active member with an email, that still has
 *   credits remaining and an expiry date with daysUntil between 0 and 14 inclusive,
 *   we consider two milestones: '14d' (window is 0..14 days) and '3d' (window is 0..3 days).
 *
 *   For each batch, we compute which milestones are CURRENTLY active and have NOT
 *   yet been recorded in reminders_sent. Those go in `thresholdsToMark`.
 *
 *   If multiple milestones are unsent (e.g. the server was offline and caught up at
 *   daysUntil=2, so both 14d and 3d are due), we still emit ONE row — the runner
 *   sends a single email and marks ALL applicable thresholds as sent. This caps each
 *   batch at at most 2 emails over its lifetime (one per milestone).
 *
 * @returns {Array<{
 *   memberId: number, memberName: string, memberEmail: string,
 *   classId: number, className: string,
 *   batchId: number, expiresAt: string, remaining: number, daysUntil: number,
 *   thresholdsToMark: number[]
 * }>}
 */
function findExpiryTriggers() {
  const raw = db
    .prepare(
      `SELECT
         m.id     AS memberId,
         m.name   AS memberName,
         m.email  AS memberEmail,
         c.id     AS classId,
         c.name   AS className,
         b.id     AS batchId,
         b.expires_at AS expiresAt,
         (b.quantity - b.used) AS remaining,
         CAST(julianday(b.expires_at) - julianday(date('now', 'localtime')) AS INTEGER)
           AS daysUntil
       FROM credit_batches b
       JOIN members m ON m.id = b.member_id
       JOIN class_types c ON c.id = b.class_id
       WHERE m.active = 1
         AND m.email IS NOT NULL
         AND TRIM(m.email) <> ''
         AND b.expires_at IS NOT NULL
         AND b.quantity > b.used
         AND CAST(julianday(b.expires_at) - julianday(date('now', 'localtime')) AS INTEGER) >= 0
         AND CAST(julianday(b.expires_at) - julianday(date('now', 'localtime')) AS INTEGER) <= 14
       ORDER BY m.name COLLATE NOCASE, c.name COLLATE NOCASE, b.expires_at ASC`
    )
    .all();

  const sentStmt = db.prepare(
    `SELECT 1 FROM reminders_sent
     WHERE member_id = ? AND class_id = ?
       AND trigger_kind = 'expiry' AND trigger_key = ?`
  );

  const triggers = [];
  for (const row of raw) {
    const candidates = [];
    if (row.daysUntil <= 14) candidates.push(14);
    if (row.daysUntil <= 3) candidates.push(3);
    const unsent = candidates.filter(
      (t) => !sentStmt.get(row.memberId, row.classId, `${row.batchId}:${t}d`)
    );
    if (unsent.length === 0) continue;
    triggers.push({ ...row, thresholdsToMark: unsent });
  }
  return triggers;
}

/** Records that a reminder of (kind, key) was sent to (member, class). Idempotent. */
function recordReminderSent(memberId, classId, kind, key) {
  db.prepare(
    `INSERT OR IGNORE INTO reminders_sent
       (member_id, class_id, trigger_kind, trigger_key)
     VALUES (?, ?, ?, ?)`
  ).run(memberId, classId, kind, String(key));
}

function getEmailRecipientsForClass(classId) {
  return db
    .prepare(
      `SELECT m.id, m.name, m.email,
              COALESCE(SUM(b.quantity - b.used), 0) AS balance
       FROM members m
       JOIN credit_batches b ON b.member_id = m.id
       WHERE m.active = 1
         AND m.email IS NOT NULL AND TRIM(m.email) <> ''
         AND b.class_id = ?
         AND b.quantity > b.used
         AND (b.expires_at IS NULL OR b.expires_at >= date('now', 'localtime'))
       GROUP BY m.id
       ORDER BY m.name COLLATE NOCASE`
    )
    .all(classId);
}

/** All active members of a class regardless of email — used to compute counts for warnings. */
function countActiveCreditMembersForClass(classId) {
  const row = db
    .prepare(
      `SELECT COUNT(DISTINCT m.id) AS n
       FROM members m
       JOIN credit_batches b ON b.member_id = m.id
       WHERE m.active = 1
         AND b.class_id = ?
         AND b.quantity > b.used
         AND (b.expires_at IS NULL OR b.expires_at >= date('now', 'localtime'))`
    )
    .get(classId);
  return row?.n ?? 0;
}

/** Distinct active members who have any remaining credits (any class). */
function countActiveCreditMembersWholeClub() {
  const row = db
    .prepare(
      `SELECT COUNT(DISTINCT m.id) AS n
       FROM members m
       JOIN credit_batches b ON b.member_id = m.id
       WHERE m.active = 1
         AND b.quantity > b.used
         AND (b.expires_at IS NULL OR b.expires_at >= date('now', 'localtime'))`
    )
    .get();
  return row?.n ?? 0;
}

/**
 * Active members who have at least one remaining credit anywhere and a non-empty email.
 * balance = sum of remaining credits across all non-expired batches.
 */
function getEmailRecipientsWholeClub() {
  return db
    .prepare(
      `SELECT m.id, m.name, m.email,
              COALESCE(SUM(CASE
                WHEN b.quantity > b.used
                  AND (b.expires_at IS NULL OR b.expires_at >= date('now', 'localtime'))
                THEN b.quantity - b.used
                ELSE 0
              END), 0) AS balance
       FROM members m
       JOIN credit_batches b ON b.member_id = m.id
       WHERE m.active = 1
         AND m.email IS NOT NULL
         AND TRIM(m.email) <> ''
       GROUP BY m.id
       HAVING balance > 0
       ORDER BY m.name COLLATE NOCASE`
    )
    .all();
}

function recordClassMessage({ classId, subject, body, recipientEmails }) {
  const info = db
    .prepare(
      `INSERT INTO class_messages (class_id, subject, body, recipient_count, recipient_emails)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(classId ?? null, subject, body, recipientEmails.length, JSON.stringify(recipientEmails));
  return Number(info.lastInsertRowid);
}

function listClassMessages(limit = 50) {
  const rows = db
    .prepare(
      `SELECT m.id, m.class_id,
              COALESCE(c.name, '(Whole club)') AS class_name,
              m.subject, m.body,
              m.recipient_count, m.recipient_emails, m.sent_at
       FROM class_messages m
       LEFT JOIN class_types c ON c.id = m.class_id
       ORDER BY m.id DESC
       LIMIT ?`
    )
    .all(limit);
  return rows.map((r) => ({
    id: r.id,
    classId: r.class_id,
    className: r.class_name || '—',
    subject: r.subject,
    body: r.body,
    recipientCount: r.recipient_count,
    recipientEmails: (() => {
      try {
        return JSON.parse(r.recipient_emails || '[]');
      } catch {
        return [];
      }
    })(),
    sentAt: r.sent_at,
  }));
}

function getSettings() {
  const row = db
    .prepare(
      `SELECT id, owner_name, owner_email, smtp_host, smtp_port, smtp_user, smtp_pass,
              smtp_secure, default_validity_months, reminders_enabled, updated_at
       FROM settings WHERE id = 1`
    )
    .get();
  if (!row) return null;
  return {
    ...row,
    smtp_secure: Boolean(row.smtp_secure),
    reminders_enabled: Boolean(row.reminders_enabled),
  };
}

/**
 * Updates settings (only provided fields). Returns the updated row.
 * @param {Partial<{
 *   owner_name: string|null, owner_email: string|null,
 *   smtp_host: string|null, smtp_port: number|null,
 *   smtp_user: string|null, smtp_pass: string|null,
 *   smtp_secure: boolean, default_validity_months: number,
 *   reminders_enabled: boolean
 * }>} patch
 */
function updateSettings(patch) {
  const allowed = [
    'owner_name',
    'owner_email',
    'smtp_host',
    'smtp_port',
    'smtp_user',
    'smtp_pass',
    'smtp_secure',
    'default_validity_months',
    'reminders_enabled',
  ];
  const sets = [];
  const values = [];
  for (const k of allowed) {
    if (k in patch) {
      let v = patch[k];
      if (k === 'smtp_secure' || k === 'reminders_enabled') v = v ? 1 : 0;
      sets.push(`${k} = ?`);
      values.push(v);
    }
  }
  if (!sets.length) return getSettings();
  sets.push("updated_at = datetime('now')");
  db.prepare(`UPDATE settings SET ${sets.join(', ')} WHERE id = 1`).run(...values);
  return getSettings();
}

export {
  db,
  balanceForMemberId,
  balanceForMemberClass,
  balancesForMember,
  activeBatchesForMember,
  listClassTypes,
  addClassType,
  deleteClassTypeById,
  getClubSummary,
  recordPurchase,
  recordAttendance,
  getSettings,
  updateSettings,
  getEmailRecipientsForClass,
  countActiveCreditMembersForClass,
  getEmailRecipientsWholeClub,
  countActiveCreditMembersWholeClub,
  recordClassMessage,
  listClassMessages,
  findLowBalanceTriggers,
  findExpiryTriggers,
  recordReminderSent,
};
