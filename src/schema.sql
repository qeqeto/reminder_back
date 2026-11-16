CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  telegram_chat_id BIGINT,
  link_code TEXT UNIQUE NOT NULL
);
CREATE TABLE IF NOT EXISTS documents (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  deadline DATE NOT NULL,
  remind_days INT[] NOT NULL DEFAULT '{7,3,1,0}'
);
CREATE TABLE IF NOT EXISTS document_users (
  document_id INT REFERENCES documents(id) ON DELETE CASCADE,
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (document_id, user_id)
);
CREATE TABLE IF NOT EXISTS reminder_log (
  document_id INT, user_id INT, channel TEXT, days_before INT,
  sent_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (document_id, user_id, channel, days_before)
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS created_by INT;
CREATE UNIQUE INDEX IF NOT EXISTS users_email_uq ON users (lower(email));
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
