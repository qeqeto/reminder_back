// Telegram long-polling. უცნობი (დაუკავშირებელი) ანგარიშიდან მოსული შეტყობინებები იგნორდება: პასუხი არ იგზავნება.
const { pool } = require('./db');
const { sendTelegram, tgUrl } = require('./notify');
const { getSettings } = require('./settings');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const frontBase = () => (process.env.FRONTEND_URL || '').replace(/\/+$/, '');

async function handle(m) {
  const chat = m.chat.id, text = m.text || '';

  // რეგისტრაციის ვერიფიკაცია QR/ბმულით: /start v_<ერთჯერადი ტოკენი>
  const vt = (text.match(/^\/start\s+v_(\S+)/) || [])[1];
  if (vt) {
    const v = await pool.query('UPDATE users SET verified=true, telegram_chat_id=$1, tg_verify_token=NULL WHERE tg_verify_token=$2 RETURNING name, approved', [chat, vt]);
    if (v.rows[0]) await sendTelegram(chat, v.rows[0].approved
      ? `${v.rows[0].name}, ანგარიში დადასტურდა ✅ შეგიძლია დაუბრუნდე საიტს.`
      : `${v.rows[0].name}, Telegram დადასტურდა ✅ ახლა ადმინმა უნდა დაგიმტკიცოს წვდომა. დამტკიცებისთანავე შეგატყობინებთ.`);
    return; // არასწორი ტოკენი: იგნორი
  }
  // არსებული ანგარიშის დაკავშირება: /start <კოდი> (მხოლოდ დამტკიცებულებისთვის)
  const code = (text.match(/^\/start\s+(\S+)/) || [])[1];
  if (code) {
    const l = await pool.query('UPDATE users SET telegram_chat_id=$1 WHERE link_code=$2 AND approved RETURNING name', [chat, code]);
    if (l.rows[0]) await sendTelegram(chat, `${l.rows[0].name}, წარმატებით დაგაკავშირეთ ✅ შეხსენებებს აქ მიიღებ. ახალი დავალებისთვის: /new`);
    return;
  }
  const { rows } = await pool.query('SELECT verified, approved FROM users WHERE telegram_chat_id=$1', [chat]);
  const u = rows[0];
  if (!u) return; // უცნობი გამგზავნი: უგულებელყოფა
  if (!/^\/new\b/.test(text)) return sendTelegram(chat, 'ახალი დავალებისთვის: /new');
  if (!(u.verified && u.approved)) return sendTelegram(chat, 'შენი ანგარიში ჯერ ადმინის დამტკიცებას ელოდება.');
  const base = frontBase();
  if (!base.startsWith('https://')) return sendTelegram(chat, 'ფორმის მისამართი (FRONTEND_URL) არ არის გამართული.');
  await sendTelegram(chat, 'დააჭირე ღილაკს და შეავსე ფორმა 👇', { reply_markup: { inline_keyboard: [[{ text: '➕ ახალი დავალება', web_app: { url: base + '/tg.html' } }]] } });
}

async function startBot() {
  let offset = 0, lastToken = '';
  while (true) {
    try {
      const { TELEGRAM_BOT_TOKEN: token } = await getSettings();
      if (!token) { await sleep(15000); continue; }
      if (token !== lastToken) {
        offset = 0; lastToken = token;
        if (frontBase().startsWith('https://')) // მენიუს ღილაკი, რომელიც დავალების ფორმას ხსნის
          fetch(`${tgUrl(token)}/setChatMenuButton`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ menu_button: { type: 'web_app', text: 'ახალი დავალება', web_app: { url: frontBase() + '/tg.html' } } }) }).catch(() => {});
      }
      const r = await fetch(`${tgUrl(token)}/getUpdates?timeout=25&offset=${offset}`);
      const { result = [], ok } = await r.json();
      if (!ok) { await sleep(10000); continue; }
      for (const u of result) {
        offset = u.update_id + 1;
        if (u.message && u.message.chat?.type === 'private') await handle(u.message).catch(e => console.error('bot handle', e.message));
      }
    } catch (e) { console.error('bot error', e.message); await sleep(5000); }
  }
}
module.exports = { startBot };
