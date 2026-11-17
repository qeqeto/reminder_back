// Telegram long-polling. უცნობი გამგზავნები იგნორდება. /todo: დავალებების სია, /new: ფორმა (Mini App, შესვლის გარეშე).
const { pool } = require('./db');
const { sendTelegram, tgUrl, tgCall } = require('./notify');
const { getSettings } = require('./settings');
const rt = require('./realtime');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const frontBase = () => (process.env.FRONTEND_URL || '').replace(/\/+$/, '');
const KB = { keyboard: [[{ text: '📋 დავალებები' }, { text: '➕ ახალი დავალება' }]], resize_keyboard: true, is_persistent: true };
const mine = `(d.created_by=$1 OR EXISTS (SELECT 1 FROM document_users x WHERE x.document_id=d.id AND x.user_id=$1))`;
const rel = ms => { const m = Math.round(Math.abs(ms) / 6e4), d = Math.floor(m / 1440), h = Math.floor(m % 1440 / 60); const t = d ? `${d} დღე` : h ? `${h} სთ` : `${m} წთ`; return ms < 0 ? `გადაცილებულია ${t}` : `დარჩა ${t}`; };
const userByChat = async chat => (await pool.query('SELECT id,name,verified,approved FROM users WHERE telegram_chat_id=$1', [chat])).rows[0];

async function todoView(u) {
  const { rows } = await pool.query(`SELECT d.id,d.title,d.deadline,to_char(d.deadline AT TIME ZONE 'Asia/Tbilisi','DD.MM HH24:MI') dl, count(*) OVER() total
    FROM documents d WHERE NOT d.done AND ${mine} ORDER BY d.deadline LIMIT 8`, [u.id]);
  const refresh = [{ text: '🔄 განახლება', callback_data: 'rf' }];
  if (!rows.length) return { text: 'აქტიური დავალება არ გაქვს 🎉', reply_markup: { inline_keyboard: [refresh] } };
  const lines = rows.map((r, i) => { const ms = new Date(r.deadline) - Date.now(); return `${i + 1}. ${ms < 0 ? '⚠️ ' : ''}${r.title}\n    ⏰ ${r.dl} · ${rel(ms)}`; });
  const total = +rows[0].total;
  const kb = rows.map((r, i) => [{ text: `✅ ${i + 1}`, callback_data: 'dn:' + r.id }, { text: `⏰ ${i + 1}`, callback_data: 'pp:' + r.id }]);
  kb.push(refresh);
  return { text: `📋 შენი აქტიური დავალებები (${total})\n\n${lines.join('\n')}${total > rows.length ? `\n\n…და კიდევ ${total - rows.length} საიტზე` : ''}\n\n✅ შესრულებულია · ⏰ +1 დღით გადადება`, reply_markup: { inline_keyboard: kb } };
}

async function handleCb(q) {
  const chat = q.message?.chat?.id; if (!chat) return;
  const u = await userByChat(chat);
  if (!u || !u.verified || !u.approved) return; // უცნობი: იგნორი
  const [k, id] = String(q.data).split(':');
  let note = '';
  if (k === 'dn') {
    const r = await pool.query(`UPDATE documents d SET done=true,done_at=now(),done_by_name=$2 WHERE d.id=$3 AND NOT d.done AND (d.created_by=$1 OR EXISTS (SELECT 1 FROM document_users x WHERE x.document_id=d.id AND x.user_id=$1))`, [u.id, u.name, +id]);
    note = r.rowCount ? 'გადავიდა ისტორიაში ✅' : 'უფლება არ გაქვს'; if (r.rowCount) rt.emit();
  } else if (k === 'pp') {
    const r = await pool.query(`UPDATE documents d SET deadline=GREATEST(d.deadline,now())+interval '1 day', postponed_count=postponed_count+1 WHERE d.id=$2 AND NOT d.done AND ${mine}`, [u.id, +id]);
    if (r.rowCount) { await pool.query('DELETE FROM reminder_sent WHERE document_id=$1', [+id]); rt.emit(); }
    note = r.rowCount ? 'ვადა გადაიდო +1 დღით ⏰' : 'უფლება არ გაქვს';
  }
  await tgCall('answerCallbackQuery', { callback_query_id: q.id, ...(note ? { text: note } : {}) }).catch(() => {});
  await tgCall('editMessageText', { chat_id: chat, message_id: q.message.message_id, ...(await todoView(u)) }).catch(() => {});
}

async function handle(m) {
  const chat = m.chat.id, text = m.text || '';
  const vt = (text.match(/^\/start\s+v_(\S+)/) || [])[1];
  if (vt) { // რეგისტრაციის ვერიფიკაცია QR/ბმულით
    const v = await pool.query('UPDATE users SET verified=true, telegram_chat_id=$1, tg_verify_token=NULL WHERE tg_verify_token=$2 RETURNING name, approved', [chat, vt]);
    if (v.rows[0]) { rt.emit('users'); await sendTelegram(chat, v.rows[0].approved
      ? `${v.rows[0].name}, ანგარიში დადასტურდა ✅ შეგიძლია დაუბრუნდე საიტს.`
      : `${v.rows[0].name}, Telegram დადასტურდა ✅ ახლა ადმინმა უნდა დაგიმტკიცოს წვდომა. დამტკიცებისთანავე შეგატყობინებთ.`); }
    return;
  }
  const code = (text.match(/^\/start\s+(\S+)/) || [])[1];
  if (code) { // არსებული ანგარიშის დაკავშირება (მხოლოდ დამტკიცებულებისთვის)
    const l = await pool.query('UPDATE users SET telegram_chat_id=$1 WHERE link_code=$2 AND approved RETURNING name', [chat, code]);
    if (l.rows[0]) { rt.emit('users'); await sendTelegram(chat, `${l.rows[0].name}, წარმატებით დაგაკავშირეთ ✅ შეხსენებებს აქ მიიღებ.\n/todo: დავალებების სია · /new: ახალი დავალება`, { reply_markup: KB }); }
    return;
  }
  const u = await userByChat(chat);
  if (!u) return; // უცნობი გამგზავნი: უგულებელყოფა
  if (!(u.verified && u.approved)) return sendTelegram(chat, 'შენი ანგარიში ჯერ ადმინის დამტკიცებას ელოდება.');
  if (/^\/todo\b/.test(text) || text === '📋 დავალებები') return tgCall('sendMessage', { chat_id: chat, ...(await todoView(u)) });
  if (/^\/new\b/.test(text) || text === '➕ ახალი დავალება') {
    const base = frontBase();
    if (!base.startsWith('https://')) return sendTelegram(chat, 'ფორმის მისამართი (FRONTEND_URL) არ არის გამართული.');
    return sendTelegram(chat, 'დააჭირე ღილაკს და შეავსე ფორმა 👇', { reply_markup: { inline_keyboard: [[{ text: '➕ ახალი დავალება', web_app: { url: base + '/tg.html' } }]] } });
  }
  await sendTelegram(chat, '👋 აირჩიე ქვემოთ ღილაკი ან ბრძანება:\n/todo: დავალებების სია\n/new: ახალი დავალება', { reply_markup: KB });
}

async function startBot() {
  let offset = 0, lastToken = '';
  while (true) {
    try {
      const { TELEGRAM_BOT_TOKEN: token } = await getSettings();
      if (!token) { await sleep(15000); continue; }
      if (token !== lastToken) {
        offset = 0; lastToken = token;
        const call = (m, b) => fetch(`${tgUrl(token)}/${m}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).catch(() => {});
        await call('setMyCommands', { commands: [{ command: 'todo', description: 'დავალებების სია' }, { command: 'new', description: 'ახალი დავალება' }] });
        if (frontBase().startsWith('https://')) await call('setChatMenuButton', { menu_button: { type: 'web_app', text: 'ახალი დავალება', web_app: { url: frontBase() + '/tg.html' } } });
      }
      const r = await fetch(`${tgUrl(token)}/getUpdates?timeout=25&offset=${offset}`);
      const { result = [], ok } = await r.json();
      if (!ok) { await sleep(10000); continue; }
      for (const u of result) {
        offset = u.update_id + 1;
        try {
          if (u.callback_query) await handleCb(u.callback_query);
          else if (u.message && u.message.chat?.type === 'private') await handle(u.message);
        } catch (e) { console.error('bot handle', e.message); }
      }
    } catch (e) { console.error('bot error', e.message); await sleep(5000); }
  }
}
module.exports = { startBot };
