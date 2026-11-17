const { pool } = require('./db');
const KEYS = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_BOT_USERNAME', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'DEFAULT_DAILY_TIME'];
const SECRET = ['TELEGRAM_BOT_TOKEN', 'SMTP_PASS'];

// ბაზაში შენახული მნიშვნელობა უპირატესია, ENV არის სარეზერვო
async function getSettings() {
  const o = {};
  for (const k of KEYS) o[k] = process.env[k] || '';
  const { rows } = await pool.query('SELECT key,value FROM settings');
  for (const r of rows) if (r.value) o[r.key] = r.value;
  return o;
}
async function setSetting(key, value) {
  await pool.query('INSERT INTO settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2', [key, value]);
}
module.exports = { KEYS, SECRET, getSettings, setSetting };
