// Telegram long-polling. უცნობი გამგზავნები იგნორდება. დავალების ფორმა ჩატშია (inline ღილაკები), ვებ გვერდის გარეშე.
const { pool } = require('./db');
const { sendTelegram, tgUrl, tgCall } = require('./notify');
const { getSettings } = require('./settings');
const { createDoc } = require('./docs');
const { notifyDoc } = require('./cron');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const REM = [[10080, '7 დღით'], [4320, '3 დღით'], [1440, '1 დღით'], [120, '2 საათით'], [60, '1 საათით'], [0, 'ვადისას']];
const pad = n => String(n).padStart(2, '0');
const fmtTb = iso => { const d = new Date(new Date(iso).getTime() + 4 * 36e5); return `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };
const minute = ms => Math.floor(ms / 6e4) * 6e4;

function parseDt(text) { // თბილისის დრო (UTC+4)
  const m = text.trim().match(/^(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?\s+(\d{1,2})[:.](\d{2})$/);
  if (!m) return null;
  const [dd, mo, hh, mi] = [m[1], m[2], m[4], m[5]].map(Number);
  let y = m[3] ? +m[3] : new Date(Date.now() + 4 * 36e5).getUTCFullYear(); if (y < 100) y += 2000;
  let t = new Date(Date.UTC(y, mo - 1, dd, hh - 4, mi));
  if (!m[3] && t < Date.now()) t = new Date(Date.UTC(y + 1, mo - 1, dd, hh - 4, mi));
  const back = new Date(t.getTime() + 4 * 36e5);
  if (back.getUTCDate() !== dd || back.getUTCMonth() !== mo - 1 || hh > 23 || mi > 59 || t < Date.now() - 6e4) return null;
  return t;
}

const getDraft = async chat => (await pool.query(`SELECT step,data,msg_id FROM bot_drafts WHERE chat_id=$1 AND updated_at > now() - interval '1 day'`, [chat])).rows[0];
const saveDraft = (chat, d) => pool.query(`INSERT INTO bot_drafts (chat_id,step,data,msg_id,updated_at) VALUES ($1,$2,$3,$4,now())
  ON CONFLICT (chat_id) DO UPDATE SET step=$2,data=$3,msg_id=$4,updated_at=now()`, [chat, d.step, JSON.stringify(d.data), d.msg_id]);
const delDraft = chat => pool.query('DELETE FROM bot_drafts WHERE chat_id=$1', [chat]);
const userByChat = async chat => (await pool.query('SELECT id,name,verified,approved FROM users WHERE telegram_chat_id=$1', [chat])).rows[0];
const people = async () => (await pool.query('SELECT id,name FROM users WHERE verified AND approved ORDER BY name LIMIT 40')).rows;

async function view(d, prompt = '') {
  const us = await people(), data = d.data;
  const text = ['📝 ახალი დავალება', '', `სახელი: ${data.title || '—'}`, `ბოლო ვადა: ${fmtTb(data.dl)}`,
    `შეხსენება: ${REM.filter(([m]) => data.rm.includes(m)).map(([, t]) => t).join(', ') || '—'}`,
    `ვის: ${us.filter(x => data.us.includes(x.id)).map(x => x.name).join(', ') || '—'}`, ...(prompt ? ['', prompt] : [])].join('\n');
  let kb;
  if (data.view === 'dl') kb = [
    [{ text: '+1 საათი', callback_data: 'q:60' }, { text: '+1 დღე', callback_data: 'q:1440' }],
    [{ text: '+3 დღე', callback_data: 'q:4320' }, { text: '+1 კვირა', callback_data: 'q:10080' }],
    [{ text: '+10 დღე (ნაგულისხმევი)', callback_data: 'q:14400' }],
    [{ text: '⌨️ ხელით ჩაწერა', callback_data: 'dm' }], [{ text: '↩ უკან', callback_data: 'b' }]];
  else {
    kb = [[{ text: '✏️ სახელი', callback_data: 't' }, { text: '📅 ვადა', callback_data: 'd' }]];
    for (let i = 0; i < REM.length; i += 2) kb.push(REM.slice(i, i + 2).map(([m, t]) => ({ text: `${data.rm.includes(m) ? '☑' : '☐'} ${t}`, callback_data: 'r:' + m })));
    for (let i = 0; i < us.length; i += 2) kb.push(us.slice(i, i + 2).map(x => ({ text: `${data.us.includes(x.id) ? '☑' : '☐'} ${x.name}`, callback_data: 'u:' + x.id })));
    kb.push([{ text: `${data.nt ? '☑' : '☐'} გაუგზავნე ახლავე`, callback_data: 'n' }]);
    kb.push([{ text: '✅ შექმნა', callback_data: 'ok' }, { text: '✖ გაუქმება', callback_data: 'x' }]);
  }
  return { text, reply_markup: { inline_keyboard: kb } };
}
async function refresh(chat, d, prompt) {
  await tgCall('editMessageText', { chat_id: chat, message_id: d.msg_id, ...(await view(d, prompt)) }).catch(e => { if (!/not modified/.test(e.message)) throw e; });
}
const promptOf = d => d.step === 'title' ? '⌨️ ჩაწერე დოკუმენტის სახელი შეტყობინებად' : d.step === 'deadline' ? '⌨️ ჩაწერე ვადა, მაგ.: 25.11.2026 14:30' : '';

async function handleCb(q) {
  const chat = q.message?.chat?.id;
  if (!chat || q.message.chat.type !== 'private') return;
  const u = await userByChat(chat);
  if (!u || !u.verified || !u.approved) return; // უცნობი ან დაუმტკიცებელი: იგნორი
  const ack = (text, alert) => tgCall('answerCallbackQuery', { callback_query_id: q.id, ...(text ? { text, show_alert: !!alert } : {}) }).catch(() => {});
  const d = await getDraft(chat);
  if (!d || d.msg_id !== q.message.message_id) return ack('ფორმა ვადაგასულია, დაწერე /new', true);
  const data = d.data, [k, v] = String(q.data).split(':');
  if (k === 'x') { await delDraft(chat); await tgCall('editMessageText', { chat_id: chat, message_id: d.msg_id, text: 'დავალება გაუქმდა.' }).catch(() => {}); return ack(); }
  if (k === 'ok') {
    if (!data.title.trim()) return ack('ჯერ ჩაწერე დოკუმენტის სახელი', true);
    const id = await createDoc({ title: data.title, deadline: data.dl, remind_mins: data.rm, user_ids: data.us }, u.id);
    await delDraft(chat);
    const names = (await people()).filter(x => data.us.includes(x.id)).map(x => x.name).join(', ') || '—';
    let line = '';
    if (data.nt) { const r = await notifyDoc(id, u.name); line = `\nგაიგზავნა: ${r.filter(x => x.ok).length}` + (r.some(x => !x.ok) ? `, ვერ გაიგზავნა: ${r.filter(x => !x.ok).length}` : ''); }
    await tgCall('editMessageText', { chat_id: chat, message_id: d.msg_id, text: `✅ დავალება შეიქმნა\n\n${data.title}\nვადა: ${fmtTb(data.dl)}\nვის: ${names}${line}` });
    return ack();
  }
  if (k === 't') d.step = 'title';
  else if (k === 'd') { data.view = 'dl'; d.step = null; }
  else if (k === 'dm') d.step = 'deadline';
  else if (k === 'b') { data.view = null; d.step = null; }
  else if (k === 'q') { data.dl = new Date(minute(Date.now() + (+v) * 6e4)).toISOString(); data.view = null; d.step = null; }
  else if (k === 'r') { const m = +v; data.rm = data.rm.includes(m) ? data.rm.filter(x => x !== m) : [...data.rm, m]; }
  else if (k === 'u') { const i = +v; data.us = data.us.includes(i) ? data.us.filter(x => x !== i) : [...data.us, i]; }
  else if (k === 'n') data.nt = !data.nt;
  await saveDraft(chat, d); await refresh(chat, d, promptOf(d)); await ack();
}

async function handle(m) {
  const chat = m.chat.id, text = m.text || '';
  const vt = (text.match(/^\/start\s+v_(\S+)/) || [])[1];
  if (vt) { // რეგისტრაციის ვერიფიკაცია QR/ბმულით
    const v = await pool.query('UPDATE users SET verified=true, telegram_chat_id=$1, tg_verify_token=NULL WHERE tg_verify_token=$2 RETURNING name, approved', [chat, vt]);
    if (v.rows[0]) await sendTelegram(chat, v.rows[0].approved
      ? `${v.rows[0].name}, ანგარიში დადასტურდა ✅ შეგიძლია დაუბრუნდე საიტს.`
      : `${v.rows[0].name}, Telegram დადასტურდა ✅ ახლა ადმინმა უნდა დაგიმტკიცოს წვდომა. დამტკიცებისთანავე შეგატყობინებთ.`);
    return;
  }
  const code = (text.match(/^\/start\s+(\S+)/) || [])[1];
  if (code) {
    const l = await pool.query('UPDATE users SET telegram_chat_id=$1 WHERE link_code=$2 AND approved RETURNING name', [chat, code]);
    if (l.rows[0]) await sendTelegram(chat, `${l.rows[0].name}, წარმატებით დაგაკავშირეთ ✅ შეხსენებებს აქ მიიღებ. ახალი დავალებისთვის: /new`);
    return;
  }
  const u = await userByChat(chat);
  if (!u) return; // უცნობი გამგზავნი: უგულებელყოფა
  const ready = u.verified && u.approved;
  if (/^\/cancel\b/.test(text)) { await delDraft(chat); return sendTelegram(chat, 'გაუქმდა.'); }
  if (/^\/new\b/.test(text)) {
    if (!ready) return sendTelegram(chat, 'შენი ანგარიში ჯერ ადმინის დამტკიცებას ელოდება.');
    const d = { step: null, msg_id: null, data: { title: '', dl: new Date(minute(Date.now() + 10 * 864e5)).toISOString(), rm: [4320, 1440, 60, 0], us: [u.id], nt: false, view: null } };
    const sent = await tgCall('sendMessage', { chat_id: chat, ...(await view(d)) });
    d.msg_id = sent.message_id; return saveDraft(chat, d);
  }
  const d = ready && await getDraft(chat);
  if (d && d.step && !text.startsWith('/')) { // ტექსტური შეყვანა: სახელი ან ვადა
    if (d.step === 'title') d.data.title = text.trim().slice(0, 200);
    else { const t = parseDt(text); if (!t) return sendTelegram(chat, 'ფორმატი არასწორია. მაგალითი: 25.11.2026 14:30 (წარსულში არ შეიძლება).'); d.data.dl = t.toISOString(); d.data.view = null; }
    d.step = null; await saveDraft(chat, d);
    tgCall('deleteMessage', { chat_id: chat, message_id: m.message_id }).catch(() => {});
    return refresh(chat, d, '');
  }
  await sendTelegram(chat, 'ახალი დავალებისთვის: /new');
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
        await call('setChatMenuButton', { menu_button: { type: 'commands' } }); // ძველი web_app ღილაკის მოხსნა
        await call('setMyCommands', { commands: [{ command: 'new', description: 'ახალი დავალება' }, { command: 'cancel', description: 'გაუქმება' }] });
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
