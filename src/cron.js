// Railway Cron Service: Start Command = "npm run cron", Schedule = "*/10 * * * *" (ყოველ 10 წუთში)
const { pool, init } = require('./db');
const { sendEmail, sendTelegram } = require('./notify');
const TZ = process.env.TZ_NAME || 'Asia/Tbilisi';

const label = m => m === 0 ? 'ვადა ახლა დგება' : m % 1440 === 0 ? `ვადამდე დარჩა ${m / 1440} დღე` : m % 60 === 0 ? `ვადამდე დარჩა ${m / 60} საათი` : `ვადამდე დარჩა ${m} წუთი`;

async function runReminders() {
  // გასაგზავნია, თუ შეხსენების მომენტი დადგა და ბოლო 90 წუთშია (ძველი, გამოტოვებული შეხსენებები აღარ იგზავნება)
  const { rows } = await pool.query(`
    SELECT d.id doc_id, d.title, to_char(d.deadline AT TIME ZONE $1,'DD.MM.YYYY HH24:MI') deadline_txt,
           t.m offset_min, u.id user_id, u.name, u.email, u.telegram_chat_id
    FROM documents d
    JOIN document_users du ON du.document_id = d.id
    JOIN users u ON u.id = du.user_id
    CROSS JOIN LATERAL unnest(d.remind_mins) AS t(m)
    WHERE NOT d.done AND u.verified
      AND now() >= d.deadline - (t.m * interval '1 minute')
      AND now() <  d.deadline - (t.m * interval '1 minute') + interval '90 minutes'`, [TZ]);

  const summary = [];
  for (const r of rows) {
    const text = `გამარჯობა, ${r.name}!\n\nდოკუმენტი: "${r.title}"\nგადაგზავნის ვადა: ${r.deadline_txt}\n${label(r.offset_min)}.`;
    const channels = [];
    if (r.email) channels.push(['email', () => sendEmail(r.email, `შეხსენება: ${r.title}`, text)]);
    if (r.telegram_chat_id) channels.push(['telegram', () => sendTelegram(r.telegram_chat_id, '⏰ ' + text)]);
    for (const [ch, send] of channels) {
      const ins = await pool.query(
        `INSERT INTO reminder_sent (document_id,user_id,channel,offset_min) VALUES ($1,$2,$3,$4)
         ON CONFLICT DO NOTHING RETURNING 1`, [r.doc_id, r.user_id, ch, r.offset_min]);
      if (!ins.rowCount) continue; // უკვე გაგზავნილია
      try { await send(); summary.push(`✔ ${r.name} (${ch}) — ${r.title}`); }
      catch (e) {
        await pool.query('DELETE FROM reminder_sent WHERE document_id=$1 AND user_id=$2 AND channel=$3 AND offset_min=$4',
          [r.doc_id, r.user_id, ch, r.offset_min]);
        summary.push(`✘ ${r.name} (${ch}) — ${e.message}`);
      }
    }
  }
  if (summary.length && process.env.ADMIN_EMAIL) {
    try { await sendEmail(process.env.ADMIN_EMAIL, 'შეხსენებების ანგარიში', summary.join('\n')); } catch {}
  }
  return summary;
}
// ახლავე გაგზავნა: ყველა მონიშნულ დადასტურებულ მომხმარებელს, დუბლირების შემოწმების გარეშე
async function notifyDoc(docId, byName) {
  const { rows } = await pool.query(`
    SELECT d.title, to_char(d.deadline AT TIME ZONE $1,'DD.MM.YYYY HH24:MI') deadline_txt, d.deadline,
           u.name, u.email, u.telegram_chat_id
    FROM documents d JOIN document_users du ON du.document_id=d.id JOIN users u ON u.id=du.user_id
    WHERE d.id=$2 AND u.verified`, [TZ, docId]);
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
module.exports = { runReminders, notifyDoc };

if (require.main === module) {
  init().then(runReminders).then(s => { console.log(s.join('\n') || 'გასაგზავნი არაფერია'); process.exit(0); })
    .catch(e => { console.error(e); process.exit(1); });
}
