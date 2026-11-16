// Railway Cron Service: Start Command = "npm run cron", Schedule = "0 5 * * *" (UTC = 09:00 თბილისი)
const { pool, init } = require('./db');
const { sendEmail, sendTelegram } = require('./notify');

async function runReminders() {
  const { rows } = await pool.query(`
    SELECT d.id doc_id, d.title, d.deadline::text deadline, d.remind_days,
           (d.deadline - (now() AT TIME ZONE 'Asia/Tbilisi')::date) AS days_left,
           u.id user_id, u.name, u.email, u.telegram_chat_id
    FROM documents d
    JOIN document_users du ON du.document_id = d.id
    JOIN users u ON u.id = du.user_id
    WHERE (d.deadline - (now() AT TIME ZONE 'Asia/Tbilisi')::date) = ANY(d.remind_days)`);

  const summary = [];
  for (const r of rows) {
    const when = r.days_left === 0 ? 'დღეს' : `${r.days_left} დღეში`;
    const text = `გამარჯობა, ${r.name}!\n\nდოკუმენტის "${r.title}" გადაგზავნის ბოლო ვადაა ${r.deadline} (${when}).`;
    const channels = [];
    if (r.email) channels.push(['email', () => sendEmail(r.email, `შეხსენება: ${r.title}`, text)]);
    if (r.telegram_chat_id) channels.push(['telegram', () => sendTelegram(r.telegram_chat_id, '⏰ ' + text)]);
    for (const [ch, send] of channels) {
      const ins = await pool.query(
        `INSERT INTO reminder_log (document_id,user_id,channel,days_before) VALUES ($1,$2,$3,$4)
         ON CONFLICT DO NOTHING RETURNING 1`, [r.doc_id, r.user_id, ch, r.days_left]);
      if (!ins.rowCount) continue; // უკვე გაგზავნილია
      try { await send(); summary.push(`✔ ${r.name} (${ch}) — ${r.title}`); }
      catch (e) {
        await pool.query('DELETE FROM reminder_log WHERE document_id=$1 AND user_id=$2 AND channel=$3 AND days_before=$4',
          [r.doc_id, r.user_id, ch, r.days_left]);
        summary.push(`✘ ${r.name} (${ch}) — ${e.message}`);
      }
    }
  }
  if (summary.length && process.env.ADMIN_EMAIL) {
    try { await sendEmail(process.env.ADMIN_EMAIL, 'შეხსენებების ანგარიში', summary.join('\n')); } catch {}
  }
  return summary;
}
module.exports = { runReminders };

if (require.main === module) {
  init().then(runReminders).then(s => { console.log(s.join('\n') || 'გასაგზავნი არაფერია'); process.exit(0); })
    .catch(e => { console.error(e); process.exit(1); });
}
