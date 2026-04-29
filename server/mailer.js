import nodemailer from 'nodemailer';
import { getSettings } from './db.js';
import { log } from './logger.js';

let cachedKey = '';
let cachedTransport = null;

function settingsKey(s) {
  return [
    s.smtp_host || '',
    s.smtp_port || '',
    s.smtp_user || '',
    s.smtp_pass || '',
    s.smtp_secure ? 1 : 0,
  ].join('|');
}

/**
 * Returns a configured nodemailer transport, or null if SMTP isn't set up yet.
 * Caches per (host, port, user, pass, secure) so we don't reconnect on every send.
 */
export function getTransport() {
  const s = getSettings();
  if (!s || !s.smtp_host || !s.smtp_port || !s.smtp_user || !s.smtp_pass) {
    return null;
  }
  const key = settingsKey(s);
  if (key !== cachedKey) {
    cachedKey = key;
    cachedTransport = nodemailer.createTransport({
      host: s.smtp_host,
      port: Number(s.smtp_port),
      secure: Boolean(s.smtp_secure),
      auth: { user: s.smtp_user, pass: s.smtp_pass },
    });
  }
  return cachedTransport;
}

/** Resets the cached transport — call after settings change. */
export function resetTransport() {
  cachedKey = '';
  cachedTransport = null;
}

/**
 * Sends an email using current settings.
 * @param {{to?: string, cc?: string, bcc?: string|string[], subject: string, text?: string, html?: string}} opts
 * @returns {Promise<{ ok: true, messageId: string } | { ok: false, error: string }>}
 */
export async function sendMail(opts) {
  const s = getSettings();
  const transport = getTransport();
  if (!transport) {
    return { ok: false, error: 'SMTP is not configured. Fill in Settings first.' };
  }
  if (!s.owner_email) {
    return { ok: false, error: 'Owner email not set in Settings.' };
  }
  const fromName = s.owner_name ? `${s.owner_name} <${s.owner_email}>` : s.owner_email;
  try {
    const info = await transport.sendMail({
      from: fromName,
      to: opts.to,
      cc: opts.cc,
      bcc: opts.bcc,
      subject: opts.subject,
      text: opts.text,
      html: opts.html,
    });
    log.info(`Email sent: subject="${opts.subject}" messageId=${info.messageId}`);
    return { ok: true, messageId: info.messageId };
  } catch (err) {
    log.error('Email send failed:', err);
    return { ok: false, error: err.message || 'Unknown SMTP error' };
  }
}
