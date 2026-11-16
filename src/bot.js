// Telegram long-polling: მომხმარებელი წერს /start <კოდი> და ბოტი აკავშირებს მის ანგარიშს
const { pool } = require('./db');
const { sendTelegram, tgUrl } = require('./notify');
const { getSettings } = require('./settings');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function startBot() {
  let offset = 0, lastToken = '';
  while (true) {
    try {
      const { TELEGRAM_BOT_TOKEN: token } = await getSettings();
      if (!token) { await sleep(15000); continue; } // ტოკენი ჯერ არ არის; ადმინის გვერდიდან დაემატება
      if (token !== lastToken) { offset = 0; lastToken = token; }
      const r = await fetch(`${tgUrl(token)}/getUpdates?timeout=25&offset=${offset}`);
      const { result = [], ok } = await r.json();
      if (!ok) { await sleep(10000); continue; }
      for (const u of result) {
        offset = u.update_id + 1;
        const m = u.message;
        if (!m?.text) continue;
        const code = (m.text.match(/^\/start\s+(\S+)/) || [])[1];
        if (!code) { await sendTelegram(m.chat.id, 'გამარჯობა! გამოიყენე ბმული ადმინისგან: /start <კოდი>'); continue; }
        const { rows } = await pool.query('UPDATE users SET telegram_chat_id=$1 WHERE link_code=$2 RETURNING name', [m.chat.id, code]);
        await sendTelegram(m.chat.id, rows[0] ? `${rows[0].name}, წარმატებით დაგაკავშირეთ ✅ შეხსენებებს აქ მიიღებ.` : 'კოდი ვერ მოიძებნა.');
      }
    } catch (e) { console.error('bot error', e.message); await sleep(5000); }
  }
}
module.exports = { startBot };
