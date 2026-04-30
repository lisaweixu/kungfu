import {
  findLowBalanceTriggers,
  findExpiryTriggers,
  recordReminderSent,
  getSettings,
} from './db.js';
import { sendMail } from './mailer.js';
import { log } from './logger.js';

/** Bilingual subject + body for low-balance reminder. */
function buildLowBalanceMessage({ memberName, className, balance }) {
  const subject =
    balance === 0
      ? `[KungFu] No ${className} credits left / ${className} 余额为零`
      : `[KungFu] Only ${balance} ${className} credit${balance === 1 ? '' : 's'} left / 余额提醒`;
  const body =
    `Hi ${memberName},\n\n` +
    (balance === 0
      ? `You have used all your prepaid ${className} credits. To keep training, please ` +
        `top up before your next class.\n\n` +
        `您好 ${memberName}，\n\n您的 ${className} 课时已用完。如需继续上课，请在下次上课前充值。\n\n`
      : `Just a heads-up — you have ${balance} ${className} credit${balance === 1 ? '' : 's'} ` +
        `remaining. Please consider topping up soon so there's no interruption.\n\n` +
        `您好 ${memberName}，\n\n温馨提示：您的 ${className} 课时还剩 ${balance} 节。` +
        `请尽快充值，以免影响课程。\n\n`) +
    `Thanks,\nKungFu Club`;
  return { subject, body };
}

/** Bilingual subject + body for upcoming-expiry reminder. Uses actual daysUntil. */
function buildExpiryMessage({ memberName, className, remaining, expiresAt, daysUntil }) {
  const dayLabel = daysUntil === 1 ? 'day' : 'days';
  const urgency =
    daysUntil <= 3
      ? `${daysUntil} ${dayLabel}`
      : `about ${daysUntil} days (~${Math.round(daysUntil / 7)} week${daysUntil >= 14 ? 's' : ''})`;
  const subject = `[KungFu] ${className} credits expire in ${daysUntil} ${dayLabel} / 课时即将过期`;
  const body =
    `Hi ${memberName},\n\n` +
    `You have ${remaining} ${className} credit${remaining === 1 ? '' : 's'} ` +
    `that will expire on ${expiresAt} (in ${urgency}). ` +
    `Please use them or top up before then.\n\n` +
    `您好 ${memberName}，\n\n您还有 ${remaining} 节 ${className} 课时将于 ${expiresAt} ` +
    `（${daysUntil} 天后）过期。请尽快使用或在到期前续费。\n\n` +
    `Thanks,\nKungFu Club`;
  return { subject, body };
}

/**
 * Runs one reminders pass: scans for low-balance + expiring batches and emails each
 * applicable member (BCC owner). Records each successful send in `reminders_sent` so
 * the same trigger doesn't fire again.
 *
 * Safe to call repeatedly — dedup is at the DB level.
 *
 * @returns {Promise<{
 *   lowBalanceSent: number, expirySent: number, lowBalanceSkipped: number,
 *   expirySkipped: number, errors: string[], reason?: string
 * }>}
 */
export async function runReminders() {
  const result = {
    lowBalanceSent: 0,
    expirySent: 0,
    lowBalanceSkipped: 0,
    expirySkipped: 0,
    errors: [],
  };

  const settings = getSettings();
  if (!settings) {
    result.reason = 'Settings row missing.';
    log.warn('Reminders skipped:', result.reason);
    return result;
  }
  if (!settings.reminders_enabled) {
    result.reason = 'Reminders disabled in Settings.';
    log.info('Reminders skipped:', result.reason);
    return result;
  }
  if (!settings.smtp_host || !settings.smtp_user || !settings.smtp_pass) {
    result.reason = 'SMTP not configured.';
    log.warn('Reminders skipped:', result.reason);
    return result;
  }
  if (!settings.owner_email) {
    result.reason = 'Owner email not set.';
    log.warn('Reminders skipped:', result.reason);
    return result;
  }

  const lowRows = findLowBalanceTriggers();
  const expRows = findExpiryTriggers();
  log.info(
    `Reminders pass: ${lowRows.length} low-balance candidate(s), ${expRows.length} expiry candidate(s)`
  );

  for (const row of lowRows) {
    const { subject, body } = buildLowBalanceMessage(row);
    const r = await sendMail({
      to: row.memberEmail,
      bcc: settings.owner_email,
      subject,
      text: body,
    });
    if (r.ok) {
      recordReminderSent(row.memberId, row.classId, 'low_balance', row.balance);
      result.lowBalanceSent++;
      log.info(
        `Reminder sent: low_balance member=${row.memberId} class=${row.classId} balance=${row.balance}`
      );
    } else {
      result.lowBalanceSkipped++;
      result.errors.push(
        `low_balance member=${row.memberId} class=${row.classId}: ${r.error}`
      );
    }
  }

  for (const row of expRows) {
    const { subject, body } = buildExpiryMessage(row);
    const r = await sendMail({
      to: row.memberEmail,
      bcc: settings.owner_email,
      subject,
      text: body,
    });
    if (r.ok) {
      for (const t of row.thresholdsToMark) {
        recordReminderSent(row.memberId, row.classId, 'expiry', `${row.batchId}:${t}d`);
      }
      result.expirySent++;
      log.info(
        `Reminder sent: expiry member=${row.memberId} batch=${row.batchId} ` +
          `daysUntil=${row.daysUntil} marked=[${row.thresholdsToMark.join(',')}d]`
      );
    } else {
      result.expirySkipped++;
      result.errors.push(
        `expiry member=${row.memberId} batch=${row.batchId}: ${r.error}`
      );
    }
  }

  log.info(
    `Reminders pass done: low-balance ${result.lowBalanceSent} sent / ${result.lowBalanceSkipped} failed; ` +
      `expiry ${result.expirySent} sent / ${result.expirySkipped} failed`
  );
  return result;
}
