const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { pool, init } = require('./db');
const { startBot } = require('./bot');
const { runReminders, notifyDoc } = require('./cron');
const { KEYS, SECRET: SECRETS, getSettings, setSetting } = require('./settings');
const { sendEmail, sendTelegram } = require('./notify');

const app = express();
app.use(cors({ origin: process.env.FRONTEND_URL || true }));
app.use(express.json());
const SECRET = process.env.JWT_SECRET || 'change-me';

const wrap = fn => (req, res) => fn(req, res).catch(e => res.status(e.code === '23505' ? 409 : 500).json({ error: e.code === '23505' ? 'ეს ელფოსტა უკვე რეგისტრირებულია' : e.message }));
const hash = pw => { const salt = crypto.randomBytes(8).toString('hex'); return salt + ':' + crypto.scryptSync(pw, salt, 32).toString('hex'); };
const verify = (pw, h) => { if (!h) return false; const [salt, k] = h.split(':'); return crypto.timingSafeEqual(Buffer.from(k, 'hex'), crypto.scryptSync(pw, salt, 32)); };
const sign = (a, exp = '7d') => jwt.sign(a, SECRET, { expiresIn: exp });
const bearer = req => (req.headers.authorization || '').replace('Bearer ', '');
const smtpReady = async () => { const s = await getSettings(); return !!(s.SMTP_HOST && s.SMTP_USER && s.SMTP_PASS); };
const tgReady = async () => { const s = await getSettings(); return !!(s.TELEGRAM_BOT_TOKEN && s.TELEGRAM_BOT_USERNAME); };
const methods = async () => ({ email: await smtpReady(), telegram: await tgReady() });
const bad = (res, code, error, extra = {}) => res.status(code).json({ error, ...extra });

app.get('/api/health', (_, res) => res.json({ ok: true, service: 'reminder-api' }));
app.get('/api/public/config', wrap(async (_, res) => res.json(await methods())));

app.post('/api/login', wrap(async (req, res) => {
  const { email, password } = req.body;
  if (email === process.env.ADMIN_EMAIL && password === process.env.ADMIN_PASSWORD)
    return res.json({ token: sign({ role: 'admin', id: 0 }) });
  const { rows } = await pool.query('SELECT id,password_hash,verified,approved FROM users WHERE lower(email)=lower($1)', [email || '']);
  if (!rows[0] || !verify(password || '', rows[0].password_hash)) return bad(res, 401, 'არასწორი ელფოსტა ან პაროლი');
  if (!rows[0].verified) return bad(res, 403, 'ანგარიში ჯერ დაუდასტურებელია', { pending: sign({ scope: 'verify', id: rows[0].id }, '15m'), methods: await methods() });
  if (!rows[0].approved) return bad(res, 403, 'ანგარიში დადასტურებულია, მაგრამ ჯერ ადმინის დამტკიცებას ელოდება');
  res.json({ token: sign({ role: 'user', id: rows[0].id }) });
}));

// --- თვითრეგისტრაცია და ვერიფიკაცია ---
app.post('/api/register', wrap(async (req, res) => {
  const { name, email, password } = req.body;
  if (!name?.trim() || !/^\S+@\S+\.\S+$/.test(email || '')) return bad(res, 400, 'შეავსე სახელი და სწორი ელფოსტა');
  if (!password || password.length < 8) return bad(res, 400, 'პაროლი მინიმუმ 8 სიმბოლო უნდა იყოს');
  const { rows } = await pool.query('INSERT INTO users (name,email,password_hash,link_code,verified,approved) VALUES ($1,$2,$3,$4,false,false) RETURNING id',
    [name.trim(), email.trim(), hash(password), crypto.randomBytes(5).toString('hex')]);
  res.json({ pending: sign({ scope: 'verify', id: rows[0].id }, '15m'), methods: await methods() });
}));

const pending = (req, res, next) => {
  try { const a = jwt.verify(bearer(req), SECRET); if (a.scope !== 'verify') throw 0; req.uid = a.id; next(); }
  catch { bad(res, 401, 'ვერიფიკაციის სესია ამოიწურა, შედი თავიდან'); }
};
app.post('/api/verify/email/send', pending, wrap(async (req, res) => {
  if (!(await smtpReady())) return bad(res, 400, 'ელფოსტით დადასტურება ჩართული არ არის');
  const { rows } = await pool.query('SELECT email,verify_sent_at FROM users WHERE id=$1', [req.uid]);
  if (rows[0].verify_sent_at && Date.now() - new Date(rows[0].verify_sent_at) < 60000) return bad(res, 429, 'ახალი კოდი 1 წუთში ერთხელ შეგიძლია მოითხოვო');
  const code = String(crypto.randomInt(100000, 1000000));
  await pool.query(`UPDATE users SET verify_code=$1, verify_expires=now()+interval '10 minutes', verify_attempts=0, verify_sent_at=now() WHERE id=$2`,
    [crypto.createHash('sha256').update(code + ':' + req.uid).digest('hex'), req.uid]);
  await sendEmail(rows[0].email, 'დადასტურების კოდი', `შენი დადასტურების კოდია: ${code}\nკოდი 10 წუთის განმავლობაში მოქმედებს.`);
  res.json({ ok: true });
}));
app.post('/api/verify/email/confirm', pending, wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT verify_code,verify_expires,verify_attempts FROM users WHERE id=$1', [req.uid]);
  const u = rows[0];
  if (!u?.verify_code || new Date(u.verify_expires) < new Date()) return bad(res, 400, 'კოდი ვადაგასულია, გამოითხოვე ახალი');
  if (u.verify_attempts >= 5) return bad(res, 429, 'ცდები ამოიწურა, გამოითხოვე ახალი კოდი');
  const h = crypto.createHash('sha256').update(String(req.body.code || '').trim() + ':' + req.uid).digest('hex');
  if (h !== u.verify_code) { await pool.query('UPDATE users SET verify_attempts=verify_attempts+1 WHERE id=$1', [req.uid]); return bad(res, 400, 'კოდი არასწორია'); }
  const a = await pool.query('UPDATE users SET verified=true, verify_code=NULL WHERE id=$1 RETURNING approved', [req.uid]);
  res.json(a.rows[0].approved ? { token: sign({ role: 'user', id: req.uid }) } : { waiting: true });
}));
app.post('/api/verify/telegram/start', pending, wrap(async (req, res) => {
  const s = await getSettings();
  if (!(await tgReady())) return bad(res, 400, 'Telegram-ით დადასტურება ჩართული არ არის');
  const t = crypto.randomBytes(12).toString('hex');
  await pool.query('UPDATE users SET tg_verify_token=$1 WHERE id=$2', [t, req.uid]);
  res.json({ link: `https://t.me/${s.TELEGRAM_BOT_USERNAME}?start=v_${t}` });
}));
app.get('/api/verify/status', pending, wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT verified,approved FROM users WHERE id=$1', [req.uid]);
  res.json(rows[0]?.verified ? { verified: true, ...(rows[0].approved ? { token: sign({ role: 'user', id: req.uid }) } : { waiting: true }) } : { verified: false });
}));

app.use('/api', (req, res, next) => {
  try { req.auth = jwt.verify(bearer(req), SECRET); if (!['admin', 'user'].includes(req.auth.role)) throw 0; next(); }
  catch { bad(res, 401, 'საჭიროა შესვლა'); }
});
const adminOnly = (req, res, next) => req.auth.role === 'admin' ? next() : bad(res, 403, 'მხოლოდ ადმინისთვის');

app.get('/api/me', wrap(async (req, res) => {
  const bot = (await getSettings()).TELEGRAM_BOT_USERNAME || null;
  if (req.auth.role === 'admin') return res.json({ role: 'admin', id: 0, name: 'ადმინი', email: process.env.ADMIN_EMAIL, bot });
  const { rows } = await pool.query('SELECT id,name,email,link_code,(telegram_chat_id IS NOT NULL) tg FROM users WHERE id=$1 AND approved', [req.auth.id]);
  if (!rows[0]) return bad(res, 401, 'მომხმარებელი ვერ მოიძებნა');
  res.json({ role: 'user', bot, ...rows[0] });
}));
app.post('/api/me/password', wrap(async (req, res) => {
  if (req.auth.role !== 'user') return bad(res, 400, 'ადმინის პაროლი Railway Variables-ში იცვლება');
  const { old, next } = req.body;
  if (!next || next.length < 8) return bad(res, 400, 'ახალი პაროლი მინიმუმ 8 სიმბოლო უნდა იყოს');
  const { rows } = await pool.query('SELECT password_hash FROM users WHERE id=$1', [req.auth.id]);
  if (rows[0].password_hash && !verify(old || '', rows[0].password_hash)) return bad(res, 400, 'ძველი პაროლი არასწორია');
  await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash(next), req.auth.id]);
  res.json({ ok: true });
}));

// --- მომხმარებლები ---
app.get('/api/users', wrap(async (req, res) => {
  const cols = req.auth.role === 'admin' ? 'id,name,email,link_code,verified,approved,(telegram_chat_id IS NOT NULL) tg' : 'id,name';
  const { rows } = await pool.query(`SELECT ${cols} FROM users ${req.auth.role === 'admin' ? '' : 'WHERE approved AND verified'} ORDER BY name`);
  res.json({ users: rows });
}));
app.post('/api/users', adminOnly, wrap(async (req, res) => {
  const { name, email, password } = req.body;
  const { rows } = await pool.query('INSERT INTO users (name,email,password_hash,link_code) VALUES ($1,$2,$3,$4) RETURNING id',
    [name, email || null, password ? hash(password) : null, crypto.randomBytes(5).toString('hex')]);
  res.json(rows[0]);
}));
app.post('/api/users/:id/approve', adminOnly, wrap(async (req, res) => {
  const { rows } = await pool.query('UPDATE users SET verified=true, approved=true WHERE id=$1 RETURNING name,email,telegram_chat_id', [req.params.id]);
  const u = rows[0];
  if (u) { // შეტყობინება დამტკიცების შესახებ (შეცდომა არ არის კრიტიკული)
    const msg = `${u.name}, შენი ანგარიში დამტკიცდა ✅ ახლა შეგიძლია შეხვიდე სისტემაში.`;
    if (u.telegram_chat_id) sendTelegram(u.telegram_chat_id, msg).catch(() => {});
    if (u.email) sendEmail(u.email, 'ანგარიში დამტკიცდა', msg).catch(() => {});
  }
  res.json({ ok: true });
}));
app.delete('/api/users/:id', adminOnly, wrap(async (req, res) => {
  await pool.query('DELETE FROM users WHERE id=$1', [req.params.id]); res.json({ ok: true });
}));

// --- დოკუმენტები: ყველას შეუძლია შექმნა და სხვების მონიშვნა; ვადა = თარიღი + დრო ---
const canAct = `($3 OR created_by=$4 OR EXISTS (SELECT 1 FROM document_users x WHERE x.document_id=$2 AND x.user_id=$4))`;
app.get('/api/documents', wrap(async (req, res) => {
  const mine = req.auth.role === 'admin' ? '' :
    'WHERE d.created_by=$1 OR EXISTS (SELECT 1 FROM document_users x WHERE x.document_id=d.id AND x.user_id=$1)';
  const { rows } = await pool.query(`
    SELECT d.id,d.title,d.deadline,d.remind_mins,d.created_by,d.done,d.done_at,d.done_by_name,d.postponed_count,cu.name creator_name,
      COALESCE(array_agg(du.user_id) FILTER (WHERE du.user_id IS NOT NULL),'{}') user_ids
    FROM documents d LEFT JOIN users cu ON cu.id=d.created_by LEFT JOIN document_users du ON du.document_id=d.id
    ${mine} GROUP BY d.id,cu.name ORDER BY d.deadline`, mine ? [req.auth.id] : []);
  res.json(rows);
}));
async function save(id, auth, { title, deadline, remind_mins, user_ids = [] }) {
  const dl = deadline ? new Date(deadline) : new Date(Date.now() + 10 * 864e5); // ნაგულისხმევი: 10 დღე
  if (isNaN(dl)) throw new Error('არასწორი თარიღი');
  const rm = (Array.isArray(remind_mins) ? remind_mins : [4320, 1440, 60, 0]).map(Number).filter(n => Number.isInteger(n) && n >= 0);
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    if (id) {
      const old = (await c.query('SELECT deadline FROM documents WHERE id=$1', [id])).rows[0];
      const r = await c.query('UPDATE documents SET title=$1,deadline=$2,remind_mins=$3 WHERE id=$4 AND ($5 OR created_by=$6)',
        [title, dl.toISOString(), rm, id, auth.role === 'admin', auth.id]);
      if (!r.rowCount) throw new Error('ამ დოკუმენტის შეცვლა არ შეგიძლია');
      if (!old || +new Date(old.deadline) !== +dl) await c.query('DELETE FROM reminder_sent WHERE document_id=$1', [id]);
    } else id = (await c.query('INSERT INTO documents (title,deadline,remind_mins,created_by) VALUES ($1,$2,$3,$4) RETURNING id',
      [title, dl.toISOString(), rm, auth.id])).rows[0].id;
    await c.query('DELETE FROM document_users WHERE document_id=$1', [id]);
    for (const u of user_ids) await c.query('INSERT INTO document_users VALUES ($1,$2)', [id, u]);
    await c.query('COMMIT'); return id;
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}
const nameOf = async auth => auth.role === 'admin' ? 'ადმინი' : (await pool.query('SELECT name FROM users WHERE id=$1', [auth.id])).rows[0]?.name || 'მომხმარებელი';
app.post('/api/documents', wrap(async (req, res) => {
  const id = await save(null, req.auth, req.body);
  res.json({ id, results: req.body.notify ? await notifyDoc(id, await nameOf(req.auth)) : null });
}));
// ახლავე გაგზავნა (შემქმნელი, მონიშნული პირი ან ადმინი; 30 წამში ერთხელ თითო დავალებაზე)
const lastNotify = new Map();
app.post('/api/documents/:id/notify', wrap(async (req, res) => {
  const id = +req.params.id;
  const ok = await pool.query(`SELECT 1 FROM documents WHERE id=$1 AND ($2 OR created_by=$3 OR EXISTS (SELECT 1 FROM document_users x WHERE x.document_id=$1 AND x.user_id=$3))`,
    [id, req.auth.role === 'admin', req.auth.id]);
  if (!ok.rowCount) return bad(res, 403, 'ამ დავალებაზე უფლება არ გაქვს');
  if (Date.now() - (lastNotify.get(id) || 0) < 30000) return bad(res, 429, 'ახლახან გაიგზავნა, მოიცადე 30 წამი');
  lastNotify.set(id, Date.now());
  res.json({ results: await notifyDoc(id, await nameOf(req.auth)) });
}));
app.put('/api/documents/:id', wrap(async (req, res) => res.json({ id: await save(req.params.id, req.auth, req.body) })));

// შესრულებულად მონიშვნა: საკმარისია ერთი მონიშნული პირი (ან შემქმნელი/ადმინი)
app.put('/api/documents/:id/done', wrap(async (req, res) => {
  const name = req.auth.role === 'admin' ? 'ადმინი' : (await pool.query('SELECT name FROM users WHERE id=$1', [req.auth.id])).rows[0]?.name;
  const done = !!req.body.done;
  const r = await pool.query(`UPDATE documents SET done=$1, done_at=CASE WHEN $1 THEN now() END, done_by_name=CASE WHEN $1 THEN $5::text END
    WHERE id=$2 AND ${canAct}`, [done, req.params.id, req.auth.role === 'admin', req.auth.id, name]);
  if (!r.rowCount) return bad(res, 403, 'ამ დავალებაზე უფლება არ გაქვს');
  res.json({ ok: true });
}));
// გადადება / ვადის შეცვლა (შემქმნელი, მონიშნული პირი ან ადმინი)
app.put('/api/documents/:id/deadline', wrap(async (req, res) => {
  const dl = new Date(req.body.deadline);
  if (isNaN(dl)) return bad(res, 400, 'არასწორი თარიღი');
  const r = await pool.query(`UPDATE documents SET deadline=$1::timestamptz,
      postponed_count = postponed_count + (CASE WHEN $1::timestamptz > deadline THEN 1 ELSE 0 END)
    WHERE id=$2 AND ${canAct}`, [dl.toISOString(), req.params.id, req.auth.role === 'admin', req.auth.id]);
  if (!r.rowCount) return bad(res, 403, 'ამ დავალებაზე უფლება არ გაქვს');
  await pool.query('DELETE FROM reminder_sent WHERE document_id=$1', [req.params.id]);
  res.json({ ok: true });
}));
app.delete('/api/documents/:id', wrap(async (req, res) => {
  const r = await pool.query('DELETE FROM documents WHERE id=$1 AND ($2 OR created_by=$3)', [req.params.id, req.auth.role === 'admin', req.auth.id]);
  if (!r.rowCount) return bad(res, 403, 'ამ დოკუმენტის წაშლა არ შეგიძლია');
  res.json({ ok: true });
}));

// --- პარამეტრები (მხოლოდ ადმინი): SMTP და Telegram ---
app.get('/api/settings', adminOnly, wrap(async (_, res) => {
  const s = await getSettings(), values = {}, has = {};
  for (const k of KEYS) { if (SECRETS.includes(k)) has[k] = !!s[k]; else values[k] = s[k]; }
  res.json({ values, has });
}));
app.put('/api/settings', adminOnly, wrap(async (req, res) => {
  const b = req.body;
  for (const k of KEYS) {
    if (b[k] === undefined || k === 'TELEGRAM_BOT_USERNAME') continue;
    const v = String(b[k]).trim();
    if (SECRETS.includes(k) && v === '') continue; // ცარიელი საიდუმლო = არ შეიცვალოს
    if (k === 'TELEGRAM_BOT_TOKEN') {
      const r = await fetch(`https://api.telegram.org/bot${v}/getMe`).then(x => x.json()).catch(() => ({}));
      if (!r.ok) return res.status(400).json({ error: 'Telegram ტოკენი არასწორია' });
      await setSetting('TELEGRAM_BOT_USERNAME', r.result.username);
    }
    await setSetting(k, v);
  }
  res.json({ ok: true });
}));
app.post('/api/settings/test-email', adminOnly, wrap(async (req, res) => {
  const to = req.body.to || process.env.ADMIN_EMAIL;
  await sendEmail(to, 'სატესტო მეილი', 'SMTP სწორად მუშაობს ✅');
  res.json({ ok: true, to });
}));

// ხელით გაშვება (ტესტისთვის)
app.post('/api/run-reminders', adminOnly, wrap(async (_, res) => res.json({ log: await runReminders() })));

init().then(() => {
  app.listen(process.env.PORT || 3000, () => console.log('API მზადაა'));
  startBot();
});
