// შეხსენებების ძრავა. მუშაობს API სერვერის შიგნით (ყოველ წუთში) და, სურვილისამებრ, Railway Cron-იდან: `npm run cron`.
const { pool, init } = require('./db');
const { sendEmail, sendTelegram } = require('./notify');
const TZ = process.env.TZ_NAME || 'Asia/Tbilisi';
const status = { lastRun: null, lastSent: 0, totalSent: 0, lastError: null, running: false };
const cool = new Map(); // ვერ გაგზავნილი შეხსენების ხელახალი ცდა 10 წუთის შემდეგ

const dur = secs => {
  const m = Math.round(Math.abs(secs) / 60), d = Math.floor(m / 1440), h = Math.floor(m % 1440 / 60), n = m % 60;
  return d ? `${d} დღე${h ? ` ${h} საათი` : ''}` : h ? `${h} საათი${n ? ` ${n} წუთი` : ''}` : `${n} წუთი`;
};
const offsetLabel = m => m === 0 ? 'ვადა ახლა დგება' : m % 1440 === 0 ? `ვადამდე დარჩა ${m / 1440} დღე` : m % 60 === 0 ? `ვადამდე დარჩა ${m / 60} საათი` : `ვადამდე დარჩა ${m} წუთი`;

async function dispatch(r, offset, text, ok) {
  const jobs = [];
  if (r.email) jobs.push(['email', () => sendEmail(r.email, `შეხსენება: ${r.title}`, text)]);
  if (r.telegram_chat_id) jobs.push(['telegram', () => sendTelegram(r.telegram_chat_id, '⏰ ' + text)]);
  for (const [ch, send] of jobs) {
    const ck = `${r.doc_id}:${r.user_id}:${ch}:${offset}`;
    if ((cool.get(ck) || 0) > Date.now()) continue;
    const ins = await pool.query(`INSERT INTO reminder_sent (document_id,user_id,channel,offset_min) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING 1`, [r.doc_id, r.user_id, ch, offset]);
    if (!ins.rowCount) continue; // უკვე გაგზავნილია
    try { await send(); ok.push(`✔ ${r.name} (${ch}) — ${r.title}`); }
    catch (e) {
      await pool.query('DELETE FROM reminder_sent WHERE document_id=$1 AND user_id=$2 AND channel=$3 AND offset_min=$4', [r.doc_id, r.user_id, ch, offset]);
      cool.set(ck, Date.now() + 10 * 60000);
      console.error(`შეხსენება ვერ გაიგზავნა (${r.name}, ${ch}): ${e.message}`);
    }
  }
}

async function runReminders() {
  const ok = [];
  // 1) ყოველდღიური შეხსენება არჩეულ დროს (ნაგულისხმევი 10:00), ვადის შემდეგაც 14 დღემდე, სანამ არ შესრულდება
  const daily = await pool.query(`
    SELECT d.id doc_id, d.title, to_char(d.deadline AT TIME ZONE $1,'DD.MM.YYYY HH24:MI') deadline_txt,
           EXTRACT(EPOCH FROM (d.deadline - now()))::float8 secs_left,
           ((now() AT TIME ZONE $1)::date - DATE '1970-01-01') day_key,
           u.id user_id, u.name, u.email, u.telegram_chat_id
    FROM documents d JOIN document_users du ON du.document_id=d.id JOIN users u ON u.id=du.user_id
    WHERE NOT d.done AND d.daily AND u.verified AND u.approved
      AND now() >= (((now() AT TIME ZONE $1)::date + d.daily_time) AT TIME ZONE $1)
      AND (((now() AT TIME ZONE $1)::date + d.daily_time) AT TIME ZONE $1) >= d.created_at
      AND d.deadline > now() - interval '14 days'`, [TZ]);
  for (const r of daily.rows) {
    const state = r.secs_left > 0 ? `ვადამდე დარჩა ${dur(r.secs_left)}` : `⚠️ ვადა გადაცილებულია: ${dur(r.secs_left)}`;
    await dispatch(r, -r.day_key, `გამარჯობა, ${r.name}!\n\nდოკუმენტი: "${r.title}"\nგადაგზავნის ვადა: ${r.deadline_txt}\n${state}.\n\nშესრულების შემდეგ მონიშნე ბოტში (/todo) ან საიტზე.`, ok);
  }
  // 2) ზუსტი შეხსენებები (მაგ. 1 საათით ადრე, ვადის დადგომისას); გამოტოვებული შეხსენება 1 დღემდე ინაზღაურება
  const exact = await pool.query(`
    SELECT d.id doc_id, d.title, to_char(d.deadline AT TIME ZONE $1,'DD.MM.YYYY HH24:MI') deadline_txt, t.m offset_min,
           u.id user_id, u.name, u.email, u.telegram_chat_id
    FROM documents d JOIN document_users du ON du.document_id=d.id JOIN users u ON u.id=du.user_id
    CROSS JOIN LATERAL unnest(d.remind_mins) AS t(m)
    WHERE NOT d.done AND u.verified AND u.approved
      AND now() >= d.deadline - (t.m * interval '1 minute')
      AND now() <  d.deadline - (t.m * interval '1 minute') + interval '1 day'
      AND d.deadline - (t.m * interval '1 minute') >= d.created_at`, [TZ]);
  for (const r of exact.rows)
    await dispatch(r, r.offset_min, `გამარჯობა, ${r.name}!\n\nდოკუმენტი: "${r.title}"\nგადაგზავნის ვადა: ${r.deadline_txt}\n${offsetLabel(r.offset_min)}.`, ok);

  if (ok.length && process.env.ADMIN_EMAIL) sendEmail(process.env.ADMIN_EMAIL, 'შეხსენებების ანგარიში', ok.join('\n')).catch(() => {});
  return ok;
}

let busy = false;
async function tick() {
  if (busy) return; busy = true; status.running = true;
  try { const ok = await runReminders(); status.lastRun = new Date().toISOString(); status.lastSent = ok.length; status.totalSent += ok.length; status.lastError = null; if (ok.length) console.log(ok.join('\n')); }
  catch (e) { status.lastError = e.message; console.error('scheduler', e.message); }
  finally { busy = false; status.running = false; }
}
function startScheduler() {
  if (process.env.DISABLE_SCHEDULER) return console.log('scheduler გამორთულია');
  setTimeout(tick, 15000); setInterval(tick, 60000); console.log('scheduler ჩაირთო (ყოველ წუთში)');
}

// ახლავე გაგზავნა: ყველა მონიშნულ დადასტურებულ მომხმარებელს, დუბლირების შემოწმების გარეშე
async function notifyDoc(docId, byName) {
  const { rows } = await pool.query(`
    SELECT d.title, to_char(d.deadline AT TIME ZONE $1,'DD.MM.YYYY HH24:MI') deadline_txt, u.name, u.email, u.telegram_chat_id
    FROM documents d JOIN document_users du ON du.document_id=d.id JOIN users u ON u.id=du.user_id
    WHERE d.id=$2 AND u.verified AND u.approved`, [TZ, docId]);
  const results = [];
  for (const r of rows) {
    const text = `გამარჯობა, ${r.name}!\n\n${byName} გახსენებს დოკუმენტს: "${r.title}"\nგადაგზავნის ვადა: ${r.deadline_txt}.`;
    const jobs = [];
    if (r.email) jobs.push(['email', () => sendEmail(r.email, `შეხსენება: ${r.title}`, text)]);
    if (r.telegram_chat_id) jobs.push(['telegram', () => sendTelegram(r.telegram_chat_id, '⏰ ' + text)]);
    if (!jobs.length) results.push({ name: r.name, channel: '—', ok: false, error: 'არც ელფოსტა აქვს, არც Telegram' });
    for (const [channel, send] of jobs) {
      try { await send(); results.push({ name: r.name, channel, ok: true }); }
      catch (e) { results.push({ name: r.name, channel, ok: false, error: e.message }); }
    }
  }
  return results;
}
module.exports = { runReminders, notifyDoc, startScheduler, status };

if (require.main === module) {
  init().then(runReminders).then(s => { console.log(s.join('\n') || 'გასაგზავნი არაფერია'); process.exit(0); })
    .catch(e => { console.error(e); process.exit(1); });
}
