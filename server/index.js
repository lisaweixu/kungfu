import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import {
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
  recordClassMessage,
  listClassMessages,
} from './db.js';
import { log, requestLogger, errorLogger } from './logger.js';
import { sendMail, resetTransport } from './mailer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const isProd = process.env.NODE_ENV === 'production';
const PORT = Number(process.env.PORT) || 3000;

const app = express();
app.use(cors(isProd ? { origin: false } : { origin: true }));
app.use(express.json({ limit: '256kb' }));
app.use(requestLogger);

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

app.get('/api/class-types/:id/email-recipients', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid id' });
  const cls = db.prepare('SELECT id, name FROM class_types WHERE id = ?').get(id);
  if (!cls) return res.status(404).json({ error: 'Not found' });
  const recipients = getEmailRecipientsForClass(id);
  const totalActive = countActiveCreditMembersForClass(id);
  res.json({
    classId: cls.id,
    className: cls.name,
    recipients: recipients.map((r) => ({
      id: r.id,
      name: r.name,
      email: r.email,
      balance: r.balance,
    })),
    totalActiveMembers: totalActive,
    withoutEmail: totalActive - recipients.length,
  });
});

app.post('/api/class-types/:id/email', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid id' });
  const cls = db.prepare('SELECT id, name FROM class_types WHERE id = ?').get(id);
  if (!cls) return res.status(404).json({ error: 'Not found' });
  const subject = String(req.body?.subject ?? '').trim();
  const body = String(req.body?.body ?? '').trim();
  if (!subject) return res.status(400).json({ error: 'Subject is required' });
  if (subject.length > 200) return res.status(400).json({ error: 'Subject must be at most 200 characters' });
  if (!body) return res.status(400).json({ error: 'Body is required' });
  if (body.length > 10000) return res.status(400).json({ error: 'Body must be at most 10000 characters' });
  const settings = getSettings();
  if (!settings?.owner_email) {
    return res.status(400).json({ error: 'Owner email is not set in Settings.' });
  }
  const recipients = getEmailRecipientsForClass(id);
  if (!recipients.length) {
    return res.status(400).json({ error: 'No active members with credits and an email in this class.' });
  }
  const recipientEmails = recipients.map((r) => r.email);
  const result = await sendMail({
    bcc: recipientEmails,
    subject,
    text: body,
  });
  if (!result.ok) {
    return res.status(400).json({ error: result.error });
  }
  const messageId = recordClassMessage({
    classId: id,
    subject,
    body,
    recipientEmails,
  });
  log.info(
    `Class email sent: classId=${id} ("${cls.name}") subject="${subject}" recipients=${recipients.length} messageRowId=${messageId}`
  );
  res.status(201).json({
    ok: true,
    classMessageId: messageId,
    recipientCount: recipients.length,
    smtpMessageId: result.messageId,
  });
});

app.get('/api/class-messages', (_req, res) => {
  res.json(listClassMessages(50));
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
  const batchesRaw = activeBatchesForMember(id);
  const classNameById = Object.fromEntries(listClassTypes().map((c) => [c.id, c.name]));
  const batches = batchesRaw.map((b) => ({
    id: b.id,
    classId: b.class_id,
    className: classNameById[b.class_id] || '—',
    quantity: b.quantity,
    used: b.used,
    remaining: b.quantity - b.used,
    expiresAt: b.expires_at,
    note: b.note,
    createdAt: b.created_at,
  }));
  res.json({
    member: { ...member, active: Boolean(member.active) },
    balance,
    balancesByClass,
    batches,
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

function resolveExpiresAt(body, settings) {
  if (body?.noExpiry === true || body?.expiresAt === null) return null;
  if (typeof body?.expiresAt === 'string' && body.expiresAt.trim()) {
    const s = body.expiresAt.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return undefined;
    return s;
  }
  const months = Number(settings?.default_validity_months) || 12;
  const d = new Date();
  d.setMonth(d.getMonth() + months);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

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
    return res.status(400).json({ error: 'classes must be an integer 1-999' });
  }
  const settings = getSettings();
  const expiresAt = resolveExpiresAt(req.body, settings);
  if (expiresAt === undefined) {
    return res.status(400).json({ error: 'expiresAt must be ISO date YYYY-MM-DD or null' });
  }
  const note = req.body?.note != null ? String(req.body.note).trim() : null;
  recordPurchase(id, classId, n, expiresAt, note || null);
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
    return res.status(400).json({ error: 'count must be an integer 1-50' });
  }
  const note = req.body?.note != null ? String(req.body.note).trim() : null;
  const result = recordAttendance(id, classId, count, note || null);
  if (!result.ok) {
    return res.status(400).json({ error: result.error, balance: result.balance, classId });
  }
  res.status(201).json({
    balance: balanceForMemberId(id),
    balancesByClass: balancesForMember(id),
  });
});

app.get('/api/settings', (_req, res) => {
  const s = getSettings();
  if (!s) return res.json(null);
  const { smtp_pass, ...safe } = s;
  res.json({ ...safe, smtp_pass_set: Boolean(smtp_pass) });
});

app.patch('/api/settings', (req, res) => {
  const body = req.body || {};
  const patch = {};
  if ('owner_name' in body) patch.owner_name = body.owner_name == null ? null : String(body.owner_name).trim() || null;
  if ('owner_email' in body) {
    const v = body.owner_email == null ? null : String(body.owner_email).trim() || null;
    if (v && !/^\S+@\S+\.\S+$/.test(v)) return res.status(400).json({ error: 'owner_email is invalid' });
    patch.owner_email = v;
  }
  if ('smtp_host' in body) patch.smtp_host = body.smtp_host == null ? null : String(body.smtp_host).trim() || null;
  if ('smtp_port' in body) {
    const v = body.smtp_port == null || body.smtp_port === '' ? null : Number(body.smtp_port);
    if (v != null && (!Number.isInteger(v) || v < 1 || v > 65535)) {
      return res.status(400).json({ error: 'smtp_port must be 1-65535' });
    }
    patch.smtp_port = v;
  }
  if ('smtp_user' in body) patch.smtp_user = body.smtp_user == null ? null : String(body.smtp_user).trim() || null;
  if ('smtp_pass' in body) {
    patch.smtp_pass = body.smtp_pass == null || body.smtp_pass === '' ? null : String(body.smtp_pass);
  }
  if ('smtp_secure' in body) patch.smtp_secure = Boolean(body.smtp_secure);
  if ('default_validity_months' in body) {
    const v = Number(body.default_validity_months);
    if (!Number.isInteger(v) || v < 1 || v > 120) {
      return res.status(400).json({ error: 'default_validity_months must be 1-120' });
    }
    patch.default_validity_months = v;
  }
  if ('reminders_enabled' in body) patch.reminders_enabled = Boolean(body.reminders_enabled);
  const updated = updateSettings(patch);
  resetTransport();
  const { smtp_pass, ...safe } = updated;
  res.json({ ...safe, smtp_pass_set: Boolean(smtp_pass) });
});

app.post('/api/settings/test-email', async (req, res) => {
  const s = getSettings();
  if (!s?.owner_email) {
    return res.status(400).json({ error: 'Set owner_email in Settings first.' });
  }
  const to =
    typeof req.body?.to === 'string' && req.body.to.trim()
      ? String(req.body.to).trim()
      : s.owner_email;
  if (!/^\S+@\S+\.\S+$/.test(to)) {
    return res.status(400).json({ error: 'Invalid recipient email' });
  }
  const result = await sendMail({
    to,
    subject: 'KungFu test email',
    text:
      `Hi ${s.owner_name || 'there'},\n\n` +
      `This is a test email from your KungFu club app.\n` +
      `If you received this, your SMTP settings are working.\n\n` +
      `Sent at ${new Date().toISOString()}.`,
  });
  if (!result.ok) {
    return res.status(400).json({ error: result.error });
  }
  res.json({ ok: true, to, messageId: result.messageId });
});

if (isProd) {
  const dist = path.join(root, 'dist');
  app.use(express.static(dist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(dist, 'index.html'));
  });
}

app.use(errorLogger);

app.listen(PORT, '0.0.0.0', () => {
  log.info(
    isProd
      ? `KungFu listening on http://0.0.0.0:${PORT} (production)`
      : `KungFu API listening on http://127.0.0.1:${PORT}`
  );
  log.info(`Logging to ${log.file}`);
});
