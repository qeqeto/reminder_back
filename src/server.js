const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { pool, init } = require('./db');
const { startBot } = require('./bot');
const { runReminders } = require('./cron');
const { KEYS, SECRET: SECRETS, getSettings, setSetting } = require('./settings');
const { sendEmail } = require('./notify');

const app = express();
app.use(cors({ origin: process.env.FRONTEND_URL || true }));
app.use(express.json());
// Public health endpoint used by the frontend to distinguish an offline API from bad credentials.
app.get('/api/health', (_, res) => res.json({ ok: true, service: 'reminder-api' }));
const SECRET = process.env.JWT_SECRET || 'change-me';
if (process.env.NODE_ENV === 'production' && SECRET === 'change-me') console.warn('WARNING: set a strong JWT_SECRET in Railway variables.');

const wrap = fn => (req, res) => fn(req, res).catch(e => res.status(500).json({ error: e.message }));
const hash = pw => { const salt = crypto.randomBytes(8).toString('hex'); return salt + ':' + crypto.scryptSync(pw, salt, 32).toString('hex'); };
const verify = (pw, h) => { if (!h) return false; const [salt, k] = h.split(':'); return crypto.timingSafeEqual(Buffer.from(k, 'hex'), crypto.scryptSync(pw, salt, 32)); };
const sign = a => jwt.sign(a, SECRET, { expiresIn: '7d' });

app.post('/api/login', wrap(async (req, res) => {
  const { email, password } = req.body;
  if (email === process.env.ADMIN_EMAIL && password === process.env.ADMIN_PASSWORD)
    return res.json({ token: sign({ role: 'admin', id: 0 }) });
  const { rows } = await pool.query('SELECT id,password_hash FROM users WHERE lower(email)=lower($1)', [email || '']);
  if (rows[0] && verify(password || '', rows[0].password_hash)) return res.json({ token: sign({ role: 'user', id: rows[0].id }) });
  res.status(401).json({ error: 'არასწორი მონაცემები' });
}));

app.use('/api', (req, res, next) => {
  try { req.auth = jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), SECRET); next(); }
  catch { res.status(401).json({ error: 'საჭიროა შესვლა' }); }
});
const adminOnly = (req, res, next) => req.auth.role === 'admin' ? next() : res.status(403).json({ error: 'მხოლოდ ადმინისთვის' });

app.get('/api/me', wrap(async (req, res) => {
  const bot = (await getSettings()).TELEGRAM_BOT_USERNAME || null;
  if (req.auth.role === 'admin') return res.json({ role: 'admin', id: 0, name: 'ადმინი', bot });
  const { rows } = await pool.query('SELECT id,name,link_code,(telegram_chat_id IS NOT NULL) tg FROM users WHERE id=$1', [req.auth.id]);
  if (!rows[0]) return res.status(401).json({ error: 'მომხმარებელი ვერ მოიძებნა' });
  res.json({ role: 'user', bot, ...rows[0] });
}));

// --- მომხმარებლები ---
app.get('/api/users', wrap(async (req, res) => {
  const cols = req.auth.role === 'admin' ? 'id,name,email,link_code,(telegram_chat_id IS NOT NULL) tg' : 'id,name';
  const { rows } = await pool.query(`SELECT ${cols} FROM users ORDER BY name`);
  res.json({ users: rows });
}));
app.post('/api/users', adminOnly, wrap(async (req, res) => {
  const { name, email, password } = req.body;
  const { rows } = await pool.query('INSERT INTO users (name,email,password_hash,link_code) VALUES ($1,$2,$3,$4) RETURNING id',
    [name, email || null, password ? hash(password) : null, crypto.randomBytes(5).toString('hex')]);
  res.json(rows[0]);
}));
app.delete('/api/users/:id', adminOnly, wrap(async (req, res) => {
  await pool.query('DELETE FROM users WHERE id=$1', [req.params.id]); res.json({ ok: true });
}));

// --- დოკუმენტები: ყველა მომხმარებელს შეუძლია დამატება და სხვების მონიშვნა ---
app.get('/api/documents', wrap(async (req, res) => {
  const mine = req.auth.role === 'admin' ? '' :
    'WHERE d.created_by=$1 OR EXISTS (SELECT 1 FROM document_users x WHERE x.document_id=d.id AND x.user_id=$1)';
  const { rows } = await pool.query(`
    SELECT d.id,d.title,d.deadline::text deadline,d.remind_days,d.created_by,
      COALESCE(array_agg(du.user_id) FILTER (WHERE du.user_id IS NOT NULL),'{}') user_ids
    FROM documents d LEFT JOIN document_users du ON du.document_id=d.id
    ${mine} GROUP BY d.id ORDER BY d.deadline`, mine ? [req.auth.id] : []);
  res.json(rows);
}));
async function save(id, auth, { title, deadline, remind_days, user_ids = [] }) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    if (id) {
      const r = await c.query('UPDATE documents SET title=$1,deadline=$2,remind_days=$3 WHERE id=$4 AND ($5 OR created_by=$6)',
        [title, deadline, remind_days, id, auth.role === 'admin', auth.id]);
      if (!r.rowCount) throw new Error('ამ დოკუმენტის შეცვლა არ შეგიძლია');
    } else id = (await c.query('INSERT INTO documents (title,deadline,remind_days,created_by) VALUES ($1,$2,$3,$4) RETURNING id',
      [title, deadline, remind_days, auth.id])).rows[0].id;
    await c.query('DELETE FROM document_users WHERE document_id=$1', [id]);
    for (const u of user_ids) await c.query('INSERT INTO document_users VALUES ($1,$2)', [id, u]);
    await c.query('COMMIT'); return id;
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}
app.post('/api/documents', wrap(async (req, res) => res.json({ id: await save(null, req.auth, req.body) })));
app.put('/api/documents/:id', wrap(async (req, res) => res.json({ id: await save(req.params.id, req.auth, req.body) })));
app.delete('/api/documents/:id', wrap(async (req, res) => {
  const r = await pool.query('DELETE FROM documents WHERE id=$1 AND ($2 OR created_by=$3)', [req.params.id, req.auth.role === 'admin', req.auth.id]);
  if (!r.rowCount) return res.status(403).json({ error: 'ამ დოკუმენტის წაშლა არ შეგიძლია' });
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
