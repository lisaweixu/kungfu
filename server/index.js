import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  db,
  balanceForMemberId,
  balanceForMemberClass,
  balancesForMember,
  listClassTypes,
  addClassType,
  deleteClassTypeById,
  getClubSummary,
} from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const isProd = process.env.NODE_ENV === 'production';
const PORT = Number(process.env.PORT) || 3000;

const app = express();
app.use(cors(isProd ? { origin: false } : { origin: true }));
app.use(express.json({ limit: '256kb' }));

function listMembers() {
  const members = db
    .prepare(
      `SELECT m.id, m.name, m.age, m.phone, m.email, m.notes, m.active, m.created_at,
              COALESCE(SUM(l.delta), 0) AS balance
       FROM members m
       LEFT JOIN ledger l ON l.member_id = m.id
       GROUP BY m.id
       ORDER BY m.active DESC, m.name COLLATE NOCASE`
    )
    .all();
  return members.map((m) => ({
    ...m,
    active: Boolean(m.active),
    balance: m.balance,
  }));
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/class-types', (_req, res) => {
  const rows = listClassTypes();
  res.json(rows.map((r) => ({ id: r.id, name: r.name, sortOrder: r.sort_order })));
});

app.post('/api/class-types', (req, res) => {
  const name = String(req.body?.name ?? '').trim();
  if (!name) return res.status(400).json({ error: 'Name is required' });
  if (name.length > 120) return res.status(400).json({ error: 'Name must be at most 120 characters' });
  const id = addClassType(name);
  const row = db.prepare('SELECT id, name, sort_order FROM class_types WHERE id = ?').get(id);
  res.status(201).json({ id: row.id, name: row.name, sortOrder: row.sort_order });
});

app.delete('/api/class-types/:id', (req, res) => {
  const result = deleteClassTypeById(req.params.id);
  if (!result.ok) {
    const status = result.error === 'Not found' ? 404 : 400;
    return res.status(status).json({ error: result.error });
  }
  res.status(204).end();
});

app.get('/api/summary', (_req, res) => {
  res.json(getClubSummary());
});

app.get('/api/members', (_req, res) => {
  res.json(listMembers());
});

app.get('/api/members/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
  const member = db.prepare('SELECT * FROM members WHERE id = ?').get(id);
  if (!member) return res.status(404).json({ error: 'Not found' });
  const ledger = db
    .prepare(
      `SELECT l.id, l.delta, l.kind, l.note, l.created_at, l.class_id,
              c.name AS class_name
       FROM ledger l
       JOIN class_types c ON c.id = l.class_id
       WHERE l.member_id = ?
       ORDER BY l.id DESC`
    )
    .all(id);
  const balance = balanceForMemberId(id);
  const balancesByClass = balancesForMember(id);
  res.json({
    member: { ...member, active: Boolean(member.active) },
    balance,
    balancesByClass,
    ledger,
  });
});

app.post('/api/members', (req, res) => {
  const name = String(req.body?.name ?? '').trim();
  if (!name) return res.status(400).json({ error: 'Name is required' });
  const ageRaw = req.body?.age;
  const age =
    ageRaw == null || ageRaw === '' ? null : Number.isInteger(Number(ageRaw)) ? Number(ageRaw) : NaN;
  if (age !== null && (!Number.isInteger(age) || age < 1 || age > 120)) {
    return res.status(400).json({ error: 'age must be an integer 1-120' });
  }
  const phone = req.body?.phone != null ? String(req.body.phone).trim() : null;
  const email = req.body?.email != null ? String(req.body.email).trim() : null;
  if (email && !/^\S+@\S+\.\S+$/.test(email)) {
    return res.status(400).json({ error: 'email is invalid' });
  }
  const notes = req.body?.notes != null ? String(req.body.notes).trim() : null;
  const info = db
    .prepare('INSERT INTO members (name, age, phone, email, notes) VALUES (?, ?, ?, ?, ?)')
    .run(name, age, phone || null, email || null, notes || null);
  res.status(201).json({ id: Number(info.lastInsertRowid) });
});

app.patch('/api/members/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
  const existing = db.prepare('SELECT * FROM members WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const name =
    req.body?.name !== undefined ? String(req.body.name).trim() : existing.name;
  const age =
    req.body?.age !== undefined
      ? req.body.age === null || req.body.age === ''
        ? null
        : Number.isInteger(Number(req.body.age))
          ? Number(req.body.age)
          : NaN
      : existing.age;
  if (age !== null && (!Number.isInteger(age) || age < 1 || age > 120)) {
    return res.status(400).json({ error: 'age must be an integer 1-120' });
  }
  const phone =
    req.body?.phone !== undefined
      ? req.body.phone === null || req.body.phone === ''
        ? null
        : String(req.body.phone).trim()
      : existing.phone;
  const email =
    req.body?.email !== undefined
      ? req.body.email === null || req.body.email === ''
        ? null
        : String(req.body.email).trim()
      : existing.email;
  if (email && !/^\S+@\S+\.\S+$/.test(email)) {
    return res.status(400).json({ error: 'email is invalid' });
  }
  const notes =
    req.body?.notes !== undefined
      ? req.body.notes === null || req.body.notes === ''
        ? null
        : String(req.body.notes).trim()
      : existing.notes;
  const active =
    req.body?.active !== undefined ? (req.body.active ? 1 : 0) : existing.active;
  if (!name) return res.status(400).json({ error: 'Name is required' });
  db.prepare('UPDATE members SET name = ?, age = ?, phone = ?, email = ?, notes = ?, active = ? WHERE id = ?').run(
    name,
    age,
    phone,
    email,
    notes,
    active,
    id
  );
  res.json({ ok: true });
});

app.post('/api/members/:id/purchase', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
  const member = db.prepare('SELECT id FROM members WHERE id = ?').get(id);
  if (!member) return res.status(404).json({ error: 'Not found' });
  const classId = Number(req.body?.classId);
  if (!Number.isInteger(classId) || classId < 1) {
    return res.status(400).json({ error: 'classId must be a positive integer' });
  }
  const type = db.prepare('SELECT id FROM class_types WHERE id = ?').get(classId);
  if (!type) return res.status(400).json({ error: 'Unknown class type' });
  const n = Number(req.body?.classes);
  if (!Number.isInteger(n) || n <= 0 || n > 999) {
    return res.status(400).json({ error: 'classes must be an integer 1–999' });
  }
  const note = req.body?.note != null ? String(req.body.note).trim() : null;
  db.prepare(
    'INSERT INTO ledger (member_id, delta, kind, note, class_id) VALUES (?, ?, ?, ?, ?)'
  ).run(id, n, 'purchase', note || null, classId);
  res.status(201).json({
    balance: balanceForMemberId(id),
    balancesByClass: balancesForMember(id),
  });
});

app.post('/api/members/:id/attend', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
  const member = db.prepare('SELECT id FROM members WHERE id = ?').get(id);
  if (!member) return res.status(404).json({ error: 'Not found' });
  const classId = Number(req.body?.classId);
  if (!Number.isInteger(classId) || classId < 1) {
    return res.status(400).json({ error: 'classId must be a positive integer' });
  }
  const type = db.prepare('SELECT id FROM class_types WHERE id = ?').get(classId);
  if (!type) return res.status(400).json({ error: 'Unknown class type' });
  const count = req.body?.count != null ? Number(req.body.count) : 1;
  if (!Number.isInteger(count) || count <= 0 || count > 50) {
    return res.status(400).json({ error: 'count must be an integer 1–50' });
  }
  const classBalance = balanceForMemberClass(id, classId);
  if (classBalance < count) {
    return res.status(400).json({
      error: 'Not enough credits for this class',
      balance: classBalance,
      classId,
    });
  }
  const note = req.body?.note != null ? String(req.body.note).trim() : null;
  db.prepare(
    'INSERT INTO ledger (member_id, delta, kind, note, class_id) VALUES (?, ?, ?, ?, ?)'
  ).run(id, -count, 'attendance', note || null, classId);
  res.status(201).json({
    balance: balanceForMemberId(id),
    balancesByClass: balancesForMember(id),
  });
});

if (isProd) {
  const dist = path.join(root, 'dist');
  app.use(express.static(dist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(dist, 'index.html'));
  });
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(
    isProd
      ? `KungFu listening on http://0.0.0.0:${PORT} (production)`
      : `KungFu API listening on http://127.0.0.1:${PORT}`
  );
});
