const nodemailer = require('nodemailer');
const { getSettings } = require('./settings');

async function sendEmail(to, subject, text) {
  const s = await getSettings();
  if (!s.SMTP_HOST) throw new Error('SMTP არ არის გაწერილი');
  const t = nodemailer.createTransport({
    host: s.SMTP_HOST, port: +(s.SMTP_PORT || 587), secure: s.SMTP_PORT === '465',
    auth: { user: s.SMTP_USER, pass: s.SMTP_PASS },
    connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000
  });
  await t.sendMail({ from: s.SMTP_FROM || s.SMTP_USER, to, subject, text });
}

const tgUrl = token => `https://api.telegram.org/bot${token}`;
async function sendTelegram(chatId, text) {
  const { TELEGRAM_BOT_TOKEN: token } = await getSettings();
  if (!token) throw new Error('Telegram ტოკენი არ არის გაწერილი');
  const r = await fetch(`${tgUrl(token)}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text })
  });
  if (!r.ok) throw new Error('Telegram: ' + (await r.text()));
}
module.exports = { sendEmail, sendTelegram, tgUrl };
