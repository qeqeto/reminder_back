const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const init = () => pool.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
module.exports = { pool, init };
