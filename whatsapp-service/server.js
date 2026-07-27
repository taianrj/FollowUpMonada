// WhatsApp Gateway do FollowUp Mônada
const express = require('express');
const nodeCrypto = require('node:crypto');
// Polyfill para garantir que a Web Crypto API esteja no escopo global (necessário para versões do Node < 19)
if (!global.crypto) {
  try {
    global.crypto = require('crypto').webcrypto || require('crypto');
  } catch (e) {
    console.error('Falha ao inicializar polyfill do crypto:', e);
  }
}

// Tratadores de erros globais para evitar queda do microsserviço por problemas internos do Baileys
process.on('uncaughtException', (err) => {
  console.error('[CRITICAL] Exceção Não Capturada no Servidor:', err.message || err, err.stack);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('[CRITICAL] Rejeição de Promise Não Capturada no Servidor:', reason);
});

const messageDomain = require('./lib/message-domain');
const historySync = require('./lib/history-sync');
let makeWASocket;
let useMultiFileAuthState;
let DisconnectReason;
let fetchLatestBaileysVersion;
let downloadMediaMessage;
let ALL_WA_PATCH_NAMES;
let BufferJSON;
let proto;

const bufferJsonFallback = {
  replacer: (_key, value) => {
    if (Buffer.isBuffer(value) || value instanceof Uint8Array || value?.type === 'Buffer') {
      return { type: 'Buffer', data: Buffer.from(value?.data || value).toString('base64') };
    }
    return value;
  },
  reviver: (_key, value) => {
    if (value && typeof value === 'object' && value.type === 'Buffer' && typeof value.data === 'string') {
      return Buffer.from(value.data, 'base64');
    }
    return value;
  }
};

function stringifyMediaState(payload, space) {
  const codec = BufferJSON || bufferJsonFallback;
  return JSON.stringify(payload, (key, value) => {
    if (typeof value === 'bigint') return value.toString();
    return codec.replacer(key, value);
  }, space);
}

function parseMediaState(payload) {
  const codec = BufferJSON || bufferJsonFallback;
  return JSON.parse(payload, codec.reviver);
}

async function loadBaileys() {
  if (makeWASocket) return;
  const baileys = await import('baileys');
  makeWASocket = baileys.default || baileys.makeWASocket;
  useMultiFileAuthState = baileys.useMultiFileAuthState;
  DisconnectReason = baileys.DisconnectReason;
  fetchLatestBaileysVersion = baileys.fetchLatestBaileysVersion;
  downloadMediaMessage = baileys.downloadMediaMessage;
  ALL_WA_PATCH_NAMES = baileys.ALL_WA_PATCH_NAMES;
  BufferJSON = baileys.BufferJSON;
  proto = baileys.proto;
}
const pino = require('pino');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
let sharp = null;
try {
  sharp = require('sharp');
} catch (err) {
  console.warn('[image] Sharp indisponivel; interpretacao de imagens sera ignorada ate a dependencia estar instalada.', err.message || err);
}

const app = express();
const port = process.env.PORT || 8080;
app.use(express.json({
  limit: '1mb',
  verify(req, _res, buffer) {
    req.rawBody = Buffer.from(buffer);
  }
}));

// Configuração do diretório de dados persistentes
const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
const authDir = path.join(dataDir, 'auth');
const contactsDir = path.join(dataDir, 'contacts');
const mediaStateDir = path.join(dataDir, 'media-processing');

// Garante que os diretórios existam
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(authDir, { recursive: true });
fs.mkdirSync(contactsDir, { recursive: true });
fs.mkdirSync(mediaStateDir, { recursive: true });

// Tenta carregar variáveis do .env do próprio microsserviço se rodando localmente
try {
  const localEnvPath = path.join(__dirname, '.env');
  if (fs.existsSync(localEnvPath)) {
    const envContent = fs.readFileSync(localEnvPath, 'utf8');
    envContent.split('\n').forEach(line => {
      const parts = line.split('=');
      if (parts.length >= 2) {
        const key = parts[0].trim();
        const val = parts.slice(1).join('=').trim().replace(/^['"]|['"]$/g, '');
        if (key && !process.env[key]) process.env[key] = val;
      }
    });
  }
} catch (err) {
  // Ignora
}

// Tenta carregar variáveis do .env.local do projeto pai se rodando localmente
try {
  const dotenvPath = path.join(__dirname, '..', '.env.local');
  if (fs.existsSync(dotenvPath)) {
    const dotenvContent = fs.readFileSync(dotenvPath, 'utf8');
    const serviceEnvKeys = new Set([
      'GROQ_API_KEY',
      'OPENAI_API_KEY',
      'GEMINI_API_KEY',
      'GEMINI_AUDIO_MODEL',
      'GEMINI_VISION_MODEL',
      'AUDIO_TRANSCRIPTION_ENABLED',
      'AUDIO_TRANSCRIPTION_URL',
      'AUDIO_TRANSCRIPTION_API_KEY',
      'AUDIO_TRANSCRIPTION_MODEL',
      'AUDIO_TRANSCRIPTION_MAX_BYTES',
      'AUDIO_TRANSCRIPTION_QUEUE_MAX',
      'AUDIO_TRANSCRIPTION_LANGUAGE',
      'AUDIO_TRANSCRIPTION_PROMPT',
      'IMAGE_INTERPRETATION_ENABLED',
      'IMAGE_INTERPRETATION_URL',
      'IMAGE_INTERPRETATION_API_KEY',
      'IMAGE_INTERPRETATION_MODEL',
      'IMAGE_INTERPRETATION_MAX_BYTES',
      'IMAGE_INTERPRETATION_QUEUE_MAX',
      'IMAGE_INTERPRETATION_MAX_DIMENSION',
      'IMAGE_INTERPRETATION_JPEG_QUALITY',
      'IMAGE_INTERPRETATION_PROMPT',
      'MEDIA_PROCESSING_MAX_ATTEMPTS',
      'MEDIA_RETRY_FALLBACK_MS',
      'MEDIA_RETRY_MAX_MS',
      'MEDIA_RETRY_BUFFER_MS',
      'MEDIA_RETRY_POLL_MS',
      'MEDIA_ERROR_SNIPPET_LENGTH',
      'MEDIA_LONG_TERM_RETRY_STEP_MS',
      'MEDIA_LONG_TERM_RETRY_MAX_MS',
      'MEDIA_MAX_LONG_TERM_ATTEMPTS',
      'MEDIA_STATE_PERSIST_DELAY_MS',
      'MEDIA_DOWNLOAD_TIMEOUT_MS',
      'MEDIA_PROVIDER_TIMEOUT_MS',
      'AUTH_STATE_PERSIST_DELAY_MS',
      'AUTH_STATE_MAX_FILE_BYTES',
      'RESYNC_POLL_INTERVAL_MS',
      'RESYNC_WAIT_TIMEOUT_MS',
      'FORCE_HISTORY_WAIT_TIMEOUT_MS'
    ]);
    dotenvContent.split('\n').forEach(line => {
      const parts = line.split('=');
      if (parts.length >= 2) {
        const key = parts[0].trim();
        const val = parts.slice(1).join('=').trim().replace(/^['"]|['"]$/g, '');
        if (key === 'NEXT_PUBLIC_SUPABASE_URL' && !process.env.SUPABASE_URL) process.env.SUPABASE_URL = val;
        if (key === 'NEXT_PUBLIC_SUPABASE_ANON_KEY' && !process.env.SUPABASE_KEY) process.env.SUPABASE_KEY = val;
        if (key === 'SUPABASE_SERVICE_ROLE_KEY' && !process.env.SUPABASE_SERVICE_ROLE_KEY) process.env.SUPABASE_SERVICE_ROLE_KEY = val;
        if (serviceEnvKeys.has(key) && !process.env[key]) process.env[key] = val;
      }
    });
  }
} catch (err) {
  console.warn('Aviso: Não foi possível carregar o arquivo .env.local localmente.', err);
}

function getDbSessionId(userId) {
  const suffix = process.env.WHATSAPP_SESSION_SUFFIX || '';
  return `${userId}${suffix}`;
}

// Funções de Persistência de Credenciais do WhatsApp no Supabase
async function saveCredsToSupabase(userId, creds) {
  const dbSessionId = getDbSessionId(userId);
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
        id: dbSessionId,
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
  const dbSessionId = getDbSessionId(userId);
  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  
  if (!supabaseUrl || !supabaseKey) {
    return null;
  }

  const cleanUrl = supabaseUrl.replace(/\/$/, '');
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 4000); // 4 segundos de timeout para evitar travamento em flutuações de rede

  try {
    const response = await fetch(`${cleanUrl}/rest/v1/whatsapp_sessions?id=eq.${dbSessionId}&select=creds`, {
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
  const dbSessionId = getDbSessionId(userId);
  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  
  if (!supabaseUrl || !supabaseKey) {
    return;
  }

  const cleanUrl = supabaseUrl.replace(/\/$/, '');
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 4000); // 4 segundos de timeout

  try {
    const response = await fetch(`${cleanUrl}/rest/v1/whatsapp_sessions?id=eq.${dbSessionId}`, {
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

async function flushMessageBackfillsForUser(userId) {
  const prefix = `${userId}:`;
  const pending = Array.from(pendingMessageBackfills.entries())
    .filter(([key]) => key.startsWith(prefix))
    .map(([, promise]) => promise);
  if (pending.length > 0) await Promise.allSettled(pending);
}

// Exclui todas as mensagens e contatos locais e do Supabase associados ao usuário de forma permanente na desconexão
async function clearAllUserData(userId) {
  const cleanUserId = userId.replace(/[^a-zA-Z0-9-_]/g, '');
  await flushMessageBackfillsForUser(cleanUserId);
  await flushContactPersist(cleanUserId);
  const dbSessionId = getDbSessionId(cleanUserId);
  console.log(`[${cleanUserId}] Iniciando limpeza completa de dados pós-desconexão...`);

  // 1. Limpa cache de mensagens locais em disco
  try {
    const userMsgDir = path.join(dataDir, 'messages', cleanUserId);
    if (fs.existsSync(userMsgDir)) {
      fs.rmSync(userMsgDir, { recursive: true, force: true });
      console.log(`[${cleanUserId}] Cache de mensagens locais excluído com sucesso.`);
    }
  } catch (err) {
    console.error(`[${cleanUserId}] Falha ao limpar mensagens locais:`, err.message || err);
  }

  // 2. Limpa cache de contatos local em disco
  try {
    const contactsPath = contactsFilePath(cleanUserId);
    if (fs.existsSync(contactsPath)) {
      fs.unlinkSync(contactsPath);
      console.log(`[${cleanUserId}] Cache de contatos local excluído com sucesso.`);
    }
  } catch (err) {
    console.error(`[${cleanUserId}] Falha ao limpar contatos locais:`, err.message || err);
  }

  // Limpa o cache de contatos na memória se a instância existir
  const instance = instances[cleanUserId];
  if (instance) {
    if (instance.contactsSaveTimer) {
      clearTimeout(instance.contactsSaveTimer);
      instance.contactsSaveTimer = null;
    }
    instance.contactsCache = {};
  }
  const authTimer = pendingAuthStateTimers.get(cleanUserId);
  if (authTimer) clearTimeout(authTimer);
  pendingAuthStateTimers.delete(cleanUserId);
  await clearMediaProcessingState(cleanUserId);

  // 3. Limpa mensagens do Supabase
  const config = getSupabaseConfig();
  if (config) {
    const headers = {
      'apikey': config.key,
      'Authorization': `Bearer ${config.key}`,
      'Content-Type': 'application/json'
    };

    try {
      const resMsg = await fetch(`${config.cleanUrl}/rest/v1/whatsapp_messages?user_id=eq.${cleanUserId}`, {
        method: 'DELETE',
        headers
      });
      console.log(`[${cleanUserId}] Limpeza de mensagens no Supabase: status ${resMsg.status}`);
    } catch (err) {
      console.error(`[${cleanUserId}] Erro de rede ao limpar mensagens no Supabase:`, err.message || err);
    }

    // 4. Limpa contatos do Supabase
    try {
      const resContacts = await fetch(`${config.cleanUrl}/rest/v1/whatsapp_contacts?user_id=eq.${cleanUserId}`, {
        method: 'DELETE',
        headers
      });
      console.log(`[${cleanUserId}] Limpeza de contatos no Supabase: status ${resContacts.status}`);
    } catch (err) {
      console.error(`[${cleanUserId}] Erro de rede ao limpar contatos no Supabase:`, err.message || err);
    }

    // 5. Limpa blobs de estado do usuário (messages/contacts) na tabela whatsapp_sessions
    const statePatterns = [
      `${dbSessionId}:messages:*`,
      `${cleanUserId}:messages:*`,
      `${dbSessionId}:contacts:*`,
      `${cleanUserId}:contacts:*`,
      `${dbSessionId}:local:contacts:*`,
      `${cleanUserId}:local:contacts:*`,
      `${dbSessionId}:media-processing:*`,
      `${cleanUserId}:media-processing:*`,
      `${dbSessionId}:auth-state:*`,
      `${cleanUserId}:auth-state:*`,
      `${dbSessionId}:auth-state-bundle:*`,
      `${cleanUserId}:auth-state-bundle:*`
    ];
    for (const pattern of [...new Set(statePatterns)]) {
      try {
        const response = await fetch(`${config.cleanUrl}/rest/v1/whatsapp_sessions?id=like.${supabaseEq(pattern)}`, {
          method: 'DELETE',
          headers
        });
        console.log(`[${cleanUserId}] Limpeza de snapshot ${pattern} no Supabase: status ${response.status}`);
      } catch (e) {
        console.error(`[${cleanUserId}] Erro de rede ao limpar snapshot ${pattern} no Supabase:`, e.message || e);
      }
    }
  }
}

async function clearUserMessagesData(userId) {
  const cleanUserId = userId.replace(/[^a-zA-Z0-9-_]/g, '');
  await flushMessageBackfillsForUser(cleanUserId);
  const dbSessionId = getDbSessionId(cleanUserId);
  const result = {
    localFiles: 0,
    supabaseMessagesStatus: null,
    snapshotStatuses: []
  };

  try {
    result.localFiles = clearLocalMessageFiles(cleanUserId);
  } catch (err) {
    console.error(`[${cleanUserId}] Falha ao limpar mensagens locais:`, err.message || err);
  }

  const config = getSupabaseConfig();
  if (!config) return result;

  const headers = {
    'apikey': config.key,
    'Authorization': `Bearer ${config.key}`,
    'Content-Type': 'application/json'
  };

  try {
    const response = await fetch(`${config.cleanUrl}/rest/v1/whatsapp_messages?user_id=eq.${supabaseEq(cleanUserId)}`, {
      method: 'DELETE',
      headers
    });
    result.supabaseMessagesStatus = response.status;
  } catch (err) {
    console.error(`[${cleanUserId}] Erro de rede ao limpar mensagens no Supabase:`, err.message || err);
  }

  const messagePatterns = [
    `${dbSessionId}:messages:*`,
    `${cleanUserId}:messages:*`
  ];
  for (const pattern of [...new Set(messagePatterns)]) {
    try {
      const response = await fetch(`${config.cleanUrl}/rest/v1/whatsapp_sessions?id=like.${supabaseEq(pattern)}`, {
        method: 'DELETE',
        headers
      });
      result.snapshotStatuses.push({ pattern, status: response.status });
    } catch (err) {
      result.snapshotStatuses.push({ pattern, status: 'network-error' });
      console.error(`[${cleanUserId}] Erro de rede ao limpar snapshot ${pattern} no Supabase:`, err.message || err);
    }
  }

  return result;
}

async function loadProfileDataFromSupabase(userId) {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  
  if (!supabaseUrl || !supabaseKey) {
    return null;
  }

  const cleanUrl = supabaseUrl.replace(/\/$/, '');
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 4000);

  try {
    let response = await fetch(`${cleanUrl}/rest/v1/profiles?id=eq.${userId}&select=name,email,transcribe_audio,interpret_images`, {
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`
      },
      signal: controller.signal
    });

    if (!response.ok) {
      // Se falhar (ex: colunas novas ainda não existem), faz fallback
      const fallbackController = new AbortController();
      const fallbackTimeoutId = setTimeout(() => fallbackController.abort(), 4000);
      response = await fetch(`${cleanUrl}/rest/v1/profiles?id=eq.${userId}&select=name,email`, {
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`
        },
        signal: fallbackController.signal
      });
      clearTimeout(fallbackTimeoutId);
    } else {
      clearTimeout(timeoutId);
    }

    if (response.ok) {
      const data = await response.json();
      if (data && data.length > 0) {
        return data[0];
      }
    }
  } catch (err) {
    console.error(`[${userId}] Erro de rede ao buscar dados do perfil no Supabase:`, err.message || err);
  }
  return null;
}

async function loadProfileNameFromSupabase(userId) {
  const profile = await loadProfileDataFromSupabase(userId);
  if (profile) {
    return profile.name || (profile.email ? profile.email.split('@')[0] : null);
  }
  return null;
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
const supabaseDisabledTables = new Map();
const pendingContactWrites = new Map();
const pendingContactTimers = new Map();
const pendingMessageBackfills = new Map();
const pendingMediaStateTimers = new Map();
const pendingAuthStateTimers = new Map();

const MESSAGE_RETENTION_DAYS = Math.max(1, parseInt(process.env.MESSAGE_RETENTION_DAYS || '2', 10)); // Padrao de 2 dias (48 horas) para sincronizacao e retencao de historico
const SUPABASE_TIMEOUT_MS = Math.max(2000, parseInt(process.env.SUPABASE_TIMEOUT_MS || '8000', 10));
const SUPABASE_TABLE_RETRY_MS = Math.max(30000, parseInt(process.env.SUPABASE_TABLE_RETRY_MS || '300000', 10));
const CONTACT_FLUSH_DELAY_MS = Math.max(250, parseInt(process.env.CONTACT_FLUSH_DELAY_MS || '1200', 10));
const CONTACT_MESSAGE_HYDRATION_INTERVAL_MS = Math.max(60000, parseInt(process.env.CONTACT_MESSAGE_HYDRATION_INTERVAL_MS || '300000', 10));
const HISTORY_SYNC_SETTLE_MS = Math.max(500, parseInt(process.env.HISTORY_SYNC_SETTLE_MS || '3000', 10));
const RESYNC_POLL_INTERVAL_MS = Math.max(1000, parseInt(process.env.RESYNC_POLL_INTERVAL_MS || '3000', 10));
const RESYNC_WAIT_TIMEOUT_MS = Math.max(5000, parseInt(process.env.RESYNC_WAIT_TIMEOUT_MS || '30000', 10));
const FORCE_HISTORY_WAIT_TIMEOUT_MS = Math.max(10000, parseInt(process.env.FORCE_HISTORY_WAIT_TIMEOUT_MS || '60000', 10));
const AUTH_STATE_PERSIST_DELAY_MS = Math.max(1000, parseInt(process.env.AUTH_STATE_PERSIST_DELAY_MS || '3000', 10));
const AUTH_STATE_MAX_FILE_BYTES = Math.max(1024, parseInt(process.env.AUTH_STATE_MAX_FILE_BYTES || '2000000', 10));
const JSON_INDENT = process.env.NODE_ENV === 'production' ? 0 : 2;
const WA_PATCH_NAMES = Array.isArray(ALL_WA_PATCH_NAMES) && ALL_WA_PATCH_NAMES.length > 0
  ? ALL_WA_PATCH_NAMES
  : ['critical_block', 'critical_unblock_low', 'regular_high', 'regular_low', 'regular'];
const AUDIO_TRANSCRIPTION_ENABLED = process.env.AUDIO_TRANSCRIPTION_ENABLED !== 'false';
const AUDIO_TRANSCRIPTION_MAX_BYTES = Math.max(1024 * 1024, parseInt(process.env.AUDIO_TRANSCRIPTION_MAX_BYTES || String(24 * 1024 * 1024), 10));
const AUDIO_TRANSCRIPTION_QUEUE_MAX = Math.max(1, parseInt(process.env.AUDIO_TRANSCRIPTION_QUEUE_MAX || '200', 10));
const AUDIO_TRANSCRIPTION_LANGUAGE = process.env.AUDIO_TRANSCRIPTION_LANGUAGE || 'pt';
const AUDIO_TRANSCRIPTION_PROMPT = process.env.AUDIO_TRANSCRIPTION_PROMPT || 'Transcreva mensagens de voz de WhatsApp em portugues do Brasil, preservando nomes proprios quando possivel.';
const audioTranscriptionQueue = [];
const queuedAudioTranscriptionKeys = new Set();
const failedAudioTranscriptionKeys = new Set();
let audioTranscriptionRunning = false;
let audioTranscriptionBackoffUntil = 0;
const MEDIA_PROCESSING_MAX_ATTEMPTS = Math.max(1, parseInt(process.env.MEDIA_PROCESSING_MAX_ATTEMPTS || '3', 10));
const MEDIA_RETRY_FALLBACK_MS = Math.max(1000, parseInt(process.env.MEDIA_RETRY_FALLBACK_MS || '5000', 10));
const MEDIA_RETRY_MAX_MS = Math.max(MEDIA_RETRY_FALLBACK_MS, parseInt(process.env.MEDIA_RETRY_MAX_MS || '120000', 10));
const MEDIA_RETRY_BUFFER_MS = Math.max(0, parseInt(process.env.MEDIA_RETRY_BUFFER_MS || '250', 10));
const MEDIA_RETRY_POLL_MS = Math.max(250, parseInt(process.env.MEDIA_RETRY_POLL_MS || '1000', 10));
const MEDIA_ERROR_SNIPPET_LENGTH = Math.max(300, parseInt(process.env.MEDIA_ERROR_SNIPPET_LENGTH || '1000', 10));
const MEDIA_LONG_TERM_RETRY_STEP_MS = Math.max(1000, parseInt(process.env.MEDIA_LONG_TERM_RETRY_STEP_MS || '60000', 10));
const MEDIA_LONG_TERM_RETRY_MAX_MS = Math.max(MEDIA_LONG_TERM_RETRY_STEP_MS, parseInt(process.env.MEDIA_LONG_TERM_RETRY_MAX_MS || String(30 * 60 * 1000), 10));
const MEDIA_MAX_LONG_TERM_ATTEMPTS = Math.max(1, parseInt(process.env.MEDIA_MAX_LONG_TERM_ATTEMPTS || '10', 10));
const MEDIA_STATE_PERSIST_DELAY_MS = Math.max(100, parseInt(process.env.MEDIA_STATE_PERSIST_DELAY_MS || '250', 10));
const MEDIA_DOWNLOAD_TIMEOUT_MS = Math.max(5000, parseInt(process.env.MEDIA_DOWNLOAD_TIMEOUT_MS || '60000', 10));
const MEDIA_PROVIDER_TIMEOUT_MS = Math.max(10000, parseInt(process.env.MEDIA_PROVIDER_TIMEOUT_MS || '120000', 10));
const IMAGE_INTERPRETATION_ENABLED = process.env.IMAGE_INTERPRETATION_ENABLED !== 'false';
const IMAGE_INTERPRETATION_MAX_BYTES = Math.max(256 * 1024, parseInt(process.env.IMAGE_INTERPRETATION_MAX_BYTES || String(3 * 1024 * 1024), 10));
const IMAGE_INTERPRETATION_QUEUE_MAX = Math.max(1, parseInt(process.env.IMAGE_INTERPRETATION_QUEUE_MAX || '200', 10));
const IMAGE_INTERPRETATION_MAX_DIMENSION = Math.max(512, parseInt(process.env.IMAGE_INTERPRETATION_MAX_DIMENSION || '1600', 10));
const IMAGE_INTERPRETATION_JPEG_QUALITY = Math.min(92, Math.max(35, parseInt(process.env.IMAGE_INTERPRETATION_JPEG_QUALITY || '72', 10)));
const IMAGE_INTERPRETATION_PROMPT = process.env.IMAGE_INTERPRETATION_PROMPT || 'Analise esta imagem ou figurinha de uma conversa de WhatsApp em portugues do Brasil. Descreva objetivamente o conteudo visual, extraia textos legiveis importantes e explique apenas o contexto util para um resumo de atendimento. Seja conciso.';
const imageInterpretationQueue = [];
const queuedImageInterpretationKeys = new Set();
const failedImageInterpretationKeys = new Set();
let imageInterpretationRunning = false;
let imageInterpretationBackoffUntil = 0;

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
  const disabledAt = supabaseDisabledTables.get(table);
  if (disabledAt && Date.now() - disabledAt < SUPABASE_TABLE_RETRY_MS) return null;
  if (disabledAt) supabaseDisabledTables.delete(table);

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
        supabaseDisabledTables.set(table, Date.now());
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
  const dbSessionId = getDbSessionId(userId);
  return `${dbSessionId}:${kind}:${key}`;
}

async function saveStateBlobToSupabase(userId, kind, key, payload) {
  const id = stateBlobId(userId, kind, key);
  const serializedPayload = kind === 'media-processing'
    ? stringifyMediaState(payload)
    : JSON.stringify(payload);
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
        creds: serializedPayload,
        updated_at: new Date().toISOString()
      })
    }
  );
  return !!response;
}

async function loadStateBlobFromSupabase(userId, kind, key = 'default') {
  const ids = [...new Set([
    stateBlobId(userId, kind, key),
    `${userId}:${kind}:${key}`
  ])];

  for (const id of ids) {
    const response = await supabaseRest(
      'whatsapp_sessions',
      `?id=eq.${supabaseEq(id)}&select=creds&limit=1`
    );
    if (!response) continue;

    try {
      const rows = await response.json();
      const raw = rows?.[0]?.creds;
      if (!raw) continue;
      if (kind === 'media-processing') {
        return parseMediaState(typeof raw === 'string' ? raw : JSON.stringify(raw));
      }
      return typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (err) {
      console.warn(`[${userId}] Falha ao carregar snapshot ${kind}/${key}:`, err.message || err);
    }
  }

  return null;
}

async function listStateBlobKeysFromSupabase(userId, kind) {
  const prefixes = [...new Set([
    `${getDbSessionId(userId)}:${kind}:`,
    `${userId}:${kind}:`
  ])];
  const keys = new Set();

  for (const prefix of prefixes) {
    const response = await supabaseRest(
      'whatsapp_sessions',
      `?id=like.${supabaseEq(`${prefix}*`)}&select=id&limit=5000`
    );
    if (!response) continue;

    try {
      const rows = await response.json();
      rows
        .map(row => String(row.id || ''))
        .filter(id => id.startsWith(prefix))
        .map(id => id.slice(prefix.length))
        .filter(Boolean)
        .forEach(key => keys.add(key));
    } catch (err) {
      console.warn(`[${userId}] Falha ao listar snapshots ${kind}:`, err.message || err);
    }
  }

  return Array.from(keys).sort();
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

function mediaProcessingKey(userId, dedupeKey) {
  return `${userId || 'unknown'}|${dedupeKey || ''}`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
}

function clearAuthStateFilesByPrefix(authStateDir, prefixes) {
  if (!fs.existsSync(authStateDir)) return 0;
  let cleared = 0;
  for (const file of fs.readdirSync(authStateDir)) {
    if (!prefixes.some(prefix => file.startsWith(`${prefix}-`))) continue;
    try {
      fs.unlinkSync(path.join(authStateDir, file));
      cleared++;
    } catch (err) {
      console.warn(`Falha ao limpar estado de auth ${file}:`, err.message || err);
    }
  }
  return cleared;
}

function isSafeAuthStateFile(file) {
  return typeof file === 'string'
    && file.endsWith('.json')
    && file.length <= 240
    && !file.includes('/')
    && !file.includes('\\')
    && file !== '.'
    && file !== '..';
}

function readAuthStateFiles(authStateDir) {
  if (!fs.existsSync(authStateDir)) return [];
  const files = [];

  for (const file of fs.readdirSync(authStateDir)) {
    if (!isSafeAuthStateFile(file)) continue;
    const filePath = path.join(authStateDir, file);
    try {
      const stats = fs.statSync(filePath);
      if (!stats.isFile() || stats.size > AUTH_STATE_MAX_FILE_BYTES) continue;
      const content = fs.readFileSync(filePath, 'utf8');
      JSON.parse(content);
      files.push({
        file,
        content
      });
    } catch (err) {
      console.warn(`Falha ao ler arquivo de auth-state ${file}:`, err.message || err);
    }
  }

  return files;
}

function buildAuthStateBundle(files) {
  const safeFiles = (Array.isArray(files) ? files : []).filter(item =>
    isSafeAuthStateFile(item?.file) && typeof item?.content === 'string'
  );
  const compressed = zlib.gzipSync(Buffer.from(JSON.stringify(safeFiles), 'utf8'));
  return {
    version: 1,
    encoding: 'gzip-base64',
    fileCount: safeFiles.length,
    data: compressed.toString('base64'),
    savedAt: new Date().toISOString()
  };
}

function parseAuthStateBundle(payload) {
  if (!payload || payload.version !== 1 || payload.encoding !== 'gzip-base64' || typeof payload.data !== 'string') {
    return [];
  }
  const decoded = zlib.gunzipSync(Buffer.from(payload.data, 'base64')).toString('utf8');
  const files = JSON.parse(decoded);
  return (Array.isArray(files) ? files : []).filter(item =>
    isSafeAuthStateFile(item?.file) && typeof item?.content === 'string'
  );
}

async function persistAuthStateSnapshot(userId, authStateDir) {
  if (instances[userId]?.intentionalLogout) return 0;
  const files = readAuthStateFiles(authStateDir);
  if (files.length === 0) return 0;

  // O useMultiFileAuthState pode criar milhares de arquivos. Um blob
  // comprimido evita uma chamada Supabase por chave durante o primeiro sync.
  const bundleSaved = await saveStateBlobToSupabase(userId, 'auth-state-bundle', 'default', buildAuthStateBundle(files));

  // Este registro base permite descobrir a sessão no boot e também mantém
  // compatibilidade com instalações anteriores.
  const credsEntry = files.find(item => item.file === 'creds.json');
  if (credsEntry) await saveCredsToSupabase(userId, JSON.parse(credsEntry.content));

  // Depois de confirmar o bundle, remove em duas operações os antigos blobs
  // por arquivo. Isso evita que o boot continue listando milhares de linhas.
  if (bundleSaved) {
    const legacyPatterns = [
      `${getDbSessionId(userId)}:auth-state:*`,
      `${userId}:auth-state:*`
    ];
    for (const pattern of [...new Set(legacyPatterns)]) {
      await supabaseRest(
        'whatsapp_sessions',
        `?id=like.${supabaseEq(pattern)}`,
        { method: 'DELETE' }
      );
    }
  }

  const instance = instances[userId];
  if (instance) {
    instance.authStateFilesBackedUp = files.length;
    instance.lastAuthStateBackupAt = new Date().toISOString();
  }
  console.log(`[${userId}] Snapshot de auth-state salvo em um blob comprimido com ${files.length} arquivos.`);
  return files.length;
}

function scheduleAuthStateSnapshot(userId, authStateDir, delayMs = AUTH_STATE_PERSIST_DELAY_MS) {
  const cleanUserId = String(userId || '').replace(/[^a-zA-Z0-9-_]/g, '');
  if (!cleanUserId || !authStateDir) return;
  if (instances[cleanUserId]?.intentionalLogout) return;
  if (pendingAuthStateTimers.has(cleanUserId)) {
    clearTimeout(pendingAuthStateTimers.get(cleanUserId));
  }

  pendingAuthStateTimers.set(cleanUserId, setTimeout(async () => {
    pendingAuthStateTimers.delete(cleanUserId);
    try {
      await persistAuthStateSnapshot(cleanUserId, authStateDir);
    } catch (err) {
      console.warn(`[${cleanUserId}] Falha ao persistir snapshot de auth-state:`, err.message || err);
    }
  }, delayMs));
}

async function restoreAuthStateSnapshot(userId, authStateDir, { overwrite = false } = {}) {
  const bundle = await loadStateBlobFromSupabase(userId, 'auth-state-bundle', 'default');
  if (bundle) {
    try {
      const files = parseAuthStateBundle(bundle);
      fs.mkdirSync(authStateDir, { recursive: true });
      let restoredFromBundle = 0;

      for (const item of files) {
        const filePath = path.join(authStateDir, item.file);
        if (!overwrite && fs.existsSync(filePath)) continue;
        JSON.parse(item.content);
        fs.writeFileSync(filePath, item.content, 'utf8');
        restoredFromBundle++;
      }

      if (restoredFromBundle > 0) {
        const instance = instances[userId];
        if (instance) {
          instance.authStateFilesRestored = restoredFromBundle;
          instance.lastAuthStateRestoreAt = new Date().toISOString();
        }
        console.log(`[${userId}] Restaurados ${restoredFromBundle} arquivos do bundle de auth-state.`);
      }
      return restoredFromBundle;
    } catch (err) {
      console.warn(`[${userId}] Bundle de auth-state inválido; tentando formato legado:`, err.message || err);
    }
  }

  // Compatibilidade de leitura com snapshots gravados antes do bundle v1.
  const keys = await listStateBlobKeysFromSupabase(userId, 'auth-state');
  if (keys.length === 0) return 0;

  fs.mkdirSync(authStateDir, { recursive: true });
  let restored = 0;

  for (const key of keys) {
    if (!isSafeAuthStateFile(key)) continue;
    const filePath = path.join(authStateDir, key);
    if (!overwrite && fs.existsSync(filePath)) continue;

    const payload = await loadStateBlobFromSupabase(userId, 'auth-state', key);
    const content = typeof payload?.content === 'string' ? payload.content : null;
    if (!content) continue;

    try {
      JSON.parse(content);
      fs.writeFileSync(filePath, content, 'utf8');
      restored++;
    } catch (err) {
      console.warn(`[${userId}] Falha ao restaurar auth-state ${key}:`, err.message || err);
    }
  }

  if (restored > 0) {
    const instance = instances[userId];
    if (instance) {
      instance.authStateFilesRestored = restored;
      instance.lastAuthStateRestoreAt = new Date().toISOString();
    }
    console.log(`[${userId}] Restaurados ${restored} arquivos de auth-state do Supabase.`);
  }
  return restored;
}

function parseRetryDelayMs(message) {
  const text = String(message || '');
  const retryMatch = text.match(/(?:please\s+)?try\s+again\s+in\s+([0-9]+(?:\.[0-9]+)?)\s*(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m)\b/i) ||
    text.match(/retry(?:-|\s*)after[^0-9]*([0-9]+(?:\.[0-9]+)?)\s*(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m)?\b/i);
  if (!retryMatch) return null;

  const value = Number(retryMatch[1]);
  if (!Number.isFinite(value) || value < 0) return null;

  const unit = String(retryMatch[2] || 's').toLowerCase();
  if (unit.startsWith('ms') || unit.startsWith('millisecond') || unit.startsWith('msec')) {
    return Math.round(value);
  }
  if (unit === 'm' || unit.startsWith('min')) {
    return Math.round(value * 60 * 1000);
  }
  return Math.round(value * 1000);
}

function retryDelayMsForError(errorMessage, failedAttempt) {
  const explicitDelay = parseRetryDelayMs(errorMessage);
  const fallbackDelay = MEDIA_RETRY_FALLBACK_MS * Math.pow(2, Math.max(0, failedAttempt - 1));
  const delay = explicitDelay == null ? fallbackDelay : explicitDelay + MEDIA_RETRY_BUFFER_MS;
  return Math.min(MEDIA_RETRY_MAX_MS, Math.max(0, delay));
}

function shouldPauseMediaQueueForError(errorMessage) {
  const text = String(errorMessage || '').toLowerCase();
  return parseRetryDelayMs(text) != null ||
    /\b429\b/.test(text) ||
    text.includes('rate limit') ||
    text.includes('too many requests') ||
    text.includes('retry-after') ||
    text.includes('try again') ||
    text.includes('temporarily unavailable');
}

function queuePauseInMs(backoffUntil) {
  return Math.max(0, Number(backoffUntil || 0) - Date.now());
}

function extendQueueBackoff(backoffUntil, retryDelayMs, now = Date.now()) {
  return Math.max(Number(backoffUntil || 0), now + Math.max(0, retryDelayMs));
}

function formatRetryDelay(ms) {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds % 1 === 0 ? 0 : 1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  return remainingSeconds > 0 ? `${minutes}m${remainingSeconds}s` : `${minutes}m`;
}

async function withMediaTimeout(promise, timeoutMs, operationLabel) {
  const boundedTimeoutMs = Math.max(1, Number(timeoutMs) || 1);
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${operationLabel} excedeu o tempo limite de ${formatRetryDelay(boundedTimeoutMs)}.`));
    }, boundedTimeoutMs);
  });

  try {
    return await Promise.race([Promise.resolve(promise), timeoutPromise]);
  } finally {
    clearTimeout(timeoutId);
  }
}

function shiftReadyQueueItem(queue) {
  const now = Date.now();
  let nextReadyIndex = -1;
  let nextAvailableAt = Infinity;

  for (let i = 0; i < queue.length; i++) {
    const availableAt = Number(queue[i].availableAt || 0);
    if (!availableAt || availableAt <= now) {
      nextReadyIndex = i;
      break;
    }
    if (availableAt < nextAvailableAt) {
      nextAvailableAt = availableAt;
    }
  }

  if (nextReadyIndex >= 0) {
    return {
      item: queue.splice(nextReadyIndex, 1)[0],
      waitMs: 0
    };
  }

  return {
    item: null,
    waitMs: Number.isFinite(nextAvailableAt) ? Math.max(0, nextAvailableAt - now) : 0
  };
}

function countScheduledRetriesForUser(queue, userId) {
  const now = Date.now();
  return queue.filter(item => item.userId === userId && Number(item.availableAt || 0) > now).length;
}

function nextRetryInMsForUser(queue, userId, backoffUntil = 0) {
  const now = Date.now();
  let nextAvailableAt = Infinity;
  let hasUserItem = false;
  for (const item of queue) {
    if (item.userId !== userId) continue;
    hasUserItem = true;
    const availableAt = Number(item.availableAt || 0);
    if (availableAt > now && availableAt < nextAvailableAt) {
      nextAvailableAt = availableAt;
    }
  }

  const pauseMs = queuePauseInMs(backoffUntil);
  if (Number.isFinite(nextAvailableAt)) {
    return Math.max(Math.max(0, nextAvailableAt - now), pauseMs);
  }
  return hasUserItem && pauseMs > 0 ? pauseMs : null;
}

function countLongTermItemsForUser(queue, userId) {
  return queue.filter(item => item.userId === userId && item.longTerm).length;
}

function nextLongTermRetryInMsForUser(queue, userId) {
  const now = Date.now();
  let nextAvailableAt = Infinity;
  for (const item of queue) {
    if (item.userId !== userId || !item.longTerm) continue;
    const availableAt = Number(item.availableAt || 0);
    if (availableAt > now && availableAt < nextAvailableAt) {
      nextAvailableAt = availableAt;
    }
  }
  return Number.isFinite(nextAvailableAt) ? Math.max(0, nextAvailableAt - now) : null;
}

function longTermRetryDelayMs(longTermAttempts) {
  const step = Math.max(1, Number(longTermAttempts || 1));
  return Math.min(MEDIA_LONG_TERM_RETRY_MAX_MS, step * MEDIA_LONG_TERM_RETRY_STEP_MS);
}

function scheduleLongTermMediaRetry(item, errorMessage) {
  const longTermAttempts = Math.max(0, Number(item.longTermAttempts || 0)) + 1;
  const retryDelayMs = longTermRetryDelayMs(longTermAttempts);
  item.longTerm = true;
  item.longTermAttempts = longTermAttempts;
  item.attempt = MEDIA_PROCESSING_MAX_ATTEMPTS;
  item.availableAt = Date.now() + retryDelayMs;
  item.lastError = String(errorMessage || '').slice(0, MEDIA_ERROR_SNIPPET_LENGTH);
  return retryDelayMs;
}

function isPermanentMediaError(errorMessage = '') {
  const err = String(errorMessage).toLowerCase();
  return err.includes('status code 403') ||
    err.includes('forbidden') ||
    err.includes('404') ||
    err.includes('not found') ||
    err.includes('media is missing') ||
    err.includes('media expired');
}

function mediaStateFilePath(userId) {
  const cleanUserId = String(userId || '').replace(/[^a-zA-Z0-9-_]/g, '');
  return path.join(mediaStateDir, `${cleanUserId}.json`);
}

function normalizeMediaNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function normalizeMediaStats(stats = {}) {
  return {
    total: normalizeMediaNumber(stats.total),
    completed: normalizeMediaNumber(stats.completed),
    failed: normalizeMediaNumber(stats.failed),
    lastError: normalizeDisplayName(stats.lastError || '')
  };
}

function mediaStatsFromInstance(instance, kind) {
  if (kind === 'audio') {
    return {
      total: normalizeMediaNumber(instance?.transcriptionTotal),
      completed: normalizeMediaNumber(instance?.transcriptionCompleted),
      failed: normalizeMediaNumber(instance?.transcriptionFailed),
      lastError: normalizeDisplayName(instance?.transcriptionLastError || '')
    };
  }
  return {
    total: normalizeMediaNumber(instance?.imageInterpretationTotal),
    completed: normalizeMediaNumber(instance?.imageInterpretationCompleted),
    failed: normalizeMediaNumber(instance?.imageInterpretationFailed),
    lastError: normalizeDisplayName(instance?.imageInterpretationLastError || '')
  };
}

function applyMediaStatsToInstance(instance, kind, stats) {
  const normalized = normalizeMediaStats(stats);
  if (kind === 'audio') {
    instance.transcriptionTotal = normalized.total;
    instance.transcriptionCompleted = normalized.completed;
    instance.transcriptionFailed = normalized.failed;
    instance.transcriptionLastError = normalized.lastError;
    return;
  }
  instance.imageInterpretationTotal = normalized.total;
  instance.imageInterpretationCompleted = normalized.completed;
  instance.imageInterpretationFailed = normalized.failed;
  instance.imageInterpretationLastError = normalized.lastError;
}

function serializeMediaQueueItem(item) {
  const messageObject = item?.messageObject;
  const rawMessage = item?.rawMessage;
  const dedupeKey = item?.dedupeKey || messageObject?.dedupeKey || createDedupeKey(messageObject || {});
  if (!dedupeKey || !messageObject || !rawMessage) return null;

  return {
    userId: String(item.userId || '').replace(/[^a-zA-Z0-9-_]/g, ''),
    dedupeKey,
    rawMessage,
    messageObject: {
      ...messageObject,
      dedupeKey
    },
    mimetype: item.mimetype || messageObject.mediaMimetype || '',
    attempt: Math.max(1, normalizeMediaNumber(item.attempt, 1)),
    availableAt: normalizeMediaNumber(item.availableAt),
    longTerm: !!item.longTerm,
    longTermAttempts: normalizeMediaNumber(item.longTermAttempts),
    lastError: String(item.lastError || '').slice(0, MEDIA_ERROR_SNIPPET_LENGTH)
  };
}

function normalizeMediaQueueItem(userId, item) {
  const serialized = serializeMediaQueueItem({ ...item, userId: item?.userId || userId });
  if (!serialized?.userId || !serialized.dedupeKey) return null;
  return serialized;
}

function shouldRestoreMediaQueueItem(kind, userId, item) {
  const storedMessage = findStoredMessageByDedupeKey(userId, item.messageObject);
  const text = storedMessage?.text || item.messageObject?.text || '';
  return kind === 'audio'
    ? !isAudioTranscriptionText(text)
    : !isImageInterpretationText(text);
}

function buildMediaProcessingStateSnapshot(userId, instance) {
  const cleanUserId = String(userId || '').replace(/[^a-zA-Z0-9-_]/g, '');
  const audioQueue = audioTranscriptionQueue
    .filter(item => item.userId === cleanUserId)
    .map(serializeMediaQueueItem)
    .filter(Boolean);
  const imageQueue = imageInterpretationQueue
    .filter(item => item.userId === cleanUserId)
    .map(serializeMediaQueueItem)
    .filter(Boolean);

  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    audio: {
      queue: audioQueue,
      backoffUntil: audioTranscriptionBackoffUntil,
      stats: mediaStatsFromInstance(instance, 'audio')
    },
    image: {
      queue: imageQueue,
      backoffUntil: imageInterpretationBackoffUntil,
      stats: mediaStatsFromInstance(instance, 'image')
    }
  };
}

function mediaStateUpdatedAtMs(state) {
  const timestamp = new Date(state?.updatedAt || 0).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function mergeMediaStats(primary = {}, secondary = {}) {
  return {
    total: Math.max(normalizeMediaNumber(primary.total), normalizeMediaNumber(secondary.total)),
    completed: Math.max(normalizeMediaNumber(primary.completed), normalizeMediaNumber(secondary.completed)),
    failed: Math.max(normalizeMediaNumber(primary.failed), normalizeMediaNumber(secondary.failed)),
    lastError: normalizeDisplayName(primary.lastError || secondary.lastError || '')
  };
}

function mergeMediaQueueItems(userId, ...queues) {
  const merged = new Map();
  for (const queue of queues) {
    for (const rawItem of Array.isArray(queue) ? queue : []) {
      const item = normalizeMediaQueueItem(userId, rawItem);
      if (!item) continue;
      const key = mediaProcessingKey(item.userId, item.dedupeKey);
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, item);
        continue;
      }
      merged.set(key, {
        ...existing,
        ...item,
        attempt: Math.max(normalizeMediaNumber(existing.attempt, 1), normalizeMediaNumber(item.attempt, 1)),
        availableAt: Math.max(normalizeMediaNumber(existing.availableAt), normalizeMediaNumber(item.availableAt)),
        longTerm: !!existing.longTerm || !!item.longTerm,
        longTermAttempts: Math.max(normalizeMediaNumber(existing.longTermAttempts), normalizeMediaNumber(item.longTermAttempts)),
        lastError: item.lastError || existing.lastError || ''
      });
    }
  }
  return Array.from(merged.values());
}

function normalizeMediaProcessingState(userId, payload) {
  if (!payload || typeof payload !== 'object') return null;
  return {
    version: 1,
    updatedAt: payload.updatedAt || null,
    audio: {
      queue: mergeMediaQueueItems(userId, payload.audio?.queue),
      backoffUntil: normalizeMediaNumber(payload.audio?.backoffUntil),
      stats: normalizeMediaStats(payload.audio?.stats)
    },
    image: {
      queue: mergeMediaQueueItems(userId, payload.image?.queue),
      backoffUntil: normalizeMediaNumber(payload.image?.backoffUntil),
      stats: normalizeMediaStats(payload.image?.stats)
    }
  };
}

function mergeMediaProcessingStates(userId, localState, remoteState) {
  const local = normalizeMediaProcessingState(userId, localState);
  const remote = normalizeMediaProcessingState(userId, remoteState);
  if (!local && !remote) return null;
  if (!local) return remote;
  if (!remote) return local;

  const primary = mediaStateUpdatedAtMs(remote) >= mediaStateUpdatedAtMs(local) ? remote : local;
  const secondary = primary === remote ? local : remote;

  return {
    version: 1,
    updatedAt: primary.updatedAt || secondary.updatedAt || new Date().toISOString(),
    audio: {
      queue: mergeMediaQueueItems(userId, primary.audio.queue, secondary.audio.queue),
      backoffUntil: Math.max(primary.audio.backoffUntil || 0, secondary.audio.backoffUntil || 0),
      stats: mergeMediaStats(primary.audio.stats, secondary.audio.stats)
    },
    image: {
      queue: mergeMediaQueueItems(userId, primary.image.queue, secondary.image.queue),
      backoffUntil: Math.max(primary.image.backoffUntil || 0, secondary.image.backoffUntil || 0),
      stats: mergeMediaStats(primary.image.stats, secondary.image.stats)
    }
  };
}

function loadLocalMediaProcessingState(userId) {
  const filePath = mediaStateFilePath(userId);
  try {
    if (!fs.existsSync(filePath)) return null;
    return parseMediaState(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    console.warn(`[${userId}] Falha ao carregar estado local da fila de midia:`, err.message || err);
    return null;
  }
}

async function loadMediaProcessingState(userId, instance) {
  const localState = loadLocalMediaProcessingState(userId);
  const remoteState = await loadStateBlobFromSupabase(userId, 'media-processing', 'default');
  const mergedState = mergeMediaProcessingStates(userId, localState, remoteState);
  if (!mergedState) return;

  applyMediaStatsToInstance(instance, 'audio', mergedState.audio.stats);
  applyMediaStatsToInstance(instance, 'image', mergedState.image.stats);
  audioTranscriptionBackoffUntil = Math.max(audioTranscriptionBackoffUntil, mergedState.audio.backoffUntil || 0);
  imageInterpretationBackoffUntil = Math.max(imageInterpretationBackoffUntil, mergedState.image.backoffUntil || 0);

  const restoredAudio = restoreMediaQueueItems(userId, 'audio', mergedState.audio.queue);
  const restoredImages = restoreMediaQueueItems(userId, 'image', mergedState.image.queue);
  if (restoredAudio > 0 || restoredImages > 0) {
    console.log(`[${userId}] Fila de midia restaurada: audios=${restoredAudio}, imagens=${restoredImages}.`);
  }
  const snapshot = makeMediaStateJsonSafe(buildMediaProcessingStateSnapshot(userId, instance));
  if (snapshot) saveMediaProcessingStateLocally(userId, snapshot);
}

function restoreMediaQueueItems(userId, kind, items) {
  const queue = kind === 'audio' ? audioTranscriptionQueue : imageInterpretationQueue;
  const queuedKeys = kind === 'audio' ? queuedAudioTranscriptionKeys : queuedImageInterpretationKeys;
  const failedKeys = kind === 'audio' ? failedAudioTranscriptionKeys : failedImageInterpretationKeys;
  let restored = 0;

  for (const rawItem of Array.isArray(items) ? items : []) {
    const item = normalizeMediaQueueItem(userId, rawItem);
    if (!item || !shouldRestoreMediaQueueItem(kind, userId, item)) continue;

    const key = mediaProcessingKey(item.userId, item.dedupeKey);
    if (queuedKeys.has(key)) continue;
    failedKeys.delete(key);
    queuedKeys.add(key);
    queue.push({
      ...item,
      instance: instances[item.userId] || null
    });
    restored++;
  }

  return restored;
}

function saveMediaProcessingStateLocally(userId, snapshot) {
  try {
    fs.mkdirSync(mediaStateDir, { recursive: true });
    fs.writeFileSync(mediaStateFilePath(userId), stringifyMediaState(snapshot, JSON_INDENT), 'utf8');
    return true;
  } catch (err) {
    console.warn(`[${userId}] Falha ao salvar estado local da fila de midia:`, err.message || err);
    return false;
  }
}

function makeMediaStateJsonSafe(snapshot) {
  try {
    return parseMediaState(stringifyMediaState(snapshot));
  } catch (err) {
    console.warn('[media] Falha ao preparar snapshot da fila de midia:', err.message || err);
    return null;
  }
}

async function saveMediaProcessingStateNow(userId, instance = instances[userId]) {
  if (!instance) return false;
  const cleanUserId = String(userId || '').replace(/[^a-zA-Z0-9-_]/g, '');
  const snapshot = makeMediaStateJsonSafe(buildMediaProcessingStateSnapshot(cleanUserId, instance));
  if (!snapshot) return false;
  saveMediaProcessingStateLocally(cleanUserId, snapshot);
  try {
    await saveStateBlobToSupabase(cleanUserId, 'media-processing', 'default', snapshot);
  } catch (err) {
    console.warn(`[${cleanUserId}] Falha ao salvar fila de midia no Supabase:`, err.message || err);
  }
  return true;
}

function scheduleMediaProcessingStateSave(userId) {
  const cleanUserId = String(userId || '').replace(/[^a-zA-Z0-9-_]/g, '');
  if (!cleanUserId) return;
  const instance = instances[cleanUserId];
  if (instance) {
    const snapshot = makeMediaStateJsonSafe(buildMediaProcessingStateSnapshot(cleanUserId, instance));
    if (snapshot) saveMediaProcessingStateLocally(cleanUserId, snapshot);
  }
  const existingTimer = pendingMediaStateTimers.get(cleanUserId);
  if (existingTimer) clearTimeout(existingTimer);
  const timer = setTimeout(() => {
    pendingMediaStateTimers.delete(cleanUserId);
    saveMediaProcessingStateNow(cleanUserId).catch(err => {
      console.warn(`[${cleanUserId}] Falha ao persistir estado da fila de midia:`, err.message || err);
    });
  }, MEDIA_STATE_PERSIST_DELAY_MS);
  pendingMediaStateTimers.set(cleanUserId, timer);
}

async function flushMediaProcessingStateSave(userId) {
  const cleanUserId = String(userId || '').replace(/[^a-zA-Z0-9-_]/g, '');
  const timer = pendingMediaStateTimers.get(cleanUserId);
  if (timer) clearTimeout(timer);
  pendingMediaStateTimers.delete(cleanUserId);
  await saveMediaProcessingStateNow(cleanUserId);
}

function removeMediaQueueItemsForUser(queue, queuedKeys, failedKeys, userId) {
  for (let i = queue.length - 1; i >= 0; i--) {
    const item = queue[i];
    if (item.userId !== userId) continue;
    const key = mediaProcessingKey(userId, item.dedupeKey || item.messageObject?.dedupeKey || '');
    queuedKeys.delete(key);
    queuedKeys.delete(item.dedupeKey);
    failedKeys.delete(key);
    queue.splice(i, 1);
  }
}

async function clearMediaProcessingState(userId) {
  const cleanUserId = String(userId || '').replace(/[^a-zA-Z0-9-_]/g, '');
  const instance = instances[cleanUserId];
  const timer = pendingMediaStateTimers.get(cleanUserId);
  if (timer) clearTimeout(timer);
  pendingMediaStateTimers.delete(cleanUserId);

  removeMediaQueueItemsForUser(audioTranscriptionQueue, queuedAudioTranscriptionKeys, failedAudioTranscriptionKeys, cleanUserId);
  removeMediaQueueItemsForUser(imageInterpretationQueue, queuedImageInterpretationKeys, failedImageInterpretationKeys, cleanUserId);
  if (audioTranscriptionQueue.length === 0) audioTranscriptionBackoffUntil = 0;
  if (imageInterpretationQueue.length === 0) imageInterpretationBackoffUntil = 0;

  if (instance) {
    applyMediaStatsToInstance(instance, 'audio', {});
    applyMediaStatsToInstance(instance, 'image', {});
    instance.transcriptionRunning = false;
    instance.imageInterpretationRunning = false;
  }

  try {
    const filePath = mediaStateFilePath(cleanUserId);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (err) {
    console.warn(`[${cleanUserId}] Falha ao excluir estado local da fila de midia:`, err.message || err);
  }

  const config = getSupabaseConfig();
  if (!config) return;
  const headers = {
    'apikey': config.key,
    'Authorization': `Bearer ${config.key}`,
    'Content-Type': 'application/json'
  };
  const dbSessionId = getDbSessionId(cleanUserId);
  const patterns = [
    `${dbSessionId}:media-processing:*`,
    `${cleanUserId}:media-processing:*`
  ];
  for (const pattern of [...new Set(patterns)]) {
    try {
      await fetch(`${config.cleanUrl}/rest/v1/whatsapp_sessions?id=like.${supabaseEq(pattern)}`, {
        method: 'DELETE',
        headers
      });
    } catch (err) {
      console.warn(`[${cleanUserId}] Falha ao excluir estado remoto da fila de midia:`, err.message || err);
    }
  }
}

function resumeMediaProcessingForUser(userId) {
  const cleanUserId = String(userId || '').replace(/[^a-zA-Z0-9-_]/g, '');
  const instance = instances[cleanUserId];
  if (!instance || instance.connectionStatus !== 'connected') return;
  if (audioTranscriptionQueue.some(item => item.userId === cleanUserId)) runAudioTranscriptionQueue();
  if (imageInterpretationQueue.some(item => item.userId === cleanUserId)) runImageInterpretationQueue();
}

function getAudioTranscriptionConfig() {
  if (!AUDIO_TRANSCRIPTION_ENABLED) return null;

  const explicitUrl = process.env.AUDIO_TRANSCRIPTION_URL;
  const explicitKey = process.env.AUDIO_TRANSCRIPTION_API_KEY;
  if (explicitUrl && explicitKey) {
    return {
      url: explicitUrl,
      key: explicitKey,
      model: process.env.AUDIO_TRANSCRIPTION_MODEL || 'whisper-large-v3-turbo'
    };
  }

  if (process.env.GROQ_API_KEY) {
    return {
      url: 'https://api.groq.com/openai/v1/audio/transcriptions',
      key: process.env.GROQ_API_KEY,
      model: process.env.AUDIO_TRANSCRIPTION_MODEL || 'whisper-large-v3-turbo'
    };
  }

  if (process.env.OPENAI_API_KEY) {
    return {
      url: 'https://api.openai.com/v1/audio/transcriptions',
      key: process.env.OPENAI_API_KEY,
      model: process.env.AUDIO_TRANSCRIPTION_MODEL || 'whisper-1'
    };
  }

  return null;
}

function extensionFromMimeType(mimetype = '') {
  const cleanMime = String(mimetype).split(';')[0].trim().toLowerCase();
  if (cleanMime.includes('ogg')) return 'ogg';
  if (cleanMime.includes('mpeg') || cleanMime.includes('mp3')) return 'mp3';
  if (cleanMime.includes('mp4')) return 'mp4';
  if (cleanMime.includes('m4a')) return 'm4a';
  if (cleanMime.includes('wav')) return 'wav';
  if (cleanMime.includes('webm')) return 'webm';
  if (cleanMime.includes('flac')) return 'flac';
  return 'ogg';
}

function blobTypeFromMimeType(mimetype = '') {
  return String(mimetype).split(';')[0].trim() || 'audio/ogg';
}

function extractTranscriptionText(data) {
  if (!data) return '';
  if (typeof data === 'string') return normalizeDisplayName(data);
  if (typeof data.text === 'string') return normalizeDisplayName(data.text);
  if (Array.isArray(data.segments)) {
    return normalizeDisplayName(data.segments.map(segment => segment.text || '').join(' '));
  }
  const choiceContent = data.choices?.[0]?.message?.content;
  if (typeof choiceContent === 'string') return normalizeDisplayName(choiceContent);
  const candidateText = data.candidates?.[0]?.content?.parts?.map(part => part?.text || '').join(' ');
  if (candidateText) return normalizeDisplayName(candidateText);
  return '';
}

async function transcribeAudioBuffer(buffer, mimetype) {
  const config = getAudioTranscriptionConfig();
  if (!config) {
    if (process.env.GEMINI_API_KEY) {
      try {
        return await transcribeAudioWithGemini(buffer, mimetype);
      } catch (geminiErr) {
        throw new Error(`Fallback Gemini falhou: ${geminiErr.message}`);
      }
    }
    return { text: '', provider: '' };
  }

  if (!buffer || buffer.length === 0) return { text: '', provider: '' };
  if (buffer.length > AUDIO_TRANSCRIPTION_MAX_BYTES) {
    console.warn(`[audio] Audio ignorado para transcricao: ${buffer.length} bytes excedem o limite de ${AUDIO_TRANSCRIPTION_MAX_BYTES}.`);
    return { text: '', provider: '' };
  }

  try {
    const form = new FormData();
    const extension = extensionFromMimeType(mimetype);
    const blob = new Blob([buffer], { type: blobTypeFromMimeType(mimetype) });
    form.append('file', blob, `whatsapp-audio.${extension}`);
    form.append('model', config.model);
    form.append('response_format', 'json');
    form.append('temperature', '0');
    if (AUDIO_TRANSCRIPTION_LANGUAGE) form.append('language', AUDIO_TRANSCRIPTION_LANGUAGE);
    if (AUDIO_TRANSCRIPTION_PROMPT) form.append('prompt', AUDIO_TRANSCRIPTION_PROMPT);

    const response = await fetch(config.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.key}`
      },
      body: form,
      signal: AbortSignal.timeout(MEDIA_PROVIDER_TIMEOUT_MS)
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`transcription ${response.status}: ${errText.slice(0, MEDIA_ERROR_SNIPPET_LENGTH)}`);
    }

    const provider = config.url.includes('groq') ? 'Groq' : (config.url.includes('openai') ? 'OpenAI' : 'Serviço Principal');
    let text = '';
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      text = extractTranscriptionText(await response.json());
    } else {
      text = extractTranscriptionText(await response.text());
    }
    return { text, provider };
  } catch (primaryErr) {
    console.warn(`[audio] Servico de transcricao principal falhou: ${primaryErr.message}. Tentando fallback com Gemini...`);
    if (process.env.GEMINI_API_KEY) {
      try {
        return await transcribeAudioWithGemini(buffer, mimetype);
      } catch (geminiErr) {
        throw new Error(`Servico principal falhou (${primaryErr.message}) e fallback Gemini tambem falhou: ${geminiErr.message}`);
      }
    }
    throw primaryErr;
  }
}

async function transcribeAudioWithGemini(buffer, mimetype) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('Chave GEMINI_API_KEY nao configurada.');
  }

  const model = process.env.GEMINI_AUDIO_MODEL || 'gemini-2.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const base64Data = buffer.toString('base64');
  const cleanMime = blobTypeFromMimeType(mimetype);

  const prompt = AUDIO_TRANSCRIPTION_PROMPT || 'Transcreva este audio em texto.';

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: prompt },
          {
            inlineData: {
              mimeType: cleanMime,
              data: base64Data
            }
          }
        ]
      }],
      generationConfig: {
        temperature: 0.0
      }
    }),
    signal: AbortSignal.timeout(MEDIA_PROVIDER_TIMEOUT_MS)
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Gemini transcription error ${response.status}: ${errText.slice(0, MEDIA_ERROR_SNIPPET_LENGTH)}`);
  }

  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error('Resposta de transcricao do Gemini veio vazia ou com formato invalido.');
  }

  return { text: normalizeDisplayName(text), provider: 'Gemini' };
}

function isAudioTranscriptionText(text) {
  const normalized = normalizeDisplayName(text)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  return normalized.startsWith('[audio transcrito]');
}

function findStoredMessageByDedupeKey(userId, messageObject) {
  if (!messageObject) return null;
  const dedupeKey = messageObject.dedupeKey || createDedupeKey(messageObject);
  const timestampMs = new Date(messageObject.timestamp || Date.now()).getTime();
  const dateStr = messageDateStr(Number.isFinite(timestampMs) ? timestampMs : Date.now());
  const filePath = path.join(dataDir, 'messages', userId, `messages-${dateStr}.json`);

  try {
    if (!fs.existsSync(filePath)) return null;
    const messages = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!Array.isArray(messages)) return null;
    return messages.map(normalizeStoredMessage).find(message => {
      const key = message.dedupeKey || createDedupeKey(message);
      return key === dedupeKey;
    }) || null;
  } catch (err) {
    console.warn(`[${userId}] Falha ao verificar audio salvo para transcricao:`, err.message || err);
    return null;
  }
}

function shouldQueueAudioTranscription(userId, messageObject, savedKeys) {
  if (!getAudioTranscriptionConfig() && !process.env.GEMINI_API_KEY) return false;

  const instance = instances[userId];
  if (instance && instance.transcribeAudioSetting === false) {
    return false;
  }

  const dedupeKey = messageObject?.dedupeKey || createDedupeKey(messageObject || {});
  if (!dedupeKey) return false;
  if (failedAudioTranscriptionKeys.has(mediaProcessingKey(userId, dedupeKey))) return false;
  if (savedKeys?.has(dedupeKey)) return true;

  const storedMessage = findStoredMessageByDedupeKey(userId, messageObject);
  return !storedMessage || !isAudioTranscriptionText(storedMessage.text);
}

function queueAudioTranscriptions(items) {
  if (!getAudioTranscriptionConfig() && !process.env.GEMINI_API_KEY) return 0;
  const affectedUsers = new Set();
  let added = 0;

  for (const item of Array.isArray(items) ? items : []) {
    const dedupeKey = item?.messageObject?.dedupeKey || createDedupeKey(item?.messageObject || {});
    const processingKey = mediaProcessingKey(item?.userId, dedupeKey);
    if (!dedupeKey || queuedAudioTranscriptionKeys.has(processingKey)) continue;
    if (failedAudioTranscriptionKeys.has(processingKey)) continue;

    if (audioTranscriptionQueue.length >= AUDIO_TRANSCRIPTION_QUEUE_MAX) {
      console.warn(`[${item.userId}] Fila de transcricao de audio acima do limite configurado; audio ${dedupeKey} sera mantido na fila persistente.`);
    }

    const userId = item.userId;
    const instance = instances[userId];
    if (instance) instance.transcriptionTotal = (instance.transcriptionTotal || 0) + 1;

    queuedAudioTranscriptionKeys.add(processingKey);
    audioTranscriptionQueue.push({
      ...item,
      dedupeKey,
      attempt: item.attempt || 1,
      availableAt: item.availableAt || 0,
      longTerm: !!item.longTerm,
      longTermAttempts: item.longTermAttempts || 0
    });
    affectedUsers.add(userId);
    added++;
  }

  for (const userId of affectedUsers) scheduleMediaProcessingStateSave(userId);
  if (added > 0) runAudioTranscriptionQueue();
  return added;
}

async function runAudioTranscriptionQueue() {
  if (audioTranscriptionRunning) return;
  audioTranscriptionRunning = true;

  while (audioTranscriptionQueue.length > 0) {
    const queuePauseMs = queuePauseInMs(audioTranscriptionBackoffUntil);
    if (queuePauseMs > 0) {
      await sleep(Math.min(queuePauseMs, MEDIA_RETRY_POLL_MS));
      continue;
    }

    const ready = shiftReadyQueueItem(audioTranscriptionQueue);
    if (!ready.item) {
      await sleep(Math.min(ready.waitMs, MEDIA_RETRY_POLL_MS));
      continue;
    }

    const item = ready.item;
    const userId = item.userId;
    const instance = instances[userId];
    if (instance) {
      item.instance = instance;
      instance.transcriptionRunning = true;
    }

    const attempt = Math.max(1, Number(item.attempt || 1));
    const processingKey = mediaProcessingKey(userId, item.dedupeKey);
    let success = false;
    let errorMessage = '';
    let retryScheduled = false;
    let retryDelayMs = 0;
    let shouldPauseQueue = false;
    try {
      success = await transcribeQueuedAudio(item);
    } catch (err) {
      errorMessage = err.message || String(err);
      console.warn(`[${userId}] Falha ao transcrever audio ${item.dedupeKey}:`, errorMessage);

      if (isPermanentMediaError(errorMessage)) {
        console.error(`[${userId}] Audio ${item.dedupeKey} falhou com erro permanente (${errorMessage}). Descartando da fila de retentativas imediatamente.`);
        if (instance) {
          instance.transcriptionLastError = `Erro permanente no download/processamento: ${errorMessage}. Item descartado.`;
        }
      } else {
        retryDelayMs = retryDelayMsForError(errorMessage, attempt);
        shouldPauseQueue = shouldPauseMediaQueueForError(errorMessage);
        const retryNow = Date.now();
        const retryAt = retryNow + retryDelayMs;
        if (attempt < MEDIA_PROCESSING_MAX_ATTEMPTS || shouldPauseQueue) {
          audioTranscriptionBackoffUntil = extendQueueBackoff(audioTranscriptionBackoffUntil, retryDelayMs, retryNow);
        }
        if (attempt < MEDIA_PROCESSING_MAX_ATTEMPTS) {
          item.attempt = attempt + 1;
          item.availableAt = retryAt;
          audioTranscriptionQueue.unshift(item);
          retryScheduled = true;
          if (instance) {
            instance.transcriptionLastError = `${errorMessage} Nova tentativa ${item.attempt}/${MEDIA_PROCESSING_MAX_ATTEMPTS} em ${formatRetryDelay(retryDelayMs)}.`;
          }
          console.warn(`[${userId}] Audio ${item.dedupeKey} sera tentado novamente em ${formatRetryDelay(retryDelayMs)} (${item.attempt}/${MEDIA_PROCESSING_MAX_ATTEMPTS}).`);
        } else {
          const nextAttempts = Math.max(0, Number(item.longTermAttempts || 0)) + 1;
          if (nextAttempts > MEDIA_MAX_LONG_TERM_ATTEMPTS) {
            console.error(`[${userId}] Audio ${item.dedupeKey} excedeu o limite maximo de tentativas de longo prazo (${MEDIA_MAX_LONG_TERM_ATTEMPTS}). Removendo da fila permanentemente.`);
            if (instance) {
              instance.transcriptionLastError = `Erro persistente: ${errorMessage}. Removido da fila apos ${MEDIA_MAX_LONG_TERM_ATTEMPTS} tentativas de longo prazo.`;
            }
          } else {
            retryDelayMs = scheduleLongTermMediaRetry(item, errorMessage);
            audioTranscriptionQueue.unshift(item);
            retryScheduled = true;
            if (instance) {
              instance.transcriptionLastError = `${errorMessage} Tentativas curtas esgotadas; audio mantido na fila longa. Proxima tentativa em ${formatRetryDelay(retryDelayMs)}.`;
            }
            console.warn(`[${userId}] Audio ${item.dedupeKey} mantido na fila longa; nova tentativa em ${formatRetryDelay(retryDelayMs)} (ciclo ${item.longTermAttempts}).`);
          }
        }
      }
    } finally {
      if (success || !retryScheduled) {
        queuedAudioTranscriptionKeys.delete(processingKey);
      }
      if (success) {
        failedAudioTranscriptionKeys.delete(processingKey);
      } else if (!retryScheduled) {
        failedAudioTranscriptionKeys.add(processingKey);
      }
      if (instance) {
        if (success) {
          instance.transcriptionCompleted = (instance.transcriptionCompleted || 0) + 1;
        } else if (!retryScheduled) {
          instance.transcriptionFailed = (instance.transcriptionFailed || 0) + 1;
          const finalPauseMessage = shouldPauseQueue
            ? ` Fila pausada por ${formatRetryDelay(retryDelayMs)} antes do proximo item.`
            : '';
          const finalErrorMessage = errorMessage
            ? `${errorMessage} Tentativas esgotadas (${attempt}/${MEDIA_PROCESSING_MAX_ATTEMPTS}); item removido da fila.${finalPauseMessage}`
            : 'Transcricao nao atualizou a mensagem.';
          instance.transcriptionLastError = finalErrorMessage;
        }
        const remainingForUser = audioTranscriptionQueue.filter(x => x.userId === userId).length;
        if (remainingForUser === 0) {
          instance.transcriptionRunning = false;
        }
        if (audioTranscriptionQueue.length === 0) {
          audioTranscriptionBackoffUntil = 0;
        }
        scheduleMediaProcessingStateSave(userId);
      }
    }
  }

  audioTranscriptionRunning = false;
  if (audioTranscriptionQueue.length === 0) {
    audioTranscriptionBackoffUntil = 0;
  }
}

async function transcribeQueuedAudio(item) {
  if (!item?.rawMessage || !item?.messageObject) {
    throw new Error('Mensagem de audio incompleta para transcricao.');
  }

  const updateMediaMessage = item.instance?.sock?.updateMediaMessage;
  const downloadContext = typeof updateMediaMessage === 'function'
    ? { logger, reuploadRequest: updateMediaMessage.bind(item.instance.sock) }
    : undefined;
  const buffer = await withMediaTimeout(
    downloadMediaMessage(item.rawMessage, 'buffer', {}, downloadContext),
    MEDIA_DOWNLOAD_TIMEOUT_MS,
    'Download do audio'
  );
  if (!buffer || buffer.length === 0) {
    throw new Error('Download do audio retornou vazio.');
  }
  const result = await transcribeAudioBuffer(buffer, item.mimetype);
  if (!result || !result.text) {
    throw new Error('Servico de transcricao retornou texto vazio.');
  }

  const tag = `[Áudio transcrito por ${result.provider}]`;
  const updated = await updateStoredMessageText(item.userId, item.messageObject, `${tag} ${result.text}`);
  if (!updated) {
    throw new Error('Transcricao gerada, mas a mensagem nao foi atualizada.');
  }
  return true;
}

async function updateStoredMessageText(userId, rawMessage, nextText) {
  if (!rawMessage || !nextText) return false;

  const normalized = normalizeStoredMessage({
    ...rawMessage,
    text: nextText
  });
  normalized.dedupeKey = createDedupeKey(normalized);

  const timestampMs = new Date(normalized.timestamp).getTime();
  const dateStr = messageDateStr(Number.isFinite(timestampMs) ? timestampMs : Date.now());
  const userMsgDir = path.join(dataDir, 'messages', userId);
  const filePath = path.join(userMsgDir, `messages-${dateStr}.json`);
  let messages = [];

  try {
    fs.mkdirSync(userMsgDir, { recursive: true });
    if (fs.existsSync(filePath)) {
      const rawData = fs.readFileSync(filePath, 'utf8');
      messages = JSON.parse(rawData).map(normalizeStoredMessage);
    }
  } catch (err) {
    console.warn(`[${userId}] Falha ao carregar mensagens para atualizar audio:`, err.message || err);
    messages = [];
  }

  let changed = false;
  let found = false;

  for (const message of messages) {
    const key = message.dedupeKey || createDedupeKey(message);
    if (key !== normalized.dedupeKey) continue;
    found = true;
    if (message.text !== nextText) {
      message.text = nextText;
      changed = true;
    }
  }

  if (!found) {
    messages.push(normalized);
    changed = true;
  }

  let localSaved = !changed;

  if (changed) {
    try {
      messages.sort(compareMessagesChronologically);
      fs.writeFileSync(filePath, JSON.stringify(messages, null, JSON_INDENT), 'utf8');
      localSaved = true;
    } catch (err) {
      console.warn(`[${userId}] Falha ao gravar mensagem atualizada localmente:`, err.message || err);
    }
  }

  await persistMessagesToSupabase(userId, [normalized]);
  return localSaved;
}

function getImageInterpretationConfig() {
  if (!IMAGE_INTERPRETATION_ENABLED) return null;
  if (!sharp) return null;

  const explicitUrl = process.env.IMAGE_INTERPRETATION_URL;
  const explicitKey = process.env.IMAGE_INTERPRETATION_API_KEY;
  if (explicitUrl && explicitKey) {
    return {
      url: explicitUrl,
      key: explicitKey,
      model: process.env.IMAGE_INTERPRETATION_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct'
    };
  }

  if (process.env.GROQ_API_KEY) {
    return {
      url: 'https://api.groq.com/openai/v1/chat/completions',
      key: process.env.GROQ_API_KEY,
      model: process.env.IMAGE_INTERPRETATION_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct'
    };
  }

  return null;
}

function extractVisionResponseText(data) {
  if (!data) return '';
  if (typeof data === 'string') return normalizeDisplayName(data);

  const content = data.choices?.[0]?.message?.content;
  if (typeof content === 'string') return normalizeDisplayName(content);
  if (Array.isArray(content)) {
    return normalizeDisplayName(content.map(part => part?.text || '').join(' '));
  }

  if (typeof data.text === 'string') return normalizeDisplayName(data.text);
  const candidateText = data.candidates?.[0]?.content?.parts?.map(part => part?.text || '').join(' ');
  if (candidateText) return normalizeDisplayName(candidateText);
  return '';
}

async function compressImageBufferForVision(buffer) {
  if (!sharp) return null;
  if (!buffer || buffer.length === 0) return null;

  const dimensions = [...new Set([
    IMAGE_INTERPRETATION_MAX_DIMENSION,
    1280,
    1024,
    768,
    640
  ].filter(value => value <= IMAGE_INTERPRETATION_MAX_DIMENSION || value === IMAGE_INTERPRETATION_MAX_DIMENSION))];
  const qualities = [...new Set([
    IMAGE_INTERPRETATION_JPEG_QUALITY,
    72,
    64,
    56,
    48,
    40
  ].filter(value => value > 0))];

  let smallest = null;
  for (const dimension of dimensions) {
    for (const quality of qualities) {
      const compressed = await sharp(buffer, { failOn: 'none' })
        .rotate()
        .resize({
          width: dimension,
          height: dimension,
          fit: 'inside',
          withoutEnlargement: true
        })
        .jpeg({
          quality,
          mozjpeg: true
        })
        .toBuffer();

      if (!smallest || compressed.length < smallest.length) {
        smallest = compressed;
      }
      if (compressed.length <= IMAGE_INTERPRETATION_MAX_BYTES) {
        return {
          buffer: compressed,
          mimetype: 'image/jpeg'
        };
      }
    }
  }

  if (smallest) {
    console.warn(`[image] Imagem ignorada para interpretacao: ${smallest.length} bytes apos compressao excedem o limite de ${IMAGE_INTERPRETATION_MAX_BYTES}.`);
  }
  return null;
}

async function interpretImageBuffer(buffer) {
  const compressed = await compressImageBufferForVision(buffer);
  if (!compressed) return { text: '', provider: '' };

  const config = getImageInterpretationConfig();
  if (!config) {
    if (process.env.GEMINI_API_KEY) {
      try {
        return await interpretImageWithGemini(compressed);
      } catch (geminiErr) {
        throw new Error(`Fallback Gemini falhou: ${geminiErr.message}`);
      }
    }
    return { text: '', provider: '' };
  }

  try {
    const imageBase64 = compressed.buffer.toString('base64');
    const response = await fetch(config.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.key}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: IMAGE_INTERPRETATION_PROMPT },
              {
                type: 'image_url',
                image_url: {
                  url: `data:${compressed.mimetype};base64,${imageBase64}`
                }
              }
            ]
          }
        ],
        temperature: 0.1,
        max_completion_tokens: 500
      }),
      signal: AbortSignal.timeout(MEDIA_PROVIDER_TIMEOUT_MS)
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`image interpretation ${response.status}: ${errText.slice(0, MEDIA_ERROR_SNIPPET_LENGTH)}`);
    }

    const provider = config.url.includes('groq') ? 'Groq' : (config.url.includes('openai') ? 'OpenAI' : 'Serviço Principal');
    let text = '';
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      text = extractVisionResponseText(await response.json());
    } else {
      text = extractVisionResponseText(await response.text());
    }
    return { text, provider };
  } catch (primaryErr) {
    console.warn(`[image] Servico de interpretacao principal falhou: ${primaryErr.message}. Tentando fallback com Gemini...`);
    if (process.env.GEMINI_API_KEY) {
      try {
        return await interpretImageWithGemini(compressed);
      } catch (geminiErr) {
        throw new Error(`Servico principal falhou (${primaryErr.message}) e fallback Gemini tambem falhou: ${geminiErr.message}`);
      }
    }
    throw primaryErr;
  }
}

async function interpretImageWithGemini(compressed) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('Chave GEMINI_API_KEY nao configurada.');
  }

  const model = process.env.GEMINI_VISION_MODEL || 'gemini-2.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const base64Data = compressed.buffer.toString('base64');
  const cleanMime = compressed.mimetype;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: IMAGE_INTERPRETATION_PROMPT },
          {
            inlineData: {
              mimeType: cleanMime,
              data: base64Data
            }
          }
        ]
      }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 500
      }
    }),
    signal: AbortSignal.timeout(MEDIA_PROVIDER_TIMEOUT_MS)
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Gemini image interpretation error ${response.status}: ${errText.slice(0, MEDIA_ERROR_SNIPPET_LENGTH)}`);
  }

  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error('Resposta de interpretacao do Gemini veio vazia ou com formato invalido.');
  }

  return { text: normalizeDisplayName(text), provider: 'Gemini' };
}

function isImageInterpretationText(text) {
  const normalized = normalizeDisplayName(text)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  return normalized.startsWith('[imagem interpretada]') ||
    normalized.startsWith('[figurinha interpretada]');
}

function shouldQueueImageInterpretation(userId, messageObject, savedKeys) {
  if (!getImageInterpretationConfig() && !process.env.GEMINI_API_KEY) return false;

  const instance = instances[userId];
  if (instance && instance.interpretImagesSetting === false) {
    return false;
  }

  const dedupeKey = messageObject?.dedupeKey || createDedupeKey(messageObject || {});
  if (!dedupeKey) return false;
  if (failedImageInterpretationKeys.has(mediaProcessingKey(userId, dedupeKey))) return false;
  if (savedKeys?.has(dedupeKey)) return true;

  const storedMessage = findStoredMessageByDedupeKey(userId, messageObject);
  return !storedMessage || !isImageInterpretationText(storedMessage.text);
}

function queueImageInterpretations(items) {
  if (!getImageInterpretationConfig() && !process.env.GEMINI_API_KEY) return 0;
  const affectedUsers = new Set();
  let added = 0;

  for (const item of Array.isArray(items) ? items : []) {
    const dedupeKey = item?.messageObject?.dedupeKey || createDedupeKey(item?.messageObject || {});
    const processingKey = mediaProcessingKey(item?.userId, dedupeKey);
    if (!dedupeKey || queuedImageInterpretationKeys.has(processingKey)) continue;
    if (failedImageInterpretationKeys.has(processingKey)) continue;

    if (imageInterpretationQueue.length >= IMAGE_INTERPRETATION_QUEUE_MAX) {
      console.warn(`[${item.userId}] Fila de interpretacao visual acima do limite configurado; midia ${dedupeKey} sera mantida na fila persistente.`);
    }

    const userId = item.userId;
    const instance = instances[userId];
    if (instance) instance.imageInterpretationTotal = (instance.imageInterpretationTotal || 0) + 1;

    queuedImageInterpretationKeys.add(processingKey);
    imageInterpretationQueue.push({
      ...item,
      dedupeKey,
      attempt: item.attempt || 1,
      availableAt: item.availableAt || 0,
      longTerm: !!item.longTerm,
      longTermAttempts: item.longTermAttempts || 0
    });
    affectedUsers.add(userId);
    added++;
  }

  for (const userId of affectedUsers) scheduleMediaProcessingStateSave(userId);
  if (added > 0) runImageInterpretationQueue();
  return added;
}

async function runImageInterpretationQueue() {
  if (imageInterpretationRunning) return;
  imageInterpretationRunning = true;

  while (imageInterpretationQueue.length > 0) {
    const queuePauseMs = queuePauseInMs(imageInterpretationBackoffUntil);
    if (queuePauseMs > 0) {
      await sleep(Math.min(queuePauseMs, MEDIA_RETRY_POLL_MS));
      continue;
    }

    const ready = shiftReadyQueueItem(imageInterpretationQueue);
    if (!ready.item) {
      await sleep(Math.min(ready.waitMs, MEDIA_RETRY_POLL_MS));
      continue;
    }

    const item = ready.item;
    const userId = item.userId;
    const instance = instances[userId];
    if (instance) {
      item.instance = instance;
      instance.imageInterpretationRunning = true;
    }

    const attempt = Math.max(1, Number(item.attempt || 1));
    const processingKey = mediaProcessingKey(userId, item.dedupeKey);
    let success = false;
    let errorMessage = '';
    let retryScheduled = false;
    let retryDelayMs = 0;
    let shouldPauseQueue = false;
    try {
      success = await interpretQueuedImage(item);
    } catch (err) {
      errorMessage = err.message || String(err);
      console.warn(`[${userId}] Falha ao interpretar midia visual ${item.dedupeKey}:`, errorMessage);

      if (isPermanentMediaError(errorMessage)) {
        console.error(`[${userId}] Midia visual ${item.dedupeKey} falhou com erro permanente (${errorMessage}). Descartando da fila de retentativas imediatamente.`);
        if (instance) {
          instance.imageInterpretationLastError = `Erro permanente no download/processamento: ${errorMessage}. Item descartado.`;
        }
      } else {
        retryDelayMs = retryDelayMsForError(errorMessage, attempt);
        shouldPauseQueue = shouldPauseMediaQueueForError(errorMessage);
        const retryNow = Date.now();
        const retryAt = retryNow + retryDelayMs;
        if (attempt < MEDIA_PROCESSING_MAX_ATTEMPTS || shouldPauseQueue) {
          imageInterpretationBackoffUntil = extendQueueBackoff(imageInterpretationBackoffUntil, retryDelayMs, retryNow);
        }
        if (attempt < MEDIA_PROCESSING_MAX_ATTEMPTS) {
          item.attempt = attempt + 1;
          item.availableAt = retryAt;
          imageInterpretationQueue.unshift(item);
          retryScheduled = true;
          if (instance) {
            instance.imageInterpretationLastError = `${errorMessage} Nova tentativa ${item.attempt}/${MEDIA_PROCESSING_MAX_ATTEMPTS} em ${formatRetryDelay(retryDelayMs)}.`;
          }
          console.warn(`[${userId}] Midia visual ${item.dedupeKey} sera tentada novamente em ${formatRetryDelay(retryDelayMs)} (${item.attempt}/${MEDIA_PROCESSING_MAX_ATTEMPTS}).`);
        } else {
          const nextAttempts = Math.max(0, Number(item.longTermAttempts || 0)) + 1;
          if (nextAttempts > MEDIA_MAX_LONG_TERM_ATTEMPTS) {
            console.error(`[${userId}] Midia visual ${item.dedupeKey} excedeu o limite maximo de tentativas de longo prazo (${MEDIA_MAX_LONG_TERM_ATTEMPTS}). Removendo da fila permanentemente.`);
            if (instance) {
              instance.imageInterpretationLastError = `Erro persistente: ${errorMessage}. Removida da fila apos ${MEDIA_MAX_LONG_TERM_ATTEMPTS} tentativas de longo prazo.`;
            }
          } else {
            retryDelayMs = scheduleLongTermMediaRetry(item, errorMessage);
            imageInterpretationQueue.unshift(item);
            retryScheduled = true;
            if (instance) {
              instance.imageInterpretationLastError = `${errorMessage} Tentativas curtas esgotadas; midia mantida na fila longa. Proxima tentativa em ${formatRetryDelay(retryDelayMs)}.`;
            }
            console.warn(`[${userId}] Midia visual ${item.dedupeKey} mantida na fila longa; nova tentativa em ${formatRetryDelay(retryDelayMs)} (ciclo ${item.longTermAttempts}).`);
          }
        }
      }
    } finally {
      if (success || !retryScheduled) {
        queuedImageInterpretationKeys.delete(processingKey);
      }
      if (success) {
        failedImageInterpretationKeys.delete(processingKey);
      } else if (!retryScheduled) {
        failedImageInterpretationKeys.add(processingKey);
      }
      if (instance) {
        if (success) {
          instance.imageInterpretationCompleted = (instance.imageInterpretationCompleted || 0) + 1;
        } else if (!retryScheduled) {
          instance.imageInterpretationFailed = (instance.imageInterpretationFailed || 0) + 1;
          const finalPauseMessage = shouldPauseQueue
            ? ` Fila pausada por ${formatRetryDelay(retryDelayMs)} antes do proximo item.`
            : '';
          const finalErrorMessage = errorMessage
            ? `${errorMessage} Tentativas esgotadas (${attempt}/${MEDIA_PROCESSING_MAX_ATTEMPTS}); item removido da fila.${finalPauseMessage}`
            : 'Interpretacao nao atualizou a mensagem.';
          instance.imageInterpretationLastError = finalErrorMessage;
        }
        const remainingForUser = imageInterpretationQueue.filter(x => x.userId === userId).length;
        if (remainingForUser === 0) {
          instance.imageInterpretationRunning = false;
        }
        if (imageInterpretationQueue.length === 0) {
          imageInterpretationBackoffUntil = 0;
        }
        scheduleMediaProcessingStateSave(userId);
      }
    }
  }

  imageInterpretationRunning = false;
  if (imageInterpretationQueue.length === 0) {
    imageInterpretationBackoffUntil = 0;
  }
}

function formatImageInterpretationMessage(originalText, interpretation, provider) {
  const cleanOriginal = normalizeDisplayName(originalText);
  const cleanInterpretation = normalizeDisplayName(interpretation);
  if (!cleanInterpretation) return '';

  const isSticker = normalizedComparableText(cleanOriginal).startsWith('[figurinha]');
  const tag = isSticker 
    ? `Figurinha interpretada por ${provider}` 
    : `Imagem interpretada por ${provider}`;
  const caption = cleanOriginal.replace(/^\[(Imagem|Figurinha)\]\s*/i, '').trim();
  if (caption) {
    return `[${tag}] Legenda: ${caption}. Interpretacao: ${cleanInterpretation}`;
  }
  return `[${tag}] ${cleanInterpretation}`;
}

async function interpretQueuedImage(item) {
  if (!item?.rawMessage || !item?.messageObject) {
    throw new Error('Mensagem de imagem incompleta para interpretacao.');
  }

  const updateMediaMessage = item.instance?.sock?.updateMediaMessage;
  const downloadContext = typeof updateMediaMessage === 'function'
    ? { logger, reuploadRequest: updateMediaMessage.bind(item.instance.sock) }
    : undefined;
  const buffer = await withMediaTimeout(
    downloadMediaMessage(item.rawMessage, 'buffer', {}, downloadContext),
    MEDIA_DOWNLOAD_TIMEOUT_MS,
    'Download da imagem'
  );
  if (!buffer || buffer.length === 0) {
    throw new Error('Download da imagem retornou vazio.');
  }
  const result = await interpretImageBuffer(buffer);
  if (!result || !result.text) {
    throw new Error('Servico de interpretacao retornou texto vazio.');
  }
  const nextText = formatImageInterpretationMessage(item.messageObject.text, result.text, result.provider);
  if (!nextText) {
    throw new Error('Servico de interpretacao retornou texto vazio.');
  }

  const updated = await updateStoredMessageText(item.userId, item.messageObject, nextText);
  if (!updated) {
    throw new Error('Interpretacao gerada, mas a mensagem nao foi atualizada.');
  }
  return true;
}

function normalizeDisplayName(name) {
  if (!name || typeof name !== 'string') return '';
  return name
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const ownerNamesFilePath = path.join(dataDir, 'owner-names.json');

function loadOwnerNamesFromFile() {
  try {
    if (!fs.existsSync(ownerNamesFilePath)) return {};
    const raw = JSON.parse(fs.readFileSync(ownerNamesFilePath, 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch (err) {
    console.warn('[owner-name] Falha ao carregar nomes do dono do WhatsApp:', err.message || err);
    return {};
  }
}

function loadOwnerNameFromFile(userId) {
  return normalizeDisplayName(loadOwnerNamesFromFile()[userId]);
}

function saveOwnerNameToFile(userId, name) {
  const cleanName = normalizeDisplayName(name);
  if (!userId || !cleanName) return;

  try {
    const names = loadOwnerNamesFromFile();
    names[userId] = cleanName;
    fs.writeFileSync(ownerNamesFilePath, JSON.stringify(names, null, JSON_INDENT), 'utf8');
  } catch (err) {
    console.warn(`[${userId}] Falha ao salvar nome do dono do WhatsApp:`, err.message || err);
  }
}

function readOwnerNameHint(req) {
  const rawHint = req.headers['x-owner-name'] || req.query.ownerName || req.query.owner_name || '';
  return normalizeDisplayName(Array.isArray(rawHint) ? rawHint[0] : rawHint);
}

function applyOwnerNameHint(userId, instance, ownerNameHint) {
  const cleanName = normalizeDisplayName(ownerNameHint);
  if (!cleanName || isSelfNamePlaceholder(cleanName) || looksLikeTechnicalName(cleanName)) return false;

  if (instance) {
    instance.myPushName = cleanName;
    instance.myPushNameSource = 'profile-hint';
  }
  saveOwnerNameToFile(userId, cleanName);
  return true;
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

const CONTACT_NAME_FIELDS = [
  'name',
  'verifiedName',
  'notify',
  'shortName',
  'pushName',
  'subject',
  'displayName',
  'fullName',
  'profileName'
];

function contactNameFields(contact) {
  if (!contact || typeof contact !== 'object') return {};
  return CONTACT_NAME_FIELDS.reduce((fields, field) => {
    const value = normalizeDisplayName(contact[field]);
    if (value) fields[field] = value;
    return fields;
  }, {});
}

function diagnosticsValue(value) {
  if (value === null || value === undefined) return value;
  const valueType = typeof value;
  if (valueType === 'string' || valueType === 'number' || valueType === 'boolean') return value;
  if (valueType === 'bigint') return value.toString();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return `[bytes:${value.length}]`;
  if (Array.isArray(value)) return value.slice(0, 20).map(item => {
    const itemType = typeof item;
    if (item === null || item === undefined || itemType === 'string' || itemType === 'number' || itemType === 'boolean') return item;
    if (itemType === 'bigint') return item.toString();
    return '[object]';
  });
  return '[object]';
}

function diagnosticsShallowObject(value) {
  if (!value || typeof value !== 'object') return {};
  return Object.entries(value).reduce((safe, [key, fieldValue]) => {
    safe[key] = diagnosticsValue(fieldValue);
    return safe;
  }, {});
}

function hasUsableProfileName(contact) {
  const name = bestNameFromContact(contact);
  return !!name && !looksLikeTechnicalName(name);
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
    key.participantAlt,
    msg?.participant,
    msg?.participantAlt,
    key.participantPn,
    key.participantLid,
    key.senderPn,
    key.senderLid,
    msg?.participantPn,
    msg?.participantLid,
    msg?.senderPn,
    msg?.senderLid
  ].map(value => {
    if (!value || typeof value !== 'string') return '';
    if (value.includes('@')) return value;
    if (/^\d{14,}$/.test(value)) return `${value}@lid`;
    return `${value}@s.whatsapp.net`;
  }));
}

function cacheJidAliasPair(instance, aliases) {
  if (!instance) return;
  if (!instance.jidAliasCache) instance.jidAliasCache = {};
  const normalized = uniqueJids(aliases);
  const pn = normalized.find(jid => jid.endsWith('@s.whatsapp.net'));
  const lid = normalized.find(jid => jid.endsWith('@lid'));
  if (!pn || !lid) return;
  instance.jidAliasCache[pn] = lid;
  instance.jidAliasCache[lid] = pn;
  if (instance.jidAliasMissCache) {
    delete instance.jidAliasMissCache[pn];
    delete instance.jidAliasMissCache[lid];
  }
}

async function expandJidAliases(aliasJids, instance) {
  const aliases = uniqueJids(aliasJids || []);
  const expanded = [...aliases];

  for (const jid of aliases) {
    const cached = instance?.jidAliasCache?.[jid];
    if (cached) expanded.push(cached);

    if (jid.endsWith('@lid') && !instance?.jidAliasMissCache?.[jid] && instance?.sock?.signalRepository?.lidMapping?.getPNForLID) {
      try {
        const pn = await instance.sock.signalRepository.lidMapping.getPNForLID(jid);
        if (pn) {
          expanded.push(pn);
          cacheJidAliasPair(instance, [jid, pn]);
        } else if (instance) {
          if (!instance.jidAliasMissCache) instance.jidAliasMissCache = {};
          instance.jidAliasMissCache[jid] = true;
        }
      } catch (err) {
        console.warn(`[jid-mapping] Falha ao resolver ${jid}:`, err.message || err);
      }
    }
  }

  return uniqueJids(expanded);
}

async function resolveIncomingMessageRoute(msg, instance, knownOwnerJids) {
  const ownerJids = knownOwnerJids || await expandJidAliases(messageDomain.ownerJidsFromInstance(instance), instance);
  const [chatAliases, participantAliases] = await Promise.all([
    expandJidAliases(messageDomain.messageChatAliases(msg), instance),
    expandJidAliases(messageDomain.messageParticipantAliases(msg), instance)
  ]);

  return messageDomain.resolveMessageRoute(msg, {
    ownerJids,
    chatAliases,
    participantAliases
  });
}

function relatedAliasesFromCache(aliasJids, contactsCache) {
  const aliases = uniqueJids(aliasJids || []);
  if (!contactsCache || aliases.length === 0) return [];

  const phoneNumbers = new Set();
  for (const alias of aliases) {
    const cleanAlias = cleanJid(alias);
    if (cleanAlias.endsWith('@s.whatsapp.net')) {
      const number = jidNumber(cleanAlias);
      if (number) phoneNumbers.add(number);
    }

    const cachedName = normalizeDisplayName(contactsCache[cleanAlias] || '');
    const cachedDigits = cachedName.replace(/\D/g, '');
    if (cachedDigits && looksLikeTechnicalName(cachedName)) {
      phoneNumbers.add(cachedDigits);
    }
  }

  if (phoneNumbers.size === 0) return [];

  const related = [];
  for (const phoneNumber of phoneNumbers) {
    related.push(`${phoneNumber}@s.whatsapp.net`);
    for (const [cachedJid, cachedName] of Object.entries(contactsCache)) {
      const normalizedName = normalizeDisplayName(cachedName);
      if (looksLikeTechnicalName(normalizedName) && normalizedName.replace(/\D/g, '') === phoneNumber) {
        related.push(cachedJid);
      }
    }
  }

  return uniqueJids(related);
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
  if (instances[userId]?.intentionalLogout) return;
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
  const id = String(messageObject.id || messageObject.message_id || '').trim();
  if (id) return `id:${id}`;
  const chat = messageObject.chatJid || `${messageObject.sender || ''}@unknown`;
  const participant = messageObject.participantJid || messageObject.participant || '';
  const timestamp = messageObject.timestamp || messageObject.message_timestamp || '';
  return `${chat}|${participant}|${timestamp}|${messageObject.text || ''}`;
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

function normalizeBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value > 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === 'true' || normalized === '1' || normalized === 'yes';
  }
  return false;
}

function normalizeStoredMessage(message) {
  const chatJid = inferChatJidFromMessage(message);
  const participantJid = inferParticipantJidFromMessage(message);
  const participantAliases = uniqueJids([
    participantJid,
    ...(Array.isArray(message.participantAliases) ? message.participantAliases : []),
    ...(Array.isArray(message.participant_aliases) ? message.participant_aliases : [])
  ]);
  const chatAliases = uniqueJids([
    chatJid,
    ...(Array.isArray(message.chatAliases) ? message.chatAliases : []),
    ...(Array.isArray(message.chat_aliases) ? message.chat_aliases : [])
  ]);
  const normalized = {
    id: message.id || message.message_id || '',
    dedupeKey: message.dedupeKey || message.dedupe_key || '',
    sender: message.sender || message.chat_number || jidNumber(chatJid),
    chatJid,
    chatAliases,
    chatName: normalizeDisplayName(message.chatName || message.chat_name || ''),
    participant: message.participant || message.participant_number || jidNumber(participantJid),
    participantJid,
    participantAliases,
    name: normalizeDisplayName(message.name || message.display_name || ''),
    text: typeof message.text === 'string' ? message.text : '',
    fromMe: normalizeBoolean(message.fromMe ?? message.from_me),
    timestamp: message.timestamp || message.message_timestamp || new Date().toISOString(),
    routingStatus: normalizeDisplayName(message.routingStatus || message.routing_status || 'legacy'),
    routingIssue: normalizeDisplayName(message.routingIssue || message.routing_issue || ''),
    isForwarded: normalizeBoolean(message.isForwarded ?? message.is_forwarded),
    quotedMessageId: normalizeDisplayName(message.quotedMessageId || message.quoted_message_id || ''),
    quotedMessageSender: cleanJid(message.quotedMessageSender || message.quoted_message_sender || ''),
    quotedMessageText: typeof (message.quotedMessageText ?? message.quoted_message_text) === 'string'
      ? normalizeDisplayName(message.quotedMessageText ?? message.quoted_message_text)
      : ''
  };
  const mediaKind = normalizeDisplayName(message.mediaKind || message.media_kind || '');
  const mediaMimetype = normalizeDisplayName(message.mediaMimetype || message.media_mimetype || '');
  const mediaSeconds = Number(message.mediaSeconds ?? message.media_seconds);
  if (mediaKind) normalized.mediaKind = mediaKind;
  if (mediaMimetype) normalized.mediaMimetype = mediaMimetype;
  if (Number.isFinite(mediaSeconds) && mediaSeconds > 0) normalized.mediaSeconds = mediaSeconds;
  normalized.dedupeKey = normalized.dedupeKey || createDedupeKey(normalized);
  return normalized;
}

function normalizedComparableText(text) {
  return normalizeDisplayName(text)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function mediaTextRank(text) {
  const cleanText = normalizeDisplayName(text);
  if (!cleanText) return 0;
  if (isAudioTranscriptionText(cleanText) || isImageInterpretationText(cleanText)) return 4;

  const normalized = normalizedComparableText(cleanText);
  if (normalized === '[audio]' || normalized.startsWith('[audio] ')) return 1;
  if (normalized === '[video]' || normalized.startsWith('[video] ')) return normalized.length > '[video]'.length ? 2 : 1;
  if (normalized === '[figurinha]' || normalized.startsWith('[figurinha] ')) return 1;
  if (normalized === '[imagem]' || normalized.startsWith('[imagem] ')) return normalized.length > '[imagem]'.length ? 2 : 1;

  return 3;
}

function chooseBetterMessageText(existingText, nextText) {
  const existing = typeof existingText === 'string' ? existingText : '';
  const next = typeof nextText === 'string' ? nextText : '';
  if (!next) return existing;
  if (!existing) return next;

  const existingRank = mediaTextRank(existing);
  const nextRank = mediaTextRank(next);
  if (nextRank !== existingRank) {
    return nextRank > existingRank ? next : existing;
  }

  return next;
}

function mergeMessages(localMessages, remoteMessages) {
  const merged = new Map();

  for (const raw of [...(localMessages || []), ...(remoteMessages || [])]) {
    const message = normalizeStoredMessage(raw);
    if (!message.id && !message.text) continue;
    const key = messageDomain.messageIdentityKey(message);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, message);
      continue;
    }

    const preferredRoute = messageDomain.preferMessageRoute(existing, message);
    const secondary = preferredRoute === message ? existing : message;
    const preferredAliases = uniqueJids([preferredRoute.chatJid, ...(preferredRoute.chatAliases || [])]);
    const secondaryAliases = uniqueJids([secondary.chatJid, ...(secondary.chatAliases || [])]);
    const sameConversation = preferredAliases.some(alias => secondaryAliases.includes(alias));
    const mergedMessage = {
      ...secondary,
      ...preferredRoute,
      dedupeKey: createDedupeKey(preferredRoute),
      chatAliases: uniqueJids([...preferredAliases, ...(sameConversation ? secondaryAliases : [])]),
      chatName: preferredRoute.chatName || (sameConversation ? secondary.chatName : ''),
      participantAliases: uniqueJids([...(secondary.participantAliases || []), ...(preferredRoute.participantAliases || [])]),
      name: preferredRoute.name || (sameConversation ? secondary.name : ''),
      text: chooseBetterMessageText(existing.text, message.text),
      isForwarded: existing.isForwarded || message.isForwarded,
      quotedMessageId: message.quotedMessageId || existing.quotedMessageId,
      quotedMessageSender: message.quotedMessageSender || existing.quotedMessageSender,
      quotedMessageText: message.quotedMessageText || existing.quotedMessageText
    };
    merged.set(key, mergedMessage);
  }

  return Array.from(merged.values()).sort(compareMessagesChronologically);
}

function compareMessagesChronologically(a, b) {
  const timeA = new Date(a.timestamp).getTime();
  const timeB = new Date(b.timestamp).getTime();
  if (timeA !== timeB) return timeA - timeB;
  return String(a.id || '').localeCompare(String(b.id || ''));
}

function isSelfNamePlaceholder(name) {
  const normalized = normalizeDisplayName(name)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  return !normalized || normalized === 'eu' || normalized === 'voce';
}

function bestWhatsAppOwnName(sock) {
  const user = sock && sock.user ? sock.user : {};
  const candidates = [
    user.name,
    user.verifiedName,
    user.notify,
    user.pushName,
    user.displayName
  ];

  for (const candidate of candidates) {
    const name = normalizeDisplayName(candidate);
    if (name && !isSelfNamePlaceholder(name) && !looksLikeTechnicalName(name)) {
      return name;
    }
  }
  return '';
}

async function ensureOwnerDisplayName(userId, instance) {
  const whatsappName = bestWhatsAppOwnName(instance?.sock);
  if (whatsappName) {
    if (instance) {
      instance.myPushName = whatsappName;
      instance.myPushNameSource = 'whatsapp';
    }
    return whatsappName;
  }

  const currentName = normalizeDisplayName(instance?.myPushName);
  if (currentName && !isSelfNamePlaceholder(currentName) && !looksLikeTechnicalName(currentName)) {
    return currentName;
  }

  const savedOwnerName = loadOwnerNameFromFile(userId);
  if (savedOwnerName && !isSelfNamePlaceholder(savedOwnerName) && !looksLikeTechnicalName(savedOwnerName)) {
    if (instance) {
      instance.myPushName = savedOwnerName;
      instance.myPushNameSource = 'profile-hint';
    }
    return savedOwnerName;
  }

  const profileName = await loadProfileNameFromSupabase(userId);
  if (profileName) {
    const cleanProfileName = normalizeDisplayName(profileName);
    if (instance) {
      instance.myPushName = cleanProfileName;
      instance.myPushNameSource = 'profile';
    }
    saveOwnerNameToFile(userId, cleanProfileName);
    return cleanProfileName;
  }

  return 'Você';
}

function resolveMessageSenderName(message, contactsCache, isGroup, myPushName, myPushNameSource = '', activeInstance = null) {
  if (message.fromMe) {
    if (myPushNameSource === 'whatsapp' && myPushName && !isSelfNamePlaceholder(myPushName)) return myPushName;
    if (message.name && !isSelfNamePlaceholder(message.name)) return message.name;
    if (myPushName && !isSelfNamePlaceholder(myPushName)) return myPushName;
    return 'Você';
  }
  if (message.routingStatus === 'ambiguous-self') {
    return 'Remetente não identificado';
  }
  const participantJid = message.participantJid || inferParticipantJidFromMessage(message);
  const aliases = uniqueJids([participantJid, ...(message.participantAliases || [])]);
  const cachedName = bestNameFromAliases(aliases, contactsCache);
  if (cachedName && !looksLikeTechnicalName(cachedName) && !shouldSuppressOwnerNameForIncomingAlias(aliases, cachedName, activeInstance)) return cachedName;
  if (message.name && !looksLikeTechnicalName(message.name) && !shouldSuppressOwnerNameForIncomingAlias(aliases, message.name, activeInstance)) return message.name;
  if (!isGroup && message.chatName && !looksLikeTechnicalName(message.chatName)) return message.chatName;
  const phoneFallback = phoneFallbackFromAliases(aliases, contactsCache);
  if (phoneFallback) return phoneFallback;
  if (cachedName && !shouldSuppressOwnerNameForIncomingAlias(aliases, cachedName, activeInstance)) return cachedName;
  return message.participant || message.sender || jidNumber(participantJid);
}

function jidNumberPart(value) {
  if (!value || typeof value !== 'string') return '';
  return cleanJid(value).split('@')[0].split(':')[0];
}

function ownSenderNumbers(activeInstance) {
  return new Set([
    activeInstance?.myJid,
    activeInstance?.myLid,
    activeInstance?.sock?.user?.id,
    activeInstance?.sock?.user?.lid
  ].map(value => jidNumberPart(String(value || ''))).filter(Boolean));
}

function comparablePersonName(value) {
  return normalizeDisplayName(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function isOwnerDisplayName(candidateName, activeInstance) {
  const candidate = comparablePersonName(candidateName);
  const owner = comparablePersonName(activeInstance?.myPushName || '');
  if (!candidate || !owner) return false;
  return candidate === owner;
}

function aliasesBelongToOwner(aliasJids, activeInstance) {
  const ownerNumbers = ownSenderNumbers(activeInstance);
  if (ownerNumbers.size === 0) return false;
  return (aliasJids || []).some(alias => ownerNumbers.has(jidNumberPart(alias)));
}

function shouldSuppressOwnerNameForIncomingAlias(aliasJids, candidateName, activeInstance) {
  return isOwnerDisplayName(candidateName, activeInstance) && !aliasesBelongToOwner(aliasJids, activeInstance);
}

function aliasesFromRawSender(rawSender) {
  const cleanSender = cleanJid(String(rawSender || '').trim());
  if (!cleanSender) return [];
  if (cleanSender.includes('@')) return uniqueJids([cleanSender]);
  if (!/^\d+$/.test(cleanSender)) return [];
  return uniqueJids([
    ensureUserJid(cleanSender, cleanSender.length >= 14 ? 'lid' : 's.whatsapp.net'),
    `${cleanSender}@s.whatsapp.net`
  ]);
}

function resolveQuotedMessageSenderName(rawSender, contactsCache, activeInstance) {
  const baseAliases = aliasesFromRawSender(rawSender);
  const aliases = uniqueJids([
    ...baseAliases,
    ...relatedAliasesFromCache(baseAliases, contactsCache)
  ]);
  if (aliases.length === 0) return normalizeDisplayName(rawSender || '');

  const ownNumbers = ownSenderNumbers(activeInstance);
  if (aliases.some(alias => ownNumbers.has(jidNumberPart(alias)))) {
    const ownerName = normalizeDisplayName(activeInstance?.myPushName || '');
    return ownerName && !isSelfNamePlaceholder(ownerName) ? ownerName : 'Voce';
  }

  const cachedName = bestNameFromAliases(aliases, contactsCache);
  if (cachedName && !looksLikeTechnicalName(cachedName)) return cachedName;
  const phoneFallback = phoneFallbackFromAliases(aliases, contactsCache);
  if (phoneFallback) return phoneFallback;
  if (cachedName) return cachedName;
  return jidNumberPart(aliases[0]) || normalizeDisplayName(rawSender || '');
}

function resolveQuotedMessageDetails(message, chatMessages, contactsCache, isGroup, activeInstance) {
  const quotedId = normalizeDisplayName(message.quotedMessageId || '');
  const quotedFromHistory = quotedId
    ? (chatMessages || []).find(candidate => candidate.id === quotedId || candidate.message_id === quotedId)
    : null;
  const quotedSenderJid = message.quotedMessageSender ||
    quotedFromHistory?.participantJid ||
    quotedFromHistory?.participant ||
    '';
  const quotedSenderName = quotedFromHistory
    ? resolveMessageSenderName(
        quotedFromHistory,
        contactsCache,
        isGroup,
        activeInstance?.myPushName,
        activeInstance?.myPushNameSource,
        activeInstance
      )
    : resolveQuotedMessageSenderName(quotedSenderJid, contactsCache, activeInstance);
  const quotedText = normalizeDisplayName(message.quotedMessageText || quotedFromHistory?.text || '');

  return {
    id: quotedId,
    senderJid: quotedSenderJid,
    senderName: quotedSenderName,
    text: quotedText
  };
}

function quotedPrefixText(value) {
  return normalizeDisplayName(value);
}

function formatMessageContextPrefixes(message, chatMessages, contactsCache, isGroup, activeInstance, escapeValue = value => value) {
  const prefixes = [];
  if (message.isForwarded) {
    prefixes.push('*[Encaminhada]*');
  }

  if (message.quotedMessageId || message.quotedMessageText || message.quotedMessageSender) {
    const quoted = resolveQuotedMessageDetails(message, chatMessages, contactsCache, isGroup, activeInstance);
    const sender = quoted.senderName || 'mensagem';
    const text = quoted.text || 'sem texto';
    prefixes.push(`*[Em resposta a ${escapeValue(sender)}: "${escapeValue(quotedPrefixText(text))}"]*`);
  }

  return prefixes.length > 0 ? `${prefixes.join(' ')} ` : '';
}

function isValidConversationDisplayName(name) {
  if (!name) return false;
  if (isSelfNamePlaceholder(name)) return false;
  if (name.includes('@')) return false;
  if (/^[0-9+\s\-()]+$/.test(name)) return false;
  return true;
}

function expandPersistedChatAliases(message, jidAliasCache = {}) {
  const aliases = uniqueJids([message.chatJid, ...(message.chatAliases || [])]);
  const expanded = [...aliases];

  for (const alias of aliases) {
    const mappedAlias = cleanJid(jidAliasCache?.[alias] || '');
    if (mappedAlias) expanded.push(mappedAlias);
  }

  return uniqueJids(expanded);
}

function buildConversationAliasComponents(messages, jidAliasCache = {}) {
  const parent = new Map();
  const directAliasByNumber = new Map();

  const find = alias => {
    if (!parent.has(alias)) parent.set(alias, alias);
    const currentParent = parent.get(alias);
    if (currentParent !== alias) parent.set(alias, find(currentParent));
    return parent.get(alias);
  };

  const union = (first, second) => {
    const firstRoot = find(first);
    const secondRoot = find(second);
    if (firstRoot !== secondRoot) parent.set(secondRoot, firstRoot);
  };

  const aliasesByMessage = messages.map(message => {
    const aliases = expandPersistedChatAliases(message, jidAliasCache);
    for (const alias of aliases) find(alias);
    for (let index = 1; index < aliases.length; index++) union(aliases[0], aliases[index]);

    for (const alias of aliases) {
      if (!messageDomain.isPnJid(alias) && !messageDomain.isLidJid(alias)) continue;
      const number = jidNumber(alias);
      const existingAlias = directAliasByNumber.get(number);
      if (existingAlias) union(existingAlias, alias);
      else directAliasByNumber.set(number, alias);
    }

    return aliases;
  });

  const componentAliases = new Map();
  for (const alias of parent.keys()) {
    const root = find(alias);
    if (!componentAliases.has(root)) componentAliases.set(root, []);
    componentAliases.get(root).push(alias);
  }

  return aliasesByMessage.map(aliases => {
    if (aliases.length === 0) return [];
    return uniqueJids(componentAliases.get(find(aliases[0])) || aliases);
  });
}

function buildMessageConversations(
  messages,
  contactsCache,
  ownerJid = '',
  ownerLid = '',
  ownerPushName = 'Você',
  jidAliasCache = {}
) {
  const normalizedMessages = (messages || [])
    .map(normalizeStoredMessage)
    .filter(message => !messageDomain.isStoredStatusMessage(message));
  const conversationAliases = buildConversationAliasComponents(normalizedMessages, jidAliasCache);
  const ownerJids = uniqueJids([
    ensureUserJid(String(ownerJid || ''), 's.whatsapp.net'),
    ensureUserJid(String(ownerLid || ''), 'lid')
  ]);
  const ownerSet = new Set(ownerJids);
  const corruptedOwnerConversation = normalizedMessages.some(message => (
    messageDomain.isAmbiguousOwnerMessage(message, ownerJids)
  ));
  const grouped = new Map();

  for (const [messageIndex, message] of normalizedMessages.entries()) {
    const aliases = conversationAliases[messageIndex];
    const isOwnerChat = aliases.some(alias => ownerSet.has(alias));
    const unresolved = corruptedOwnerConversation && isOwnerChat;
    const canonicalJid = unresolved
      ? 'unresolved-direct@lid'
      : (messageDomain.chooseCanonicalJid(aliases) || message.chatJid);
    if (!canonicalJid) continue;
    const groupKey = unresolved ? 'unresolved-direct' : canonicalJid;

    if (!grouped.has(groupKey)) {
      grouped.set(groupKey, {
        chatJid: canonicalJid,
        chatAliases: aliases,
        unresolved,
        messages: []
      });
    }

    const chat = grouped.get(groupKey);
    chat.chatAliases = uniqueJids([...chat.chatAliases, ...aliases]);
    chat.messages.push(unresolved && !message.fromMe
      ? { ...message, routingStatus: 'ambiguous-self', routingIssue: message.routingIssue || 'Interlocutor ausente nos dados de origem.' }
      : message);
  }

  return Array.from(grouped.values()).map(chat => {
    chat.messages.sort(compareMessagesChronologically);
    const isGroup = isGroupJid(chat.chatJid);
    const isOwnerChat = chat.chatAliases.some(alias => ownerSet.has(alias));
    const chatKey = chat.unresolved
      ? 'nao-identificada'
      : (jidNumber(chat.chatJid) || chat.chatJid);
    let displayName = '';

    if (chat.unresolved) {
      displayName = 'Conversa não identificada';
    } else if (isOwnerChat) {
      displayName = ownerPushName || 'Você';
    } else {
      displayName = bestNameFromAliases(chat.chatAliases, contactsCache) ||
        chat.messages.find(message => isValidConversationDisplayName(message.chatName))?.chatName || '';

      if (!displayName && !isGroup) {
        displayName = chat.messages.find(message => !message.fromMe && isValidConversationDisplayName(message.name))?.name || '';
      }
    }

    if (!displayName || isSelfNamePlaceholder(displayName) || displayName.includes('@')) {
      displayName = chatKey;
    }

    return {
      chatKey,
      chatJid: chat.chatJid,
      chatAliases: chat.chatAliases,
      isGroup,
      displayName,
      routingWarning: chat.unresolved
        ? 'O WhatsApp não informou o interlocutor desta conversa. Uma ressincronização profunda pode reparar os dados.'
        : '',
      messages: chat.messages
    };
  });
}

function createMessageDateTimeFormatter() {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
}

function formatMessagesAsText(conversations, contactsCache, activeInstance) {
  const dateTimeFormatter = createMessageDateTimeFormatter();
  return conversations.map(chat => {
    const chatMessagesText = chat.messages.map(message => {
      const dateTimeStr = dateTimeFormatter.format(new Date(message.timestamp)).replace(',', '');
      const senderName = resolveMessageSenderName(
        message,
        contactsCache,
        chat.isGroup,
        activeInstance?.myPushName,
        activeInstance?.myPushNameSource,
        activeInstance
      );
      const contextPrefix = formatMessageContextPrefixes(
        message,
        chat.messages,
        contactsCache,
        chat.isGroup,
        activeInstance
      );
      return `  [${dateTimeStr}] ${senderName}: ${contextPrefix}${message.text}`;
    }).join('\n');

    const routingWarning = chat.routingWarning ? `  [AVISO] ${chat.routingWarning}\n` : '';
    return `--- Conversa com: ${chat.displayName} (${chat.chatKey}) ---\n${routingWarning}${chatMessagesText}`;
  }).join('\n\n');
}

function escapeMarkdown(value) {
  return normalizeDisplayName(String(value ?? ''))
    .replace(/([\\`*_[\]{}()#+\-.!>])/g, '\\$1');
}

function formatDateLabel(dateStr) {
  const [year, month, day] = String(dateStr || '').split('-');
  return year && month && day ? `${day}/${month}/${year}` : dateStr;
}

function formatMessagesAsMarkdown(conversations, contactsCache, activeInstance, dateStr) {
  if (!conversations || conversations.length === 0) return '';

  const dateTimeFormatter = createMessageDateTimeFormatter();
  const lines = [`# Conversas de ${formatDateLabel(dateStr)}`];

  for (const chat of conversations) {
    lines.push('', `## ${escapeMarkdown(chat.displayName)}`, `_Identificador: \`${escapeMarkdown(chat.chatKey)}\`_`, '');
    if (chat.routingWarning) {
      lines.push(`> ${escapeMarkdown(chat.routingWarning)}`, '');
    }

    for (const message of chat.messages) {
      const dateTimeStr = dateTimeFormatter.format(new Date(message.timestamp)).replace(',', '');
      const senderName = resolveMessageSenderName(
        message,
        contactsCache,
        chat.isGroup,
        activeInstance?.myPushName,
        activeInstance?.myPushNameSource,
        activeInstance
      );
      const contextPrefix = formatMessageContextPrefixes(
        message,
        chat.messages,
        contactsCache,
        chat.isGroup,
        activeInstance,
        escapeMarkdown
      );
      lines.push(`- **${escapeMarkdown(dateTimeStr)}** · **${escapeMarkdown(senderName)}:** ${contextPrefix}${escapeMarkdown(message.text)}`);
    }
  }

  return lines.join('\n').trim();
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

function addContactRecordToCache(userId, instance, contact, source = 'sync', updateFiles = true) {
  if (!contact || !instance) return false;
  const baseAliases = contactAliasJids(contact);
  cacheJidAliasPair(instance, baseAliases);
  const aliases = uniqueJids([
    ...baseAliases,
    ...relatedAliasesFromCache(baseAliases, instance.contactsCache)
  ]);
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
    changed = addContactToCache(userId, instance, alias, name, source, updateFiles) || changed;
  }
  return changed;
}

function addGroupMetadataToCache(userId, instance, metadata, source = 'groupMetadata', updateFiles = true) {
  if (!metadata || !instance) return false;
  let changed = addContactToCache(userId, instance, metadata.id, metadata.subject, source, updateFiles);
  for (const participant of metadata.participants || []) {
    changed = addContactRecordToCache(userId, instance, participant, `${source}.participant`, updateFiles) || changed;
  }
  return changed;
}

async function persistContactsCacheNow(userId, instance) {
  if (!instance) return;
  await flushContactPersist(userId);
  saveContactsToFile(userId, instance.contactsCache || {});
}

async function processContactRecords(userId, instance, contacts, source = 'contacts.update', { updateFiles = true } = {}) {
  if (!instance || !Array.isArray(contacts) || contacts.length === 0) return 0;
  let changed = 0;
  for (const contact of contacts) {
    if (addContactRecordToCache(userId, instance, contact, source, updateFiles)) {
      changed++;
    }
  }
  if (changed > 0) {
    await persistContactsCacheNow(userId, instance);
    resetUserSyncTimer(userId);
  }
  return changed;
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
        await persistContactsCacheNow(userId, instance);
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
    await persistContactsCacheNow(userId, instance);
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
    if (name && !isSelfNamePlaceholder(name) && !looksLikeTechnicalName(name)) return name;
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

    if (!message.fromMe && shouldSuppressOwnerNameForIncomingAlias(aliases, name, instance)) {
      continue;
    }

    for (const alias of aliases) {
      if (addContactToCache(userId, instance, alias, name, source, false)) changed++;
    }
  }

  return changed;
}

function isRetainedDate(dateStr) {
  if (!messageDomain.isValidDate(dateStr)) return false;
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
    await persistContactsCacheNow(userId, instance);
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

  await restoreAuthStateSnapshot(userId, userAuthDir);

  // Restaura creds.json legado do Supabase se não existir localmente no container
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
  const expectsHistorySync = instance.forceHistorySync || Number(state.creds.accountSyncCounter || 0) === 0;
  // O Baileys pode emitir messaging-history.status antes de connection=open.
  // Inicialize o estado desta geração antes de registrar/receber esses eventos
  // para que a abertura da conexão não apague a confirmação RECENT 100%.
  initializeUserSyncState(instance, expectsHistorySync);
  if (state?.creds?.me) {
    instance.myJid = jidNumber(state.creds.me.id || '');
    instance.myLid = jidNumber(state.creds.me.lid || '');
  }

  if (instance.forceHistorySync) {
    const previousProcessedCount = Array.isArray(state.creds.processedHistoryMessages)
      ? state.creds.processedHistoryMessages.length
      : 0;
    state.creds.processedHistoryMessages = [];
    const clearedAppStateFiles = clearAuthStateFilesByPrefix(userAuthDir, ['app-state-sync-version']);
    instance.forceHistorySync = false;
    instance.requestAppStateResync = true;
    await saveCreds();
    try {
      if (fs.existsSync(credsFilePath)) {
        const credsData = JSON.parse(fs.readFileSync(credsFilePath, 'utf8'));
        await saveCredsToSupabase(userId, credsData);
      }
    } catch (err) {
      console.error(`[${userId}] Erro ao salvar credenciais apos force-history:`, err);
    }
    scheduleAuthStateSnapshot(userId, userAuthDir, 0);
    console.log(`[${userId}] force-history ativo: ${previousProcessedCount} marcadores de historico processado e ${clearedAppStateFiles} versoes de app-state foram limpos.`);
  }

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
    // O v7 mudou o comportamento deste filtro. Mantemos os tipos processáveis
    // oficiais e recusamos FULL, pois a aplicação retém somente a janela recente.
    shouldSyncHistoryMessage: ({ syncType }) => syncType !== proto.HistorySync.HistorySyncType.FULL,
    // Status/Stories não são conversas e não devem entrar no pipeline.
    shouldIgnoreJid: (jid) => messageDomain.isStatusBroadcastJid(jid),
    printQRInTerminal: false, // Desativado (evita avisos no log)
    logger: logger,
    browser: ['FollowUp Mônada', 'Chrome', '1.0'], // Customiza a exibição no celular do usuário
    markOnlineOnConnect: false, // Mantém as notificações push funcionando no celular do usuário
    keepAliveIntervalMs: 15000, // Envia pings de keep-alive para detectar conexões ociosas rapidamente
    connectTimeoutMs: 60000, // Tolera até 60 segundos para conexão inicial
    retryRequestDelayMs: 2000, // Dá 2 segundos de folga para a rede se estabilizar em retentativas falhas
    defaultQueryTimeoutMs: 60000, // Evita queries presas em background
    cachedGroupMetadata: async (jid) => {
      return instance.groupMetadataCache ? instance.groupMetadataCache[jid] : undefined;
    },
    getMessage: async (key) => {
      try {
        const dates = listLocalMessageFiles(userId).slice(-MESSAGE_RETENTION_DAYS).reverse();
        for (const dateStr of dates) {
          const filePath = path.join(dataDir, 'messages', userId, `messages-${dateStr}.json`);
          const rawData = fs.readFileSync(filePath, 'utf8');
          const messages = JSON.parse(rawData);
          const found = messages.find(m => m.id === key.id);
          if (found) return { conversation: found.text };
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
    scheduleAuthStateSnapshot(userId, userAuthDir);
  });

  // Monitora alterações na conexão
  sock.ev.on('connection.update', async (update) => {
    if (instance.connectionGeneration !== connectionGeneration) return;
    const { connection, lastDisconnect, qr, receivedPendingNotifications } = update;
    instance.lastConnectionEventAt = new Date().toISOString();
    if (receivedPendingNotifications) instance.pendingNotificationsObserved = true;

    if (qr) {
      clearUserSyncCompletionTimer(instance);
      instance.currentQr = qr;
      instance.connectionStatus = 'qrcode';
      instance.syncStatus = 'pending';
      instance.messagesProcessedCount = 0;
      console.log(`[${userId}] Novo QR Code gerado! Acesse /qr para escanear.`);
    }

    if (connection === 'close') {
      clearUserSyncCompletionTimer(instance);
      instance.currentQr = null;
      instance.syncStatus = 'pending';
      instance.messagesProcessedCount = 0;
      if (instance.intentionalLogout) {
        instance.connectionStatus = 'disconnected';
        return;
      }
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      instance.lastConnectionCloseAt = new Date().toISOString();
      instance.lastDisconnectCode = lastDisconnect?.error?.output?.statusCode || null;
      instance.lastDisconnectError = normalizeDisplayName(lastDisconnect?.error?.message || lastDisconnect?.error || '');
      console.log(`[${userId}] Conexão fechada devido a:`, lastDisconnect?.error || 'motivo desconhecido');
      
      if (shouldReconnect) {
        console.log(`[${userId}] Tentando reconectar em 5 segundos...`);
        instance.connectionStatus = 'connecting';
        if (instance.reconnectTimer) clearTimeout(instance.reconnectTimer);
        instance.reconnectTimer = setTimeout(() => {
          instance.reconnectTimer = null;
          connectUserWhatsApp(userId).catch(err => {
            console.error(`[${userId}] Falha na reconexao automatica:`, err.message || err);
          });
        }, 5000);
      } else {
        console.log(`[${userId}] Desconectado permanentemente (Sessão encerrada pelo celular). Excluindo credenciais...`);
        instance.connectionStatus = 'disconnected';
        
        // Exclui as credenciais permanentemente do banco de dados do Supabase
        await deleteCredsFromSupabase(userId);

        // Exclui todas as mensagens e contatos locais e do Supabase de forma permanente na desconexão
        await clearAllUserData(userId);
        
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
          connectUserWhatsApp(userId).catch(err => {
            console.error(`[${userId}] Falha ao reiniciar para novo QR Code:`, err.message || err);
          });
        }, 3000);
      }
    } else if (connection === 'open') {
      instance.currentQr = null;
      instance.connectionStatus = 'connected';
      markUserSyncConnected(instance, expectsHistorySync);
      instance.lastConnectionOpenAt = new Date().toISOString();
      instance.lastDisconnectCode = null;
      instance.lastDisconnectError = '';
      if (sock && sock.user) {
        instance.myJid = jidNumber(sock.user.id);
        instance.myLid = sock.user.lid ? jidNumber(sock.user.lid) : '';
      }
      if (instance.reconnectTimer) {
        clearTimeout(instance.reconnectTimer);
        instance.reconnectTimer = null;
      }
      
      // Captura o nome de perfil do próprio dono da conta para usar nas mensagens "fromMe"
      const whatsappOwnName = bestWhatsAppOwnName(sock);
      if (whatsappOwnName) {
        instance.myPushName = whatsappOwnName;
        instance.myPushNameSource = 'whatsapp';
        console.log(`[${userId}] Nome do dono da conta identificado: ${instance.myPushName}`);
      } else {
        ensureOwnerDisplayName(userId, instance).catch(err => {
          console.warn(`[${userId}] Falha ao carregar nome do dono da conta:`, err.message || err);
        });
      }

      console.log(`[${userId}] WhatsApp conectado com sucesso!`);
      resetUserSyncTimer(userId);
      resumeMediaProcessingForUser(userId);
      scheduleAuthStateSnapshot(userId, userAuthDir);
      if (instance.requestAppStateResync && typeof sock.resyncAppState === 'function') {
        instance.requestAppStateResync = false;
        sock.resyncAppState(WA_PATCH_NAMES, true)
          .then(() => {
            console.log(`[${userId}] App-state ressincronizado apos force-history.`);
            resetUserSyncTimer(userId);
            scheduleAuthStateSnapshot(userId, userAuthDir);
          })
          .catch(err => {
            console.warn(`[${userId}] Falha ao ressincronizar app-state apos force-history:`, err.message || err);
          });
      }
      hydrateContactsFromStoredMessages(userId, instance)
        .then(() => refreshGroupMetadataAliases(userId, instance))
        .catch(err => {
        console.warn(`[${userId}] Falha ao hidratar aliases de grupos apos conexao:`, err.message || err);
      });
      if (instance.pendingNotificationsObserved) {
        historySync.markPendingNotifications(instance.historySyncState);
        instance.pendingNotificationsObserved = false;
        scheduleUserSyncCompletion(userId);
      }
    }

    if (receivedPendingNotifications) {
      console.log(`[${userId}] Sincronização de notificações pendentes recebida.`);
      if (!instance.historySyncState || connection === 'open') {
        // connection=open pode chegar no mesmo update; o estado já foi
        // inicializado acima com a informação do accountSyncCounter.
        instance.historySyncState = instance.historySyncState || historySync.createHistorySyncState({ expectsHistory: expectsHistorySync });
      }
      resetUserSyncTimer(userId);
      if (instance.connectionStatus === 'connected') {
        historySync.markPendingNotifications(instance.historySyncState);
        instance.pendingNotificationsObserved = false;
        scheduleUserSyncCompletion(userId);
      }
    }
  });

  // Sincroniza metadados dos grupos e salva no cache para otimizar consultas e evitar rate-limit
  sock.ev.on('groups.upsert', async (groups) => {
    if (instance.connectionGeneration !== connectionGeneration) return;
    let changed = 0;
    for (const metadata of groups || []) {
      if (!metadata?.id || !instance.groupMetadataCache) continue;
      instance.groupMetadataCache[metadata.id] = metadata;
      if (addGroupMetadataToCache(userId, instance, metadata, 'groups.upsert', false)) changed++;
    }
    if (changed > 0) {
      await persistContactsCacheNow(userId, instance);
      resetUserSyncTimer(userId);
    }
  });

  sock.ev.on('groups.update', async ([event]) => {
    if (instance.connectionGeneration !== connectionGeneration) return;
    try {
      if (sock && event?.id && instance.groupMetadataCache) {
        const metadata = await sock.groupMetadata(event.id);
        instance.groupMetadataCache[event.id] = metadata;
        addGroupMetadataToCache(userId, instance, metadata, 'groups.update');
        await persistContactsCacheNow(userId, instance);
        resetUserSyncTimer(userId);
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
        await persistContactsCacheNow(userId, instance);
        resetUserSyncTimer(userId);
      }
    } catch (err) {
      console.warn(`[${userId}] Falha ao atualizar cache de grupo no group-participants.update:`, err.message);
    }
  });

  // Função auxiliar para processar e salvar um lote de mensagens
  async function processUserMessages(messagesList, { bulk = false } = {}) {
    if (instance.intentionalLogout) return;
    if (!messagesList || messagesList.length === 0) return;

    // Retém apenas uma janela configurável para limitar disco, memória e tempo de sincronização.
    const retentionThreshold = Date.now() - (MESSAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    let ignoredStatusCount = 0;
    const filteredList = messagesList.filter(msg => {
      if (!msg) return false;
      if (messageDomain.isStatusBroadcastMessage(msg)) {
        ignoredStatusCount++;
        return false;
      }
      return getMessageTimestampMs(msg) >= retentionThreshold;
    });

    if (ignoredStatusCount > 0) {
      instance.statusMessagesIgnored = (instance.statusMessagesIgnored || 0) + ignoredStatusCount;
      instance.lastStatusMessageIgnoredAt = new Date().toISOString();
      console.log(`[${userId}] ${ignoredStatusCount} atualização(ões) de status ignorada(s); nenhuma foi salva como conversa.`);
    }

    if (filteredList.length === 0) return;

    instance.messagesProcessedCount += filteredList.length;
    resetUserSyncTimer(userId);

    const messageObjects = [];
    const audioTranscriptionCandidates = [];
    const imageInterpretationCandidates = [];
    let failedMessageCount = 0;
    const needsOwnerName = filteredList.some(msg => msg?.key?.fromMe);
    const [ownerDisplayName, ownerJids] = await Promise.all([
      needsOwnerName ? ensureOwnerDisplayName(userId, instance) : Promise.resolve(''),
      expandJidAliases(messageDomain.ownerJidsFromInstance(instance), instance)
    ]);

    for (const msg of filteredList) {
      try {
        if (!msg.key || (!msg.key.remoteJid && !msg.key.remoteJidAlt)) continue;

        const route = await resolveIncomingMessageRoute(msg, instance, ownerJids);
        const chatJid = cleanJid(route.chatJid);
        
        // Mantém chats privados (PN ou LID) e grupos.
        if (!isSupportedChatJid(chatJid)) continue;

        const fromMe = route.fromMe;
        const isGroup = isGroupJid(chatJid);
        
        // Determina o remetente individual e todos os aliases conhecidos (LID + telefone).
        const participantJid = route.participantJid || (fromMe
          ? messageDomain.chooseCanonicalJid(messageDomain.ownerJidsFromInstance(instance))
          : chatJid);
        const directParticipantAliases = uniqueJids([participantJid, ...(route.participantAliases || [])]);
        const participantAliases = uniqueJids([
          ...directParticipantAliases,
          ...relatedAliasesFromCache(directParticipantAliases, instance.contactsCache)
        ]);
        
        let pushName = '';
        if (!fromMe) {
          const savedNameCandidate = bestNameFromAliases(participantAliases, instance.contactsCache);
          const savedName = shouldSuppressOwnerNameForIncomingAlias(participantAliases, savedNameCandidate, instance)
            ? ''
            : savedNameCandidate;
          const messagePushNameCandidate = normalizeDisplayName(msg.pushName);
          const messagePushName = shouldSuppressOwnerNameForIncomingAlias(participantAliases, messagePushNameCandidate, instance)
            ? ''
            : messagePushNameCandidate;
          pushName = savedName || messagePushName || jidNumber(participantJid);
          if (messagePushName) {
            for (const alias of participantAliases) {
              addContactToCache(userId, instance, alias, messagePushName, 'message.pushName', !bulk);
            }
          }
        } else {
          // Usa o nome real do dono do celular configurado no WhatsApp
          pushName = ownerDisplayName;
        }

        const chatAliases = uniqueJids([chatJid, ...(route.chatAliases || [])]);
        const chatName = bestNameFromAliases(chatAliases, instance.contactsCache) || (!isGroup && !fromMe ? pushName : '');
        if (!isGroup && !fromMe && pushName) {
          for (const alias of chatAliases) {
            addContactToCache(userId, instance, alias, pushName, 'message.chat', !bulk);
          }
        }

        if (route.routingStatus === 'ambiguous-self') {
          instance.ambiguousRoutingCount = (instance.ambiguousRoutingCount || 0) + 1;
          instance.lastAmbiguousRoutingAt = new Date().toISOString();
          console.warn(`[${userId}] Mensagem ${msg.key.id || 'sem-id'} com rota direta ambigua; preservada para reparo por ressincronizacao.`);
        }

        const mediaInfo = getMessageMediaInfo(msg);
        const text = getMessageText(msg);
        const contextMetadata = getMessageContextMetadata(msg, chatJid);

        // Ignora se não houver texto legível (ex: figurinhas, reações, chamadas de áudio)
        if (!text.trim()) continue;

        const timestamp = new Date(getMessageTimestampMs(msg));
        
        const messageObject = {
          id: msg.key.id,
          sender: jidNumber(chatJid),
          chatJid,
          chatAliases,
          chatName,
          participant: jidNumber(participantJid), // Identifica quem de fato enviou sem sufixo de dispositivo para compatibilidade retroativa
          participantJid,
          participantAliases,
          name: pushName,
          text: text,
          fromMe: fromMe,
          routingStatus: route.routingStatus,
          routingIssue: route.routingIssue,
          timestamp: timestamp.toISOString(),
          isForwarded: contextMetadata.isForwarded,
          quotedMessageId: contextMetadata.quotedMessageId,
          quotedMessageSender: contextMetadata.quotedMessageSender,
          quotedMessageText: contextMetadata.quotedMessageText
        };
        if (mediaInfo) {
          messageObject.mediaKind = mediaInfo.kind;
          if (mediaInfo.mimetype) messageObject.mediaMimetype = mediaInfo.mimetype;
          if (mediaInfo.seconds) messageObject.mediaSeconds = mediaInfo.seconds;
        }
        messageObject.dedupeKey = createDedupeKey(messageObject);

        messageObjects.push(messageObject);

        if (mediaInfo?.kind === 'audio') {
          audioTranscriptionCandidates.push({
            userId,
            instance,
            rawMessage: msg,
            messageObject,
            mimetype: mediaInfo.mimetype
          });
        }

        if (mediaInfo?.kind === 'image' || mediaInfo?.kind === 'sticker') {
          imageInterpretationCandidates.push({
            userId,
            instance,
            rawMessage: msg,
            messageObject,
            mimetype: mediaInfo.mimetype
          });
        }

      } catch (err) {
        failedMessageCount++;
        console.error(`[${userId}] Erro ao processar mensagem do lote:`, err);
      }
    }

    const savedMessages = saveUserMessagesBatch(userId, messageObjects);
    if (savedMessages.length > 0) {
      await persistMessagesToSupabase(userId, savedMessages);
      const newestSaved = savedMessages.reduce((newest, message) => {
        if (!newest) return message;
        return new Date(message.timestamp).getTime() > new Date(newest.timestamp).getTime() ? message : newest;
      }, null);
      if (newestSaved) {
        instance.lastStoredMessageAt = newestSaved.timestamp;
        instance.lastStoredMessageDate = messageDateStr(new Date(newestSaved.timestamp).getTime());
      }
      instance.lastStoredMessagesCount = (instance.lastStoredMessagesCount || 0) + savedMessages.length;
      console.log(`[${userId}] ${savedMessages.length} mensagens novas salvas. Ultima data: ${instance.lastStoredMessageDate || 'desconhecida'}.`);
    }

    if (audioTranscriptionCandidates.length > 0) {
      const savedKeys = new Set(savedMessages.map(message => message.dedupeKey || createDedupeKey(message)));
      queueAudioTranscriptions(audioTranscriptionCandidates.filter(candidate =>
        shouldQueueAudioTranscription(userId, candidate.messageObject, savedKeys)
      ));
    }

    if (imageInterpretationCandidates.length > 0) {
      const savedKeys = new Set(savedMessages.map(message => message.dedupeKey || createDedupeKey(message)));
      queueImageInterpretations(imageInterpretationCandidates.filter(candidate =>
        shouldQueueImageInterpretation(userId, candidate.messageObject, savedKeys)
      ));
    }

    if (bulk && failedMessageCount > 0) {
      throw new Error(`${failedMessageCount} mensagem(ns) do histórico falharam no processamento local.`);
    }
  }

  // Escuta novas mensagens (enviadas e recebidas em tempo real)
  sock.ev.on('messages.upsert', async (m) => {
    if (instance.connectionGeneration !== connectionGeneration) return;
    const batchCount = Array.isArray(m?.messages) ? m.messages.length : 0;
    instance.lastIncomingBatchAt = new Date().toISOString();
    instance.lastIncomingBatchType = m?.type || 'unknown';
    instance.lastIncomingBatchCount = batchCount;
    if (batchCount > 0) {
      console.log(`[${userId}] messages.upsert recebido: type=${instance.lastIncomingBatchType} count=${batchCount}`);
    }
    await processUserMessages(m?.messages || []);
    scheduleAuthStateSnapshot(userId, userAuthDir);
  });

  sock.ev.on('messages.update', async (updates) => {
    if (instance.connectionGeneration !== connectionGeneration) return;
    const editedMessages = (updates || [])
      .filter(item => item?.update?.message)
      .map(item => ({
        ...item.update,
        key: { ...item.key, ...(item.update.key || {}) }
      }));
    if (editedMessages.length > 0) {
      await processUserMessages(editedMessages);
      scheduleAuthStateSnapshot(userId, userAuthDir);
    }
  });

  sock.ev.on('contacts.upsert', async (contacts) => {
    if (instance.connectionGeneration !== connectionGeneration) return;
    const changed = await processContactRecords(userId, instance, contacts, 'contacts.upsert');
    if (changed > 0) {
      console.log(`[${userId}] Atualizados ${changed} contatos via contacts.upsert.`);
    }
  });

  sock.ev.on('contacts.update', async (contacts) => {
    if (instance.connectionGeneration !== connectionGeneration) return;
    const changed = await processContactRecords(userId, instance, contacts, 'contacts.update');
    if (changed > 0) {
      console.log(`[${userId}] Atualizados ${changed} contatos via contacts.update.`);
    }
  });

  // Evento oficial do Baileys 7 para manter o mapeamento LID <-> PN.
  sock.ev.on('lid-mapping.update', async ({ lid, pn }) => {
    if (instance.connectionGeneration !== connectionGeneration) return;
    if (!lid || !pn) return;
    cacheJidAliasPair(instance, [lid, pn]);
    const name = bestNameFromAliases([lid, pn], instance.contactsCache);
    if (name) {
      addContactToCache(userId, instance, lid, name, 'lid-mapping.update', false);
      addContactToCache(userId, instance, pn, name, 'lid-mapping.update', false);
      await persistContactsCacheNow(userId, instance);
    }
  });

  sock.ev.on('messaging-history.status', ({ syncType, status, explicit }) => {
    if (instance.connectionGeneration !== connectionGeneration) return;
    if (!instance.historySyncState) initializeUserSyncState(instance, true);

    historySync.applyHistoryStatus(instance.historySyncState, {
      isRecent: syncType === proto.HistorySync.HistorySyncType.RECENT,
      isInitialBootstrap: syncType === proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP,
      status,
      explicit
    });
    instance.lastSyncActivity = Date.now();

    if (status === 'paused') {
      clearUserSyncCompletionTimer(instance);
      instance.syncStatus = 'stalled';
      console.warn(`[${userId}] Histórico RECENT pausado pelo Baileys sem progresso 100; mantendo sincronização como pendente.`);
      return;
    }

    scheduleUserSyncCompletion(userId);
  });

  // Escuta o histórico de mensagens inicial enviado pelo WhatsApp na sincronização
  sock.ev.on('messaging-history.set', async ({ chats, contacts, messages, lidPnMappings, syncType, progress, isLatest, chunkOrder }) => {
    if (instance.connectionGeneration !== connectionGeneration) return;
    if (!instance.historySyncState) initializeUserSyncState(instance, true);
    clearUserSyncCompletionTimer(instance);
    historySync.beginHistoryBatch(instance.historySyncState);
    instance.syncStatus = 'syncing';

    const historyContacts = Array.isArray(contacts) ? contacts : [];
    const historyChats = Array.isArray(chats) ? chats : [];
    const historyMessages = Array.isArray(messages) ? messages : [];
    const historyLidMappings = Array.isArray(lidPnMappings) ? lidPnMappings : [];
    const profileNameContacts = historyContacts.filter(hasUsableProfileName).length;
    const retentionThreshold = Date.now() - (MESSAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const collected = historySync.collectHistoryMessages({
      messages: historyMessages,
      chats: historyChats,
      retentionThreshold,
      getTimestampMs: getMessageTimestampMs
    });

    instance.historySyncStats = {
      ...(instance.historySyncStats || {}),
      batches: (instance.historySyncStats?.batches || 0) + 1,
      contacts: (instance.historySyncStats?.contacts || 0) + historyContacts.length,
      pushNameContacts: (instance.historySyncStats?.pushNameContacts || 0) + profileNameContacts,
      lidPnMappings: (instance.historySyncStats?.lidPnMappings || 0) + historyLidMappings.length,
      messages: (instance.historySyncStats?.messages || 0) + collected.messages.length,
      filteredOut: (instance.historySyncStats?.filteredOut || 0) + collected.filteredOut,
      duplicatesSkipped: (instance.historySyncStats?.duplicatesSkipped || 0) + collected.duplicatesSkipped,
      lastSyncType: syncType ?? null,
      lastProgress: progress ?? null,
      lastIsLatest: isLatest ?? null,
      lastChunkOrder: chunkOrder ?? null,
      lastAt: new Date().toISOString()
    };

    console.log(
      `[${userId}] History sync: type=${syncType ?? 'unknown'} progress=${progress ?? 'unknown'} ` +
      `contacts=${historyContacts.length} profileNames=${profileNameContacts} chats=${historyChats.length} ` +
      `messages=${collected.messages.length} filtered=${collected.filteredOut} duplicates=${collected.duplicatesSkipped}`
    );

    try {
      // O evento lid-mapping.update ainda é WIP no v7 e pode não ser emitido;
      // o próprio lote de histórico é uma fonte oficial adicional do mapeamento.
      for (const mapping of historyLidMappings) {
        if (mapping?.lid && mapping?.pn) cacheJidAliasPair(instance, [mapping.lid, mapping.pn]);
      }

      // 0. Sincroniza a lista de contatos da agenda inicial do celular
      if (historyContacts.length > 0) {
        const changedContacts = await processContactRecords(userId, instance, historyContacts, 'history.contacts', { updateFiles: false });
        console.log(`[${userId}] Sincronizados ${historyContacts.length} contatos do histórico, incluindo ${profileNameContacts} nomes de perfil (${changedContacts} atualizados).`);
      }

      // 0.1. Sincroniza os nomes das conversas e grupos do histórico recente
      if (historyChats.length > 0) {
        let syncGroupNamesCount = 0;
        let changedChats = 0;
        for (const chat of historyChats) {
          if (addContactRecordToCache(userId, instance, chat, 'history.chats', false)) {
            changedChats++;
            if (chat.id?.endsWith('@g.us')) syncGroupNamesCount++;
          }
        }
        if (changedChats > 0) await persistContactsCacheNow(userId, instance);
        console.log(`[${userId}] Sincronizados ${historyChats.length} chats recentes, incluindo ${syncGroupNamesCount} nomes de grupos (${changedChats} atualizados).`);
      }

      // O v7 já fornece o array global. O fallback chat.messages é combinado
      // somente para snapshots antigos e deduplicado antes de uma única gravação.
      if (collected.messages.length > 0) await processUserMessages(collected.messages, { bulk: true });

      await persistContactsCacheNow(userId, instance);
      scheduleAuthStateSnapshot(userId, userAuthDir);
      console.log(`[${userId}] Lote de histórico finalizado. Total de mensagens únicas processadas: ${collected.messages.length}`);
    } catch (err) {
      instance.historySyncStats.lastError = err?.message || String(err);
      historySync.failHistoryBatch(instance.historySyncState, err);
      instance.syncStatus = 'stalled';
      console.error(`[${userId}] Falha ao processar lote do histórico:`, err);
    } finally {
      historySync.finishHistoryBatch(instance.historySyncState);
      resetUserSyncTimer(userId);
      scheduleUserSyncCompletion(userId);
    }
  });
}

// Extrai texto de diferentes tipos de mensagens do Baileys
function mediaText(tag, caption = '') {
  const cleanCaption = normalizeDisplayName(caption);
  return cleanCaption ? `[${tag}] ${cleanCaption}` : `[${tag}]`;
}

function getMessageMediaInfo(msg) {
  if (!msg.message) return null;
  const content = unwrapMessageContent(msg.message);

  if (content.imageMessage) {
    return {
      kind: 'image',
      text: mediaText('Imagem', content.imageMessage.caption),
      mimetype: content.imageMessage.mimetype || 'image/jpeg'
    };
  }

  if (content.videoMessage) {
    return {
      kind: 'video',
      text: mediaText('Vídeo', content.videoMessage.caption)
    };
  }

  if (content.audioMessage) {
    return {
      kind: 'audio',
      text: '[Áudio]',
      mimetype: content.audioMessage.mimetype || 'audio/ogg',
      seconds: content.audioMessage.seconds || null
    };
  }

  if (content.stickerMessage) {
    return {
      kind: 'sticker',
      text: '[Figurinha]',
      mimetype: content.stickerMessage.mimetype || 'image/webp'
    };
  }

  return null;
}

function getMessageText(msg) {
  if (!msg.message) return '';
  
  const content = unwrapMessageContent(msg.message);
  
  // Trata mensagem de texto simples
  if (content.conversation) return content.conversation;
  
  // Trata mensagem de texto formatada / respostas / links
  if (content.extendedTextMessage) return content.extendedTextMessage.text || '';

  const mediaInfo = getMessageMediaInfo(msg);
  if (mediaInfo) return mediaInfo.text;

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

function getMessageContextInfo(msg) {
  if (!msg?.message) return {};
  const content = unwrapMessageContent(msg.message);
  if (content.contextInfo && typeof content.contextInfo === 'object') return content.contextInfo;

  for (const value of Object.values(content)) {
    if (value?.contextInfo && typeof value.contextInfo === 'object') {
      return value.contextInfo;
    }
  }

  return {};
}

function normalizeContextParticipantJid(value) {
  if (!value || typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed.includes('@')) return cleanJid(trimmed);
  return ensureUserJid(trimmed, /^\d{14,}$/.test(trimmed) ? 'lid' : 's.whatsapp.net');
}

function getMessageContextMetadata(msg, chatJid = '') {
  const contextInfo = getMessageContextInfo(msg);
  const forwardingScore = Number(contextInfo.forwardingScore || 0);
  const quotedMessage = contextInfo.quotedMessage && typeof contextInfo.quotedMessage === 'object'
    ? contextInfo.quotedMessage
    : null;
  const quotedRemoteJid = normalizeContextParticipantJid(contextInfo.remoteJid || '');
  const quotedSender = normalizeContextParticipantJid(contextInfo.participant || '') ||
    (!isGroupJid(quotedRemoteJid) && !isGroupJid(chatJid) ? quotedRemoteJid : '');
  const quotedText = quotedMessage
    ? getMessageText({ message: quotedMessage })
    : '';

  return {
    isForwarded: Boolean(contextInfo.isForwarded) || forwardingScore > 0,
    quotedMessageId: normalizeDisplayName(contextInfo.stanzaId || ''),
    quotedMessageSender: quotedSender,
    quotedMessageText: normalizeDisplayName(quotedText)
  };
}

function unwrapMessageContent(content) {
  let current = content || {};
  const visited = new Set();

  while (current && typeof current === 'object' && !visited.has(current)) {
    visited.add(current);

    if (current.deviceSentMessage?.message) {
      current = current.deviceSentMessage.message;
      continue;
    }
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

    const messageIndexes = new Map(messages.map((message, index) => [
      messageDomain.messageIdentityKey(message),
      index
    ]));
    let changed = false;

    for (const messageObject of dateMessages) {
      const identityKey = messageDomain.messageIdentityKey(messageObject);
      const existingIndex = messageIndexes.get(identityKey);
      if (existingIndex !== undefined) {
        const mergedMessage = mergeMessages([messages[existingIndex]], [messageObject])[0];
        if (JSON.stringify(messages[existingIndex]) !== JSON.stringify(mergedMessage)) {
          messages[existingIndex] = mergedMessage;
          savedMessages.push(mergedMessage);
          changed = true;
        }
        continue;
      }

      messageObject.dedupeKey = createDedupeKey(messageObject);
      messageIndexes.set(identityKey, messages.length);
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
  if (instances[userId]?.intentionalLogout) return 0;
  if (!messages || messages.length === 0) return 0;

  const rows = messages.map(message => {
    const normalized = normalizeStoredMessage(message);
    return {
      user_id: userId,
      dedupe_key: normalized.dedupeKey,
      message_id: normalized.id,
      chat_jid: normalized.chatJid,
      chat_number: normalized.sender,
      chat_aliases: normalized.chatAliases || [],
      chat_name: normalized.chatName || null,
      participant_jid: normalized.participantJid,
      participant_number: normalized.participant,
      participant_aliases: normalized.participantAliases || [],
      display_name: normalized.name || null,
      text: normalized.text,
      from_me: normalized.fromMe,
      routing_status: normalized.routingStatus || 'legacy',
      routing_issue: normalized.routingIssue || null,
      is_forwarded: normalized.isForwarded,
      quoted_message_id: normalized.quotedMessageId || null,
      quoted_message_sender: normalized.quotedMessageSender || null,
      quoted_message_text: normalized.quotedMessageText || null,
      message_timestamp: normalized.timestamp,
      message_date: messageDateStr(new Date(normalized.timestamp).getTime()),
      updated_at: new Date().toISOString()
    };
  });

  let persisted = 0;
  for (const chunk of chunkArray(rows, 250)) {
    let response = await supabaseRest(
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
    if (!response) {
      const compatibleChunk = chunk.map(row => {
        const compatibleRow = { ...row };
        delete compatibleRow.chat_aliases;
        delete compatibleRow.routing_status;
        delete compatibleRow.routing_issue;
        return compatibleRow;
      });
      response = await supabaseRest(
        'whatsapp_messages',
        '?on_conflict=user_id,dedupe_key',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Prefer': 'resolution=merge-dupes,return=minimal'
          },
          body: JSON.stringify(compatibleChunk)
        }
      );
      if (response) {
        console.warn(`[${userId}] Mensagens persistidas sem metadados de aliases/roteamento. Execute a migracao mais recente.`);
      }
    }
    if (!response) {
      const legacyChunk = chunk.map(row => {
        const legacyRow = { ...row };
        delete legacyRow.chat_aliases;
        delete legacyRow.routing_status;
        delete legacyRow.routing_issue;
        delete legacyRow.is_forwarded;
        delete legacyRow.quoted_message_id;
        delete legacyRow.quoted_message_sender;
        delete legacyRow.quoted_message_text;
        return legacyRow;
      });
      response = await supabaseRest(
        'whatsapp_messages',
        '?on_conflict=user_id,dedupe_key',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Prefer': 'resolution=merge-dupes,return=minimal'
          },
          body: JSON.stringify(legacyChunk)
        }
      );
      if (response) {
        console.warn(`[${userId}] Mensagens persistidas no modo legado. Execute todas as migracoes do WhatsApp.`);
      }
    }
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
  const fallbackPromise = loadStateBlobFromSupabase(userId, 'messages', dateStr);
  const baseSelect = 'dedupe_key,message_id,chat_jid,chat_number,chat_name,participant_jid,participant_number,participant_aliases,display_name,text,from_me,message_timestamp';
  const contextSelect = `${baseSelect},is_forwarded,quoted_message_id,quoted_message_sender,quoted_message_text`;
  const routingSelect = `${contextSelect},chat_aliases,routing_status,routing_issue`;
  let response = await supabaseRest(
    'whatsapp_messages',
    `?user_id=eq.${supabaseEq(userId)}&message_date=eq.${supabaseEq(dateStr)}&select=${routingSelect}&order=message_timestamp.asc&limit=20000`
  );
  if (!response) {
    response = await supabaseRest(
      'whatsapp_messages',
      `?user_id=eq.${supabaseEq(userId)}&message_date=eq.${supabaseEq(dateStr)}&select=${contextSelect}&order=message_timestamp.asc&limit=20000`
    );
  }
  if (!response) {
    response = await supabaseRest(
      'whatsapp_messages',
      `?user_id=eq.${supabaseEq(userId)}&message_date=eq.${supabaseEq(dateStr)}&select=${baseSelect}&order=message_timestamp.asc&limit=20000`
    );
  }
  if (!response) {
    const fallbackSnapshot = await fallbackPromise;
    const fallbackMessages = Array.isArray(fallbackSnapshot) ? fallbackSnapshot.map(normalizeStoredMessage) : [];
    return fallbackMessages;
  }

  try {
    const fallbackSnapshot = await fallbackPromise;
    const fallbackMessages = Array.isArray(fallbackSnapshot) ? fallbackSnapshot.map(normalizeStoredMessage) : [];
    const rows = await response.json();
    const tableMessages = rows.map(row => normalizeStoredMessage({
      dedupe_key: row.dedupe_key,
      message_id: row.message_id,
      chat_jid: row.chat_jid,
      chat_number: row.chat_number,
      chat_aliases: row.chat_aliases,
      chat_name: row.chat_name,
      participant_jid: row.participant_jid,
      participant_number: row.participant_number,
      participant_aliases: row.participant_aliases,
      display_name: row.display_name,
      text: row.text,
      from_me: row.from_me,
      routing_status: row.routing_status,
      routing_issue: row.routing_issue,
      is_forwarded: row.is_forwarded,
      quoted_message_id: row.quoted_message_id,
      quoted_message_sender: row.quoted_message_sender,
      quoted_message_text: row.quoted_message_text,
      message_timestamp: row.message_timestamp
    }));
    const mergedMessages = mergeMessages(fallbackMessages, tableMessages);
    if (tableMessages.length < mergedMessages.length) {
      const backfillKey = `${userId}:${dateStr}`;
      if (!pendingMessageBackfills.has(backfillKey)) {
        const backfillPromise = persistMessagesToSupabase(userId, mergedMessages)
          .catch(err => console.warn(`[${userId}] Falha no backfill relacional de ${dateStr}:`, err.message || err))
          .finally(() => pendingMessageBackfills.delete(backfillKey));
        pendingMessageBackfills.set(backfillKey, backfillPromise);
      }
    }
    return mergedMessages;
  } catch (err) {
    console.warn(`[${userId}] Falha ao carregar mensagens do Supabase:`, err.message || err);
  }

  const fallbackSnapshot = await fallbackPromise;
  const fallbackMessages = Array.isArray(fallbackSnapshot) ? fallbackSnapshot.map(normalizeStoredMessage) : [];
  return fallbackMessages;
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

function clearUserSyncCompletionTimer(instance) {
  if (!instance?.syncTimer) return;
  clearTimeout(instance.syncTimer);
  instance.syncTimer = null;
}

function initializeUserSyncState(instance, expectsHistory) {
  clearUserSyncCompletionTimer(instance);
  instance.historySyncState = historySync.createHistorySyncState({ expectsHistory });
  instance.syncStatus = 'syncing';
  instance.lastSyncActivity = Date.now();
  instance.syncCompletedAt = null;
}

function markUserSyncConnected(instance, expectsHistory, now = Date.now()) {
  if (!instance.historySyncState) {
    initializeUserSyncState(instance, expectsHistory);
  }
  instance.syncStatus = 'syncing';
  instance.lastSyncActivity = now;
  instance.syncCompletedAt = null;
}

function scheduleUserSyncCompletion(userId) {
  const instance = instances[userId];
  if (!instance?.historySyncState || instance.connectionStatus !== 'connected') return;

  clearUserSyncCompletionTimer(instance);
  if (!historySync.canFinalizeHistorySync(instance.historySyncState)) {
    if (instance.historySyncState.paused) instance.syncStatus = 'stalled';
    return;
  }

  instance.syncTimer = setTimeout(() => {
    instance.syncTimer = null;
    if (instance.connectionStatus !== 'connected') return;
    if (!historySync.finalizeHistorySync(instance.historySyncState)) return;
    instance.syncStatus = 'completed';
    instance.syncCompletedAt = new Date(instance.historySyncState.completedAt).toISOString();
    console.log(`[${userId}] Sincronização concluída por sinal explícito do Baileys e drenagem dos lotes locais.`);
  }, HISTORY_SYNC_SETTLE_MS);
}

// Registra atividade sem inferir que o histórico terminou. No Baileys 7, a
// conclusão vem de messaging-history.status (RECENT com progresso 100).
function resetUserSyncTimer(userId) {
  const instance = instances[userId];
  if (!instance) return;

  instance.lastSyncActivity = Date.now();
  if (instance.syncTimer) scheduleUserSyncCompletion(userId);
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
  const storedOwnerName = loadOwnerNameFromFile(cleanUserId);
  
  const instanceState = {
    sock: null,
    currentQr: null,
    connectionStatus: 'connecting',
    syncStatus: 'pending',
    transcribeAudioSetting: true, // padrao ativado
    interpretImagesSetting: false, // padrao desativado,
    messagesProcessedCount: 0,
    contactsCache: hydratedContactsCache,
    jidAliasCache: {},
    jidAliasMissCache: {},
    groupMetadataCache: {}, // Cache de metadados dos grupos para otimização e evitar rate-limit do WhatsApp
    myPushName: storedOwnerName, // Nome de perfil do próprio usuário dono do WhatsApp
    myPushNameSource: storedOwnerName ? 'profile-hint' : 'fallback',
    lastSyncActivity: Date.now(),
    syncTimer: null,
    syncCompletedAt: null,
    historySyncState: historySync.createHistorySyncState({ expectsHistory: true }),
    contactsSaveTimer: null,
    reconnectTimer: null,
    pendingNotificationsObserved: false,
    lastConnectionEventAt: null,
    lastConnectionOpenAt: null,
    lastConnectionCloseAt: null,
    lastDisconnectCode: null,
    lastDisconnectError: '',
    connectionGeneration: 0,
    forceHistorySync: false,
    requestAppStateResync: false,
    intentionalLogout: false,
    lastIncomingBatchAt: null,
    lastIncomingBatchType: null,
    lastIncomingBatchCount: 0,
    lastStoredMessageAt: null,
    lastStoredMessageDate: null,
    lastStoredMessagesCount: 0,
    ambiguousRoutingCount: 0,
    statusMessagesIgnored: 0,
    lastStatusMessageIgnoredAt: null,
    lastAmbiguousRoutingAt: null,
    lastRecoveryAttemptAt: null,
    lastRecoveryMode: null,
    lastRecoveryRequestedDate: null,
    authStateFilesBackedUp: 0,
    lastAuthStateBackupAt: null,
    authStateFilesRestored: 0,
    lastAuthStateRestoreAt: null,
    transcriptionRunning: false,
    transcriptionCompleted: 0,
    transcriptionFailed: 0,
    transcriptionTotal: 0,
    transcriptionLastError: '',
    imageInterpretationRunning: false,
    imageInterpretationCompleted: 0,
    imageInterpretationFailed: 0,
    imageInterpretationTotal: 0,
    imageInterpretationLastError: '',
    lastStoredMessageContactHydration: 0,
    historySyncStats: {
      batches: 0,
      contacts: 0,
      pushNameContacts: 0,
      messages: 0,
      lastSyncType: null,
      lastProgress: null,
      lastAt: null
    }
  };

  instances[cleanUserId] = instanceState;
  if (Object.keys(hydratedContactsCache).length > 0) {
    saveContactsToFile(cleanUserId, hydratedContactsCache);
  }
  await loadMediaProcessingState(cleanUserId, instanceState);

  // Busca as configuracoes e o nome do usuario no Supabase profiles
  try {
    const profile = await loadProfileDataFromSupabase(cleanUserId);
    if (profile) {
      const profileName = profile.name || (profile.email ? profile.email.split('@')[0] : null);
      if (profileName) {
        instanceState.myPushName = profileName;
        instanceState.myPushNameSource = 'profile';
        console.log(`[${cleanUserId}] Nome do perfil do Supabase carregado: ${profileName}`);
      }
      instanceState.transcribeAudioSetting = profile.transcribe_audio !== false;
      instanceState.interpretImagesSetting = !!profile.interpret_images;
      console.log(`[${cleanUserId}] Configurações de mídia do Supabase carregadas: transcribeAudio=${instanceState.transcribeAudioSetting}, interpretImages=${instanceState.interpretImagesSetting}`);
    }
  } catch (err) {
    console.warn(`[${cleanUserId}] Erro ao carregar dados do perfil no Supabase:`, err.message || err);
  }
  
  // Inicia o processo de conexão do Baileys assincronamente
  connectUserWhatsApp(cleanUserId).catch(err => {
    instanceState.connectionStatus = 'disconnected';
    console.error(`[${cleanUserId}] Falha ao iniciar WhatsApp:`, err.message || err);
  });

  return instanceState;
}

const configuredCorsOrigins = new Set(
  String(process.env.WHATSAPP_ALLOWED_ORIGINS || '')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean)
);

function isAllowedCorsOrigin(origin) {
  if (!origin) return true;
  if (configuredCorsOrigins.has(origin)) return true;
  try {
    const url = new URL(origin);
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  } catch {
    return false;
  }
}

// O app em produção usa o proxy do Next.js; CORS direto fica restrito ao desenvolvimento local.
app.use((req, res, next) => {
  res.header('Cache-Control', 'no-store');
  res.header('Referrer-Policy', 'no-referrer');
  res.header('X-Content-Type-Options', 'nosniff');
  res.header('X-Frame-Options', 'DENY');
  const origin = req.headers.origin;
  if (!isAllowedCorsOrigin(origin)) {
    return res.status(403).json({ error: 'Origem nao permitida.' });
  }
  if (origin) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Vary', 'Origin');
  }
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, x-api-key, x-owner-name');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.get('/healthz', (req, res) => {
  res.json({
    ok: true,
    service: 'whatsapp-service',
    uptimeSeconds: Math.floor(process.uptime()),
    generatedAt: new Date().toISOString()
  });
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

// Autenticacao entre o proxy Next.js e o microsservico.
// O segredo nunca trafega: cada chamada usa HMAC, timestamp, nonce e hash do corpo.
const SERVICE_SECRET = process.env.WHATSAPP_SERVICE_SECRET || '';
const SERVICE_AUTH_VERSION = 'v1';
const SERVICE_AUTH_MAX_AGE_MS = 60_000;
const seenServiceNonces = new Map();
const failedAuthWindows = new Map();
const FAILED_AUTH_WINDOW_MS = 60_000;
const FAILED_AUTH_LIMIT = 30;

function headerString(req, name) {
  const value = req.headers[name];
  return typeof value === 'string' ? value : '';
}

function requestBodyHash(req) {
  return nodeCrypto.createHash('sha256').update(req.rawBody || Buffer.alloc(0)).digest('hex');
}

function serviceCanonicalRequest({ timestamp, nonce, userId, method, pathAndQuery, bodyHash }) {
  return [
    SERVICE_AUTH_VERSION,
    String(timestamp),
    nonce,
    userId,
    String(method).toUpperCase(),
    pathAndQuery,
    bodyHash
  ].join('\n');
}

function secureHexEqual(left, right) {
  if (!/^[0-9a-f]{64}$/i.test(left) || !/^[0-9a-f]{64}$/i.test(right)) return false;
  return nodeCrypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function consumeServiceNonce(nonce, now) {
  for (const [storedNonce, expiresAt] of seenServiceNonces) {
    if (expiresAt <= now) seenServiceNonces.delete(storedNonce);
  }
  if (seenServiceNonces.has(nonce)) return false;
  seenServiceNonces.set(nonce, now + SERVICE_AUTH_MAX_AGE_MS);
  return true;
}

function checkAuth(req, res, next) {
  if (SERVICE_SECRET.length < 32) return denyAccess(req, res);

  const userId = headerString(req, 'x-api-key');
  const timestampText = headerString(req, 'x-service-timestamp');
  const nonce = headerString(req, 'x-service-nonce');
  const suppliedBodyHash = headerString(req, 'x-service-body-sha256');
  const suppliedSignature = headerString(req, 'x-service-signature');
  const timestamp = Number(timestampText);
  const now = Date.now();

  if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/.test(userId)) {
    return denyAccess(req, res);
  }
  if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > SERVICE_AUTH_MAX_AGE_MS) {
    return denyAccess(req, res);
  }
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) {
    return denyAccess(req, res);
  }

  const bodyHash = requestBodyHash(req);
  if (!secureHexEqual(suppliedBodyHash, bodyHash)) {
    return denyAccess(req, res);
  }

  const canonicalRequest = serviceCanonicalRequest({
    timestamp,
    nonce,
    userId,
    method: req.method,
    pathAndQuery: req.originalUrl,
    bodyHash
  });
  const expectedSignature = nodeCrypto.createHmac('sha256', SERVICE_SECRET)
    .update(canonicalRequest, 'utf8')
    .digest('hex');

  if (!secureHexEqual(suppliedSignature, expectedSignature) || !consumeServiceNonce(nonce, now)) {
    return denyAccess(req, res);
  }

  req.authUserId = userId;
  next();
}

function readAuthenticatedUserId(req) {
  return req.authUserId || '';
}

function denyAccess(req, res) {
  const key = String(req.ip || req.socket?.remoteAddress || 'unknown');
  const now = Date.now();
  const current = failedAuthWindows.get(key);
  const windowState = !current || current.resetAt <= now
    ? { count: 1, resetAt: now + FAILED_AUTH_WINDOW_MS }
    : { count: current.count + 1, resetAt: current.resetAt };
  failedAuthWindows.set(key, windowState);

  if (windowState.count > FAILED_AUTH_LIMIT) {
    res.set('Retry-After', String(Math.max(1, Math.ceil((windowState.resetAt - now) / 1000))));
    return res.status(429).json({ error: 'Muitas tentativas de autenticacao.' });
  }
  return res.status(401).json({ error: 'Nao autorizado.' });
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

async function loadMergedMessagesForDate(userId, dateStr) {
  // Versões anteriores podiam resolver status@broadcast pelo participante e
  // salvá-lo com aparência de conversa direta. O alias original permaneceu no
  // registro e permite ocultá-lo com segurança sem afetar mensagens diretas.
  const localMessages = readLocalMessagesForDate(userId, dateStr)
    .filter(message => !messageDomain.isStoredStatusMessage(message));
  const remoteMessages = (await loadMessagesFromSupabase(userId, dateStr))
    .filter(message => !messageDomain.isStoredStatusMessage(message));
  return {
    localMessages,
    remoteMessages,
    messages: mergeMessages(localMessages, remoteMessages)
  };
}

async function waitForMessagesForDate(userId, dateStr, timeoutMs) {
  const startedAt = Date.now();
  let snapshot = await loadMergedMessagesForDate(userId, dateStr);

  while (snapshot.messages.length === 0 && Date.now() - startedAt < timeoutMs) {
    await sleep(RESYNC_POLL_INTERVAL_MS);
    snapshot = await loadMergedMessagesForDate(userId, dateStr);
  }

  return {
    found: snapshot.messages.length > 0,
    waitedMs: Date.now() - startedAt,
    localCount: snapshot.localMessages.length,
    remoteCount: snapshot.remoteMessages.length,
    mergedCount: snapshot.messages.length,
    firstTimestamp: snapshot.messages[0]?.timestamp || null,
    lastTimestamp: snapshot.messages[snapshot.messages.length - 1]?.timestamp || null
  };
}

function listLocalMessageFiles(userId) {
  const userMsgDir = path.join(dataDir, 'messages', userId);
  if (!fs.existsSync(userMsgDir)) return [];
  return fs.readdirSync(userMsgDir)
    .filter(file => file.startsWith('messages-') && file.endsWith('.json'))
    .map(file => file.replace('messages-', '').replace('.json', ''))
    .sort();
}

function analyzeMessagesIntegrity(messages, contactsCache, ownerJids = []) {
  const seen = new Set();
  let duplicateKeys = 0;
  let outOfOrder = 0;
  let missingChatNames = 0;
  let missingSenderNames = 0;
  let missingHumanSenderNames = 0;
  let ambiguousRoutes = 0;
  let invalidTimestamps = 0;
  let unsupportedChatJids = 0;
  let missingChatAliases = 0;
  let previousTime = 0;

  for (const raw of messages) {
    const message = normalizeStoredMessage(raw);
    const key = message.dedupeKey || createDedupeKey(message);
    if (seen.has(key)) duplicateKeys++;
    seen.add(key);

    const currentTime = new Date(message.timestamp).getTime();
    if (!Number.isFinite(currentTime)) {
      invalidTimestamps++;
    } else {
      if (previousTime && currentTime < previousTime) outOfOrder++;
      previousTime = currentTime;
    }

    if (!isSupportedChatJid(message.chatJid)) unsupportedChatJids++;
    if (!message.chatAliases || message.chatAliases.length === 0) missingChatAliases++;
    if (messageDomain.isAmbiguousOwnerMessage(message, ownerJids)) ambiguousRoutes++;

    const chatName = contactsCache[message.chatJid] || message.chatName;
    if (!chatName || looksLikeTechnicalName(chatName)) missingChatNames++;

    if (!message.fromMe) {
      const aliases = [message.participantJid, ...(message.participantAliases || [])];
      const participantName = bestNameFromAliases(aliases, contactsCache) || message.name;
      const hasHumanName = participantName && !looksLikeTechnicalName(participantName);
      const phoneFallback = phoneFallbackFromAliases(aliases, contactsCache);
      if (!hasHumanName) missingHumanSenderNames++;
      if (!hasHumanName && !phoneFallback) missingSenderNames++;
    }
  }

  return {
    total: messages.length,
    unique: seen.size,
    duplicateKeys,
    outOfOrder,
    missingChatNames,
    missingSenderNames,
    missingHumanSenderNames,
    ambiguousRoutes,
    invalidTimestamps,
    unsupportedChatJids,
    missingChatAliases,
    firstTimestamp: messages[0]?.timestamp || null,
    lastTimestamp: messages[messages.length - 1]?.timestamp || null,
    ok: duplicateKeys === 0 && outOfOrder === 0 && ambiguousRoutes === 0 && invalidTimestamps === 0 && unsupportedChatJids === 0
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
  const ownerJids = instance ? messageDomain.ownerJidsFromInstance(instance) : [];
  const dateStats = [];

  for (const date of dates) {
    const { localMessages, remoteMessages, messages: mergedMessages } = await loadMergedMessagesForDate(userId, date);
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
      persistenceDivergence: Math.abs(localMessages.length - remoteMessages.length),
      integrity: analyzeMessagesIntegrity(mergedMessages, contacts, ownerJids)
    });
  }

  return {
    status: instance ? instance.connectionStatus : 'not_initialized',
    syncStatus: instance ? instance.syncStatus : 'not_initialized',
    messagesProcessedInSession: instance ? instance.messagesProcessedCount : 0,
    contactsCount: Object.keys(contacts).length,
    historySyncStats: instance ? (instance.historySyncStats || null) : null,
    retentionDays: MESSAGE_RETENTION_DAYS,
    persistence: {
      supabaseConfigured: !!getSupabaseConfig(),
      disabledTables: Array.from(supabaseDisabledTables.keys()),
      tableRetryMs: SUPABASE_TABLE_RETRY_MS,
      usingServiceRole: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
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
  const userId = readAuthenticatedUserId(req);
  if (!userId) {
    return res.status(400).json({ error: 'Identificação de usuário necessária.' });
  }

  const cleanUserId = userId.replace(/[^a-zA-Z0-9-_]/g, '');
  const mode = String(req.query.mode || 'soft');
  if (req.query.date && !messageDomain.isValidDate(req.query.date)) {
    return res.status(400).json({ error: 'Data invalida. Use o formato YYYY-MM-DD.' });
  }
  const dateStr = messageDomain.isValidDate(req.query.date) ? String(req.query.date) : null;
  let clearedMessageFiles = 0;
  let clearedContacts = false;
  const forcedHistory = mode === 'force-history';
  const shouldWait = ['1', 'true', 'yes'].includes(String(req.query.wait || '').toLowerCase());
  const requestedWaitMs = parseInt(String(req.query.waitMs || ''), 10);
  const defaultWaitMs = forcedHistory ? FORCE_HISTORY_WAIT_TIMEOUT_MS : RESYNC_WAIT_TIMEOUT_MS;
  const waitTimeoutMs = Math.min(90000, Math.max(0, Number.isFinite(requestedWaitMs) ? requestedWaitMs : defaultWaitMs));

  let instance = instances[cleanUserId] || await getOrCreateInstance(cleanUserId);
  console.log(`[${cleanUserId}] Ressincronizacao solicitada: mode=${mode} date=${dateStr || 'sem-data'} wait=${shouldWait ? waitTimeoutMs : 0}ms`);

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
    instance.lastRecoveryAttemptAt = new Date().toISOString();
    instance.lastRecoveryMode = mode;
    instance.lastRecoveryRequestedDate = dateStr;
    instance.historySyncStats = {
      batches: 0,
      contacts: 0,
      pushNameContacts: 0,
      messages: 0,
      lastSyncType: null,
      lastProgress: null,
      lastAt: null
    };
    if (forcedHistory) {
      instance.forceHistorySync = true;
    }
    resetUserSyncTimer(cleanUserId);
    saveContactsToFile(cleanUserId, contacts);
    connectUserWhatsApp(cleanUserId).catch(err => {
      instance.connectionStatus = 'disconnected';
      console.error(`[${cleanUserId}] Falha ao reiniciar durante ressincronizacao:`, err.message || err);
    });
  }

  const waitResult = shouldWait && dateStr
    ? await waitForMessagesForDate(cleanUserId, dateStr, waitTimeoutMs)
    : null;
  const diagnostics = await buildDiagnostics(cleanUserId, dateStr || undefined);
  return res.json({
    ok: true,
    mode,
    forcedHistory,
    clearedMessageFiles,
    clearedContacts,
    restarted: !!instance,
    waitResult,
    diagnostics
  });
}

// --- ROTAS DO SERVIDOR HTTP ---

// O painel HTML legado dependia de credenciais na URL. Toda operacao agora passa
// exclusivamente pelo proxy autenticado do Next.js.
app.get(['/', '/qr'], (_req, res) => {
  res.status(404).json({ error: 'Use o painel autenticado do FollowUp Monada.' });
});

// Rota principal (Home/Dashboard simples) - protegida
app.get('/', checkAuth, async (req, res) => {
  const userId = readAuthenticatedUserId(req);
  const instance = await getOrCreateInstance(userId);
  
  const connStatus = instance ? instance.connectionStatus : 'disconnected';
  const syncStatusVal = instance ? instance.syncStatus : 'pending';
  
  const queryParam = '';
  const todayVal = messageDomain.dateInTimeZone();
  res.send(`
    <html>
      <head>
        <meta charset="utf-8">
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
          .markdown-output { display: none; flex-direction: column; gap: 0.85rem; background: #0f172a; border: 1px solid #334155; border-radius: 8px; padding: 1rem; overflow: auto; max-height: 520px; }
          .md-title { margin: 0 0 0.25rem 0; font-size: 1.05rem; color: #f8fafc; }
          .md-chat { border: 1px solid #334155; border-radius: 8px; background: #111827; overflow: hidden; }
          .md-chat-header { padding: 0.85rem 1rem; border-bottom: 1px solid #334155; background: #1e293b; }
          .md-chat-name { margin: 0; color: #e5e7eb; font-size: 0.98rem; }
          .md-chat-meta { margin: 0.3rem 0 0 0; color: #94a3b8; font-size: 0.75rem; }
          .md-message { display: grid; grid-template-columns: 120px 170px minmax(0, 1fr); gap: 0.75rem; padding: 0.7rem 1rem; border-bottom: 1px solid rgba(51, 65, 85, 0.65); align-items: start; }
          .md-message:last-child { border-bottom: 0; }
          .md-time { color: #93c5fd; font-size: 0.78rem; font-variant-numeric: tabular-nums; }
          .md-sender { color: #fbbf24; font-weight: 700; font-size: 0.82rem; }
          .md-text { color: #dbeafe; font-size: 0.86rem; line-height: 1.45; word-break: break-word; }
          .md-note { color: #94a3b8; font-size: 0.85rem; }
          .md-media { display: inline-flex; align-items: center; padding: 0.12rem 0.45rem; border-radius: 999px; background: rgba(16, 185, 129, 0.15); color: #34d399; font-weight: 700; }
          @media (max-width: 720px) { .md-message { grid-template-columns: 1fr; gap: 0.25rem; } }
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
            <div id="outputMarkdown" class="markdown-output"></div>
          </div>
        </div>

        <script>
          // Define a data de hoje no input de data por padrão
          const dateInput = document.getElementById('msgDate');
          const today = '${todayVal}';
          dateInput.value = today;

          // Elementos de Status de Sincronização
          const connStatusBadge = document.getElementById('connStatusBadge');
          const syncStatusBadge = document.getElementById('syncStatusBadge');
          const syncProgressContainer = document.getElementById('syncProgressContainer');
          const syncProgressText = document.getElementById('syncProgressText');
          const syncProgressPercent = document.getElementById('syncProgressPercent');
          const syncProgressBarFill = document.getElementById('syncProgressBarFill');
          const logoutLink = document.getElementById('logoutLink');
          const rawOutput = document.getElementById('output');
          const markdownOutput = document.getElementById('outputMarkdown');

          function unescapeMarkdownText(value) {
            return String(value || '')
              .replace(/\\\\([\\\\*_[\\]{}()#+\\-.!>])/g, '$1')
              .replace(new RegExp(String.fromCharCode(96), 'g'), '');
          }

          function showRawOutput(text) {
            markdownOutput.style.display = 'none';
            markdownOutput.replaceChildren();
            rawOutput.style.display = 'block';
            rawOutput.textContent = text;
          }

          function appendTextWithMediaTag(parent, text) {
            const cleanText = unescapeMarkdownText(text);
            if (!cleanText.startsWith('[')) {
              parent.textContent = cleanText;
              return;
            }

            const closeIndex = cleanText.indexOf(']');
            if (closeIndex <= 0) {
              parent.textContent = cleanText;
              return;
            }

            const tag = document.createElement('span');
            tag.className = 'md-media';
            tag.textContent = cleanText.slice(0, closeIndex + 1);
            parent.appendChild(tag);
            parent.appendChild(document.createTextNode(cleanText.slice(closeIndex + 1)));
          }

          function showMarkdownOutput(markdown) {
            rawOutput.style.display = 'none';
            rawOutput.textContent = '';
            markdownOutput.style.display = 'flex';
            markdownOutput.replaceChildren();

            const lines = String(markdown || '').split(/\\r?\\n/);
            let title = '';
            const sections = [];
            let current = null;

            const messageRegex = /^- \\*\\*(.*?)\\*\\*([^\\*]*?)\\*\\*(.*?)(?::\\*\\*|\\*\\*:) (.*)$/;

            for (const rawLine of lines) {
              const line = rawLine.trim();
              if (!line) continue;

              if (line.startsWith('# ')) {
                title = unescapeMarkdownText(line.slice(2));
                continue;
              }

              if (line.startsWith('## ')) {
                current = {
                  title: unescapeMarkdownText(line.slice(3)),
                  meta: '',
                  messages: [],
                  notes: []
                };
                sections.push(current);
                continue;
              }

              if (line.startsWith('_Identificador:') && current) {
                current.meta = unescapeMarkdownText(line.replace(/^_Identificador:\\s*/, '').replace(/_$/, ''));
                continue;
              }

              const messageMatch = line.match(messageRegex);
              if (messageMatch && current) {
                current.messages.push({
                  time: unescapeMarkdownText(messageMatch[1]),
                  sender: unescapeMarkdownText(messageMatch[3]),
                  text: unescapeMarkdownText(messageMatch[4])
                });
                continue;
              }

              if (current) {
                current.notes.push(unescapeMarkdownText(line));
              }
            }

            // Filtra seções válidas (que têm título e possuem mensagens ou notas)
            const validSections = sections.filter(s => {
              const hasContent = s.messages.length > 0 || s.notes.length > 0;
              const hasValidTitle = s.title && s.title.trim() !== '' && s.title !== 'undefined';
              return hasContent && hasValidTitle;
            });

            if (title) {
              const titleEl = document.createElement('h2');
              titleEl.className = 'md-title';
              titleEl.textContent = title;
              markdownOutput.appendChild(titleEl);
            }

            for (const section of validSections) {
              const chatSection = document.createElement('section');
              chatSection.className = 'md-chat';
              
              const header = document.createElement('div');
              header.className = 'md-chat-header';
              
              const nameEl = document.createElement('h3');
              nameEl.className = 'md-chat-name';
              nameEl.textContent = section.title;
              header.appendChild(nameEl);

              if (section.meta) {
                const metaEl = document.createElement('p');
                metaEl.className = 'md-chat-meta';
                metaEl.textContent = section.meta;
                header.appendChild(metaEl);
              }

              chatSection.appendChild(header);
              
              const body = document.createElement('div');
              
              for (const msg of section.messages) {
                const row = document.createElement('div');
                row.className = 'md-message';
                
                const timeEl = document.createElement('span');
                timeEl.className = 'md-time';
                timeEl.textContent = msg.time;
                
                const senderEl = document.createElement('span');
                senderEl.className = 'md-sender';
                senderEl.textContent = msg.sender;
                
                const textEl = document.createElement('span');
                textEl.className = 'md-text';
                appendTextWithMediaTag(textEl, msg.text);
                
                row.appendChild(timeEl);
                row.appendChild(senderEl);
                row.appendChild(textEl);
                body.appendChild(row);
              }

              for (const note of section.notes) {
                const noteEl = document.createElement('p');
                noteEl.className = 'md-note';
                noteEl.textContent = note;
                body.appendChild(noteEl);
              }

              chatSection.appendChild(body);
              markdownOutput.appendChild(chatSection);
            }

            if (!markdownOutput.childElementCount) {
              showRawOutput('Nenhuma mensagem registrada para esta data.');
            }
          }

          // Função para desconectar a sessão do WhatsApp
          async function handleLogout(e) {
            e.preventDefault();
            if (!confirm('Deseja realmente encerrar a sessão do WhatsApp? Você precisará ler um QR Code novamente para reconectar.')) return;
            
            try {
              const response = await fetch('/logout' + window.location.search);
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
              const response = await fetch('/status' + window.location.search);
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
                  const serverProgress = Number(data.historySyncStats && data.historySyncStats.lastProgress);
                  const percent = Number.isFinite(serverProgress)
                    ? Math.min(99, Math.max(0, Math.floor(serverProgress)))
                    : Math.min(95, Math.floor(100 * (1 - Math.exp(-count / 150))));
                  
                  syncProgressText.textContent = 'Sincronizando histórico... (' + count + ' mensagens importadas)';
                  syncProgressPercent.textContent = percent + '%';
                  syncProgressBarFill.style.width = percent + '%';
                  
                } else if (data.syncStatus === 'stalled') {
                  syncStatusBadge.textContent = '⏸ SINCRONIZAÇÃO PAUSADA';
                  syncStatusBadge.style.background = 'rgba(245, 158, 11, 0.15)';
                  syncStatusBadge.style.color = '#f59e0b';
                  syncStatusBadge.style.border = '1px solid rgba(245, 158, 11, 0.3)';
                  syncProgressText.textContent = 'O WhatsApp pausou o histórico antes de confirmar 100%.';
                  syncProgressPercent.textContent = String(data.historySyncStats?.lastProgress ?? '—') + '%';
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

            showRawOutput('Buscando mensagens no servidor...');
            label.textContent = 'Mensagens do dia: ' + date.split('-').reverse().join('/');

            try {
              const response = await fetch('/messages' + window.location.search + '&date=' + date + '&format=' + format);
              
              if (!response.ok) {
                if (response.status === 401) {
                  showRawOutput('Erro 401: Acesso Não Autorizado.');
                  return;
                }
                throw new Error('Erro do servidor: ' + response.status);
              }

              if (format === 'json') {
                const data = await response.json();
                showRawOutput(JSON.stringify(data, null, 2));
              } else {
                const text = await response.text();
                if (format === 'markdown') {
                  if (text.trim()) {
                    showMarkdownOutput(text);
                  } else {
                    showRawOutput('Nenhuma mensagem registrada para esta data.');
                  }
                } else {
                  showRawOutput(text.trim() ? text : 'Nenhuma mensagem registrada para esta data.');
                }
              }
            } catch (err) {
              showRawOutput('Erro ao buscar mensagens: ' + err.message);
            }
          });

          // Função para buscar e renderizar contatos sincronizados
          document.getElementById('btnContacts').addEventListener('click', async () => {
            const output = document.getElementById('output');
            const label = document.getElementById('viewerLabel');
            
            showRawOutput('Buscando contatos sincronizados...');
            label.textContent = 'Contatos e Grupos Sincronizados:';

            try {
              // Obtém a API Key da URL para autenticação
              const urlParams = new URLSearchParams(window.location.search);
              const key = urlParams.get('key') || '';
              const keyParam = key ? '?key=' + key : '';

              const response = await fetch('/contacts' + window.location.search);
              if (!response.ok) {
                if (response.status === 401) {
                  showRawOutput('Erro 401: Acesso Não Autorizado.');
                  return;
                }
                throw new Error('Erro do servidor: ' + response.status);
              }

              const data = await response.json();
              if (data.count === 0) {
                showRawOutput('Nenhum contato ou grupo sincronizado na memória deste servidor ainda.');
                return;
              }

              let text = 'Total de Contatos/Chats Sincronizados: ' + data.count + '\\n\\n';
              const sorted = Object.entries(data.contacts).sort((a, b) => a[1].localeCompare(b[1]));
              
              sorted.forEach(([jid, name]) => {
                const number = jid.split('@')[0];
                const type = jid.endsWith('@g.us') ? 'GRUPO' : 'CONTATO';
                text += '• [' + type + '] ' + name + ' (' + number + ')\\n';
              });

              showRawOutput(text);
            } catch (err) {
              showRawOutput('Erro ao buscar contatos: ' + err.message);
            }
          });

          // Função para verificar integridade de mensagens, nomes e ordenação
          document.getElementById('btnDiagnostics').addEventListener('click', async () => {
            const date = dateInput.value;
            const output = document.getElementById('output');
            const label = document.getElementById('viewerLabel');
            showRawOutput('Verificando integridade dos dados...');
            label.textContent = 'Diagnóstico de Integridade:';

            try {
              const response = await fetch('/diagnostics' + window.location.search + '&date=' + date);
              if (!response.ok) throw new Error('Erro do servidor: ' + response.status);
              const data = await response.json();
              showRawOutput(JSON.stringify(data, null, 2));
            } catch (err) {
              showRawOutput('Erro ao verificar integridade: ' + err.message);
            }
          });

          // Reinicia o socket e reidrata os caches sem desconectar o WhatsApp do celular
          document.getElementById('btnResync').addEventListener('click', async () => {
            const date = dateInput.value;
            const output = document.getElementById('output');
            const label = document.getElementById('viewerLabel');
            if (!confirm('Ressincronizar o cache local sem apagar credenciais nem desconectar o celular?')) return;
            showRawOutput('Ressincronizando cache local e reiniciando o socket...');
            label.textContent = 'Ressincronização:';

            try {
              const response = await fetch('/maintenance/resync' + window.location.search + '&mode=soft&date=' + date);
              if (!response.ok) throw new Error('Erro do servidor: ' + response.status);
              const data = await response.json();
              showRawOutput(JSON.stringify(data, null, 2));
              updateSyncStatus();
            } catch (err) {
              showRawOutput('Erro ao ressincronizar: ' + err.message);
            }
          });
        </script>
      </body>
    </html>
  `);
});

// Retorna o status da conexão em JSON
app.get('/status', checkAuth, async (req, res) => {
  const userId = readAuthenticatedUserId(req);
  const instance = await getOrCreateInstance(userId);
  if (!instance) {
    return res.status(400).json({ error: 'Identificação de usuário necessária.' });
  }
  const cleanUserId = userId.replace(/[^a-zA-Z0-9-_]/g, '');
  applyOwnerNameHint(cleanUserId, instance, readOwnerNameHint(req));
  const ownerDisplayName = await ensureOwnerDisplayName(cleanUserId, instance);

  res.json({
    status: instance.connectionStatus,
    connected: instance.connectionStatus === 'connected',
    qrAvailable: !!instance.currentQr,
    syncStatus: instance.syncStatus,
    messagesCount: instance.messagesProcessedCount,
    contactsCount: Object.keys(instance.contactsCache || {}).length,
    historySyncStats: instance.historySyncStats || null,
    historySyncState: instance.historySyncState ? {
      expectsHistory: instance.historySyncState.expectsHistory,
      pendingNotificationsReceived: instance.historySyncState.pendingNotificationsReceived,
      pendingBatches: instance.historySyncState.pendingBatches,
      explicitRecentComplete: instance.historySyncState.explicitRecentComplete,
      finalBatchObservedAfterCompletion: instance.historySyncState.finalBatchObservedAfterCompletion,
      initialBootstrapComplete: instance.historySyncState.initialBootstrapComplete,
      paused: instance.historySyncState.paused,
      processingFailed: instance.historySyncState.processingFailed,
      lastProcessingError: instance.historySyncState.lastProcessingError,
      completionSource: instance.historySyncState.completionSource,
      completedAt: instance.syncCompletedAt
    } : null,
    lastSyncActivity: instance.lastSyncActivity ? new Date(instance.lastSyncActivity).toISOString() : null,
    lastConnectionEventAt: instance.lastConnectionEventAt || null,
    lastConnectionOpenAt: instance.lastConnectionOpenAt || null,
    lastConnectionCloseAt: instance.lastConnectionCloseAt || null,
    lastDisconnectCode: instance.lastDisconnectCode || null,
    lastDisconnectError: instance.lastDisconnectError || null,
    lastIncomingBatchAt: instance.lastIncomingBatchAt || null,
    lastIncomingBatchType: instance.lastIncomingBatchType || null,
    lastIncomingBatchCount: instance.lastIncomingBatchCount || 0,
    lastStoredMessageAt: instance.lastStoredMessageAt || null,
    lastStoredMessageDate: instance.lastStoredMessageDate || null,
    lastStoredMessagesCount: instance.lastStoredMessagesCount || 0,
    ambiguousRoutingCount: instance.ambiguousRoutingCount || 0,
    lastAmbiguousRoutingAt: instance.lastAmbiguousRoutingAt || null,
    statusMessagesIgnored: instance.statusMessagesIgnored || 0,
    lastStatusMessageIgnoredAt: instance.lastStatusMessageIgnoredAt || null,
    lastRecoveryAttemptAt: instance.lastRecoveryAttemptAt || null,
    lastRecoveryMode: instance.lastRecoveryMode || null,
    lastRecoveryRequestedDate: instance.lastRecoveryRequestedDate || null,
    authStateFilesBackedUp: instance.authStateFilesBackedUp || 0,
    lastAuthStateBackupAt: instance.lastAuthStateBackupAt || null,
    authStateFilesRestored: instance.authStateFilesRestored || 0,
    lastAuthStateRestoreAt: instance.lastAuthStateRestoreAt || null,
    retentionDays: MESSAGE_RETENTION_DAYS,
    persistence: {
      supabaseConfigured: !!getSupabaseConfig(),
      disabledTables: Array.from(supabaseDisabledTables.keys()),
      tableRetryMs: SUPABASE_TABLE_RETRY_MS,
      usingServiceRole: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
      fallbackSnapshots: true
    },
    audioTranscription: {
      configured: !!getAudioTranscriptionConfig() || !!process.env.GEMINI_API_KEY,
      queueLength: audioTranscriptionQueue.filter(x => x.userId === cleanUserId).length,
      retrying: countScheduledRetriesForUser(audioTranscriptionQueue, cleanUserId),
      nextRetryInMs: nextRetryInMsForUser(audioTranscriptionQueue, cleanUserId, audioTranscriptionBackoffUntil),
      pauseInMs: queuePauseInMs(audioTranscriptionBackoffUntil),
      maxAttempts: MEDIA_PROCESSING_MAX_ATTEMPTS,
      longTermQueueLength: countLongTermItemsForUser(audioTranscriptionQueue, cleanUserId),
      longTermNextRetryInMs: nextLongTermRetryInMsForUser(audioTranscriptionQueue, cleanUserId),
      longTermRetryStepMs: MEDIA_LONG_TERM_RETRY_STEP_MS,
      longTermRetryMaxMs: MEDIA_LONG_TERM_RETRY_MAX_MS,
      running: !!instance.transcriptionRunning,
      completed: instance.transcriptionCompleted || 0,
      failed: instance.transcriptionFailed || 0,
      total: instance.transcriptionTotal || 0,
      lastError: instance.transcriptionLastError || null
    },
    imageInterpretation: {
      configured: !!getImageInterpretationConfig() || !!process.env.GEMINI_API_KEY,
      compressorAvailable: !!sharp,
      queueLength: imageInterpretationQueue.filter(x => x.userId === cleanUserId).length,
      retrying: countScheduledRetriesForUser(imageInterpretationQueue, cleanUserId),
      nextRetryInMs: nextRetryInMsForUser(imageInterpretationQueue, cleanUserId, imageInterpretationBackoffUntil),
      pauseInMs: queuePauseInMs(imageInterpretationBackoffUntil),
      maxAttempts: MEDIA_PROCESSING_MAX_ATTEMPTS,
      longTermQueueLength: countLongTermItemsForUser(imageInterpretationQueue, cleanUserId),
      longTermNextRetryInMs: nextLongTermRetryInMsForUser(imageInterpretationQueue, cleanUserId),
      longTermRetryStepMs: MEDIA_LONG_TERM_RETRY_STEP_MS,
      longTermRetryMaxMs: MEDIA_LONG_TERM_RETRY_MAX_MS,
      running: !!instance.imageInterpretationRunning,
      completed: instance.imageInterpretationCompleted || 0,
      failed: instance.imageInterpretationFailed || 0,
      total: instance.imageInterpretationTotal || 0,
      lastError: instance.imageInterpretationLastError || null
    },
    user: instance.sock && instance.sock.user ? {
      id: instance.sock.user.id,
      name: instance.sock.user.name || instance.sock.user.id.split('@')[0].split(':')[0]
    } : null,
    ownerDisplayName,
    ownerDisplayNameSource: instance.myPushNameSource || 'fallback',
    settings: {
      transcribeAudio: instance.transcribeAudioSetting !== false,
      interpretImages: !!instance.interpretImagesSetting
    }
  });
});

// Atualiza as configurações de processamento de mídia (áudio e imagem) do usuário em memória
app.post('/settings', checkAuth, async (req, res) => {
  const userId = readAuthenticatedUserId(req);
  const cleanUserId = userId.replace(/[^a-zA-Z0-9-_]/g, '');
  const { transcribe_audio, interpret_images } = req.body;
  if (transcribe_audio === undefined && interpret_images === undefined) {
    return res.status(400).json({ error: 'Informe ao menos uma configuracao.' });
  }
  if (transcribe_audio !== undefined && typeof transcribe_audio !== 'boolean') {
    return res.status(400).json({ error: 'transcribe_audio deve ser booleano.' });
  }
  if (interpret_images !== undefined && typeof interpret_images !== 'boolean') {
    return res.status(400).json({ error: 'interpret_images deve ser booleano.' });
  }
  const instance = await getOrCreateInstance(cleanUserId);
  if (!instance) {
    return res.status(400).json({ error: 'Instância não encontrada.' });
  }
  if (transcribe_audio !== undefined) instance.transcribeAudioSetting = !!transcribe_audio;
  if (interpret_images !== undefined) instance.interpretImagesSetting = !!interpret_images;

  res.json({
    success: true,
    settings: {
      transcribeAudio: instance.transcribeAudioSetting !== false,
      interpretImages: !!instance.interpretImagesSetting
    }
  });
});

// Retorna a lista de contatos sincronizados em JSON
app.get('/contacts', checkAuth, async (req, res) => {
  const userId = readAuthenticatedUserId(req);
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

// Busca diagnostica pontual no cache de contatos sem despejar a lista completa
app.get('/diagnostics/contact-lookup', checkAuth, async (req, res) => {
  const userId = readAuthenticatedUserId(req);
  if (!userId) {
    return res.status(400).json({ error: 'Identificacao de usuario necessaria.' });
  }

  const cleanUserId = userId.replace(/[^a-zA-Z0-9-_]/g, '');
  const term = normalizeDisplayName(String(req.query.term || req.query.q || ''));
  if (!term) {
    return res.status(400).json({ error: 'Informe o termo em ?term=.' });
  }

  const instance = instances[cleanUserId];
  const contacts = mergeContactCaches(
    loadContactsFromFile(cleanUserId),
    await loadContactsFromSupabase(cleanUserId),
    instance ? instance.contactsCache : {}
  );
  const loweredTerm = term.toLowerCase();
  const matches = Object.entries(contacts)
    .filter(([jid, name]) => jid.toLowerCase().includes(loweredTerm) || String(name).toLowerCase().includes(loweredTerm))
    .sort(([jidA], [jidB]) => jidA.localeCompare(jidB))
    .slice(0, 200)
    .map(([jid, name]) => ({
      jid,
      name,
      technicalName: looksLikeTechnicalName(name)
    }));

  res.json({
    term,
    count: matches.length,
    truncated: matches.length === 200,
    matches
  });
});

// Diagnostico de integridade para dar confianca sobre ordem, duplicidade e nomes
app.get('/diagnostics', checkAuth, async (req, res) => {
  const userId = readAuthenticatedUserId(req);
  if (!userId) {
    return res.status(400).json({ error: 'Identificação de usuário necessária.' });
  }

  const cleanUserId = userId.replace(/[^a-zA-Z0-9-_]/g, '');
  const dateQuery = req.query.date;
  const dateStr = messageDomain.isValidDate(dateQuery) ? String(dateQuery) : undefined;
  const diagnostics = await buildDiagnostics(cleanUserId, dateStr);
  res.json(diagnostics);
});

// Diagnostico pontual de aliases de participantes de um grupo
app.get('/diagnostics/group-aliases', checkAuth, async (req, res) => {
  const userId = readAuthenticatedUserId(req);
  if (!userId) {
    return res.status(400).json({ error: 'Identificacao de usuario necessaria.' });
  }

  const cleanUserId = userId.replace(/[^a-zA-Z0-9-_]/g, '');
  const groupParam = cleanJid(String(req.query.group || ''));
  const includeRaw = ['1', 'true', 'yes'].includes(String(req.query.raw || '').toLowerCase());
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
      const output = {
        id: participant.id || '',
        jid: participant.jid || '',
        lid: participant.lid || '',
        aliases,
        nameFields: contactNameFields(participant),
        name: bestNameFromAliases(aliases, contacts) || null
      };
      if (includeRaw) {
        output.raw = diagnosticsShallowObject(participant);
      }
      return output;
    })
  });
});

// Ressincronizacao leve sem apagar credenciais nem exigir novo QR Code
app.post('/maintenance/resync', checkAuth, handleMaintenanceResync);

// Retorna o QR Code em base64 ou status da conexão em JSON para modais
app.get('/qr-code', checkAuth, async (req, res) => {
  const userId = readAuthenticatedUserId(req);
  const instance = await getOrCreateInstance(userId);
  if (!instance) {
    return res.status(400).json({ error: 'Identificação de usuário necessária.' });
  }
  applyOwnerNameHint(userId.replace(/[^a-zA-Z0-9-_]/g, ''), instance, readOwnerNameHint(req));

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
  const userId = readAuthenticatedUserId(req);
  const instance = await getOrCreateInstance(userId);
  if (!instance) {
    return res.status(400).send('Erro: Identificação do usuário inválida.');
  }
  applyOwnerNameHint(userId.replace(/[^a-zA-Z0-9-_]/g, ''), instance, readOwnerNameHint(req));

  const keyParam = '';

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
  const userId = readAuthenticatedUserId(req);
  if (!userId) {
    return res.status(400).json({ error: 'Identificação de usuário necessária.' });
  }

  const cleanUserId = userId.replace(/[^a-zA-Z0-9-_]/g, '');
  const dateQuery = req.query.date;
  if (dateQuery && !messageDomain.isValidDate(dateQuery)) {
    return res.status(400).json({ error: 'Data invalida. Use o formato YYYY-MM-DD.' });
  }
  const dateStr = messageDomain.isValidDate(dateQuery)
    ? String(dateQuery)
    : messageDomain.dateInTimeZone();

  const userMsgDir = path.join(dataDir, 'messages', cleanUserId);
  const filePath = path.join(userMsgDir, `messages-${dateStr}.json`);

  try {
    const { localMessages, remoteMessages, messages } = await loadMergedMessagesForDate(cleanUserId, dateStr);
    let activeInstance = instances[cleanUserId] || await getOrCreateInstance(cleanUserId);
    let contactsCache = mergeContactCaches(
      loadContactsFromFile(cleanUserId),
      await loadContactsFromSupabase(cleanUserId),
      activeInstance ? (activeInstance.contactsCache || {}) : {}
    );
    if (activeInstance) {
      applyOwnerNameHint(cleanUserId, activeInstance, readOwnerNameHint(req));
      activeInstance.contactsCache = contactsCache;
      await ensureOwnerDisplayName(cleanUserId, activeInstance);
      await hydrateContactsFromStoredMessages(cleanUserId, activeInstance, messages, dateStr);
      if (activeInstance.connectionStatus === 'connected') {
        const groupJids = uniqueJids(messages.map(m => m.chatJid)).filter(isGroupJid);
        if (groupJids.length > 0) {
          await refreshGroupMetadataAliases(cleanUserId, activeInstance, groupJids);
        }
      }
      contactsCache = mergeContactCaches(contactsCache, activeInstance.contactsCache || {});
    }

    const localSnapshot = mergeMessages(localMessages, []);
    const mergedSnapshotChanged = JSON.stringify(localSnapshot) !== JSON.stringify(messages);
    if (messages.length > 0 && (!fs.existsSync(filePath) || mergedSnapshotChanged)) {
      fs.mkdirSync(userMsgDir, { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(messages, null, JSON_INDENT), 'utf8');
    }
    
    // Sempre ordena cronologicamente por timestamp (crescente: do mais antigo ao mais recente)
    messages.sort(compareMessagesChronologically);

    const requestedFormat = String(req.query.format || '').toLowerCase();
    const ownJid = activeInstance?.myJid || (activeInstance?.sock?.user?.id ? jidNumber(activeInstance.sock.user.id) : '');
    const ownLid = activeInstance?.myLid || (activeInstance?.sock?.user?.lid ? jidNumber(activeInstance.sock.user.lid) : '');
    const ownName = activeInstance?.myPushName || 'Você';

    if (requestedFormat === 'json_grouped') {
      const conversations = buildMessageConversations(
        messages,
        contactsCache,
        ownJid,
        ownLid,
        ownName,
        activeInstance?.jidAliasCache
      );
      const formattedConversations = conversations.map(chat => {
        return {
          chatKey: chat.chatKey,
          chatJid: chat.chatJid,
          chatAliases: chat.chatAliases,
          isGroup: chat.isGroup,
          displayName: chat.displayName,
          routingWarning: chat.routingWarning || '',
          messages: chat.messages.map(m => {
            const senderName = resolveMessageSenderName(
              m,
              contactsCache,
              chat.isGroup,
              activeInstance?.myPushName,
              activeInstance?.myPushNameSource,
              activeInstance
            );
            const quoted = resolveQuotedMessageDetails(
              m,
              chat.messages,
              contactsCache,
              chat.isGroup,
              activeInstance
            );
            return {
              id: m.id,
              sender: m.sender,
              senderName: senderName,
              text: m.text || '',
              fromMe: !!m.fromMe,
              timestamp: m.timestamp,
              isForwarded: !!m.isForwarded,
              quotedMessageId: quoted.id || '',
              quotedMessageSender: quoted.senderName || '',
              quotedMessageSenderJid: quoted.senderJid || '',
              quotedMessageText: quoted.text || ''
            };
          })
        };
      });
      return res.json({
        date: dateStr,
        count: messages.length,
        unresolvedConversations: formattedConversations.filter(chat => chat.routingWarning).length,
        conversations: formattedConversations
      });
    }

    if (requestedFormat === 'text' || requestedFormat === 'markdown' || requestedFormat === 'md') {
      const conversations = buildMessageConversations(
        messages,
        contactsCache,
        ownJid,
        ownLid,
        ownName,
        activeInstance?.jidAliasCache
      );

      if (requestedFormat === 'markdown' || requestedFormat === 'md') {
        res.type('text/markdown');
        return res.send(formatMessagesAsMarkdown(conversations, contactsCache, activeInstance, dateStr));
      }

      return res.send(formatMessagesAsText(conversations, contactsCache, activeInstance));
    }

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

      const resolvedChats = [];

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
        
        // 3. Se ainda assim não achar, ou se for o JID puro, ou se for placeholder, define fallbacks
        if (!displayName || isSelfNamePlaceholder(displayName) || displayName.includes('@')) {
          displayName = chatKey;
        }

        resolvedChats.push({
          chatKey,
          chatJid: chat.chatJid,
          isGroup,
          displayName,
          messages: chat.messages
        });
      }

      // Unifica conversas que possuem o mesmo displayName válido (evita separar LID de JID telefônico)
      const unifiedGrouped = {};
      const isValidDisplayName = (name) => {
        if (!name) return false;
        if (isSelfNamePlaceholder(name)) return false;
        if (name.includes('@')) return false;
        if (/^[0-9+\s\-()]+$/.test(name)) return false; // Se for puramente número de telefone, não é nome válido
        return true;
      };

      resolvedChats.forEach(chat => {
        const isNameValid = isValidDisplayName(chat.displayName);
        const unifiedKey = isNameValid ? chat.displayName.trim().toLowerCase() : chat.chatKey;

        if (!unifiedGrouped[unifiedKey]) {
          unifiedGrouped[unifiedKey] = {
            displayName: chat.displayName,
            chatKey: chat.chatKey,
            chatJid: chat.chatJid,
            isGroup: chat.isGroup,
            messages: [...chat.messages]
          };
        } else {
          // Se já existe e a chave atual for JID telefônico (não-LID, mais curto), preferimos o JID telefônico
          const currentIsLid = chat.chatKey.length > 15;
          const existingIsLid = unifiedGrouped[unifiedKey].chatKey.length > 15;
          if (existingIsLid && !currentIsLid) {
            unifiedGrouped[unifiedKey].chatKey = chat.chatKey;
            unifiedGrouped[unifiedKey].chatJid = chat.chatJid;
          }
          unifiedGrouped[unifiedKey].messages.push(...chat.messages);
        }
      });

      for (const key in unifiedGrouped) {
        const chat = unifiedGrouped[key];
        
        // Reordena cronologicamente após unificar as mensagens
        chat.messages.sort(compareMessagesChronologically);

        const chatMessagesText = chat.messages.map(m => {
          const dateTimeStr = dateTimeFormatter.format(new Date(m.timestamp)).replace(',', '');
          const senderName = resolveMessageSenderName(
            m,
            contactsCache,
            chat.isGroup,
            activeInstance?.myPushName,
            activeInstance?.myPushNameSource,
            activeInstance
          );
          return `  [${dateTimeStr}] ${senderName}: ${m.text}`;
        }).join('\n');
        
        formattedChats.push(`--- Conversa com: ${chat.displayName} (${chat.chatKey}) ---\n${chatMessagesText}`);
      }

      const textResult = formattedChats.join('\n\n');
      return res.send(textResult);
    }

    res.json({ date: dateStr, count: messages.length, messages });
  } catch (e) {
    console.error('Erro detalhado na rota /messages:', e);
    res.status(500).json({ error: 'Erro ao ler banco de mensagens local.', details: e.message || String(e) });
  }
});

// Limpa todos os logs/snapshots de mensagens do usuário, localmente e no Supabase.
app.post('/clear-logs', checkAuth, async (req, res) => {
  const userId = readAuthenticatedUserId(req);
  if (!userId) {
    return res.status(400).send('Identificação de usuário necessária.');
  }

  const cleanUserId = userId.replace(/[^a-zA-Z0-9-_]/g, '');

  try {
    const result = await clearUserMessagesData(cleanUserId);
    res.send(
      `Sucesso: limpeza de mensagens concluída. ` +
      `Arquivos locais apagados: ${result.localFiles}. ` +
      `Supabase mensagens: ${result.supabaseMessagesStatus || 'não configurado'}. ` +
      `Snapshots: ${result.snapshotStatuses.map(item => `${item.pattern}=${item.status}`).join(', ') || 'nenhum'}.`
    );
  } catch (err) {
    res.status(500).send('Erro ao limpar logs de mensagens: ' + err.message);
  }
});

// Desconecta a sessão do WhatsApp no servidor e zera as credenciais locais do usuário
app.post('/logout', checkAuth, async (req, res) => {
  const userId = readAuthenticatedUserId(req);
  if (!userId) {
    return res.status(400).send('Identificação de usuário necessária.');
  }

  const cleanUserId = userId.replace(/[^a-zA-Z0-9-_]/g, '');
  const instance = instances[cleanUserId];

  try {
    console.log(`Recebida solicitação de logout do WhatsApp para usuário: ${cleanUserId}...`);
    
    if (instance && instance.sock) {
      instance.intentionalLogout = true;
      if (instance.reconnectTimer) {
        clearTimeout(instance.reconnectTimer);
        instance.reconnectTimer = null;
      }
      try {
        await instance.sock.logout();
      } catch (e) {
        console.log(`Erro ao enviar logout no socket para ${cleanUserId}:`, e);
      }
      try {
        instance.sock.end();
      } catch (e) {}
    }

    // Apaga credenciais, mensagens e caches persistidos, mantendo os resumos salvos.
    await deleteCredsFromSupabase(cleanUserId);
    await clearAllUserData(cleanUserId);

    // Apaga fisicamente a pasta de chaves de autenticação do usuário
    const userAuthDir = path.join(dataDir, 'auth', cleanUserId);
    fs.rmSync(userAuthDir, { recursive: true, force: true });
    fs.mkdirSync(userAuthDir, { recursive: true });

    // Limpa a instância do dicionário de memória
    if (instances[cleanUserId]) {
      delete instances[cleanUserId];
    }

    res.send('Sessão do WhatsApp desconectada e logs apagados com sucesso para o usuário.');
  } catch (err) {
    res.status(500).send('Erro ao encerrar sessão: ' + err.message);
  }
});

// Reconecta automaticamente todas as sessões ativas do WhatsApp no boot
async function autoReconnectAllUsers() {
  console.log('Iniciando reconexão automática das sessões de WhatsApp salvas no Supabase...');
  try {
    const response = await supabaseRest('whatsapp_sessions', '?select=id');
    if (!response) {
      console.log('Supabase não configurado ou inativo. Pulando reconexão automática.');
      return;
    }
    const rows = await response.json();
    if (Array.isArray(rows) && rows.length > 0) {
      console.log(`Encontradas ${rows.length} sessões ativas no Supabase. Inicializando...`);
      for (const row of rows) {
        const userId = row.id;
        if (userId.includes(':')) continue; // Ignora blobs de estado e arquivos
        
        console.log(`Reconectando sessão para usuário: ${userId}...`);
        getOrCreateInstance(userId).catch(err => {
          console.error(`Erro ao criar instância para usuário ${userId} no boot:`, err.message || err);
        });
      }
    } else {
      console.log('Nenhuma sessão anterior ativa encontrada no Supabase.');
    }
  } catch (err) {
    console.error('Erro na reconexão automática das sessões no boot:', err.message || err);
  }
}

async function startServer() {
  await loadBaileys();
  const server = await new Promise((resolve, reject) => {
    const listeningServer = app.listen(port, '0.0.0.0', () => {
      console.log(`WhatsApp Gateway ativo na porta ${listeningServer.address()?.port || port}`);
      console.log(`Pasta de dados configurada em: ${dataDir}`);
      resolve(listeningServer);
    });
    listeningServer.once('error', reject);
  });
  autoReconnectAllUsers().catch(err => {
    console.error('Erro ao iniciar reconexao automatica:', err.message || err);
  });
  return server;
}

if (require.main === module) {
  startServer().catch(err => {
    console.error('Falha ao iniciar o WhatsApp Gateway:', err);
    process.exitCode = 1;
  });
}

module.exports = {
  app,
  startServer,
  __test: {
    analyzeMessagesIntegrity,
    buildAuthStateBundle,
    buildMessageConversations,
    chooseBetterMessageText,
    cleanJid,
    compareMessagesChronologically,
    createDedupeKey,
    escapeMarkdown,
    extendQueueBackoff,
    extensionFromMimeType,
    extractTranscriptionText,
    extractVisionResponseText,
    formatImageInterpretationMessage,
    formatDateLabel,
    formatMessagesAsMarkdown,
    formatMessagesAsText,
    getMessageContextMetadata,
    getMessageMediaInfo,
    getMessageText,
    getMessageTimestampMs,
    inferChatJidFromMessage,
    inferParticipantJidFromMessage,
    isAllowedCorsOrigin,
    isAudioTranscriptionText,
    isImageInterpretationText,
    isPermanentMediaError,
    longTermRetryDelayMs,
    mediaText,
    mergeMessages,
    mergeMediaStats,
    initializeUserSyncState,
    markUserSyncConnected,
    normalizeBoolean,
    normalizeDisplayName,
    normalizeStoredMessage,
    parseCookies,
    parseAuthStateBundle,
    parseMediaState,
    parseRetryDelayMs,
    queuePauseInMs,
    retryDelayMsForError,
    shouldPauseMediaQueueForError,
    stringifyMediaState,
    withMediaTimeout,
    unwrapMessageContent,
    shouldQueueAudioTranscription,
    shouldQueueImageInterpretation,
    queueAudioTranscriptions,
    queueImageInterpretations,
    getAudioTranscriptionConfig,
    getImageInterpretationConfig
  }
};
