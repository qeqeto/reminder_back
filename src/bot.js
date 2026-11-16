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
      if (token !== lastToken) {
        offset = 0; lastToken = token;
        const base = (process.env.FRONTEND_URL || '').replace(/\/+$/, '');
        if (base.startsWith('https://')) // ბოტის მენიუს ღილაკი, რომელიც დავალების ფორმას ხსნის
          fetch(`${tgUrl(token)}/setChatMenuButton`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ menu_button: { type: 'web_app', text: 'ახალი დავალება', web_app: { url: base + '/tg.html' } } }) }).catch(() => {});
      }
      const r = await fetch(`${tgUrl(token)}/getUpdates?timeout=25&offset=${offset}`);
      const { result = [], ok } = await r.json();
      if (!ok) { await sleep(10000); continue; }
      for (const u of result) {
        offset = u.update_id + 1;
        const m = u.message;
        if (!m?.text) continue;
        if (/^\/new\b/.test(m.text)) { // დავალების ფორმა (Mini App)
          const base = (process.env.FRONTEND_URL || '').replace(/\/+$/, '');
          const known = await pool.query('SELECT 1 FROM users WHERE telegram_chat_id=$1 AND verified', [m.chat.id]);
          if (!known.rowCount) { await sendTelegram(m.chat.id, 'ჯერ დააკავშირე Telegram შენს ანგარიშთან (საიტი → პარამეტრები).'); continue; }
          if (!base.startsWith('https://')) { await sendTelegram(m.chat.id, 'ფორმის მისამართი (FRONTEND_URL) არ არის გამართული.'); continue; }
          await sendTelegram(m.chat.id, 'დააჭირე ღილაკს და შეავსე ფორმა 👇', { reply_markup: { inline_keyboard: [[{ text: '➕ ახალი დავალება', web_app: { url: base + '/tg.html' } }]] } });
          continue;
        }
        const vt = (m.text.match(/^\/start\s+v_(\S+)/) || [])[1];
        if (vt) { // რეგისტრაციის ვერიფიკაცია QR/ბმულით
          const v = await pool.query('UPDATE users SET verified=true, telegram_chat_id=$1, tg_verify_token=NULL WHERE tg_verify_token=$2 RETURNING name', [m.chat.id, vt]);
          await sendTelegram(m.chat.id, v.rows[0] ? `${v.rows[0].name}, ანგარიში დადასტურდა ✅ შეგიძლია დაუბრუნდე საიტს.` : 'ბმული ვადაგასულია ან უკვე გამოყენებულია.');
          continue;
        }
        const code = (m.text.match(/^\/start\s+(\S+)/) || [])[1];
        if (!code) { await sendTelegram(m.chat.id, 'გამარჯობა! ანგარიშის დასაკავშირებლად გამოიყენე ბმული საიტიდან ან ადმინისგან. ახალი დავალებისთვის: /new'); continue; }
        const { rows } = await pool.query('UPDATE users SET telegram_chat_id=$1 WHERE link_code=$2 RETURNING name', [m.chat.id, code]);
        await sendTelegram(m.chat.id, rows[0] ? `${rows[0].name}, წარმატებით დაგაკავშირეთ ✅ შეხსენებებს აქ მიიღებ.` : 'კოდი ვერ მოიძებნა.');
      }
    } catch (e) { console.error('bot error', e.message); await sleep(5000); }
  }
}
module.exports = { startBot };
