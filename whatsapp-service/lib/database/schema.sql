-- D1 schema v1. Additive; application IDs survive provider changes.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS monada_auth_users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_hash TEXT,
  email_confirmed_at TEXT,
  last_sign_in_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY REFERENCES monada_auth_users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  name TEXT,
  role TEXT NOT NULL DEFAULT 'collaborator' CHECK (role IN ('admin','collaborator')),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  transcribe_audio INTEGER NOT NULL DEFAULT 1 CHECK (transcribe_audio IN (0,1)),
  interpret_images INTEGER NOT NULL DEFAULT 0 CHECK (interpret_images IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS collaborators (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS statuses (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, color TEXT NOT NULL DEFAULT '#8b5cf6',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  responsibles TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(responsibles)),
  status TEXT NOT NULL REFERENCES statuses(id) ON UPDATE CASCADE,
  observations TEXT NOT NULL DEFAULT '',
  created_by TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  is_archived INTEGER NOT NULL DEFAULT 0 CHECK (is_archived IN (0,1)),
  description_embedding TEXT,
  description_embedding_model TEXT,
  description_embedding_updated_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_tasks_client ON tasks(client_id,is_archived);
CREATE TRIGGER IF NOT EXISTS tasks_embedding_invalidation
AFTER UPDATE OF description ON tasks WHEN NEW.description IS NOT OLD.description
BEGIN
  UPDATE tasks SET description_embedding=NULL, description_embedding_model=NULL,
    description_embedding_updated_at=NULL WHERE id=NEW.id;
END;
CREATE TABLE IF NOT EXISTS task_history (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  changed_by TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  changed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  action TEXT NOT NULL,
  changes TEXT CHECK (changes IS NULL OR json_valid(changes)),
  created_by_ai INTEGER NOT NULL DEFAULT 0 CHECK (created_by_ai IN (0,1)),
  ai_provider TEXT, ai_model TEXT
);
CREATE INDEX IF NOT EXISTS idx_task_history_task ON task_history(task_id,changed_at);
CREATE TABLE IF NOT EXISTS whatsapp_summaries (
  id TEXT PRIMARY KEY, summary_date TEXT NOT NULL,
  raw_text TEXT NOT NULL,
  summary_data TEXT NOT NULL CHECK (json_valid(summary_data)),
  created_by TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ai_provider TEXT, ai_model TEXT,
  UNIQUE (created_by,summary_date)
);
CREATE INDEX IF NOT EXISTS idx_summaries_user_date ON whatsapp_summaries(created_by,summary_date);
CREATE TABLE IF NOT EXISTS whatsapp_summaries_duplicate_archive (
  original_id TEXT PRIMARY KEY,
  archived_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  archival_reason TEXT NOT NULL,
  summary_record TEXT NOT NULL CHECK (json_valid(summary_record))
);
CREATE TABLE IF NOT EXISTS whatsapp_contacts (
  user_id TEXT NOT NULL, jid TEXT NOT NULL, name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'contact' CHECK (type IN ('contact','group')),
  source TEXT, updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id,jid)
);
CREATE TABLE IF NOT EXISTS whatsapp_messages (
  user_id TEXT NOT NULL, dedupe_key TEXT NOT NULL, message_id TEXT,
  chat_jid TEXT NOT NULL, chat_number TEXT NOT NULL,
  chat_aliases TEXT NOT NULL DEFAULT '[]', chat_name TEXT,
  participant_jid TEXT, participant_number TEXT,
  participant_aliases TEXT NOT NULL DEFAULT '[]', display_name TEXT,
  text TEXT NOT NULL, from_me INTEGER NOT NULL DEFAULT 0,
  routing_status TEXT NOT NULL DEFAULT 'legacy', routing_issue TEXT,
  is_forwarded INTEGER NOT NULL DEFAULT 0,
  quoted_message_id TEXT, quoted_message_sender TEXT, quoted_message_text TEXT,
  message_timestamp TEXT NOT NULL, message_date TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id,dedupe_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_identity ON whatsapp_messages(user_id,message_id)
  WHERE message_id IS NOT NULL AND message_id <> '';
CREATE INDEX IF NOT EXISTS idx_messages_user_date ON whatsapp_messages(user_id,message_date,message_timestamp);
CREATE TABLE IF NOT EXISTS whatsapp_sessions (
  id TEXT PRIMARY KEY, creds TEXT NOT NULL, updated_at TEXT NOT NULL
);
-- Large persistence blobs are chunked before reaching D1's 2 MB row limit.
CREATE TABLE IF NOT EXISTS monada_blob_chunks (
  session_id TEXT NOT NULL REFERENCES whatsapp_sessions(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL, content TEXT NOT NULL,
  PRIMARY KEY (session_id,chunk_index)
);
CREATE TABLE IF NOT EXISTS monada_auth_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES monada_auth_users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL, purpose TEXT NOT NULL CHECK (purpose IN ('session','recovery'))
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON monada_auth_sessions(user_id);
CREATE TABLE IF NOT EXISTS monada_auth_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES monada_auth_users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('invite','recovery')),
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS monada_auth_attempts (
  bucket TEXT PRIMARY KEY, attempts INTEGER NOT NULL DEFAULT 0, window_start INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS monada_migrations (
  id TEXT PRIMARY KEY, applied_at TEXT NOT NULL
);
