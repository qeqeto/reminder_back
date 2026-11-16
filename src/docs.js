const { pool } = require('./db');
async function createDoc({ title, deadline, remind_mins, user_ids }, createdBy) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const id = (await c.query('INSERT INTO documents (title,deadline,remind_mins,created_by) VALUES ($1,$2,$3,$4) RETURNING id',
      [title.trim(), deadline, remind_mins, createdBy])).rows[0].id;
    for (const u of user_ids) await c.query('INSERT INTO document_users VALUES ($1,$2)', [id, u]);
    await c.query('COMMIT'); return id;
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}
module.exports = { createDoc };
