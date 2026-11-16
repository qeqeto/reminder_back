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
ALTER TABLE users ADD COLUMN IF NOT EXISTS verified BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE users ADD COLUMN IF NOT EXISTS verify_code TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS verify_expires TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS verify_attempts INT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS verify_sent_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS tg_verify_token TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS done BOOLEAN NOT NULL DEFAULT false;
DO $$ BEGIN
  IF (SELECT data_type FROM information_schema.columns WHERE table_name='documents' AND column_name='deadline')='date' THEN
    ALTER TABLE documents ALTER COLUMN deadline TYPE TIMESTAMPTZ USING ((deadline + time '18:00') AT TIME ZONE 'Asia/Tbilisi');
  END IF;
END $$;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS remind_mins INT[] NOT NULL DEFAULT '{4320,1440,60,0}';
ALTER TABLE documents ADD COLUMN IF NOT EXISTS done_at TIMESTAMPTZ;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS done_by_name TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS postponed_count INT NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS reminder_sent (
  document_id INT REFERENCES documents(id) ON DELETE CASCADE, user_id INT, channel TEXT, offset_min INT,
  sent_at TIMESTAMPTZ DEFAULT now(), PRIMARY KEY (document_id, user_id, channel, offset_min)
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS approved BOOLEAN NOT NULL DEFAULT true;
CREATE TABLE IF NOT EXISTS bot_drafts (chat_id BIGINT PRIMARY KEY, step TEXT, data JSONB NOT NULL, msg_id INT, updated_at TIMESTAMPTZ DEFAULT now());
