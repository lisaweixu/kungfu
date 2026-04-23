import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logsDir = path.join(__dirname, '..', 'logs');

try {
  fs.mkdirSync(logsDir, { recursive: true });
} catch {
  // ignore
}

function todayStamp() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

let currentDate = todayStamp();
let currentPath = path.join(logsDir, `server-${currentDate}.log`);
let stream = fs.createWriteStream(currentPath, { flags: 'a' });

function rotateIfNeeded() {
  const stamp = todayStamp();
  if (stamp === currentDate) return;
  try {
    stream.end();
  } catch {
    // ignore
  }
  currentDate = stamp;
  currentPath = path.join(logsDir, `server-${currentDate}.log`);
  stream = fs.createWriteStream(currentPath, { flags: 'a' });
}

function write(level, parts) {
  rotateIfNeeded();
  const ts = new Date().toISOString();
  const msg = parts
    .map((p) => {
      if (p instanceof Error) return p.stack || `${p.name}: ${p.message}`;
      if (typeof p === 'string') return p;
      try {
        return JSON.stringify(p);
      } catch {
        return String(p);
      }
    })
    .join(' ');
  const line = `${ts} [${level}] ${msg}\n`;
  try {
    stream.write(line);
  } catch {
    // ignore disk errors to avoid crashing the server
  }
  const out = level === 'ERROR' || level === 'WARN' ? process.stderr : process.stdout;
  out.write(line);
}

export const log = {
  info: (...args) => write('INFO', args),
  warn: (...args) => write('WARN', args),
  error: (...args) => write('ERROR', args),
  get file() {
    return currentPath;
  },
};

export function requestLogger(req, res, next) {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    const ip = req.ip || req.socket?.remoteAddress || '-';
    log.info(
      `${req.method} ${req.originalUrl || req.url} ${res.statusCode} ${ms.toFixed(1)}ms ${ip}`
    );
  });
  next();
}

export function errorLogger(err, req, res, _next) {
  log.error(
    `Unhandled error on ${req.method} ${req.originalUrl || req.url}:`,
    err
  );
  if (res.headersSent) return;
  res.status(500).json({ error: 'Internal server error' });
}

process.on('uncaughtException', (err) => {
  log.error('uncaughtException:', err);
});
process.on('unhandledRejection', (reason) => {
  log.error('unhandledRejection:', reason);
});
