import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let dbMod;
let remindersMod;
let mailerMod;
let tmpDb;

const sentEmails = [];

beforeAll(async () => {
  tmpDb = path.join(
    os.tmpdir(),
    `kungfu-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
  );
  process.env.KUNGFU_DB_PATH = tmpDb;

  vi.doMock('../../server/mailer.js', () => ({
    sendMail: vi.fn(async (opts) => {
      sentEmails.push(opts);
      return { ok: true, messageId: `test-${sentEmails.length}` };
    }),
    resetTransport: vi.fn(),
  }));

  dbMod = await import('../../server/db.js');
  mailerMod = await import('../../server/mailer.js');
  remindersMod = await import('../../server/reminders.js');
});

afterAll(() => {
  try {
    if (dbMod?.db?.close) dbMod.db.close();
  } catch {
    /* noop */
  }
  for (const ext of ['', '-shm', '-wal']) {
    try {
      fs.unlinkSync(tmpDb + ext);
    } catch {
      /* noop */
    }
  }
});

beforeEach(() => {
  sentEmails.length = 0;
  const { db } = dbMod;
  db.exec('DELETE FROM reminders_sent');
  db.exec('DELETE FROM credit_batches');
  db.exec('DELETE FROM ledger');
  db.exec("DELETE FROM members WHERE id > 0");
  db.exec("DELETE FROM class_messages");

  dbMod.updateSettings({
    owner_name: 'Test Owner',
    owner_email: 'owner@test.com',
    smtp_host: 'smtp.test.com',
    smtp_port: 465,
    smtp_user: 'user',
    smtp_pass: 'pass',
    smtp_secure: true,
    reminders_enabled: true,
  });

  mailerMod.sendMail.mockClear();
});

function addMember({ name, email, active = 1 }) {
  const { db } = dbMod;
  const info = db
    .prepare('INSERT INTO members (name, email, active) VALUES (?, ?, ?)')
    .run(name, email, active ? 1 : 0);
  return Number(info.lastInsertRowid);
}

function addBatch({ memberId, classId = 1, quantity, used = 0, expiresAt = null }) {
  const { db } = dbMod;
  const info = db
    .prepare(
      `INSERT INTO credit_batches (member_id, class_id, quantity, used, expires_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(memberId, classId, quantity, used, expiresAt);
  return Number(info.lastInsertRowid);
}

function localDateIso(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

describe('findLowBalanceTriggers', () => {
  it('returns one row per (member,class) when balance is 0, 1, or 2', () => {
    const m = addMember({ name: 'Alice', email: 'alice@x.com' });
    addBatch({ memberId: m, quantity: 5, used: 3 });
    const rows = dbMod.findLowBalanceTriggers();
    expect(rows).toHaveLength(1);
    expect(rows[0].balance).toBe(2);
    expect(rows[0].memberEmail).toBe('alice@x.com');
  });

  it('does not return when balance is 3+', () => {
    const m = addMember({ name: 'Alice', email: 'alice@x.com' });
    addBatch({ memberId: m, quantity: 5, used: 0 });
    expect(dbMod.findLowBalanceTriggers()).toHaveLength(0);
  });

  it('skips members without email', () => {
    const m = addMember({ name: 'NoEmail', email: '' });
    addBatch({ memberId: m, quantity: 2 });
    expect(dbMod.findLowBalanceTriggers()).toHaveLength(0);
  });

  it('skips inactive members', () => {
    const m = addMember({ name: 'Inactive', email: 'i@x.com', active: 0 });
    addBatch({ memberId: m, quantity: 1 });
    expect(dbMod.findLowBalanceTriggers()).toHaveLength(0);
  });

  it('does not return rows for classes the member never had credits in', () => {
    const m = addMember({ name: 'OnlyLongFist', email: 'a@x.com' });
    addBatch({ memberId: m, classId: 1, quantity: 2 });
    const rows = dbMod.findLowBalanceTriggers();
    expect(rows).toHaveLength(1);
    expect(rows[0].classId).toBe(1);
  });

  it('treats expired batches as 0 balance (and triggers a 0 reminder)', () => {
    const m = addMember({ name: 'ExpiredOnly', email: 'e@x.com' });
    addBatch({ memberId: m, quantity: 5, expiresAt: localDateIso(-1) });
    const rows = dbMod.findLowBalanceTriggers();
    expect(rows).toHaveLength(1);
    expect(rows[0].balance).toBe(0);
  });

  it('dedupes via reminders_sent — same (member,class,threshold) only once', () => {
    const m = addMember({ name: 'Once', email: 'o@x.com' });
    addBatch({ memberId: m, quantity: 5, used: 3 });
    expect(dbMod.findLowBalanceTriggers()).toHaveLength(1);
    dbMod.recordReminderSent(m, 1, 'low_balance', 2);
    expect(dbMod.findLowBalanceTriggers()).toHaveLength(0);
  });
});

describe('findExpiryTriggers', () => {
  it('triggers at exactly 14 days with thresholdsToMark=[14]', () => {
    const m = addMember({ name: 'Soon', email: 's@x.com' });
    addBatch({ memberId: m, quantity: 5, expiresAt: localDateIso(14) });
    const rows = dbMod.findExpiryTriggers();
    expect(rows).toHaveLength(1);
    expect(rows[0].daysUntil).toBe(14);
    expect(rows[0].thresholdsToMark).toEqual([14]);
  });

  it('triggers between 4 and 13 days with thresholdsToMark=[14] (catch-up case)', () => {
    const m = addMember({ name: 'Catchup', email: 'c@x.com' });
    addBatch({ memberId: m, quantity: 5, expiresAt: localDateIso(7) });
    const rows = dbMod.findExpiryTriggers();
    expect(rows).toHaveLength(1);
    expect(rows[0].daysUntil).toBe(7);
    expect(rows[0].thresholdsToMark).toEqual([14]);
  });

  it('triggers at exactly 3 days with thresholdsToMark=[14, 3] when nothing sent yet', () => {
    const m = addMember({ name: 'Sooner', email: 's2@x.com' });
    addBatch({ memberId: m, quantity: 5, expiresAt: localDateIso(3) });
    const rows = dbMod.findExpiryTriggers();
    expect(rows).toHaveLength(1);
    expect(rows[0].daysUntil).toBe(3);
    expect(rows[0].thresholdsToMark).toEqual([14, 3]);
  });

  it('triggers at 0..3 days with thresholdsToMark=[3] when 14d already sent', () => {
    const m = addMember({ name: 'Late', email: 'l@x.com' });
    const batchId = addBatch({ memberId: m, quantity: 5, expiresAt: localDateIso(2) });
    dbMod.recordReminderSent(m, 1, 'expiry', `${batchId}:14d`);
    const rows = dbMod.findExpiryTriggers();
    expect(rows).toHaveLength(1);
    expect(rows[0].daysUntil).toBe(2);
    expect(rows[0].thresholdsToMark).toEqual([3]);
  });

  it('does NOT trigger when daysUntil > 14', () => {
    const m = addMember({ name: 'TooEarly', email: 'e@x.com' });
    addBatch({ memberId: m, quantity: 5, expiresAt: localDateIso(15) });
    expect(dbMod.findExpiryTriggers()).toHaveLength(0);
  });

  it('skips batches with no expiry', () => {
    const m = addMember({ name: 'Forever', email: 'f@x.com' });
    addBatch({ memberId: m, quantity: 5, expiresAt: null });
    expect(dbMod.findExpiryTriggers()).toHaveLength(0);
  });

  it('skips fully-consumed batches', () => {
    const m = addMember({ name: 'Used', email: 'u@x.com' });
    addBatch({ memberId: m, quantity: 5, used: 5, expiresAt: localDateIso(3) });
    expect(dbMod.findExpiryTriggers()).toHaveLength(0);
  });

  it('skips already-expired batches (daysUntil < 0); low-balance handles those', () => {
    const m = addMember({ name: 'Past', email: 'p@x.com' });
    addBatch({ memberId: m, quantity: 5, expiresAt: localDateIso(-1) });
    expect(dbMod.findExpiryTriggers()).toHaveLength(0);
  });

  it('does not re-trigger after both thresholds have been recorded', () => {
    const m = addMember({ name: 'Done', email: 'd@x.com' });
    const batchId = addBatch({ memberId: m, quantity: 5, expiresAt: localDateIso(2) });
    dbMod.recordReminderSent(m, 1, 'expiry', `${batchId}:14d`);
    dbMod.recordReminderSent(m, 1, 'expiry', `${batchId}:3d`);
    expect(dbMod.findExpiryTriggers()).toHaveLength(0);
  });
});

describe('recordPurchase clears stale low_balance reminders', () => {
  it('lets the next low-balance trigger fire after a top-up', () => {
    const m = addMember({ name: 'TopUp', email: 't@x.com' });
    addBatch({ memberId: m, quantity: 5, used: 3 });
    expect(dbMod.findLowBalanceTriggers()).toHaveLength(1);
    dbMod.recordReminderSent(m, 1, 'low_balance', 2);
    expect(dbMod.findLowBalanceTriggers()).toHaveLength(0);

    dbMod.recordPurchase(m, 1, 5, null, 'topup');
    dbMod.recordAttendance(m, 1, 6, 'use it down');
    const rows = dbMod.findLowBalanceTriggers();
    expect(rows).toHaveLength(1);
    expect(rows[0].balance).toBe(1);
  });
});

describe('runReminders end-to-end', () => {
  it('skips when reminders are disabled', async () => {
    dbMod.updateSettings({ reminders_enabled: false });
    const m = addMember({ name: 'Alice', email: 'a@x.com' });
    addBatch({ memberId: m, quantity: 2 });
    const r = await remindersMod.runReminders();
    expect(r.reason).toMatch(/disabled/i);
    expect(mailerMod.sendMail).not.toHaveBeenCalled();
  });

  it('skips when SMTP not configured', async () => {
    dbMod.updateSettings({ smtp_host: '' });
    const m = addMember({ name: 'Alice', email: 'a@x.com' });
    addBatch({ memberId: m, quantity: 2 });
    const r = await remindersMod.runReminders();
    expect(r.reason).toMatch(/SMTP/i);
    expect(mailerMod.sendMail).not.toHaveBeenCalled();
  });

  it('sends a low-balance email and records it', async () => {
    const m = addMember({ name: 'Alice', email: 'a@x.com' });
    addBatch({ memberId: m, quantity: 5, used: 3 });
    const r = await remindersMod.runReminders();
    expect(r.lowBalanceSent).toBe(1);
    expect(mailerMod.sendMail).toHaveBeenCalledTimes(1);
    const sent = sentEmails[0];
    expect(sent.to).toBe('a@x.com');
    expect(sent.bcc).toBe('owner@test.com');
    expect(sent.subject).toMatch(/2/);

    const r2 = await remindersMod.runReminders();
    expect(r2.lowBalanceSent).toBe(0);
  });

  it('sends one expiry email at 14d, then another at 3d (max 2 per batch)', async () => {
    const m = addMember({ name: 'Bob', email: 'b@x.com' });
    const batchId = addBatch({ memberId: m, quantity: 5, expiresAt: localDateIso(14) });

    let r = await remindersMod.runReminders();
    expect(r.expirySent).toBe(1);
    expect(sentEmails[0].subject).toMatch(/14/);

    r = await remindersMod.runReminders();
    expect(r.expirySent).toBe(0);

    const { db } = dbMod;
    db.prepare(
      `UPDATE credit_batches SET expires_at = ? WHERE id = ?`
    ).run(localDateIso(3), batchId);
    db.prepare(
      `DELETE FROM reminders_sent WHERE trigger_kind = 'expiry'`
    ).run();
    dbMod.recordReminderSent(m, 1, 'expiry', `${batchId}:14d`);

    r = await remindersMod.runReminders();
    expect(r.expirySent).toBe(1);
    expect(sentEmails.at(-1).subject).toMatch(/3/);

    r = await remindersMod.runReminders();
    expect(r.expirySent).toBe(0);
  });

  it('catch-up: server offline through 14d window, comes online at 7d → ONE 14d email', async () => {
    const m = addMember({ name: 'Late', email: 'l@x.com' });
    addBatch({ memberId: m, quantity: 5, expiresAt: localDateIso(7) });
    const r = await remindersMod.runReminders();
    expect(r.expirySent).toBe(1);
    expect(sentEmails[0].subject).toMatch(/7/);

    const r2 = await remindersMod.runReminders();
    expect(r2.expirySent).toBe(0);
  });

  it('catch-up: server offline through both windows, comes online at 2d → ONE email, both marked', async () => {
    const m = addMember({ name: 'VeryLate', email: 'vl@x.com' });
    const batchId = addBatch({ memberId: m, quantity: 5, expiresAt: localDateIso(2) });

    const r = await remindersMod.runReminders();
    expect(r.expirySent).toBe(1);
    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0].subject).toMatch(/2/);

    const { db } = dbMod;
    const sentRows = db
      .prepare(
        `SELECT trigger_key FROM reminders_sent
         WHERE trigger_kind='expiry' AND member_id=?`
      )
      .all(m);
    const keys = sentRows.map((r) => r.trigger_key).sort();
    expect(keys).toEqual([`${batchId}:14d`, `${batchId}:3d`]);

    const r2 = await remindersMod.runReminders();
    expect(r2.expirySent).toBe(0);
    expect(sentEmails).toHaveLength(1);
  });
});
