const express = require('express');
// Polyfill para garantir que a Web Crypto API esteja no escopo global (necessário para versões do Node < 19)
if (!global.crypto) {
  try {
    global.crypto = require('crypto').webcrypto || require('crypto');
  } catch (e) {
    console.error('Falha ao inicializar polyfill do crypto:', e);
  }
}

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

const app = express();
const port = process.env.PORT || 8080;
app.use(express.json({ limit: '1mb' }));

// Configuração do diretório de dados persistentes
const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
const authDir = path.join(dataDir, 'auth');
const contactsDir = path.join(dataDir, 'contacts');

// Garante que os diretórios existam
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(authDir, { recursive: true });
fs.mkdirSync(contactsDir, { recursive: true });

// Tenta carregar variáveis do .env.local do projeto pai se rodando localmente
if (!process.env.SUPABASE_URL) {
  try {
    const dotenvPath = path.join(__dirname, '..', '.env.local');
    if (fs.existsSync(dotenvPath)) {
      const dotenvContent = fs.readFileSync(dotenvPath, 'utf8');
      dotenvContent.split('\n').forEach(line => {
        const parts = line.split('=');
        if (parts.length >= 2) {
          const key = parts[0].trim();
          const val = parts.slice(1).join('=').trim().replace(/^['"]|['"]$/g, '');
          if (key === 'NEXT_PUBLIC_SUPABASE_URL') process.env.SUPABASE_URL = val;
          if (key === 'NEXT_PUBLIC_SUPABASE_ANON_KEY') process.env.SUPABASE_KEY = val;
          if (key === 'SUPABASE_SERVICE_ROLE_KEY') process.env.SUPABASE_SERVICE_ROLE_KEY = val;
        }
      });
    }
  } catch (err) {
    console.warn('Aviso: Não foi possível carregar o arquivo .env.local localmente.', err);
  }
}

// Funções de Persistência de Credenciais do WhatsApp no Supabase
async function saveCredsToSupabase(userId, creds) {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  
  if (!supabaseUrl || !supabaseKey) {
    return;
  }

  const cleanUrl = supabaseUrl.replace(/\/$/, '');
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 4000); // 4 segundos de timeout para evitar travamento em flutuações de rede

  try {
    const credsString = JSON.stringify(creds);
    const response = await fetch(`${cleanUrl}/rest/v1/whatsapp_sessions`, {
      method: 'POST',
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-dupes'
      },
      body: JSON.stringify({
        id: userId,
        creds: credsString,
        updated_at: new Date().toISOString()
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errText = await response.text();
      console.error(`[${userId}] Erro ao salvar credenciais no Supabase:`, response.status, errText);
    }
  } catch (err) {
    clearTimeout(timeoutId);
    console.error(`[${userId}] Erro de rede ao conectar com o Supabase para backup:`, err.message || err);
  }
}

async function loadCredsFromSupabase(userId) {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  
  if (!supabaseUrl || !supabaseKey) {
    return null;
  }

  const cleanUrl = supabaseUrl.replace(/\/$/, '');
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 4000); // 4 segundos de timeout para evitar travamento em flutuações de rede

  try {
    const response = await fetch(`${cleanUrl}/rest/v1/whatsapp_sessions?id=eq.${userId}&select=creds`, {
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`
      },
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (response.ok) {
      const data = await response.json();
      if (data && data.length > 0 && data[0].creds) {
        console.log(`[${userId}] Credenciais do WhatsApp encontradas no Supabase.`);
        return typeof data[0].creds === 'string' ? JSON.parse(data[0].creds) : data[0].creds;
      }
    }
  } catch (err) {
    clearTimeout(timeoutId);
    console.error(`[${userId}] Erro de rede ao buscar credenciais no Supabase:`, err.message || err);
  }
  return null;
}

async function deleteCredsFromSupabase(userId) {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  
  if (!supabaseUrl || !supabaseKey) {
    return;
  }

  const cleanUrl = supabaseUrl.replace(/\/$/, '');
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 4000); // 4 segundos de timeout

  try {
    const response = await fetch(`${cleanUrl}/rest/v1/whatsapp_sessions?id=eq.${userId}`, {
      method: 'DELETE',
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`
      },
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errText = await response.text();
      console.error(`[${userId}] Erro ao excluir credenciais no Supabase:`, response.status, errText);
    } else {
      console.log(`[${userId}] Credenciais excluídas do Supabase com sucesso.`);
    }
  } catch (err) {
    clearTimeout(timeoutId);
    console.error(`[${userId}] Erro de rede ao conectar com o Supabase para exclusão:`, err.message || err);
  }
}

// Logger silencioso para o Baileys para não sujar o console do Fly.io
const logger = pino({ level: 'warn' });

// Estado global da conexão
let sock = null;
let currentQr = null;
let connectionStatus = 'connecting'; // 'connecting' | 'qrcode' | 'connected' | 'disconnected'
let syncStatus = 'pending'; // 'pending' | 'syncing' | 'completed'
let messagesProcessedCount = 0;
const contactsCache = {};
const supabaseDisabledTables = new Set();
const pendingContactWrites = new Map();
const pendingContactTimers = new Map();

const MESSAGE_RETENTION_DAYS = Math.max(1, parseInt(process.env.MESSAGE_RETENTION_DAYS || '30', 10));
const SUPABASE_TIMEOUT_MS = Math.max(2000, parseInt(process.env.SUPABASE_TIMEOUT_MS || '8000', 10));
const CONTACT_FLUSH_DELAY_MS = Math.max(250, parseInt(process.env.CONTACT_FLUSH_DELAY_MS || '1200', 10));
const CONTACT_MESSAGE_HYDRATION_INTERVAL_MS = Math.max(60000, parseInt(process.env.CONTACT_MESSAGE_HYDRATION_INTERVAL_MS || '300000', 10));
const SYNC_IDLE_COMPLETE_MS = Math.max(5000, parseInt(process.env.SYNC_IDLE_COMPLETE_MS || '30000', 10));
const JSON_INDENT = process.env.NODE_ENV === 'production' ? 0 : 2;

function getSupabaseConfig() {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseKey) return null;
  return {
    cleanUrl: supabaseUrl.replace(/\/$/, ''),
    key: supabaseKey
  };
}

async function supabaseRest(table, query = '', options = {}) {
  if (supabaseDisabledTables.has(table)) return null;

  const config = getSupabaseConfig();
  if (!config) return null;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), SUPABASE_TIMEOUT_MS);
  const headers = {
    'apikey': config.key,
    'Authorization': `Bearer ${config.key}`,
    ...(options.headers || {})
  };

  try {
    const response = await fetch(`${config.cleanUrl}/rest/v1/${table}${query}`, {
      ...options,
      headers,
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      if (response.status === 404 || errText.includes('PGRST205') || errText.includes('does not exist')) {
        supabaseDisabledTables.add(table);
        console.warn(`[supabase] Tabela ${table} indisponivel. Usando cache local ate a migracao ser aplicada.`);
        return null;
      }
      console.warn(`[supabase] Falha na tabela ${table}:`, response.status, errText.slice(0, 300));
      return null;
    }

    return response;
  } catch (err) {
    clearTimeout(timeoutId);
    console.warn(`[supabase] Falha de rede na tabela ${table}:`, err.message || err);
    return null;
  }
}

function stateBlobId(userId, kind, key = 'default') {
  return `${userId}:${kind}:${key}`;
}

async function saveStateBlobToSupabase(userId, kind, key, payload) {
  const id = stateBlobId(userId, kind, key);
  const response = await supabaseRest(
    'whatsapp_sessions',
    '?on_conflict=id',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-dupes,return=minimal'
      },
      body: JSON.stringify({
        id,
        creds: JSON.stringify(payload),
        updated_at: new Date().toISOString()
      })
    }
  );
  return !!response;
}

async function loadStateBlobFromSupabase(userId, kind, key = 'default') {
  const id = stateBlobId(userId, kind, key);
  const response = await supabaseRest(
    'whatsapp_sessions',
    `?id=eq.${supabaseEq(id)}&select=creds&limit=1`
  );
  if (!response) return null;

  try {
    const rows = await response.json();
    const raw = rows?.[0]?.creds;
    if (!raw) return null;
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (err) {
    console.warn(`[${userId}] Falha ao carregar snapshot ${kind}/${key}:`, err.message || err);
    return null;
  }
}

async function listStateBlobKeysFromSupabase(userId, kind) {
  const prefix = `${userId}:${kind}:`;
  const response = await supabaseRest(
    'whatsapp_sessions',
    `?id=like.${supabaseEq(`${prefix}*`)}&select=id&limit=1000`
  );
  if (!response) return [];

  try {
    const rows = await response.json();
    return rows
      .map(row => String(row.id || ''))
      .filter(id => id.startsWith(prefix))
      .map(id => id.slice(prefix.length))
      .filter(Boolean)
      .sort();
  } catch (err) {
    console.warn(`[${userId}] Falha ao listar snapshots ${kind}:`, err.message || err);
    return [];
  }
}

function supabaseEq(value) {
  return encodeURIComponent(String(value));
}

function chunkArray(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function normalizeDisplayName(name) {
  if (!name || typeof name !== 'string') return '';
  return name
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function bestNameFromContact(contact) {
  if (!contact || typeof contact !== 'object') return '';
  return normalizeDisplayName(
    contact.name ||
    contact.verifiedName ||
    contact.notify ||
    contact.shortName ||
    contact.pushName ||
    contact.subject ||
    ''
  );
}

function looksLikeTechnicalName(name) {
  if (!name) return true;
  return name.includes('@') || /^[+\d\s().-]{6,}$/.test(name.trim());
}

function isBetterContactName(nextName, currentName) {
  if (!nextName) return false;
  if (!currentName) return true;
  if (nextName === currentName) return false;
  if (looksLikeTechnicalName(nextName) && !looksLikeTechnicalName(currentName)) return false;
  if (!looksLikeTechnicalName(nextName) && looksLikeTechnicalName(currentName)) return true;
  return nextName.length > currentName.length;
}

function jidNumber(jid) {
  return cleanJid(jid).split('@')[0] || '';
}

function ensureUserJid(value, preferredServer = 's.whatsapp.net') {
  if (!value || typeof value !== 'string') return '';
  const cleaned = cleanJid(value.trim());
  if (!cleaned) return '';
  if (cleaned.includes('@')) return cleaned;
  return `${cleaned}@${preferredServer}`;
}

function isGroupJid(jid) {
  return cleanJid(jid).endsWith('@g.us');
}

function isSupportedChatJid(jid) {
  const cleaned = cleanJid(jid);
  return cleaned.endsWith('@s.whatsapp.net') || cleaned.endsWith('@g.us') || cleaned.endsWith('@lid');
}

function contactTypeFromJid(jid) {
  return isGroupJid(jid) ? 'group' : 'contact';
}

function uniqueJids(values) {
  const result = [];
  const seen = new Set();
  for (const value of values) {
    const jid = cleanJid(value);
    if (!jid || seen.has(jid)) continue;
    seen.add(jid);
    result.push(jid);
  }
  return result;
}

function contactAliasJids(contact) {
  if (!contact || typeof contact !== 'object') return [];
  const candidates = [
    contact.id,
    contact.jid,
    contact.lid,
    contact.phoneNumber,
    contact.phone_number,
    contact.participantPn,
    contact.participantLid,
    contact.senderPn,
    contact.senderLid
  ];

  return uniqueJids(candidates.map(value => {
    if (!value || typeof value !== 'string') return '';
    if (value.includes('@')) return value;
    if (/^\d{14,}$/.test(value)) return `${value}@lid`;
    return `${value}@s.whatsapp.net`;
  }));
}

function messageParticipantAliases(msg, fallbackJid) {
  const key = msg?.key || {};
  return uniqueJids([
    fallbackJid,
    key.participant,
    msg?.participant,
    key.participantPn,
    key.participantLid,
    key.senderPn,
    key.senderLid
  ].map(value => {
    if (!value || typeof value !== 'string') return '';
    if (value.includes('@')) return value;
    if (/^\d{14,}$/.test(value)) return `${value}@lid`;
    return `${value}@s.whatsapp.net`;
  }));
}

function bestNameFromAliases(aliasJids, contactsCache) {
  if (!contactsCache) return '';
  for (const alias of aliasJids || []) {
    const name = contactsCache[cleanJid(alias)];
    if (name && !looksLikeTechnicalName(name)) return name;
  }
  for (const alias of aliasJids || []) {
    const name = contactsCache[cleanJid(alias)];
    if (name) return name;
  }
  return '';
}

function phoneFallbackFromAliases(aliasJids, contactsCache) {
  for (const alias of aliasJids || []) {
    const cached = normalizeDisplayName(contactsCache?.[cleanJid(alias)] || '');
    if (cached && looksLikeTechnicalName(cached) && /^\d{8,}$/.test(cached.replace(/\D/g, ''))) {
      return cached;
    }
  }

  const phoneAlias = (aliasJids || []).map(cleanJid).find(alias => alias.endsWith('@s.whatsapp.net'));
  return phoneAlias ? jidNumber(phoneAlias) : '';
}

function contactsFilePath(userId) {
  return path.join(contactsDir, `${userId}.json`);
}

function loadContactsFromFile(userId) {
  const filePath = contactsFilePath(userId);
  try {
    if (!fs.existsSync(filePath)) return {};
    const rawData = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(rawData);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    console.warn(`[${userId}] Falha ao ler cache local de contatos:`, err.message || err);
    return {};
  }
}

function saveContactsToFile(userId, contacts) {
  const filePath = contactsFilePath(userId);
  try {
    fs.mkdirSync(contactsDir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(contacts || {}, null, JSON_INDENT), 'utf8');
  } catch (err) {
    console.warn(`[${userId}] Falha ao salvar cache local de contatos:`, err.message || err);
  }
}

function scheduleContactsFileSave(userId, instance) {
  if (!instance) return;
  if (instance.contactsSaveTimer) clearTimeout(instance.contactsSaveTimer);
  instance.contactsSaveTimer = setTimeout(() => {
    saveContactsToFile(userId, instance.contactsCache || {});
    instance.contactsSaveTimer = null;
  }, 1000);
}

function queueContactPersist(userId, jid, name, source = 'sync') {
  const cleanId = cleanJid(jid);
  const cleanName = normalizeDisplayName(name);
  if (!cleanId || !cleanName) return;

  if (!pendingContactWrites.has(userId)) {
    pendingContactWrites.set(userId, new Map());
  }

  pendingContactWrites.get(userId).set(cleanId, {
    user_id: userId,
    jid: cleanId,
    name: cleanName,
    type: contactTypeFromJid(cleanId),
    source,
    updated_at: new Date().toISOString()
  });

  if (pendingContactTimers.has(userId)) {
    clearTimeout(pendingContactTimers.get(userId));
  }

  pendingContactTimers.set(userId, setTimeout(() => {
    flushContactPersist(userId).catch(err => {
      console.warn(`[${userId}] Falha ao persistir contatos pendentes:`, err.message || err);
    });
  }, CONTACT_FLUSH_DELAY_MS));
}

async function flushContactPersist(userId) {
  const timer = pendingContactTimers.get(userId);
  if (timer) clearTimeout(timer);
  pendingContactTimers.delete(userId);

  const pending = pendingContactWrites.get(userId);
  if (!pending || pending.size === 0) return 0;
  pendingContactWrites.delete(userId);

  const rows = Array.from(pending.values());
  let persisted = 0;

  for (const chunk of chunkArray(rows, 500)) {
    const response = await supabaseRest(
      'whatsapp_contacts',
      '?on_conflict=user_id,jid',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-dupes,return=minimal'
        },
        body: JSON.stringify(chunk)
      }
    );
    if (response) persisted += chunk.length;
  }

  const existingSnapshot = await loadStateBlobFromSupabase(userId, 'contacts') || {};
  const mergedSnapshot = { ...existingSnapshot };
  let snapshotChanged = false;
  for (const row of rows) {
    if (isBetterContactName(row.name, mergedSnapshot[row.jid])) {
      mergedSnapshot[row.jid] = row.name;
      snapshotChanged = true;
    }
  }

  if (snapshotChanged || persisted < rows.length) {
    await saveStateBlobToSupabase(userId, 'contacts', 'default', mergedSnapshot);
  }

  return persisted;
}

async function loadContactsFromSupabase(userId) {
  const fallbackContacts = await loadStateBlobFromSupabase(userId, 'contacts');
  const response = await supabaseRest(
    'whatsapp_contacts',
    `?user_id=eq.${supabaseEq(userId)}&select=jid,name&limit=20000`
  );
  if (!response) {
    return fallbackContacts && typeof fallbackContacts === 'object' ? fallbackContacts : {};
  }

  try {
    const rows = await response.json();
    const tableContacts = rows.reduce((acc, row) => {
      const jid = cleanJid(row.jid);
      const name = normalizeDisplayName(row.name);
      if (jid && name) acc[jid] = name;
      return acc;
    }, {});
    return mergeContactCaches(tableContacts, fallbackContacts);
  } catch (err) {
    console.warn(`[${userId}] Falha ao carregar contatos do Supabase:`, err.message || err);
  }

  return fallbackContacts && typeof fallbackContacts === 'object' ? fallbackContacts : {};
}

function mergeContactCaches(...caches) {
  const merged = {};
  for (const cache of caches) {
    if (!cache || typeof cache !== 'object') continue;
    for (const [jid, name] of Object.entries(cache)) {
      const cleanId = cleanJid(jid);
      const cleanName = normalizeDisplayName(name);
      if (cleanId && isBetterContactName(cleanName, merged[cleanId])) {
        merged[cleanId] = cleanName;
      }
    }
  }
  return merged;
}

function getMessageTimestampMs(msg) {
  const raw = msg && msg.messageTimestamp;
  if (!raw) return Date.now();
  if (typeof raw === 'number') return raw > 1e12 ? raw : raw * 1000;
  if (typeof raw === 'bigint') {
    const asNumber = Number(raw);
    return asNumber > 1e12 ? asNumber : asNumber * 1000;
  }
  if (typeof raw === 'object') {
    if (typeof raw.toNumber === 'function') {
      const asNumber = raw.toNumber();
      return asNumber > 1e12 ? asNumber : asNumber * 1000;
    }
    if (typeof raw.low === 'number') {
      return raw.low > 1e12 ? raw.low : raw.low * 1000;
    }
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? (parsed > 1e12 ? parsed : parsed * 1000) : Date.now();
}

function messageDateStr(timestamp) {
  return yyyymmddFormatter.format(new Date(timestamp));
}

function createDedupeKey(messageObject) {
  const chat = messageObject.chatJid || `${messageObject.sender || ''}@unknown`;
  const participant = messageObject.participantJid || messageObject.participant || '';
  const id = messageObject.id || '';
  return `${chat}|${participant}|${id}`;
}

function inferChatJidFromMessage(message) {
  if (message.chatJid) return cleanJid(message.chatJid);
  if (!message.sender) return '';
  if (message.sender.includes('@')) return cleanJid(message.sender);
  if (message.chatType === 'group' || (message.participant && message.participant !== message.sender)) {
    return `${message.sender}@g.us`;
  }
  return `${message.sender}@s.whatsapp.net`;
}

function inferParticipantJidFromMessage(message) {
  if (message.participantJid) return cleanJid(message.participantJid);
  if (!message.participant) return inferChatJidFromMessage(message);
  if (message.participant.includes('@')) return cleanJid(message.participant);
  if (/^\d{14,}$/.test(String(message.participant))) return `${message.participant}@lid`;
  return `${message.participant}@s.whatsapp.net`;
}

function normalizeStoredMessage(message) {
  const chatJid = inferChatJidFromMessage(message);
  const participantJid = inferParticipantJidFromMessage(message);
  const participantAliases = uniqueJids([
    participantJid,
    ...(Array.isArray(message.participantAliases) ? message.participantAliases : []),
    ...(Array.isArray(message.participant_aliases) ? message.participant_aliases : [])
  ]);
  const normalized = {
    id: message.id || message.message_id || '',
    dedupeKey: message.dedupeKey || message.dedupe_key || '',
    sender: message.sender || message.chat_number || jidNumber(chatJid),
    chatJid,
    chatName: normalizeDisplayName(message.chatName || message.chat_name || ''),
    participant: message.participant || message.participant_number || jidNumber(participantJid),
    participantJid,
    participantAliases,
    name: normalizeDisplayName(message.name || message.display_name || ''),
    text: typeof message.text === 'string' ? message.text : '',
    fromMe: Boolean(message.fromMe ?? message.from_me),
    timestamp: message.timestamp || message.message_timestamp || new Date().toISOString()
  };
  normalized.dedupeKey = normalized.dedupeKey || createDedupeKey(normalized);
  return normalized;
}

function mergeMessages(localMessages, remoteMessages) {
  const merged = new Map();

  for (const raw of [...(localMessages || []), ...(remoteMessages || [])]) {
    const message = normalizeStoredMessage(raw);
    if (!message.id && !message.text) continue;
    const key = message.dedupeKey || createDedupeKey(message);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, message);
      continue;
    }

    merged.set(key, {
      ...existing,
      ...message,
      chatName: isBetterContactName(message.chatName, existing.chatName) ? message.chatName : existing.chatName,
      participantAliases: uniqueJids([...(existing.participantAliases || []), ...(message.participantAliases || [])]),
      name: isBetterContactName(message.name, existing.name) ? message.name : existing.name,
      text: message.text || existing.text
    });
  }

  return Array.from(merged.values()).sort(compareMessagesChronologically);
}

function compareMessagesChronologically(a, b) {
  const timeA = new Date(a.timestamp).getTime();
  const timeB = new Date(b.timestamp).getTime();
  if (timeA !== timeB) return timeA - timeB;
  return String(a.id || '').localeCompare(String(b.id || ''));
}

function resolveMessageSenderName(message, contactsCache, isGroup) {
  if (message.fromMe) return 'Eu';
  const participantJid = message.participantJid || inferParticipantJidFromMessage(message);
  const aliases = uniqueJids([participantJid, ...(message.participantAliases || [])]);
  const cachedName = bestNameFromAliases(aliases, contactsCache);
  if (cachedName && !looksLikeTechnicalName(cachedName)) return cachedName;
  if (message.name && !looksLikeTechnicalName(message.name)) return message.name;
  if (!isGroup && message.chatName && !looksLikeTechnicalName(message.chatName)) return message.chatName;
  const phoneFallback = phoneFallbackFromAliases(aliases, contactsCache);
  if (phoneFallback) return phoneFallback;
  if (cachedName) return cachedName;
  return message.participant || message.sender || jidNumber(participantJid);
}

// Helper para atualizar retroativamente os nomes das mensagens em arquivos físicos diários
function updateMessageNamesInFiles(userId, contactId, contactName) {
  const cleanedContactId = cleanJid(contactId);
  const cleanedContactName = normalizeDisplayName(contactName);
  if (!cleanedContactId || !cleanedContactName) return;
  const senderNumber = cleanedContactId.split('@')[0];
  const userMsgDir = path.join(dataDir, 'messages', userId);
  try {
    if (!fs.existsSync(userMsgDir)) return;
    const files = fs.readdirSync(userMsgDir);
    for (const file of files) {
      if (file.startsWith('messages-') && file.endsWith('.json')) {
        const filePath = path.join(userMsgDir, file);
        if (!fs.existsSync(filePath)) continue;
        
        const rawData = fs.readFileSync(filePath, 'utf8');
        let messages = JSON.parse(rawData);
        let modified = false;
        
        for (const m of messages) {
          const rawMsgSender = m.participant || m.sender;
          const msgSender = cleanJid(rawMsgSender + (rawMsgSender.includes('@') ? '' : '@s.whatsapp.net')).split('@')[0];
          if (msgSender === senderNumber && !m.fromMe && isBetterContactName(cleanedContactName, m.name)) {
            m.name = cleanedContactName;
            m.participantJid = cleanedContactId;
            modified = true;
          }
        }
        
        if (modified) {
          fs.writeFileSync(filePath, JSON.stringify(messages, null, JSON_INDENT), 'utf8');
        }
      }
    }
  } catch (err) {
    console.error(`Erro ao atualizar retroativamente contatos do remetente ${senderNumber} para o usuário ${userId}:`, err);
  }
}

// Helper para adicionar contato ao cache e disparar atualização nos logs diários
function addContactToCache(userId, instance, id, name, source = 'sync', updateFiles = true) {
  if (!id || !name || !instance) return false;
  const cleanedId = cleanJid(id);
  const cleanedName = normalizeDisplayName(name);
  if (!cleanedId || !cleanedName) return false;

  const currentName = instance.contactsCache[cleanedId];
  if (!isBetterContactName(cleanedName, currentName)) return false;

  instance.contactsCache[cleanedId] = cleanedName;
  if (updateFiles) {
    updateMessageNamesInFiles(userId, cleanedId, cleanedName);
  }
  scheduleContactsFileSave(userId, instance);
  queueContactPersist(userId, cleanedId, cleanedName, source);
  return true;
}

function addContactRecordToCache(userId, instance, contact, source = 'sync') {
  if (!contact || !instance) return false;
  const aliases = contactAliasJids(contact);
  if (aliases.length === 0) return false;

  const name = bestNameFromContact(contact) || bestNameFromAliases(aliases, instance.contactsCache);
  if (!name) {
    const phoneFallback = phoneFallbackFromAliases(aliases, instance.contactsCache);
    if (!phoneFallback) return false;

    let fallbackChanged = false;
    for (const alias of aliases) {
      fallbackChanged = addContactToCache(userId, instance, alias, phoneFallback, `${source}.phoneFallback`, false) || fallbackChanged;
    }
    return fallbackChanged;
  }

  let changed = false;
  for (const alias of aliases) {
    changed = addContactToCache(userId, instance, alias, name, source) || changed;
  }
  return changed;
}

function addGroupMetadataToCache(userId, instance, metadata, source = 'groupMetadata') {
  if (!metadata || !instance) return;
  addContactToCache(userId, instance, metadata.id, metadata.subject, source);
  for (const participant of metadata.participants || []) {
    addContactRecordToCache(userId, instance, participant, `${source}.participant`);
  }
}

async function refreshGroupMetadataAliases(userId, instance, groupJids = []) {
  if (!instance || !instance.sock) return 0;
  let refreshed = 0;

  if (groupJids.length === 0 && typeof instance.sock.groupFetchAllParticipating === 'function') {
    try {
      const groups = await instance.sock.groupFetchAllParticipating();
      for (const metadata of Object.values(groups || {})) {
        if (!metadata || !metadata.id) continue;
        instance.groupMetadataCache[metadata.id] = metadata;
        addGroupMetadataToCache(userId, instance, metadata, 'groupFetchAllParticipating');
        refreshed++;
      }
      if (refreshed > 0) {
        await flushContactPersist(userId);
        saveContactsToFile(userId, instance.contactsCache || {});
      }
      return refreshed;
    } catch (err) {
      console.warn(`[${userId}] Falha ao buscar grupos participantes:`, err.message || err);
    }
  }

  for (const groupJid of uniqueJids(groupJids).filter(isGroupJid)) {
    try {
      const metadata = instance.groupMetadataCache[groupJid] || await instance.sock.groupMetadata(groupJid);
      if (!metadata) continue;
      instance.groupMetadataCache[groupJid] = metadata;
      addGroupMetadataToCache(userId, instance, metadata, 'groupMetadata.lookup');
      refreshed++;
    } catch (err) {
      console.warn(`[${userId}] Falha ao atualizar aliases do grupo ${groupJid}:`, err.message || err);
    }
  }

  if (refreshed > 0) {
    await flushContactPersist(userId);
    saveContactsToFile(userId, instance.contactsCache || {});
  }
  return refreshed;
}

// Inicia a conexão com o WhatsApp para um usuário específico de forma isolada
function usableContactNameFromMessage(message, isGroup) {
  const candidates = isGroup
    ? [message.name]
    : [message.chatName, message.name];

  for (const candidate of candidates) {
    const name = normalizeDisplayName(candidate);
    if (name && name !== 'Eu' && !looksLikeTechnicalName(name)) return name;
  }
  return '';
}

function hydrateContactsFromMessages(userId, instance, messages, source = 'messages') {
  if (!instance || !Array.isArray(messages) || messages.length === 0) return 0;
  let changed = 0;

  for (const raw of messages) {
    const message = normalizeStoredMessage(raw);
    if (!message.chatJid) continue;

    const isGroup = isGroupJid(message.chatJid) || (message.participant && message.participant !== message.sender);
    const name = usableContactNameFromMessage(message, isGroup);
    if (!name) continue;

    const aliases = isGroup
      ? uniqueJids([message.participantJid, ...(message.participantAliases || [])])
      : uniqueJids([message.chatJid, message.participantJid, ...(message.participantAliases || [])]);

    for (const alias of aliases) {
      if (addContactToCache(userId, instance, alias, name, source, false)) changed++;
    }
  }

  return changed;
}

function isRetainedDate(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr))) return false;
  const endOfDay = new Date(`${dateStr}T23:59:59.999Z`).getTime();
  return Number.isFinite(endOfDay) && endOfDay >= Date.now() - (MESSAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000);
}

async function hydrateContactsFromStoredMessages(userId, instance, seedMessages = [], seedDate = '') {
  if (!instance) return 0;

  let changed = hydrateContactsFromMessages(userId, instance, seedMessages, seedDate ? `messages.${seedDate}` : 'messages.current');
  const now = Date.now();
  const shouldScanStored = !instance.lastStoredMessageContactHydration ||
    (now - instance.lastStoredMessageContactHydration) >= CONTACT_MESSAGE_HYDRATION_INTERVAL_MS;

  if (shouldScanStored) {
    const dates = new Set(listLocalMessageFiles(userId).filter(isRetainedDate));
    const remoteDates = await listStateBlobKeysFromSupabase(userId, 'messages');
    for (const date of remoteDates) {
      if (isRetainedDate(date)) dates.add(date);
    }
    if (seedDate && isRetainedDate(seedDate)) dates.add(seedDate);

    for (const date of Array.from(dates).sort()) {
      try {
        const messages = mergeMessages(
          readLocalMessagesForDate(userId, date),
          await loadMessagesFromSupabase(userId, date)
        );
        changed += hydrateContactsFromMessages(userId, instance, messages, `messages.${date}`);
      } catch (err) {
        console.warn(`[${userId}] Falha ao hidratar contatos a partir das mensagens de ${date}:`, err.message || err);
      }
    }

    instance.lastStoredMessageContactHydration = now;
  }

  if (changed > 0) {
    await flushContactPersist(userId);
    saveContactsToFile(userId, instance.contactsCache || {});
  }

  return changed;
}

async function connectUserWhatsApp(userId) {
  const instance = instances[userId];
  if (!instance) return;
  const connectionGeneration = (instance.connectionGeneration || 0) + 1;
  instance.connectionGeneration = connectionGeneration;
  if (instance.reconnectTimer) {
    clearTimeout(instance.reconnectTimer);
    instance.reconnectTimer = null;
  }

  console.log(`Iniciando conexão com o WhatsApp para o usuário: ${userId}`);
  
  // Limpa de forma segura qualquer socket ou listener anterior para evitar loops de reconexão concorrentes e leaks de memória
  if (instance.sock) {
    try {
      console.log(`[${userId}] Encerrando conexão socket anterior de forma limpa antes de reiniciar...`);
      instance.sock.ev.removeAllListeners();
      instance.sock.end();
    } catch (e) {
      console.error(`[${userId}] Erro ao fechar socket anterior:`, e);
    }
    instance.sock = null;
  }

  instance.connectionStatus = 'connecting';

  const userAuthDir = path.join(dataDir, 'auth', userId);
  fs.mkdirSync(userAuthDir, { recursive: true });

  // Restaura creds.json do Supabase se não existir localmente no container
  const credsFilePath = path.join(userAuthDir, 'creds.json');
  if (!fs.existsSync(credsFilePath)) {
    console.log(`[${userId}] creds.json não encontrado localmente. Tentando restaurar do Supabase...`);
    try {
      const savedCreds = await loadCredsFromSupabase(userId);
      if (savedCreds) {
        fs.writeFileSync(credsFilePath, JSON.stringify(savedCreds, null, 2), 'utf8');
        console.log(`[${userId}] creds.json restaurado com sucesso do Supabase.`);
      } else {
        console.log(`[${userId}] Nenhuma credencial anterior encontrada no Supabase.`);
      }
    } catch (e) {
      console.error(`[${userId}] Falha ao restaurar credenciais do Supabase:`, e);
    }
  }

  const { state, saveCreds } = await useMultiFileAuthState(userAuthDir);

  // Busca a versão mais recente do WhatsApp Web para evitar o erro 405 (Method Not Allowed)
  let version = [2, 3000, 1015901307]; // Fallback de versão recente
  try {
    const latest = await fetchLatestBaileysVersion();
    version = latest.version;
    console.log(`[${userId}] Versão dinâmica do WhatsApp Web obtida com sucesso: ${version.join('.')}`);
  } catch (err) {
    console.warn(`[${userId}] Erro ao buscar última versão do WhatsApp Web. Usando backup.`, err);
  }

  const sock = makeWASocket({
    auth: state,
    version,
    syncFullHistory: true, // Força a sincronização do histórico inicial recente
    printQRInTerminal: false, // Desativado (evita avisos no log)
    logger: logger,
    browser: ['FollowUp Mônada', 'Chrome', '1.0'], // Customiza a exibição no celular do usuário
    markOnlineOnConnect: false, // Mantém as notificações push funcionando no celular do usuário
    keepAliveIntervalMs: 15000, // Envia pings de keep-alive a cada 15 segundos para evitar que o proxy do Render encerre a conexão por ociosidade
    connectTimeoutMs: 60000, // Tolera até 60 segundos para conexão inicial
    retryRequestDelayMs: 2000, // Dá 2 segundos de folga para a rede se estabilizar em retentativas falhas
    defaultQueryTimeoutMs: 60000, // Evita queries presas em background
    cachedGroupMetadata: async (jid) => {
      return instance.groupMetadataCache ? instance.groupMetadataCache[jid] : undefined;
    },
    getMessage: async (key) => {
      try {
        const dateStr = new Date().toISOString().split('T')[0];
        const filePath = path.join(dataDir, 'messages', userId, `messages-${dateStr}.json`);
        if (fs.existsSync(filePath)) {
          const rawData = fs.readFileSync(filePath, 'utf8');
          const messages = JSON.parse(rawData);
          const found = messages.find(m => m.id === key.id);
          if (found) {
            return {
              conversation: found.text
            };
          }
        }
      } catch (err) {
        console.warn(`[${userId}] Falha ao buscar mensagem para getMessage retry:`, err.message);
      }
      return undefined;
    }
  });

  instance.sock = sock;

  // Salva as credenciais a cada alteração de autenticação e faz backup no Supabase
  sock.ev.on('creds.update', async () => {
    await saveCreds();
    try {
      if (fs.existsSync(credsFilePath)) {
        const credsData = JSON.parse(fs.readFileSync(credsFilePath, 'utf8'));
        await saveCredsToSupabase(userId, credsData);
      }
    } catch (err) {
      console.error(`[${userId}] Erro ao fazer backup do creds.json para o Supabase:`, err);
    }
  });

  // Monitora alterações na conexão
  sock.ev.on('connection.update', (update) => {
    if (instance.connectionGeneration !== connectionGeneration) return;
    const { connection, lastDisconnect, qr, receivedPendingNotifications } = update;

    if (qr) {
      instance.currentQr = qr;
      instance.connectionStatus = 'qrcode';
      instance.syncStatus = 'pending';
      instance.messagesProcessedCount = 0;
      console.log(`[${userId}] Novo QR Code gerado! Acesse /qr para escanear.`);
    }

    if (receivedPendingNotifications) {
      console.log(`[${userId}] Sincronização de notificações pendentes recebida.`);
      resetUserSyncTimer(userId);
    }

    if (connection === 'close') {
      instance.currentQr = null;
      instance.syncStatus = 'pending';
      instance.messagesProcessedCount = 0;
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log(`[${userId}] Conexão fechada devido a:`, lastDisconnect?.error || 'motivo desconhecido');
      
      if (shouldReconnect) {
        console.log(`[${userId}] Tentando reconectar em 5 segundos...`);
        instance.connectionStatus = 'connecting';
        if (instance.reconnectTimer) clearTimeout(instance.reconnectTimer);
        instance.reconnectTimer = setTimeout(() => {
          instance.reconnectTimer = null;
          connectUserWhatsApp(userId);
        }, 5000);
      } else {
        console.log(`[${userId}] Desconectado permanentemente (Sessão encerrada pelo celular). Excluindo credenciais...`);
        instance.connectionStatus = 'disconnected';
        
        // Exclui as credenciais permanentemente do banco de dados do Supabase
        deleteCredsFromSupabase(userId);
        
        try {
          fs.rmSync(userAuthDir, { recursive: true, force: true });
          fs.mkdirSync(userAuthDir, { recursive: true });
        } catch (e) {
          console.error(`[${userId}] Erro ao limpar pasta de auth:`, e);
        }
        console.log(`[${userId}] Reiniciando conexão em 3 segundos para gerar novo QR Code...`);
        if (instance.reconnectTimer) clearTimeout(instance.reconnectTimer);
        instance.reconnectTimer = setTimeout(() => {
          instance.reconnectTimer = null;
          connectUserWhatsApp(userId);
        }, 3000);
      }
    } else if (connection === 'open') {
      instance.currentQr = null;
      instance.connectionStatus = 'connected';
      instance.syncStatus = 'syncing';
      if (instance.reconnectTimer) {
        clearTimeout(instance.reconnectTimer);
        instance.reconnectTimer = null;
      }
      console.log(`[${userId}] WhatsApp conectado com sucesso!`);
      resetUserSyncTimer(userId);
      hydrateContactsFromStoredMessages(userId, instance)
        .then(() => refreshGroupMetadataAliases(userId, instance))
        .catch(err => {
        console.warn(`[${userId}] Falha ao hidratar aliases de grupos apos conexao:`, err.message || err);
      });
    }
  });

  // Sincroniza a lista de contatos quando houver novos contatos adicionados
  sock.ev.on('contacts.upsert', (contacts) => {
    if (instance.connectionGeneration !== connectionGeneration) return;
    for (const contact of contacts) {
      addContactRecordToCache(userId, instance, contact, 'contacts.upsert');
    }
    resetUserSyncTimer(userId);
  });

  // Atualiza dados dos contatos da agenda caso mudem de nome
  sock.ev.on('contacts.update', (contacts) => {
    if (instance.connectionGeneration !== connectionGeneration) return;
    for (const contact of contacts) {
      addContactRecordToCache(userId, instance, contact, 'contacts.update');
    }
    resetUserSyncTimer(userId);
  });

  // Sincroniza metadados dos grupos e salva no cache para otimizar consultas e evitar rate-limit
  sock.ev.on('groups.update', async ([event]) => {
    if (instance.connectionGeneration !== connectionGeneration) return;
    try {
      if (sock && event.id && instance.groupMetadataCache) {
        const metadata = await sock.groupMetadata(event.id);
        instance.groupMetadataCache[event.id] = metadata;
        addGroupMetadataToCache(userId, instance, metadata, 'groups.update');
      }
    } catch (err) {
      console.warn(`[${userId}] Falha ao atualizar cache de grupo no groups.update:`, err.message);
    }
  });

  sock.ev.on('group-participants.update', async (event) => {
    if (instance.connectionGeneration !== connectionGeneration) return;
    try {
      if (sock && event.id && instance.groupMetadataCache) {
        const metadata = await sock.groupMetadata(event.id);
        instance.groupMetadataCache[event.id] = metadata;
        addGroupMetadataToCache(userId, instance, metadata, 'group-participants.update');
      }
    } catch (err) {
      console.warn(`[${userId}] Falha ao atualizar cache de grupo no group-participants.update:`, err.message);
    }
  });

  // Função auxiliar para processar e salvar um lote de mensagens
  async function processUserMessages(messagesList) {
    if (!messagesList || messagesList.length === 0) return;

    // Retem apenas uma janela configuravel para evitar que o Render gratuito cresca sem limite.
    const retentionThreshold = Date.now() - (MESSAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const filteredList = messagesList.filter(msg => {
      if (!msg) return false;
      return getMessageTimestampMs(msg) >= retentionThreshold;
    });

    if (filteredList.length === 0) return;

    instance.messagesProcessedCount += filteredList.length;
    resetUserSyncTimer(userId);

    const messageObjects = [];

    for (const msg of filteredList) {
      try {
        if (!msg.key || !msg.key.remoteJid) continue;
        
        const chatJid = cleanJid(msg.key.remoteJid);
        
        // Mantém chats privados (@s.whatsapp.net) e grupos (@g.us).
        if (!isSupportedChatJid(chatJid)) continue;

        const fromMe = msg.key.fromMe;
        const isGroup = isGroupJid(chatJid);
        
        // Determina o remetente individual e todos os aliases conhecidos (LID + telefone).
        const rawParticipant = msg.key.participant || msg.participant || (isGroup && fromMe && instance.sock?.user?.id) || chatJid;
        const participantJid = ensureUserJid(rawParticipant, /^\d{14,}$/.test(String(rawParticipant || '')) ? 'lid' : 's.whatsapp.net');
        const participantAliases = messageParticipantAliases(msg, participantJid);
        
        let pushName = 'Eu';
        if (!fromMe) {
          const savedName = bestNameFromAliases(participantAliases, instance.contactsCache);
          const messagePushName = normalizeDisplayName(msg.pushName);
          pushName = savedName || messagePushName || jidNumber(participantJid);
          if (msg.pushName) {
            for (const alias of participantAliases) {
              addContactToCache(userId, instance, alias, msg.pushName, 'message.pushName');
            }
          }
        }

        const chatName = instance.contactsCache[chatJid] || (!isGroup && !fromMe ? pushName : '');
        if (!isGroup && !fromMe && pushName) {
          addContactToCache(userId, instance, chatJid, pushName, 'message.chat');
        }

        const text = getMessageText(msg);

        // Ignora se não houver texto legível (ex: figurinhas, reações, chamadas de áudio)
        if (!text.trim()) continue;

        const timestamp = new Date(getMessageTimestampMs(msg));
        
        const messageObject = {
          id: msg.key.id,
          sender: jidNumber(chatJid),
          chatJid,
          chatName,
          participant: jidNumber(participantJid), // Identifica quem de fato enviou sem sufixo de dispositivo para compatibilidade retroativa
          participantJid,
          participantAliases,
          name: pushName,
          text: text,
          fromMe: fromMe,
          timestamp: timestamp.toISOString()
        };
        messageObject.dedupeKey = createDedupeKey(messageObject);

        messageObjects.push(messageObject);

      } catch (err) {
        console.error(`[${userId}] Erro ao processar mensagem do lote:`, err);
      }
    }

    const savedMessages = saveUserMessagesBatch(userId, messageObjects);
    if (savedMessages.length > 0) {
      await persistMessagesToSupabase(userId, savedMessages);
    }
  }

  // Escuta novas mensagens (enviadas e recebidas em tempo real)
  sock.ev.on('messages.upsert', async (m) => {
    if (instance.connectionGeneration !== connectionGeneration) return;
    if (m.type !== 'notify') return;
    await processUserMessages(m.messages);
  });

  // Escuta o histórico de mensagens inicial enviado pelo WhatsApp na sincronização
  sock.ev.on('messaging-history.set', async ({ chats, contacts, messages }) => {
    if (instance.connectionGeneration !== connectionGeneration) return;
    let totalMessages = 0;
    
    // 0. Sincroniza a lista de contatos da agenda inicial do celular
    if (contacts && contacts.length > 0) {
      for (const contact of contacts) {
        addContactRecordToCache(userId, instance, contact, 'history.contacts');
      }
      console.log(`[${userId}] Sincronizados ${contacts.length} contatos da agenda.`);
    }

    // 0.1. Sincroniza os nomes das conversas e grupos do histórico recente
    if (chats && chats.length > 0) {
      let syncGroupNamesCount = 0;
      for (const chat of chats) {
        if (addContactRecordToCache(userId, instance, chat, 'history.chats')) {
          if (chat.id.endsWith('@g.us')) {
            syncGroupNamesCount++;
          }
        }
      }
      console.log(`[${userId}] Sincronizados ${chats.length} chats recentes, incluindo ${syncGroupNamesCount} nomes de grupos.`);
    }
    
    // 1. Processa mensagens do array global (se houver)
    if (messages && messages.length > 0) {
      await processUserMessages(messages);
      totalMessages += messages.length;
    }
    
    // 2. Extrai e processa mensagens do histórico de cada chat (onde o Baileys agrupa o histórico real)
    if (chats && chats.length > 0) {
      let chatMsgsCount = 0;
      const retentionThreshold = Date.now() - (MESSAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000);
      for (const chat of chats) {
        if (chat.messages && chat.messages.length > 0) {
          // Filtra na origem do chat as mensagens recentes para poupar RAM e CPU
          const chatMsgs = chat.messages.filter(m => {
            if (!m) return false;
            return getMessageTimestampMs(m) >= retentionThreshold;
          });
          if (chatMsgs.length > 0) {
            await processUserMessages(chatMsgs);
            chatMsgsCount += chatMsgs.length;
          }
        }
      }
      totalMessages += chatMsgsCount;
    }
    
    await flushContactPersist(userId);
    saveContactsToFile(userId, instance.contactsCache || {});
    console.log(`[${userId}] Carga de histórico finalizada. Total de mensagens processadas: ${totalMessages}`);
  });
}

// Extrai texto de diferentes tipos de mensagens do Baileys
function getMessageText(msg) {
  if (!msg.message) return '';
  
  const content = unwrapMessageContent(msg.message);
  
  // Trata mensagem de texto simples
  if (content.conversation) return content.conversation;
  
  // Trata mensagem de texto formatada / respostas / links
  if (content.extendedTextMessage) return content.extendedTextMessage.text || '';
  
  // Trata mensagem de imagem com legenda
  if (content.imageMessage) return content.imageMessage.caption || '';
  
  // Trata mensagem de vídeo com legenda
  if (content.videoMessage) return content.videoMessage.caption || '';

  // Trata documentos e locais com legenda/descricao
  if (content.documentMessage) return content.documentMessage.caption || content.documentMessage.fileName || '';
  if (content.liveLocationMessage) return content.liveLocationMessage.caption || '';
  if (content.locationMessage) return content.locationMessage.name || content.locationMessage.address || '';
  
  // Trata mensagem com botões ou interações
  if (content.buttonsResponseMessage) {
    return content.buttonsResponseMessage.selectedDisplayText || content.buttonsResponseMessage.selectedButtonId || '';
  }
  if (content.templateButtonReplyMessage) {
    return content.templateButtonReplyMessage.selectedDisplayText || content.templateButtonReplyMessage.selectedId || '';
  }
  if (content.listResponseMessage) {
    const reply = content.listResponseMessage.singleSelectReply || {};
    return content.listResponseMessage.title || content.listResponseMessage.description || reply.selectedRowId || '';
  }
  if (content.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson) {
    try {
      const params = JSON.parse(content.interactiveResponseMessage.nativeFlowResponseMessage.paramsJson);
      return params.display_text || params.title || params.id || '';
    } catch {
      return content.interactiveResponseMessage.nativeFlowResponseMessage.paramsJson;
    }
  }
  if (content.pollCreationMessage) return content.pollCreationMessage.name || '';
  if (content.pollCreationMessageV3) return content.pollCreationMessageV3.name || '';
  if (content.contactMessage) return content.contactMessage.displayName || '';

  return '';
}

function unwrapMessageContent(content) {
  let current = content || {};
  const visited = new Set();

  while (current && typeof current === 'object' && !visited.has(current)) {
    visited.add(current);

    if (current.ephemeralMessage?.message) {
      current = current.ephemeralMessage.message;
      continue;
    }
    if (current.viewOnceMessage?.message) {
      current = current.viewOnceMessage.message;
      continue;
    }
    if (current.viewOnceMessageV2?.message) {
      current = current.viewOnceMessageV2.message;
      continue;
    }
    if (current.viewOnceMessageV2Extension?.message) {
      current = current.viewOnceMessageV2Extension.message;
      continue;
    }
    if (current.documentWithCaptionMessage?.message) {
      current = current.documentWithCaptionMessage.message;
      continue;
    }
    if (current.editedMessage?.message) {
      current = current.editedMessage.message;
      continue;
    }
    if (current.protocolMessage?.editedMessage) {
      current = current.protocolMessage.editedMessage;
      continue;
    }

    break;
  }

  return current || {};
}

// Salva mensagens localmente em arquivos JSON por data e isolado por usuário
function saveUserMessagesBatch(userId, messageObjects) {
  if (!messageObjects || messageObjects.length === 0) return [];

  const userMsgDir = path.join(dataDir, 'messages', userId);
  fs.mkdirSync(userMsgDir, { recursive: true });
  const messagesByDate = new Map();
  const savedMessages = [];

  for (const rawMessage of messageObjects) {
    const messageObject = normalizeStoredMessage(rawMessage);
    if (!messageObject.text || !messageObject.timestamp) continue;
    const dateStr = messageDateStr(new Date(messageObject.timestamp).getTime());
    if (!messagesByDate.has(dateStr)) messagesByDate.set(dateStr, []);
    messagesByDate.get(dateStr).push(messageObject);
  }

  for (const [dateStr, dateMessages] of messagesByDate.entries()) {
    const filePath = path.join(userMsgDir, `messages-${dateStr}.json`);
    let messages = [];

    try {
      if (fs.existsSync(filePath)) {
        const rawData = fs.readFileSync(filePath, 'utf8');
        messages = JSON.parse(rawData).map(normalizeStoredMessage);
      }
    } catch (e) {
      console.error(`Erro ao ler mensagens de ${dateStr} do usuário ${userId}:`, e);
    }

    const seen = new Set(messages.map(m => m.dedupeKey || createDedupeKey(m)));
    let changed = false;

    for (const messageObject of dateMessages) {
      const dedupeKey = messageObject.dedupeKey || createDedupeKey(messageObject);
      if (seen.has(dedupeKey)) continue;
      messageObject.dedupeKey = dedupeKey;
      seen.add(dedupeKey);
      messages.push(messageObject);
      savedMessages.push(messageObject);
      changed = true;
    }

    if (!changed) continue;

    try {
      messages.sort(compareMessagesChronologically);
      fs.writeFileSync(filePath, JSON.stringify(messages, null, JSON_INDENT), 'utf8');
    } catch (e) {
      console.error(`Erro ao gravar mensagens de ${dateStr} do usuário ${userId}:`, e);
    }
  }

  return savedMessages;
}

async function persistMessagesToSupabase(userId, messages) {
  if (!messages || messages.length === 0) return 0;

  const rows = messages.map(message => {
    const normalized = normalizeStoredMessage(message);
    return {
      user_id: userId,
      dedupe_key: normalized.dedupeKey,
      message_id: normalized.id,
      chat_jid: normalized.chatJid,
      chat_number: normalized.sender,
      chat_name: normalized.chatName || null,
      participant_jid: normalized.participantJid,
      participant_number: normalized.participant,
      participant_aliases: normalized.participantAliases || [],
      display_name: normalized.name || null,
      text: normalized.text,
      from_me: normalized.fromMe,
      message_timestamp: normalized.timestamp,
      message_date: messageDateStr(new Date(normalized.timestamp).getTime()),
      updated_at: new Date().toISOString()
    };
  });

  let persisted = 0;
  for (const chunk of chunkArray(rows, 250)) {
    const response = await supabaseRest(
      'whatsapp_messages',
      '?on_conflict=user_id,dedupe_key',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-dupes,return=minimal'
        },
        body: JSON.stringify(chunk)
      }
    );
    if (response) persisted += chunk.length;
  }

  if (persisted < rows.length) {
    const messagesByDate = new Map();
    for (const message of messages.map(normalizeStoredMessage)) {
      const dateStr = messageDateStr(new Date(message.timestamp).getTime());
      if (!messagesByDate.has(dateStr)) messagesByDate.set(dateStr, []);
      messagesByDate.get(dateStr).push(message);
    }

    for (const [dateStr, dateMessages] of messagesByDate.entries()) {
      const existingSnapshot = await loadStateBlobFromSupabase(userId, 'messages', dateStr) || [];
      const mergedSnapshot = mergeMessages(existingSnapshot, dateMessages);
      await saveStateBlobToSupabase(userId, 'messages', dateStr, mergedSnapshot);
    }
  }

  return persisted;
}

async function loadMessagesFromSupabase(userId, dateStr) {
  const response = await supabaseRest(
    'whatsapp_messages',
    `?user_id=eq.${supabaseEq(userId)}&message_date=eq.${supabaseEq(dateStr)}&select=dedupe_key,message_id,chat_jid,chat_number,chat_name,participant_jid,participant_number,participant_aliases,display_name,text,from_me,message_timestamp&order=message_timestamp.asc&limit=20000`
  );
  if (!response) {
    const fallbackMessages = await loadStateBlobFromSupabase(userId, 'messages', dateStr);
    return Array.isArray(fallbackMessages) ? fallbackMessages.map(normalizeStoredMessage) : [];
  }

  try {
    const rows = await response.json();
    return rows.map(row => normalizeStoredMessage({
      dedupe_key: row.dedupe_key,
      message_id: row.message_id,
      chat_jid: row.chat_jid,
      chat_number: row.chat_number,
      chat_name: row.chat_name,
      participant_jid: row.participant_jid,
      participant_number: row.participant_number,
      participant_aliases: row.participant_aliases,
      display_name: row.display_name,
      text: row.text,
      from_me: row.from_me,
      message_timestamp: row.message_timestamp
    }));
  } catch (err) {
    console.warn(`[${userId}] Falha ao carregar mensagens do Supabase:`, err.message || err);
  }

  const fallbackMessages = await loadStateBlobFromSupabase(userId, 'messages', dateStr);
  return Array.isArray(fallbackMessages) ? fallbackMessages.map(normalizeStoredMessage) : [];
}

// Higieniza o JID removendo IDs de dispositivos pareados para garantir compatibilidade no cache de contatos
function cleanJid(jid) {
  if (!jid || typeof jid !== 'string') return '';
  // Exemplo: 5521979710824:89@s.whatsapp.net -> 5521979710824@s.whatsapp.net
  if (jid.includes(':')) {
    const parts = jid.split('@');
    if (parts.length === 2) {
      const numberPart = parts[0].split(':')[0];
      return `${numberPart}@${parts[1]}`;
    }
  }
  return jid;
}

// Formatador global de datas no formato YYYY-MM-DD para evitar instanciações repetidas lentas na CPU
const yyyymmddFormatter = new Intl.DateTimeFormat('fr-CA', {
  timeZone: 'America/Sao_Paulo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});

// Dicionário de instâncias ativas em memória
const instances = {};

// Reseta o timer de inatividade de sincronização do WhatsApp
function resetUserSyncTimer(userId) {
  const instance = instances[userId];
  if (!instance) return;

  instance.lastSyncActivity = Date.now();

  if (instance.connectionStatus === 'connected' && instance.syncStatus !== 'completed') {
    if (instance.syncTimer) {
      clearTimeout(instance.syncTimer);
    }

    instance.syncTimer = setTimeout(() => {
      instance.syncStatus = 'completed';
      console.log(`[${userId}] Sincronização concluída por inatividade de eventos (mensagens e contatos processados).`);
      instance.syncTimer = null;
    }, SYNC_IDLE_COMPLETE_MS);
  }
}

// Retorna ou cria dinamicamente a instância do WhatsApp de um usuário sob demanda
async function getOrCreateInstance(userId) {
  if (!userId || typeof userId !== 'string' || userId.trim().length < 5) {
    return null;
  }
  
  // Higieniza o userId para evitar caminhos maliciosos no filesystem
  const cleanUserId = userId.replace(/[^a-zA-Z0-9-_]/g, '');
  
  if (instances[cleanUserId]) {
    return instances[cleanUserId];
  }

  console.log(`Inicializando instância dinâmica sob demanda para o usuário: ${cleanUserId}`);
  const localContactsCache = loadContactsFromFile(cleanUserId);
  const remoteContactsCache = await loadContactsFromSupabase(cleanUserId);
  const hydratedContactsCache = mergeContactCaches(localContactsCache, remoteContactsCache);
  
  const instanceState = {
    sock: null,
    currentQr: null,
    connectionStatus: 'connecting',
    syncStatus: 'pending',
    messagesProcessedCount: 0,
    contactsCache: hydratedContactsCache,
    groupMetadataCache: {}, // Cache de metadados dos grupos para otimização e evitar rate-limit do WhatsApp
    lastSyncActivity: Date.now(),
    syncTimer: null,
    contactsSaveTimer: null,
    reconnectTimer: null,
    connectionGeneration: 0,
    lastStoredMessageContactHydration: 0
  };

  instances[cleanUserId] = instanceState;
  if (Object.keys(hydratedContactsCache).length > 0) {
    saveContactsToFile(cleanUserId, hydratedContactsCache);
  }
  
  // Inicia o processo de conexão do Baileys assincronamente
  connectUserWhatsApp(cleanUserId);
  
  // Pequena pausa para dar tempo ao socket de iniciar
  await new Promise(resolve => setTimeout(resolve, 500));

  return instanceState;
}

// Habilita o CORS para permitir requisições do frontend local (localhost)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, x-api-key');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Helper para extrair cookies do cabeçalho HTTP
function parseCookies(cookieHeader) {
  const list = {};
  if (!cookieHeader) return list;
  cookieHeader.split(';').forEach(cookie => {
    const parts = cookie.split('=');
    if (parts.length >= 2) {
      list[parts.shift().trim()] = decodeURI(parts.join('='));
    }
  });
  return list;
}

// Middleware de verificação de API Key para segurança de dados
const API_KEY = process.env.WHATSAPP_API_KEY;

function checkAuth(req, res, next) {
  const cookies = parseCookies(req.headers.cookie);
  
  // Lê a chave de API do Header, da Query string, ou do Cookie persistente
  const token = req.headers['x-api-key'] || req.query.key || cookies['whatsapp_api_key'];
  
  if (!token) {
    return denyAccess(req, res);
  }
  
  // Valida se o token é a API_KEY global do servidor ou um formato UUID válido (usuário do Supabase)
  const isMasterKey = API_KEY && token === API_KEY;
  const isUuidKey = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(token);
  
  if (!isMasterKey && !isUuidKey) {
    return denyAccess(req, res);
  }
  
  // Salva o token nos cookies para pings e navegação subsequente
  res.cookie('whatsapp_api_key', token, {
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 dias
    httpOnly: true,
    secure: true,
    sameSite: 'lax'
  });
  
  next();
}

function denyAccess(req, res) {
  return res.status(401).send(`
    <html>
      <head>
        <title>Não Autorizado</title>
        <style>
          body { font-family: sans-serif; background: #0f172a; color: #f8fafc; text-align: center; padding-top: 5rem; }
          .card { max-width: 500px; margin: 0 auto; background: #1e293b; padding: 2.5rem; border-radius: 12px; border: 1px solid #ef4444; }
          h2 { color: #ef4444; margin-top: 0; }
        </style>
      </head>
      <body>
        <div class="card">
          <h2>⚠️ Acesso Não Autorizado</h2>
          <p>Este gateway do WhatsApp está protegido por chaves de segurança da aplicação.</p>
          <p>Por favor, acesse o painel principal do FollowUp Mônada para fazer a integração.</p>
        </div>
      </body>
    </html>
  `);
}

function readLocalMessagesForDate(userId, dateStr) {
  const filePath = path.join(dataDir, 'messages', userId, `messages-${dateStr}.json`);
  try {
    if (!fs.existsSync(filePath)) return [];
    return JSON.parse(fs.readFileSync(filePath, 'utf8')).map(normalizeStoredMessage);
  } catch (err) {
    console.warn(`[${userId}] Falha ao ler mensagens locais de ${dateStr}:`, err.message || err);
    return [];
  }
}

function listLocalMessageFiles(userId) {
  const userMsgDir = path.join(dataDir, 'messages', userId);
  if (!fs.existsSync(userMsgDir)) return [];
  return fs.readdirSync(userMsgDir)
    .filter(file => file.startsWith('messages-') && file.endsWith('.json'))
    .map(file => file.replace('messages-', '').replace('.json', ''))
    .sort();
}

function analyzeMessagesIntegrity(messages, contactsCache) {
  const seen = new Set();
  let duplicateKeys = 0;
  let outOfOrder = 0;
  let missingChatNames = 0;
  let missingSenderNames = 0;
  let previousTime = 0;

  for (const raw of messages) {
    const message = normalizeStoredMessage(raw);
    const key = message.dedupeKey || createDedupeKey(message);
    if (seen.has(key)) duplicateKeys++;
    seen.add(key);

    const currentTime = new Date(message.timestamp).getTime();
    if (previousTime && currentTime < previousTime) outOfOrder++;
    previousTime = currentTime;

    const chatName = contactsCache[message.chatJid] || message.chatName;
    if (!chatName || looksLikeTechnicalName(chatName)) missingChatNames++;

    if (!message.fromMe) {
      const participantName = bestNameFromAliases([message.participantJid, ...(message.participantAliases || [])], contactsCache) || message.name;
      if (!participantName || looksLikeTechnicalName(participantName)) missingSenderNames++;
    }
  }

  return {
    total: messages.length,
    unique: seen.size,
    duplicateKeys,
    outOfOrder,
    missingChatNames,
    missingSenderNames,
    firstTimestamp: messages[0]?.timestamp || null,
    lastTimestamp: messages[messages.length - 1]?.timestamp || null,
    ok: duplicateKeys === 0 && outOfOrder === 0
  };
}

async function buildDiagnostics(userId, dateStr) {
  const instance = instances[userId];
  let contacts = mergeContactCaches(
    loadContactsFromFile(userId),
    await loadContactsFromSupabase(userId),
    instance ? instance.contactsCache : {}
  );

  const dates = dateStr ? [dateStr] : listLocalMessageFiles(userId).slice(-7);
  const dateStats = [];

  for (const date of dates) {
    const localMessages = readLocalMessagesForDate(userId, date);
    const remoteMessages = await loadMessagesFromSupabase(userId, date);
    const mergedMessages = mergeMessages(localMessages, remoteMessages);
    if (instance) {
      instance.contactsCache = mergeContactCaches(contacts, instance.contactsCache || {});
      await hydrateContactsFromStoredMessages(userId, instance, mergedMessages, date);
      if (instance.connectionStatus === 'connected') {
        const groupJids = uniqueJids(mergedMessages.map(m => m.chatJid)).filter(isGroupJid);
        if (groupJids.length > 0) await refreshGroupMetadataAliases(userId, instance, groupJids);
      }
      contacts = mergeContactCaches(contacts, instance.contactsCache || {});
    }
    dateStats.push({
      date,
      localCount: localMessages.length,
      remoteCount: remoteMessages.length,
      mergedCount: mergedMessages.length,
      integrity: analyzeMessagesIntegrity(mergedMessages, contacts)
    });
  }

  return {
    status: instance ? instance.connectionStatus : 'not_initialized',
    syncStatus: instance ? instance.syncStatus : 'not_initialized',
    messagesProcessedInSession: instance ? instance.messagesProcessedCount : 0,
    contactsCount: Object.keys(contacts).length,
    retentionDays: MESSAGE_RETENTION_DAYS,
    persistence: {
      supabaseConfigured: !!getSupabaseConfig(),
      disabledTables: Array.from(supabaseDisabledTables),
      fallbackSnapshots: true
    },
    dates: dateStats,
    generatedAt: new Date().toISOString()
  };
}

function clearLocalMessageFiles(userId, dateStr) {
  const userMsgDir = path.join(dataDir, 'messages', userId);
  if (!fs.existsSync(userMsgDir)) return 0;
  const files = fs.readdirSync(userMsgDir)
    .filter(file => file.startsWith('messages-') && file.endsWith('.json'))
    .filter(file => !dateStr || file === `messages-${dateStr}.json`);

  for (const file of files) {
    fs.unlinkSync(path.join(userMsgDir, file));
  }

  return files.length;
}

async function handleMaintenanceResync(req, res) {
  const userId = req.headers['x-api-key'] || req.query.key || parseCookies(req.headers.cookie)['whatsapp_api_key'];
  if (!userId) {
    return res.status(400).json({ error: 'Identificação de usuário necessária.' });
  }

  const cleanUserId = userId.replace(/[^a-zA-Z0-9-_]/g, '');
  const mode = String(req.query.mode || 'soft');
  const dateStr = req.query.date && /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date)) ? String(req.query.date) : null;
  let clearedMessageFiles = 0;
  let clearedContacts = false;

  let instance = instances[cleanUserId] || await getOrCreateInstance(cleanUserId);

  if (mode === 'desync-local') {
    clearedMessageFiles = clearLocalMessageFiles(cleanUserId, dateStr);
    try {
      const contactsPath = contactsFilePath(cleanUserId);
      if (fs.existsSync(contactsPath)) fs.unlinkSync(contactsPath);
      clearedContacts = true;
    } catch (err) {
      console.warn(`[${cleanUserId}] Falha ao limpar cache local de contatos:`, err.message || err);
    }
    if (instance) {
      instance.contactsCache = {};
    }
  }

  const contacts = mergeContactCaches(
    loadContactsFromFile(cleanUserId),
    await loadContactsFromSupabase(cleanUserId),
    instance ? instance.contactsCache : {}
  );

  if (instance) {
    instance.contactsCache = contacts;
    instance.syncStatus = 'syncing';
    instance.messagesProcessedCount = 0;
    resetUserSyncTimer(cleanUserId);
    saveContactsToFile(cleanUserId, contacts);
    connectUserWhatsApp(cleanUserId);
  }

  const diagnostics = await buildDiagnostics(cleanUserId, dateStr || undefined);
  return res.json({
    ok: true,
    mode,
    clearedMessageFiles,
    clearedContacts,
    restarted: !!instance,
    diagnostics
  });
}

// --- ROTAS DO SERVIDOR HTTP ---

// Rota principal (Home/Dashboard simples) - protegida
app.get('/', checkAuth, async (req, res) => {
  const userId = req.headers['x-api-key'] || req.query.key || parseCookies(req.headers.cookie)['whatsapp_api_key'];
  const instance = await getOrCreateInstance(userId);
  
  const connStatus = instance ? instance.connectionStatus : 'disconnected';
  const syncStatusVal = instance ? instance.syncStatus : 'pending';
  
  const queryParam = userId ? `?key=${userId}` : '';
  res.send(`
    <html>
      <head>
        <title>WhatsApp Web Integration Gateway</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f8fafc; padding: 2rem; }
          h1 { font-size: 1.75rem; margin-bottom: 0.5rem; background: linear-gradient(135deg, #10b981 0%, #3b82f6 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; margin-top: 0; }
          .container { max-width: 800px; margin: 0 auto; background: #1e293b; padding: 2rem; border-radius: 12px; border: 1px solid #334155; box-shadow: 0 4px 20px rgba(0,0,0,0.3); display: flex; flex-direction: column; gap: 1.5rem; }
          .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #334155; padding-bottom: 1rem; }
          .status { display: inline-block; padding: 0.35rem 0.85rem; border-radius: 9999px; font-weight: bold; font-size: 0.85rem; }
          .connected { background: rgba(16, 185, 129, 0.15); color: #10b981; border: 1px solid rgba(16, 185, 129, 0.3); }
          .qrcode { background: rgba(245, 158, 11, 0.15); color: #f59e0b; border: 1px solid rgba(245, 158, 11, 0.3); }
          .connecting { background: rgba(59, 130, 246, 0.15); color: #3b82f6; border: 1px solid rgba(59, 130, 246, 0.3); }
          .disconnected { background: rgba(239, 68, 68, 0.15); color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.3); }
          .controls { display: flex; gap: 1rem; flex-wrap: wrap; align-items: flex-end; background: #0f172a; padding: 1.25rem; border-radius: 8px; border: 1px solid #334155; }
          .form-group { display: flex; flex-direction: column; gap: 0.35rem; }
          label { font-size: 0.75rem; color: #94a3b8; font-weight: 600; text-transform: uppercase; }
          input, select, button { background: #1e293b; border: 1px solid #334155; color: white; padding: 0.5rem 0.75rem; border-radius: 6px; font-size: 0.9rem; outline: none; }
          input:focus, select:focus { border-color: #3b82f6; }
          button { background: linear-gradient(135deg, #10b981 0%, #059669 100%); border: none; font-weight: bold; cursor: pointer; transition: opacity 0.2s; padding: 0.5rem 1.25rem; }
          button:hover { opacity: 0.9; }
          .viewer { display: flex; flex-direction: column; gap: 0.5rem; }
          pre { background: #0f172a; border: 1px solid #334155; border-radius: 8px; padding: 1rem; overflow: auto; max-height: 400px; font-family: monospace; font-size: 0.85rem; color: #38bdf8; white-space: pre-wrap; word-break: break-all; }
          .nav-links { display: flex; gap: 0.75rem; align-items: center; }
          .nav-links a { 
            text-decoration: none; 
            font-size: 0.82rem; 
            font-weight: 600; 
            padding: 0.45rem 0.85rem; 
            border-radius: 6px; 
            transition: all 0.2s; 
            white-space: nowrap; 
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <div>
              <h1>WhatsApp Gateway 🔌</h1>
              <p style="color: #94a3b8; font-size: 0.85rem; margin: 0;">Coleta e visualização persistente de mensagens</p>
            </div>
            <div class="nav-links">
              <a id="logoutLink" href="#" style="display: none; color: #f87171; border: 1px solid rgba(239, 68, 68, 0.3); background: rgba(239, 68, 68, 0.08);" onmouseover="this.style.background='rgba(239, 68, 68, 0.18)'" onmouseout="this.style.background='rgba(239, 68, 68, 0.08)'" onclick="handleLogout(event)">🔴 Desconectar WhatsApp</a>
              <a href="/qr${queryParam}" style="color: #34d399; border: 1px solid rgba(16, 185, 129, 0.3); background: rgba(16, 185, 129, 0.08);" onmouseover="this.style.background='rgba(16, 185, 129, 0.18)'" onmouseout="this.style.background='rgba(16, 185, 129, 0.08)'">🔗 Login / QR Code</a>
              <a href="/status${queryParam}" style="color: #60a5fa; border: 1px solid rgba(59, 130, 246, 0.3); background: rgba(59, 130, 246, 0.08);" onmouseover="this.style.background='rgba(59, 130, 246, 0.18)'" onmouseout="this.style.background='rgba(59, 130, 246, 0.08)'">📡 Status JSON</a>
            </div>
          </div>
          
          <div style="display: flex; flex-direction: column; gap: 0.75rem; background: #0f172a; padding: 1.25rem; border-radius: 8px; border: 1px solid #334155;">
            <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 0.5rem;">
              <span id="connStatusBadge" class="status ${connStatus}">Status: ${connStatus.toUpperCase()}</span>
              <span id="syncStatusBadge" style="display: none; font-size: 0.85rem; padding: 0.35rem 0.85rem; border-radius: 9999px; font-weight: bold;"></span>
            </div>
            
            <div id="syncProgressContainer" style="display: none; flex-direction: column; gap: 0.5rem; width: 100%;">
              <div style="display: flex; justify-content: space-between; align-items: center; font-size: 0.85rem;">
                <span id="syncProgressText" style="color: #94a3b8; font-weight: 500;">Inicializando sincronização...</span>
                <span id="syncProgressPercent" style="color: #38bdf8; font-weight: bold;">0%</span>
              </div>
              <div style="width: 100%; height: 6px; background: #1e293b; border-radius: 9999px; overflow: hidden; border: 1px solid #334155;">
                <div id="syncProgressBarFill" style="width: 0%; height: 100%; background: linear-gradient(90deg, #3b82f6 0%, #10b981 100%); transition: width 0.4s ease; border-radius: 9999px;"></div>
              </div>
            </div>
          </div>

          <div class="controls">
            <div class="form-group">
              <label for="msgDate">Selecionar Data:</label>
              <input type="date" id="msgDate"/>
            </div>
            <div class="form-group">
              <label for="msgFormat">Formato:</label>
              <select id="msgFormat">
                <option value="text">Texto Corrido (Leitura)</option>
                <option value="json">JSON Estruturado</option>
              </select>
            </div>
            <button id="btnFetch">🔍 Buscar Mensagens</button>
            <button id="btnContacts" style="background: linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%); font-weight: bold; cursor: pointer; transition: opacity 0.2s; padding: 0.5rem 1.25rem; border: none; border-radius: 6px; color: white;">📋 Ver Contatos</button>
            <button id="btnDiagnostics" style="background: linear-gradient(135deg, #14b8a6 0%, #0f766e 100%); font-weight: bold; cursor: pointer; transition: opacity 0.2s; padding: 0.5rem 1.25rem; border: none; border-radius: 6px; color: white;">Verificar Integridade</button>
            <button id="btnResync" style="background: linear-gradient(135deg, #f59e0b 0%, #b45309 100%); font-weight: bold; cursor: pointer; transition: opacity 0.2s; padding: 0.5rem 1.25rem; border: none; border-radius: 6px; color: white;">Ressincronizar Cache</button>
          </div>

          <div class="viewer">
            <label id="viewerLabel">Mensagens Registradas:</label>
            <pre id="output">Clique em "Buscar Mensagens" para carregar os logs do dia selecionado.</pre>
          </div>
        </div>

        <script>
          // Define a data de hoje no input de data por padrão
          const dateInput = document.getElementById('msgDate');
          const today = new Date().toISOString().split('T')[0];
          dateInput.value = today;

          // Elementos de Status de Sincronização
          const connStatusBadge = document.getElementById('connStatusBadge');
          const syncStatusBadge = document.getElementById('syncStatusBadge');
          const syncProgressContainer = document.getElementById('syncProgressContainer');
          const syncProgressText = document.getElementById('syncProgressText');
          const syncProgressPercent = document.getElementById('syncProgressPercent');
          const syncProgressBarFill = document.getElementById('syncProgressBarFill');
          const logoutLink = document.getElementById('logoutLink');

          // Função para desconectar a sessão do WhatsApp
          async function handleLogout(e) {
            e.preventDefault();
            if (!confirm('Deseja realmente encerrar a sessão do WhatsApp? Você precisará ler um QR Code novamente para reconectar.')) return;
            
            try {
              const response = await fetch('/logout');
              if (response.ok) {
                alert('Sessão encerrada e logs limpos com sucesso!');
                window.location.href = '/qr' + window.location.search;
              } else {
                alert('Erro ao desconectar: ' + response.statusText);
              }
            } catch (err) {
              alert('Erro de rede ao desconectar: ' + err.message);
            }
          }

          // Função para atualizar barra de status de sincronização
          async function updateSyncStatus() {
            try {
              const response = await fetch('/status');
              if (!response.ok) return;
              const data = await response.json();
              
              // Atualiza o status da conexão principal
              connStatusBadge.textContent = 'Status: ' + data.status.toUpperCase();
              connStatusBadge.className = 'status ' + data.status;
              
              if (data.status === 'connected') {
                logoutLink.style.display = 'inline-block';
                syncStatusBadge.style.display = 'inline-block';
                syncProgressContainer.style.display = 'flex';
                
                if (data.syncStatus === 'syncing') {
                  syncStatusBadge.textContent = '🔄 SINCRONIZANDO';
                  syncStatusBadge.style.background = 'rgba(245, 158, 11, 0.15)';
                  syncStatusBadge.style.color = '#f59e0b';
                  syncStatusBadge.style.border = '1px solid rgba(245, 158, 11, 0.3)';
                  
                  const count = data.messagesCount || 0;
                  const percent = Math.min(95, Math.floor(100 * (1 - Math.exp(-count / 150))));
                  
                  syncProgressText.textContent = 'Sincronizando histórico... (' + count + ' mensagens importadas)';
                  syncProgressPercent.textContent = percent + '%';
                  syncProgressBarFill.style.width = percent + '%';
                  
                } else if (data.syncStatus === 'completed') {
                  syncStatusBadge.textContent = '✓ SINCRONIZADO';
                  syncStatusBadge.style.background = 'rgba(16, 185, 129, 0.15)';
                  syncStatusBadge.style.color = '#10b981';
                  syncStatusBadge.style.border = '1px solid rgba(16, 185, 129, 0.3)';
                  
                  syncProgressText.textContent = 'Histórico recente de sincronização importado com sucesso!';
                  syncProgressPercent.textContent = '100%';
                  syncProgressBarFill.style.width = '100%';
                } else {
                  syncStatusBadge.style.display = 'none';
                  syncProgressContainer.style.display = 'none';
                }
              } else {
                logoutLink.style.display = 'none';
                syncStatusBadge.style.display = 'none';
                syncProgressContainer.style.display = 'none';
              }
            } catch (err) {
              console.error('Erro no polling de status:', err);
            }
          }

          // Executa a primeira vez e define o polling a cada 3 segundos
          updateSyncStatus();
          setInterval(updateSyncStatus, 3000);

          // Função para buscar mensagens
          document.getElementById('btnFetch').addEventListener('click', async () => {
            const date = dateInput.value;
            const format = document.getElementById('msgFormat').value;
            const output = document.getElementById('output');
            const label = document.getElementById('viewerLabel');
            
            if (!date) {
              alert('Por favor, selecione uma data.');
              return;
            }

            output.textContent = 'Buscando mensagens no servidor...';
            label.textContent = 'Mensagens do dia: ' + date.split('-').reverse().join('/');

            try {
              const response = await fetch('/messages?date=' + date + '&format=' + format);
              
              if (!response.ok) {
                if (response.status === 401) {
                  output.textContent = 'Erro 401: Acesso Não Autorizado.';
                  return;
                }
                throw new Error('Erro do servidor: ' + response.status);
              }

              if (format === 'json') {
                const data = await response.json();
                output.textContent = JSON.stringify(data, null, 2);
              } else {
                const text = await response.text();
                output.textContent = text.trim() ? text : 'Nenhuma mensagem registrada para esta data.';
              }
            } catch (err) {
              output.textContent = 'Erro ao buscar mensagens: ' + err.message;
            }
          });

          // Função para buscar e renderizar contatos sincronizados
          document.getElementById('btnContacts').addEventListener('click', async () => {
            const output = document.getElementById('output');
            const label = document.getElementById('viewerLabel');
            
            output.textContent = 'Buscando contatos sincronizados...';
            label.textContent = 'Contatos e Grupos Sincronizados:';

            try {
              // Obtém a API Key da URL para autenticação
              const urlParams = new URLSearchParams(window.location.search);
              const key = urlParams.get('key') || '';
              const keyParam = key ? '?key=' + key : '';

              const response = await fetch('/contacts' + keyParam);
              if (!response.ok) {
                if (response.status === 401) {
                  output.textContent = 'Erro 401: Acesso Não Autorizado.';
                  return;
                }
                throw new Error('Erro do servidor: ' + response.status);
              }

              const data = await response.json();
              if (data.count === 0) {
                output.textContent = 'Nenhum contato ou grupo sincronizado na memória deste servidor ainda.';
                return;
              }

              let text = 'Total de Contatos/Chats Sincronizados: ' + data.count + '\\n\\n';
              const sorted = Object.entries(data.contacts).sort((a, b) => a[1].localeCompare(b[1]));
              
              sorted.forEach(([jid, name]) => {
                const number = jid.split('@')[0];
                const type = jid.endsWith('@g.us') ? 'GRUPO' : 'CONTATO';
                text += '• [' + type + '] ' + name + ' (' + number + ')\\n';
              });

              output.textContent = text;
            } catch (err) {
              output.textContent = 'Erro ao buscar contatos: ' + err.message;
            }
          });

          // Função para verificar integridade de mensagens, nomes e ordenação
          document.getElementById('btnDiagnostics').addEventListener('click', async () => {
            const date = dateInput.value;
            const output = document.getElementById('output');
            const label = document.getElementById('viewerLabel');
            output.textContent = 'Verificando integridade dos dados...';
            label.textContent = 'Diagnóstico de Integridade:';

            try {
              const response = await fetch('/diagnostics?date=' + date);
              if (!response.ok) throw new Error('Erro do servidor: ' + response.status);
              const data = await response.json();
              output.textContent = JSON.stringify(data, null, 2);
            } catch (err) {
              output.textContent = 'Erro ao verificar integridade: ' + err.message;
            }
          });

          // Reinicia o socket e reidrata os caches sem desconectar o WhatsApp do celular
          document.getElementById('btnResync').addEventListener('click', async () => {
            const date = dateInput.value;
            const output = document.getElementById('output');
            const label = document.getElementById('viewerLabel');
            if (!confirm('Ressincronizar o cache local sem apagar credenciais nem desconectar o celular?')) return;
            output.textContent = 'Ressincronizando cache local e reiniciando o socket...';
            label.textContent = 'Ressincronização:';

            try {
              const response = await fetch('/maintenance/resync?mode=soft&date=' + date);
              if (!response.ok) throw new Error('Erro do servidor: ' + response.status);
              const data = await response.json();
              output.textContent = JSON.stringify(data, null, 2);
              updateSyncStatus();
            } catch (err) {
              output.textContent = 'Erro ao ressincronizar: ' + err.message;
            }
          });
        </script>
      </body>
    </html>
  `);
});

// Retorna o status da conexão em JSON
app.get('/status', checkAuth, async (req, res) => {
  const userId = req.headers['x-api-key'] || req.query.key || parseCookies(req.headers.cookie)['whatsapp_api_key'];
  const instance = await getOrCreateInstance(userId);
  if (!instance) {
    return res.status(400).json({ error: 'Identificação de usuário necessária.' });
  }

  res.json({
    status: instance.connectionStatus,
    connected: instance.connectionStatus === 'connected',
    qrAvailable: !!instance.currentQr,
    syncStatus: instance.syncStatus,
    messagesCount: instance.messagesProcessedCount,
    contactsCount: Object.keys(instance.contactsCache || {}).length,
    lastSyncActivity: instance.lastSyncActivity ? new Date(instance.lastSyncActivity).toISOString() : null,
    retentionDays: MESSAGE_RETENTION_DAYS,
    persistence: {
      supabaseConfigured: !!getSupabaseConfig(),
      disabledTables: Array.from(supabaseDisabledTables),
      fallbackSnapshots: true
    },
    user: instance.sock && instance.sock.user ? {
      id: instance.sock.user.id,
      name: instance.sock.user.name
    } : null
  });
});

// Retorna a lista de contatos sincronizados em JSON
app.get('/contacts', checkAuth, async (req, res) => {
  const userId = req.headers['x-api-key'] || req.query.key || parseCookies(req.headers.cookie)['whatsapp_api_key'];
  if (!userId) {
    return res.status(400).json({ error: 'Identificação de usuário necessária.' });
  }

  const cleanUserId = userId.replace(/[^a-zA-Z0-9-_]/g, '');
  const instance = instances[cleanUserId];
  const localContactsCache = loadContactsFromFile(cleanUserId);
  const remoteContactsCache = await loadContactsFromSupabase(cleanUserId);
  const contacts = mergeContactCaches(localContactsCache, remoteContactsCache, instance ? instance.contactsCache : {});

  if (instance) {
    instance.contactsCache = mergeContactCaches(instance.contactsCache, contacts);
    scheduleContactsFileSave(cleanUserId, instance);
  } else if (Object.keys(contacts).length > 0) {
    saveContactsToFile(cleanUserId, contacts);
  }

  res.json({
    count: Object.keys(contacts || {}).length,
    contacts: contacts || {}
  });
});

// Diagnostico de integridade para dar confianca sobre ordem, duplicidade e nomes
app.get('/diagnostics', checkAuth, async (req, res) => {
  const userId = req.headers['x-api-key'] || req.query.key || parseCookies(req.headers.cookie)['whatsapp_api_key'];
  if (!userId) {
    return res.status(400).json({ error: 'Identificação de usuário necessária.' });
  }

  const cleanUserId = userId.replace(/[^a-zA-Z0-9-_]/g, '');
  const dateQuery = req.query.date;
  const dateStr = dateQuery && /^\d{4}-\d{2}-\d{2}$/.test(String(dateQuery)) ? String(dateQuery) : undefined;
  const diagnostics = await buildDiagnostics(cleanUserId, dateStr);
  res.json(diagnostics);
});

// Diagnostico pontual de aliases de participantes de um grupo
app.get('/diagnostics/group-aliases', checkAuth, async (req, res) => {
  const userId = req.headers['x-api-key'] || req.query.key || parseCookies(req.headers.cookie)['whatsapp_api_key'];
  if (!userId) {
    return res.status(400).json({ error: 'Identificacao de usuario necessaria.' });
  }

  const cleanUserId = userId.replace(/[^a-zA-Z0-9-_]/g, '');
  const groupParam = cleanJid(String(req.query.group || ''));
  if (!groupParam) {
    return res.status(400).json({ error: 'Informe o grupo em ?group=.' });
  }

  const groupJid = isGroupJid(groupParam) ? groupParam : `${groupParam}@g.us`;
  const instance = instances[cleanUserId] || await getOrCreateInstance(cleanUserId);
  if (!instance || instance.connectionStatus !== 'connected') {
    return res.status(409).json({ error: 'Sessao ainda nao conectada.', status: instance?.connectionStatus || 'not_initialized' });
  }

  await hydrateContactsFromStoredMessages(cleanUserId, instance);
  await refreshGroupMetadataAliases(cleanUserId, instance, [groupJid]);

  const contacts = mergeContactCaches(
    loadContactsFromFile(cleanUserId),
    await loadContactsFromSupabase(cleanUserId),
    instance.contactsCache || {}
  );
  const metadata = instance.groupMetadataCache[groupJid];

  res.json({
    groupJid,
    subject: contacts[groupJid] || metadata?.subject || '',
    participants: (metadata?.participants || []).map(participant => {
      const aliases = contactAliasJids(participant);
      return {
        id: participant.id || '',
        jid: participant.jid || '',
        lid: participant.lid || '',
        aliases,
        name: bestNameFromAliases(aliases, contacts) || null
      };
    })
  });
});

// Ressincronizacao leve sem apagar credenciais nem exigir novo QR Code
app.get('/maintenance/resync', checkAuth, handleMaintenanceResync);
app.post('/maintenance/resync', checkAuth, handleMaintenanceResync);

// Retorna o QR Code em base64 ou status da conexão em JSON para modais
app.get('/qr-code', checkAuth, async (req, res) => {
  const userId = req.headers['x-api-key'] || req.query.key || parseCookies(req.headers.cookie)['whatsapp_api_key'];
  const instance = await getOrCreateInstance(userId);
  if (!instance) {
    return res.status(400).json({ error: 'Identificação de usuário necessária.' });
  }

  if (instance.connectionStatus === 'connected') {
    return res.json({ status: 'connected' });
  }

  if (!instance.currentQr) {
    return res.json({ status: 'waiting' });
  }

  try {
    const qrImage = await QRCode.toDataURL(instance.currentQr, { width: 300, margin: 2 });
    res.json({ status: 'qrcode', qrCode: qrImage });
  } catch (e) {
    res.status(500).json({ error: 'Erro ao gerar QR Code.' });
  }
});

// Renderiza a página web com o QR Code de autenticação
app.get('/qr', checkAuth, async (req, res) => {
  const userId = req.headers['x-api-key'] || req.query.key || parseCookies(req.headers.cookie)['whatsapp_api_key'];
  const instance = await getOrCreateInstance(userId);
  if (!instance) {
    return res.status(400).send('Erro: Identificação do usuário inválida.');
  }

  const keyParam = userId ? `?key=${userId}` : '';

  if (instance.connectionStatus === 'connected') {
    return res.send(`
      <html>
        <head>
          <title>WhatsApp Conectado</title>
          <meta http-equiv="refresh" content="5; URL=/${keyParam}">
          <style>
            body { font-family: sans-serif; background: #0f172a; color: #f8fafc; text-align: center; padding-top: 5rem; }
            .card { max-width: 400px; margin: 0 auto; background: #1e293b; padding: 2rem; border-radius: 12px; border: 1px solid #10b981; }
            h1 { color: #10b981; }
          </style>
        </head>
        <body>
          <div class="card">
            <h1>✓ Conectado!</h1>
            <p>Seu WhatsApp já está conectado com sucesso.</p>
            <p style="color: #64748b; font-size: 0.85rem;">Redirecionando para a página principal em 5 segundos...</p>
          </div>
        </body>
      </html>
    `);
  }

  if (!instance.currentQr) {
    return res.send(`
      <html>
        <head>
          <title>Aguardando QR Code</title>
          <meta http-equiv="refresh" content="3">
          <style>
            body { font-family: sans-serif; background: #0f172a; color: #f8fafc; text-align: center; padding-top: 5rem; }
          </style>
        </head>
        <body>
          <h2>Aguardando geração do QR Code...</h2>
          <p>O servidor está inicializando a sessão. Esta página atualizará sozinha em instantes.</p>
        </body>
      </html>
    `);
  }

  try {
    const qrImage = await QRCode.toDataURL(instance.currentQr, { width: 300, margin: 2 });
    
    res.send(`
      <html>
        <head>
          <title>Escanear WhatsApp</title>
          <meta http-equiv="refresh" content="10">
          <style>
            body { font-family: sans-serif; background: #0f172a; color: #f8fafc; text-align: center; padding: 2rem; }
            .card { max-width: 450px; margin: 0 auto; background: #1e293b; padding: 2rem; border-radius: 12px; border: 1px solid #334155; }
            img { background: white; padding: 1rem; border-radius: 8px; margin: 1.5rem 0; box-shadow: 0 4px 12px rgba(0,0,0,0.5); }
            .btn { display: inline-block; padding: 0.5rem 1rem; background: #3b82f6; color: white; text-decoration: none; border-radius: 6px; font-weight: bold; margin-top: 1rem; }
            .btn:hover { background: #2563eb; }
          </style>
        </head>
        <body>
          <div class="card">
            <h2>Escanear QR Code 📱</h2>
            <p>Abra o WhatsApp no celular, vá em Dispositivos Conectados e escaneie o código abaixo:</p>
            <img src="${qrImage}" alt="QR Code do WhatsApp"/>
            <p style="color: #64748b; font-size: 0.8rem;">Esta página se atualiza automaticamente a cada 10 segundos.</p>
            <a href="/${keyParam}" class="btn">Voltar ao Início</a>
          </div>
        </body>
      </html>
    `);
  } catch (err) {
    res.status(500).send('Erro ao renderizar imagem do QR Code.');
  }
});

// Retorna as mensagens de um dia específico
app.get('/messages', checkAuth, async (req, res) => {
  const userId = req.headers['x-api-key'] || req.query.key || parseCookies(req.headers.cookie)['whatsapp_api_key'];
  if (!userId) {
    return res.status(400).json({ error: 'Identificação de usuário necessária.' });
  }

  const cleanUserId = userId.replace(/[^a-zA-Z0-9-_]/g, '');
  const dateQuery = req.query.date;
  const dateStr = dateQuery && /^\d{4}-\d{2}-\d{2}$/.test(dateQuery)
    ? dateQuery
    : new Date().toISOString().split('T')[0];

  const userMsgDir = path.join(dataDir, 'messages', cleanUserId);
  const filePath = path.join(userMsgDir, `messages-${dateStr}.json`);

  try {
    let localMessages = [];
    if (fs.existsSync(filePath)) {
      const rawData = fs.readFileSync(filePath, 'utf8');
      localMessages = JSON.parse(rawData);
    }
    const remoteMessages = await loadMessagesFromSupabase(cleanUserId, dateStr);
    const messages = mergeMessages(localMessages, remoteMessages);
    const activeInstance = instances[cleanUserId];
    if (activeInstance) {
      activeInstance.contactsCache = mergeContactCaches(
        loadContactsFromFile(cleanUserId),
        await loadContactsFromSupabase(cleanUserId),
        activeInstance.contactsCache || {}
      );
      await hydrateContactsFromStoredMessages(cleanUserId, activeInstance, messages, dateStr);
      if (activeInstance.connectionStatus === 'connected') {
        const groupJids = uniqueJids(messages.map(m => m.chatJid)).filter(isGroupJid);
        if (groupJids.length > 0) {
          await refreshGroupMetadataAliases(cleanUserId, activeInstance, groupJids);
        }
      }
    }

    if (messages.length > 0 && (!fs.existsSync(filePath) || remoteMessages.length > localMessages.length)) {
      fs.mkdirSync(userMsgDir, { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(messages, null, JSON_INDENT), 'utf8');
    }
    
    // Sempre ordena cronologicamente por timestamp (crescente: do mais antigo ao mais recente)
    messages.sort(compareMessagesChronologically);

    const formatText = req.query.format === 'text';
    if (formatText) {
      // Agrupa por remetente/conversa para a IA processar sem misturas
      const grouped = {};
      messages.forEach(m => {
        const normalized = normalizeStoredMessage(m);
        const chatKey = normalized.sender;
        if (!grouped[chatKey]) {
          grouped[chatKey] = {
            name: normalized.chatName || normalized.name || normalized.sender,
            chatJid: normalized.chatJid,
            messages: []
          };
        }
        grouped[chatKey].messages.push(normalized);
      });

      // Obtém contatos da instância ativa na memória para extrair nomes reais de conversas
      const contactsCache = mergeContactCaches(
        loadContactsFromFile(cleanUserId),
        await loadContactsFromSupabase(cleanUserId),
        activeInstance ? (activeInstance.contactsCache || {}) : {}
      );

      const formattedChats = [];
      const dateTimeFormatter = new Intl.DateTimeFormat('pt-BR', {
        timeZone: 'America/Sao_Paulo',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      });

      for (const chatKey in grouped) {
        const chat = grouped[chatKey];
        const isGroup = isGroupJid(chat.chatJid) || chat.messages.some(m => m.participant && m.participant !== m.sender);

        // 1. Tenta pegar o nome da conversa pelo cache de contatos
        const jid = chat.chatJid || (isGroup ? `${chatKey}@g.us` : `${chatKey}@s.whatsapp.net`);
        let displayName = contactsCache[jid] || chat.messages.find(m => m.chatName)?.chatName;
        
        // 2. Para chats individuais, se não estiver no cache, procura nas mensagens desse chat o nome do contato
        if (!displayName && !isGroup) {
          const nonMeMessage = chat.messages.find(m => !m.fromMe);
          if (nonMeMessage) {
            displayName = nonMeMessage.name;
          }
        }
        
        // 3. Se ainda assim não achar, ou se for o JID puro, ou se for "Eu", define fallbacks
        if (!displayName || displayName === 'Eu' || displayName.includes('@')) {
          displayName = chatKey;
        }

        const chatMessagesText = chat.messages.map(m => {
          const dateTimeStr = dateTimeFormatter.format(new Date(m.timestamp)).replace(',', '');
          const senderName = resolveMessageSenderName(m, contactsCache, isGroup);
          return `  [${dateTimeStr}] ${senderName}: ${m.text}`;
        }).join('\n');
        
        formattedChats.push(`--- Conversa com: ${displayName} (${chatKey}) ---\n${chatMessagesText}`);
      }

      const textResult = formattedChats.join('\n\n');
      return res.send(textResult);
    }

    res.json({ date: dateStr, count: messages.length, messages });
  } catch (e) {
    res.status(500).json({ error: 'Erro ao ler banco de mensagens local.' });
  }
});

// Limpa todos os arquivos de logs de mensagens diárias do usuário
app.get('/clear-logs', checkAuth, (req, res) => {
  const userId = req.headers['x-api-key'] || req.query.key || parseCookies(req.headers.cookie)['whatsapp_api_key'];
  if (!userId) {
    return res.status(400).send('Identificação de usuário necessária.');
  }

  const cleanUserId = userId.replace(/[^a-zA-Z0-9-_]/g, '');
  const userMsgDir = path.join(dataDir, 'messages', cleanUserId);

  try {
    if (fs.existsSync(userMsgDir)) {
      const files = fs.readdirSync(userMsgDir);
      let count = 0;
      for (const file of files) {
        if (file.startsWith('messages-') && file.endsWith('.json')) {
          fs.unlinkSync(path.join(userMsgDir, file));
          count++;
        }
      }
      return res.send(`Sucesso: ${count} arquivo(s) de logs de mensagens foram apagados para o usuário.`);
    }
    res.send('Nenhum log de mensagens encontrado para este usuário.');
  } catch (err) {
    res.status(500).send('Erro ao limpar arquivos de logs: ' + err.message);
  }
});

// Desconecta a sessão do WhatsApp no servidor e zera as credenciais locais do usuário
app.get('/logout', checkAuth, async (req, res) => {
  const userId = req.headers['x-api-key'] || req.query.key || parseCookies(req.headers.cookie)['whatsapp_api_key'];
  if (!userId) {
    return res.status(400).send('Identificação de usuário necessária.');
  }

  const cleanUserId = userId.replace(/[^a-zA-Z0-9-_]/g, '');
  const instance = instances[cleanUserId];

  try {
    console.log(`Recebida solicitação de logout do WhatsApp para usuário: ${cleanUserId}...`);
    
    if (instance && instance.sock) {
      try {
        await instance.sock.logout();
      } catch (e) {
        console.log(`Erro ao enviar logout no socket para ${cleanUserId}:`, e);
      }
      try {
        instance.sock.end();
      } catch (e) {}
    }

    // Apaga credenciais do Supabase de forma assíncrona
    await deleteCredsFromSupabase(cleanUserId);

    // Apaga fisicamente a pasta de chaves de autenticação do usuário
    const userAuthDir = path.join(dataDir, 'auth', cleanUserId);
    fs.rmSync(userAuthDir, { recursive: true, force: true });
    fs.mkdirSync(userAuthDir, { recursive: true });

    // Apaga logs de mensagens diárias anteriores do usuário
    const userMsgDir = path.join(dataDir, 'messages', cleanUserId);
    try {
      if (fs.existsSync(userMsgDir)) {
        const files = fs.readdirSync(userMsgDir);
        for (const file of files) {
          if (file.startsWith('messages-') && file.endsWith('.json')) {
            fs.unlinkSync(path.join(userMsgDir, file));
          }
        }
      }
    } catch (e) {}

    // Limpa a instância do dicionário de memória
    if (instances[cleanUserId]) {
      delete instances[cleanUserId];
    }

    res.send('Sessão do WhatsApp desconectada e logs apagados com sucesso para o usuário.');
  } catch (err) {
    res.status(500).send('Erro ao encerrar sessão: ' + err.message);
  }
});

app.listen(port, '0.0.0.0', () => {
  console.log(`WhatsApp Gateway ativo na porta ${port}`);
  console.log(`Pasta de dados configurada em: ${dataDir}`);
});
