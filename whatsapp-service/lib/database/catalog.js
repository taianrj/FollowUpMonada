'use strict';

// This catalog is a server allowlist, not a schema supplied by callers.
const definitions = {
  profiles: ['id email name role is_active transcribe_audio interpret_images created_at', 'id'],
  clients: ['id name created_at', 'id'],
  collaborators: ['id name created_at', 'id'],
  statuses: ['id name color created_at', 'id'],
  tasks: ['id client_id description responsibles status observations created_by is_archived description_embedding description_embedding_model description_embedding_updated_at created_at updated_at', 'id'],
  task_history: ['id task_id changed_by changed_at action changes created_by_ai ai_provider ai_model', 'id'],
  whatsapp_summaries: ['id summary_date raw_text summary_data created_by created_at ai_provider ai_model', 'id'],
  whatsapp_summaries_duplicate_archive: ['original_id archived_at archival_reason summary_record', 'original_id'],
  whatsapp_contacts: ['user_id jid name type source updated_at', 'user_id,jid'],
  whatsapp_messages: ['user_id dedupe_key message_id chat_jid chat_number chat_aliases chat_name participant_jid participant_number participant_aliases display_name text from_me routing_status routing_issue is_forwarded quoted_message_id quoted_message_sender quoted_message_text message_timestamp message_date updated_at', 'user_id,dedupe_key'],
  whatsapp_sessions: ['id creds updated_at', 'id']
};
const jsonColumns = new Set(['responsibles', 'changes', 'summary_data', 'summary_record', 'chat_aliases', 'participant_aliases']);
const booleanColumns = new Set(['is_active', 'transcribe_audio', 'interpret_images', 'is_archived', 'created_by_ai', 'from_me', 'is_forwarded']);
const tables = Object.freeze(Object.fromEntries(Object.entries(definitions).map(([name, [columns, key]]) => [name, Object.freeze({ columns: columns.split(' '), key: key.split(',') })])));

function column(table, name) {
  if (!tables[table]?.columns.includes(name)) throw new Error('Coluna nao permitida.');
  return `"${name}"`;
}

function encodeValue(name, value) {
  if (value === undefined) throw new Error('Valor indefinido.');
  if (value === null) return null;
  if (booleanColumns.has(name)) {
    if (typeof value !== 'boolean') throw new Error('Valor booleano invalido.');
    return value ? 1 : 0;
  }
  if (jsonColumns.has(name)) return JSON.stringify(value);
  if (typeof value !== 'string' && typeof value !== 'number') throw new Error('Valor escalar invalido.');
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Numero invalido.');
  return value;
}

function decodeRow(row) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key,
    value === null ? null : booleanColumns.has(key) ? !!value : jsonColumns.has(key) ? JSON.parse(value) : value
  ]));
}

module.exports = { tables, column, encodeValue, decodeRow };
