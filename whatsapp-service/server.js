const express = require('express');
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

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, downloadMediaMessage } = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
let sharp = null;
try {
  sharp = require('sharp');
} catch (err) {
  console.warn('[image] Sharp indisponivel; interpretacao de imagens sera ignorada ate a dependencia estar instalada.', err.message || err);
}

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
        if (key) process.env[key] = val;
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
      'MEDIA_ERROR_SNIPPET_LENGTH'
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

// Exclui todas as mensagens e contatos locais e do Supabase associados ao usuário de forma permanente na desconexão
async function clearAllUserData(userId) {
  const cleanUserId = userId.replace(/[^a-zA-Z0-9-_]/g, '');
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
    instance.contactsCache = {};
  }

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
      `${cleanUserId}:local:contacts:*`
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

async function loadProfileNameFromSupabase(userId) {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  
  if (!supabaseUrl || !supabaseKey) {
    return null;
  }

  const cleanUrl = supabaseUrl.replace(/\/$/, '');
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 4000); // 4 segundos de timeout

  try {
    const response = await fetch(`${cleanUrl}/rest/v1/profiles?id=eq.${userId}&select=name,email`, {
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`
      },
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (response.ok) {
      const data = await response.json();
      if (data && data.length > 0) {
        const profileName = data[0].name || (data[0].email ? data[0].email.split('@')[0] : null);
        if (profileName) {
          console.log(`[${userId}] Nome do perfil do Supabase carregado: ${profileName}`);
          return profileName;
        }
      }
    }
  } catch (err) {
    clearTimeout(timeoutId);
    console.error(`[${userId}] Erro de rede ao buscar nome no Supabase profiles:`, err.message || err);
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
const supabaseDisabledTables = new Set();
const pendingContactWrites = new Map();
const pendingContactTimers = new Map();

const MESSAGE_RETENTION_DAYS = Math.max(1, parseInt(process.env.MESSAGE_RETENTION_DAYS || '2', 10)); // Padrão de 2 dias (48 horas) para sincronização e retenção de histórico
const SUPABASE_TIMEOUT_MS = Math.max(2000, parseInt(process.env.SUPABASE_TIMEOUT_MS || '8000', 10));
const CONTACT_FLUSH_DELAY_MS = Math.max(250, parseInt(process.env.CONTACT_FLUSH_DELAY_MS || '1200', 10));
const CONTACT_MESSAGE_HYDRATION_INTERVAL_MS = Math.max(60000, parseInt(process.env.CONTACT_MESSAGE_HYDRATION_INTERVAL_MS || '300000', 10));
const SYNC_IDLE_COMPLETE_MS = Math.max(5000, parseInt(process.env.SYNC_IDLE_COMPLETE_MS || '90000', 10));
const JSON_INDENT = process.env.NODE_ENV === 'production' ? 0 : 2;
const AUDIO_TRANSCRIPTION_ENABLED = process.env.AUDIO_TRANSCRIPTION_ENABLED !== 'false';
const AUDIO_TRANSCRIPTION_MAX_BYTES = Math.max(1024 * 1024, parseInt(process.env.AUDIO_TRANSCRIPTION_MAX_BYTES || String(24 * 1024 * 1024), 10));
const AUDIO_TRANSCRIPTION_QUEUE_MAX = Math.max(1, parseInt(process.env.AUDIO_TRANSCRIPTION_QUEUE_MAX || '200', 10));
const AUDIO_TRANSCRIPTION_LANGUAGE = process.env.AUDIO_TRANSCRIPTION_LANGUAGE || 'pt';
const AUDIO_TRANSCRIPTION_PROMPT = process.env.AUDIO_TRANSCRIPTION_PROMPT || 'Transcreva mensagens de voz de WhatsApp em portugues do Brasil, preservando nomes proprios quando possivel.';
const audioTranscriptionQueue = [];
const queuedAudioTranscriptionKeys = new Set();
const failedAudioTranscriptionKeys = new Set();
let audioTranscriptionRunning = false;
const MEDIA_PROCESSING_MAX_ATTEMPTS = Math.max(1, parseInt(process.env.MEDIA_PROCESSING_MAX_ATTEMPTS || '3', 10));
const MEDIA_RETRY_FALLBACK_MS = Math.max(1000, parseInt(process.env.MEDIA_RETRY_FALLBACK_MS || '5000', 10));
const MEDIA_RETRY_MAX_MS = Math.max(MEDIA_RETRY_FALLBACK_MS, parseInt(process.env.MEDIA_RETRY_MAX_MS || '120000', 10));
const MEDIA_RETRY_BUFFER_MS = Math.max(0, parseInt(process.env.MEDIA_RETRY_BUFFER_MS || '250', 10));
const MEDIA_RETRY_POLL_MS = Math.max(250, parseInt(process.env.MEDIA_RETRY_POLL_MS || '1000', 10));
const MEDIA_ERROR_SNIPPET_LENGTH = Math.max(300, parseInt(process.env.MEDIA_ERROR_SNIPPET_LENGTH || '1000', 10));
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
  const dbSessionId = getDbSessionId(userId);
  return `${dbSessionId}:${kind}:${key}`;
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

function mediaProcessingKey(userId, dedupeKey) {
  return `${userId || 'unknown'}|${dedupeKey || ''}`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
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

function formatRetryDelay(ms) {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds % 1 === 0 ? 0 : 1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  return remainingSeconds > 0 ? `${minutes}m${remainingSeconds}s` : `${minutes}m`;
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

function nextRetryInMsForUser(queue, userId) {
  const now = Date.now();
  let nextAvailableAt = Infinity;
  for (const item of queue) {
    if (item.userId !== userId) continue;
    const availableAt = Number(item.availableAt || 0);
    if (availableAt > now && availableAt < nextAvailableAt) {
      nextAvailableAt = availableAt;
    }
  }
  return Number.isFinite(nextAvailableAt) ? Math.max(0, nextAvailableAt - now) : null;
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
  return '';
}

async function transcribeAudioBuffer(buffer, mimetype) {
  const config = getAudioTranscriptionConfig();
  if (!config) return '';
  if (!buffer || buffer.length === 0) return '';
  if (buffer.length > AUDIO_TRANSCRIPTION_MAX_BYTES) {
    console.warn(`[audio] Audio ignorado para transcricao: ${buffer.length} bytes excedem o limite de ${AUDIO_TRANSCRIPTION_MAX_BYTES}.`);
    return '';
  }

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
    body: form
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`transcription ${response.status}: ${errText.slice(0, MEDIA_ERROR_SNIPPET_LENGTH)}`);
  }

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return extractTranscriptionText(await response.json());
  }
  return extractTranscriptionText(await response.text());
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
  if (!getAudioTranscriptionConfig()) return false;

  const dedupeKey = messageObject?.dedupeKey || createDedupeKey(messageObject || {});
  if (!dedupeKey) return false;
  if (failedAudioTranscriptionKeys.has(mediaProcessingKey(userId, dedupeKey))) return false;
  if (savedKeys?.has(dedupeKey)) return true;

  const storedMessage = findStoredMessageByDedupeKey(userId, messageObject);
  return !storedMessage || !isAudioTranscriptionText(storedMessage.text);
}

function queueAudioTranscription(item) {
  if (!getAudioTranscriptionConfig()) return;

  const dedupeKey = item?.messageObject?.dedupeKey || createDedupeKey(item?.messageObject || {});
  if (!dedupeKey || queuedAudioTranscriptionKeys.has(dedupeKey)) return;
  if (failedAudioTranscriptionKeys.has(mediaProcessingKey(item.userId, dedupeKey))) return;

  if (audioTranscriptionQueue.length >= AUDIO_TRANSCRIPTION_QUEUE_MAX) {
    console.warn(`[${item.userId}] Fila de transcricao de audio cheia; audio ${dedupeKey} sera mantido como tag.`);
    return;
  }

  // Incrementa estatísticas da instância correspondente
  const userId = item.userId;
  const instance = instances[userId];
  if (instance) {
    const remainingForUser = audioTranscriptionQueue.filter(x => x.userId === userId).length;
    if (remainingForUser === 0 && !instance.transcriptionRunning) {
      instance.transcriptionTotal = 0;
      instance.transcriptionCompleted = 0;
      instance.transcriptionFailed = 0;
      instance.transcriptionLastError = '';
    }
    instance.transcriptionTotal = (instance.transcriptionTotal || 0) + 1;
  }

  queuedAudioTranscriptionKeys.add(dedupeKey);
  audioTranscriptionQueue.push({
    ...item,
    dedupeKey,
    attempt: item.attempt || 1,
    availableAt: item.availableAt || 0
  });
  runAudioTranscriptionQueue();
}

async function runAudioTranscriptionQueue() {
  if (audioTranscriptionRunning) return;
  audioTranscriptionRunning = true;

  while (audioTranscriptionQueue.length > 0) {
    const ready = shiftReadyQueueItem(audioTranscriptionQueue);
    if (!ready.item) {
      await sleep(Math.min(ready.waitMs, MEDIA_RETRY_POLL_MS));
      continue;
    }

    const item = ready.item;
    const userId = item.userId;
    const instance = instances[userId];
    if (instance) {
      instance.transcriptionRunning = true;
    }

    const attempt = Math.max(1, Number(item.attempt || 1));
    let success = false;
    let errorMessage = '';
    let retryScheduled = false;
    try {
      success = await transcribeQueuedAudio(item);
    } catch (err) {
      errorMessage = err.message || String(err);
      console.warn(`[${userId}] Falha ao transcrever audio ${item.dedupeKey}:`, errorMessage);
      if (attempt < MEDIA_PROCESSING_MAX_ATTEMPTS) {
        const retryDelayMs = retryDelayMsForError(errorMessage, attempt);
        item.attempt = attempt + 1;
        item.availableAt = Date.now() + retryDelayMs;
        audioTranscriptionQueue.push(item);
        retryScheduled = true;
        if (instance) {
          instance.transcriptionLastError = `${errorMessage} Nova tentativa ${item.attempt}/${MEDIA_PROCESSING_MAX_ATTEMPTS} em ${formatRetryDelay(retryDelayMs)}.`;
        }
        console.warn(`[${userId}] Audio ${item.dedupeKey} sera tentado novamente em ${formatRetryDelay(retryDelayMs)} (${item.attempt}/${MEDIA_PROCESSING_MAX_ATTEMPTS}).`);
      }
    } finally {
      if (success || !retryScheduled) {
        queuedAudioTranscriptionKeys.delete(item.dedupeKey);
      }
      if (success) {
        failedAudioTranscriptionKeys.delete(mediaProcessingKey(userId, item.dedupeKey));
      } else if (!retryScheduled) {
        failedAudioTranscriptionKeys.add(mediaProcessingKey(userId, item.dedupeKey));
      }
      if (instance) {
        if (success) {
          instance.transcriptionCompleted = (instance.transcriptionCompleted || 0) + 1;
        } else if (!retryScheduled) {
          instance.transcriptionFailed = (instance.transcriptionFailed || 0) + 1;
          instance.transcriptionLastError = errorMessage || 'Transcricao nao atualizou a mensagem.';
        }
        const remainingForUser = audioTranscriptionQueue.filter(x => x.userId === userId).length;
        if (remainingForUser === 0) {
          instance.transcriptionRunning = false;
        }
      }
    }
  }

  audioTranscriptionRunning = false;
}

async function transcribeQueuedAudio(item) {
  if (!item?.rawMessage || !item?.messageObject) {
    throw new Error('Mensagem de audio incompleta para transcricao.');
  }

  const updateMediaMessage = item.instance?.sock?.updateMediaMessage;
  const downloadContext = typeof updateMediaMessage === 'function'
    ? { logger, reuploadRequest: updateMediaMessage.bind(item.instance.sock) }
    : { logger };
  const buffer = await downloadMediaMessage(item.rawMessage, 'buffer', {}, downloadContext);
  if (!buffer || buffer.length === 0) {
    throw new Error('Download do audio retornou vazio.');
  }
  const transcript = await transcribeAudioBuffer(buffer, item.mimetype);
  if (!transcript) {
    throw new Error('Servico de transcricao retornou texto vazio.');
  }

  const updated = await updateStoredMessageText(item.userId, item.messageObject, `[Áudio transcrito] ${transcript}`);
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
  normalized.dedupeKey = normalized.dedupeKey || createDedupeKey(normalized);

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
  const config = getImageInterpretationConfig();
  if (!config) return '';

  const compressed = await compressImageBufferForVision(buffer);
  if (!compressed) return '';

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
    })
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`image interpretation ${response.status}: ${errText.slice(0, MEDIA_ERROR_SNIPPET_LENGTH)}`);
  }

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return extractVisionResponseText(await response.json());
  }
  return extractVisionResponseText(await response.text());
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
  if (!getImageInterpretationConfig()) return false;

  const dedupeKey = messageObject?.dedupeKey || createDedupeKey(messageObject || {});
  if (!dedupeKey) return false;
  if (failedImageInterpretationKeys.has(mediaProcessingKey(userId, dedupeKey))) return false;
  if (savedKeys?.has(dedupeKey)) return true;

  const storedMessage = findStoredMessageByDedupeKey(userId, messageObject);
  return !storedMessage || !isImageInterpretationText(storedMessage.text);
}

function queueImageInterpretation(item) {
  if (!getImageInterpretationConfig()) return;

  const dedupeKey = item?.messageObject?.dedupeKey || createDedupeKey(item?.messageObject || {});
  if (!dedupeKey || queuedImageInterpretationKeys.has(dedupeKey)) return;
  if (failedImageInterpretationKeys.has(mediaProcessingKey(item.userId, dedupeKey))) return;

  if (imageInterpretationQueue.length >= IMAGE_INTERPRETATION_QUEUE_MAX) {
    console.warn(`[${item.userId}] Fila de interpretacao visual cheia; midia ${dedupeKey} sera mantida como tag.`);
    return;
  }

  const userId = item.userId;
  const instance = instances[userId];
  if (instance) {
    const remainingForUser = imageInterpretationQueue.filter(x => x.userId === userId).length;
    if (remainingForUser === 0 && !instance.imageInterpretationRunning) {
      instance.imageInterpretationTotal = 0;
      instance.imageInterpretationCompleted = 0;
      instance.imageInterpretationFailed = 0;
      instance.imageInterpretationLastError = '';
    }
    instance.imageInterpretationTotal = (instance.imageInterpretationTotal || 0) + 1;
  }

  queuedImageInterpretationKeys.add(dedupeKey);
  imageInterpretationQueue.push({
    ...item,
    dedupeKey,
    attempt: item.attempt || 1,
    availableAt: item.availableAt || 0
  });
  runImageInterpretationQueue();
}

async function runImageInterpretationQueue() {
  if (imageInterpretationRunning) return;
  imageInterpretationRunning = true;

  while (imageInterpretationQueue.length > 0) {
    const ready = shiftReadyQueueItem(imageInterpretationQueue);
    if (!ready.item) {
      await sleep(Math.min(ready.waitMs, MEDIA_RETRY_POLL_MS));
      continue;
    }

    const item = ready.item;
    const userId = item.userId;
    const instance = instances[userId];
    if (instance) {
      instance.imageInterpretationRunning = true;
    }

    const attempt = Math.max(1, Number(item.attempt || 1));
    let success = false;
    let errorMessage = '';
    let retryScheduled = false;
    try {
      success = await interpretQueuedImage(item);
    } catch (err) {
      errorMessage = err.message || String(err);
      console.warn(`[${userId}] Falha ao interpretar midia visual ${item.dedupeKey}:`, errorMessage);
      if (attempt < MEDIA_PROCESSING_MAX_ATTEMPTS) {
        const retryDelayMs = retryDelayMsForError(errorMessage, attempt);
        item.attempt = attempt + 1;
        item.availableAt = Date.now() + retryDelayMs;
        imageInterpretationQueue.push(item);
        retryScheduled = true;
        if (instance) {
          instance.imageInterpretationLastError = `${errorMessage} Nova tentativa ${item.attempt}/${MEDIA_PROCESSING_MAX_ATTEMPTS} em ${formatRetryDelay(retryDelayMs)}.`;
        }
        console.warn(`[${userId}] Midia visual ${item.dedupeKey} sera tentada novamente em ${formatRetryDelay(retryDelayMs)} (${item.attempt}/${MEDIA_PROCESSING_MAX_ATTEMPTS}).`);
      }
    } finally {
      if (success || !retryScheduled) {
        queuedImageInterpretationKeys.delete(item.dedupeKey);
      }
      if (success) {
        failedImageInterpretationKeys.delete(mediaProcessingKey(userId, item.dedupeKey));
      } else if (!retryScheduled) {
        failedImageInterpretationKeys.add(mediaProcessingKey(userId, item.dedupeKey));
      }
      if (instance) {
        if (success) {
          instance.imageInterpretationCompleted = (instance.imageInterpretationCompleted || 0) + 1;
        } else if (!retryScheduled) {
          instance.imageInterpretationFailed = (instance.imageInterpretationFailed || 0) + 1;
          instance.imageInterpretationLastError = errorMessage || 'Interpretacao nao atualizou a mensagem.';
        }
        const remainingForUser = imageInterpretationQueue.filter(x => x.userId === userId).length;
        if (remainingForUser === 0) {
          instance.imageInterpretationRunning = false;
        }
      }
    }
  }

  imageInterpretationRunning = false;
}

function formatImageInterpretationMessage(originalText, interpretation) {
  const cleanOriginal = normalizeDisplayName(originalText);
  const cleanInterpretation = normalizeDisplayName(interpretation);
  if (!cleanInterpretation) return '';

  const isSticker = normalizedComparableText(cleanOriginal).startsWith('[figurinha]');
  const tag = isSticker ? 'Figurinha interpretada' : 'Imagem interpretada';
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
    : { logger };
  const buffer = await downloadMediaMessage(item.rawMessage, 'buffer', {}, downloadContext);
  if (!buffer || buffer.length === 0) {
    throw new Error('Download da imagem retornou vazio.');
  }
  const interpretation = await interpretImageBuffer(buffer);
  const nextText = formatImageInterpretationMessage(item.messageObject.text, interpretation);
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
      text: chooseBetterMessageText(existing.text, message.text)
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

function resolveMessageSenderName(message, contactsCache, isGroup, myPushName, myPushNameSource = '') {
  if (message.fromMe) {
    if (myPushNameSource === 'whatsapp' && myPushName && !isSelfNamePlaceholder(myPushName)) return myPushName;
    if (message.name && !isSelfNamePlaceholder(message.name)) return message.name;
    if (myPushName && !isSelfNamePlaceholder(myPushName)) return myPushName;
    return 'Você';
  }
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

function isValidConversationDisplayName(name) {
  if (!name) return false;
  if (isSelfNamePlaceholder(name)) return false;
  if (name.includes('@')) return false;
  if (/^[0-9+\s\-()]+$/.test(name)) return false;
  return true;
}

function buildMessageConversations(messages, contactsCache) {
  const grouped = {};

  messages.forEach(rawMessage => {
    const normalized = normalizeStoredMessage(rawMessage);
    const chatKey = normalized.sender;
    if (!chatKey || chatKey === 'undefined' || chatKey.trim() === '') return;

    if (!grouped[chatKey]) {
      grouped[chatKey] = {
        name: normalized.chatName || normalized.name || normalized.sender,
        chatJid: normalized.chatJid,
        messages: []
      };
    }
    grouped[chatKey].messages.push(normalized);
  });

  const resolvedChats = [];
  for (const chatKey in grouped) {
    const chat = grouped[chatKey];
    const isGroup = isGroupJid(chat.chatJid) || chat.messages.some(m => m.participant && m.participant !== m.sender);
    const jid = chat.chatJid || (isGroup ? `${chatKey}@g.us` : `${chatKey}@s.whatsapp.net`);
    let displayName = contactsCache[jid] || chat.messages.find(m => m.chatName)?.chatName;

    if (!displayName && !isGroup) {
      const nonMeMessage = chat.messages.find(m => !m.fromMe);
      if (nonMeMessage) displayName = nonMeMessage.name;
    }

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

  const unifiedGrouped = {};
  resolvedChats.forEach(chat => {
    const isNameValid = isValidConversationDisplayName(chat.displayName);
    const unifiedKey = isNameValid ? chat.displayName.trim().toLowerCase() : chat.chatKey;

    if (!unifiedGrouped[unifiedKey]) {
      unifiedGrouped[unifiedKey] = {
        displayName: chat.displayName,
        chatKey: chat.chatKey,
        chatJid: chat.chatJid,
        isGroup: chat.isGroup,
        messages: [...chat.messages]
      };
      return;
    }

    const currentIsLid = chat.chatKey.length > 15;
    const existingIsLid = unifiedGrouped[unifiedKey].chatKey.length > 15;
    if (existingIsLid && !currentIsLid) {
      unifiedGrouped[unifiedKey].chatKey = chat.chatKey;
      unifiedGrouped[unifiedKey].chatJid = chat.chatJid;
    }
    unifiedGrouped[unifiedKey].messages.push(...chat.messages);
  });

  return Object.values(unifiedGrouped).map(chat => {
    chat.messages.sort(compareMessagesChronologically);
    return chat;
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
        activeInstance?.myPushNameSource
      );
      return `  [${dateTimeStr}] ${senderName}: ${message.text}`;
    }).join('\n');

    return `--- Conversa com: ${chat.displayName} (${chat.chatKey}) ---\n${chatMessagesText}`;
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

    for (const message of chat.messages) {
      const dateTimeStr = dateTimeFormatter.format(new Date(message.timestamp)).replace(',', '');
      const senderName = resolveMessageSenderName(
        message,
        contactsCache,
        chat.isGroup,
        activeInstance?.myPushName,
        activeInstance?.myPushNameSource
      );
      lines.push(`- **${escapeMarkdown(dateTimeStr)}** · **${escapeMarkdown(senderName)}:** ${escapeMarkdown(message.text)}`);
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

function addContactRecordToCache(userId, instance, contact, source = 'sync') {
  if (!contact || !instance) return false;
  const baseAliases = contactAliasJids(contact);
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
    changed = addContactToCache(userId, instance, alias, name, source) || changed;
  }
  return changed;
}

function addGroupMetadataToCache(userId, instance, metadata, source = 'groupMetadata') {
  if (!metadata || !instance) return false;
  let changed = addContactToCache(userId, instance, metadata.id, metadata.subject, source);
  for (const participant of metadata.participants || []) {
    changed = addContactRecordToCache(userId, instance, participant, `${source}.participant`) || changed;
  }
  return changed;
}

async function persistContactsCacheNow(userId, instance) {
  if (!instance) return;
  await flushContactPersist(userId);
  saveContactsToFile(userId, instance.contactsCache || {});
}

async function processContactRecords(userId, instance, contacts, source = 'contacts.update') {
  if (!instance || !Array.isArray(contacts) || contacts.length === 0) return 0;
  let changed = 0;
  for (const contact of contacts) {
    if (addContactRecordToCache(userId, instance, contact, source)) {
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

  if (instance.forceHistorySync) {
    const previousProcessedCount = Array.isArray(state.creds.processedHistoryMessages)
      ? state.creds.processedHistoryMessages.length
      : 0;
    state.creds.processedHistoryMessages = [];
    instance.forceHistorySync = false;
    await saveCreds();
    try {
      if (fs.existsSync(credsFilePath)) {
        const credsData = JSON.parse(fs.readFileSync(credsFilePath, 'utf8'));
        await saveCredsToSupabase(userId, credsData);
      }
    } catch (err) {
      console.error(`[${userId}] Erro ao salvar credenciais apos force-history:`, err);
    }
    console.log(`[${userId}] force-history ativo: ${previousProcessedCount} marcadores de histórico processado foram limpos.`);
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
  sock.ev.on('connection.update', async (update) => {
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
      hydrateContactsFromStoredMessages(userId, instance)
        .then(() => refreshGroupMetadataAliases(userId, instance))
        .catch(err => {
        console.warn(`[${userId}] Falha ao hidratar aliases de grupos apos conexao:`, err.message || err);
      });
    }
  });

  // Sincroniza metadados dos grupos e salva no cache para otimizar consultas e evitar rate-limit
  sock.ev.on('groups.upsert', async (groups) => {
    if (instance.connectionGeneration !== connectionGeneration) return;
    let changed = 0;
    for (const metadata of groups || []) {
      if (!metadata?.id || !instance.groupMetadataCache) continue;
      instance.groupMetadataCache[metadata.id] = metadata;
      if (addGroupMetadataToCache(userId, instance, metadata, 'groups.upsert')) changed++;
    }
    if (changed > 0) {
      await persistContactsCacheNow(userId, instance);
      resetUserSyncTimer(userId);
    }
  });

  sock.ev.on('groups.update', async ([event]) => {
    if (instance.connectionGeneration !== connectionGeneration) return;
    try {
      if (sock && event.id && instance.groupMetadataCache) {
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
    const audioTranscriptionCandidates = [];
    const imageInterpretationCandidates = [];
    const ownerDisplayName = filteredList.some(msg => msg?.key?.fromMe)
      ? await ensureOwnerDisplayName(userId, instance)
      : '';

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
        const directParticipantAliases = messageParticipantAliases(msg, participantJid);
        const participantAliases = uniqueJids([
          ...directParticipantAliases,
          ...relatedAliasesFromCache(directParticipantAliases, instance.contactsCache)
        ]);
        
        let pushName = '';
        if (!fromMe) {
          const savedName = bestNameFromAliases(participantAliases, instance.contactsCache);
          const messagePushName = normalizeDisplayName(msg.pushName);
          pushName = savedName || messagePushName || jidNumber(participantJid);
          if (msg.pushName) {
            for (const alias of participantAliases) {
              addContactToCache(userId, instance, alias, msg.pushName, 'message.pushName');
            }
          }
        } else {
          // Usa o nome real do dono do celular configurado no WhatsApp
          pushName = ownerDisplayName;
        }

        const chatName = instance.contactsCache[chatJid] || (!isGroup && !fromMe ? pushName : '');
        if (!isGroup && !fromMe && pushName) {
          addContactToCache(userId, instance, chatJid, pushName, 'message.chat');
        }

        const mediaInfo = getMessageMediaInfo(msg);
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
        console.error(`[${userId}] Erro ao processar mensagem do lote:`, err);
      }
    }

    const savedMessages = saveUserMessagesBatch(userId, messageObjects);
    if (savedMessages.length > 0) {
      await persistMessagesToSupabase(userId, savedMessages);
    }

    if (audioTranscriptionCandidates.length > 0) {
      const savedKeys = new Set(savedMessages.map(message => message.dedupeKey || createDedupeKey(message)));
      for (const candidate of audioTranscriptionCandidates) {
        if (shouldQueueAudioTranscription(userId, candidate.messageObject, savedKeys)) {
          queueAudioTranscription(candidate);
        }
      }
    }

    if (imageInterpretationCandidates.length > 0) {
      const savedKeys = new Set(savedMessages.map(message => message.dedupeKey || createDedupeKey(message)));
      for (const candidate of imageInterpretationCandidates) {
        if (shouldQueueImageInterpretation(userId, candidate.messageObject, savedKeys)) {
          queueImageInterpretation(candidate);
        }
      }
    }
  }

  // Escuta novas mensagens (enviadas e recebidas em tempo real)
  sock.ev.on('messages.upsert', async (m) => {
    if (instance.connectionGeneration !== connectionGeneration) return;
    if (m.type !== 'notify') return;
    await processUserMessages(m.messages);
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

  sock.ev.on('chats.phoneNumberShare', async ({ lid, jid }) => {
    if (instance.connectionGeneration !== connectionGeneration) return;
    if (!lid || !jid) return;
    const changed = addContactRecordToCache(userId, instance, { id: lid, lid, jid }, 'chats.phoneNumberShare');
    if (changed) {
      await persistContactsCacheNow(userId, instance);
      resetUserSyncTimer(userId);
      console.log(`[${userId}] Alias telefone/LID recebido via chats.phoneNumberShare: ${lid} -> ${jid}`);
    }
  });

  // Escuta o histórico de mensagens inicial enviado pelo WhatsApp na sincronização
  sock.ev.on('messaging-history.set', async ({ chats, contacts, messages, syncType, progress }) => {
    if (instance.connectionGeneration !== connectionGeneration) return;
    let totalMessages = 0;
    const historyContacts = Array.isArray(contacts) ? contacts : [];
    const historyChats = Array.isArray(chats) ? chats : [];
    const historyMessages = Array.isArray(messages) ? messages : [];
    const profileNameContacts = historyContacts.filter(hasUsableProfileName).length;

    instance.historySyncStats = {
      ...(instance.historySyncStats || {}),
      batches: (instance.historySyncStats?.batches || 0) + 1,
      contacts: (instance.historySyncStats?.contacts || 0) + historyContacts.length,
      pushNameContacts: (instance.historySyncStats?.pushNameContacts || 0) + profileNameContacts,
      messages: (instance.historySyncStats?.messages || 0) + historyMessages.length,
      lastSyncType: syncType ?? null,
      lastProgress: progress ?? null,
      lastAt: new Date().toISOString()
    };

    console.log(
      `[${userId}] History sync: type=${syncType ?? 'unknown'} progress=${progress ?? 'unknown'} ` +
      `contacts=${historyContacts.length} profileNames=${profileNameContacts} chats=${historyChats.length} messages=${historyMessages.length}`
    );
    
    // 0. Sincroniza a lista de contatos da agenda inicial do celular
    if (historyContacts.length > 0) {
      const changedContacts = await processContactRecords(userId, instance, historyContacts, 'history.contacts');
      console.log(`[${userId}] Sincronizados ${historyContacts.length} contatos do histórico, incluindo ${profileNameContacts} nomes de perfil (${changedContacts} atualizados).`);
    }

    // 0.1. Sincroniza os nomes das conversas e grupos do histórico recente
    if (historyChats.length > 0) {
      let syncGroupNamesCount = 0;
      let changedChats = 0;
      for (const chat of historyChats) {
        if (addContactRecordToCache(userId, instance, chat, 'history.chats')) {
          changedChats++;
          if (chat.id.endsWith('@g.us')) {
            syncGroupNamesCount++;
          }
        }
      }
      if (changedChats > 0) {
        await persistContactsCacheNow(userId, instance);
      }
      console.log(`[${userId}] Sincronizados ${historyChats.length} chats recentes, incluindo ${syncGroupNamesCount} nomes de grupos (${changedChats} atualizados).`);
    }
    
    // 1. Processa mensagens do array global (se houver)
    if (historyMessages.length > 0) {
      await processUserMessages(historyMessages);
      totalMessages += historyMessages.length;
    }
    
    // 2. Extrai e processa mensagens do histórico de cada chat (onde o Baileys agrupa o histórico real)
    if (historyChats.length > 0) {
      let chatMsgsCount = 0;
      const retentionThreshold = Date.now() - (MESSAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000);
      for (const chat of historyChats) {
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
    
    await persistContactsCacheNow(userId, instance);
    console.log(`[${userId}] Carga de histórico finalizada. Total de mensagens processadas: ${totalMessages}`);
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
  const storedOwnerName = loadOwnerNameFromFile(cleanUserId);
  
  const instanceState = {
    sock: null,
    currentQr: null,
    connectionStatus: 'connecting',
    syncStatus: 'pending',
    messagesProcessedCount: 0,
    contactsCache: hydratedContactsCache,
    groupMetadataCache: {}, // Cache de metadados dos grupos para otimização e evitar rate-limit do WhatsApp
    myPushName: storedOwnerName, // Nome de perfil do próprio usuário dono do WhatsApp
    myPushNameSource: storedOwnerName ? 'profile-hint' : 'fallback',
    lastSyncActivity: Date.now(),
    syncTimer: null,
    contactsSaveTimer: null,
    reconnectTimer: null,
    connectionGeneration: 0,
    forceHistorySync: false,
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

  // Busca o nome do usuário no Supabase profiles para carregar o myPushName real
  try {
    const profileName = await loadProfileNameFromSupabase(cleanUserId);
    if (profileName) {
      instanceState.myPushName = profileName;
      instanceState.myPushNameSource = 'profile';
      console.log(`[${cleanUserId}] Nome do perfil do Supabase carregado: ${profileName}`);
    }
  } catch (err) {
    console.warn(`[${cleanUserId}] Erro ao carregar nome do perfil no Supabase:`, err.message || err);
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
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, x-api-key, x-owner-name');
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
  let missingHumanSenderNames = 0;
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
    historySyncStats: instance ? (instance.historySyncStats || null) : null,
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
  const forcedHistory = mode === 'force-history';

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
    connectUserWhatsApp(cleanUserId);
  }

  const diagnostics = await buildDiagnostics(cleanUserId, dateStr || undefined);
  return res.json({
    ok: true,
    mode,
    forcedHistory,
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

            showRawOutput('Buscando mensagens no servidor...');
            label.textContent = 'Mensagens do dia: ' + date.split('-').reverse().join('/');

            try {
              const response = await fetch('/messages?date=' + date + '&format=' + format);
              
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

              const response = await fetch('/contacts' + keyParam);
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
              const response = await fetch('/diagnostics?date=' + date);
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
              const response = await fetch('/maintenance/resync?mode=soft&date=' + date);
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
  const userId = req.headers['x-api-key'] || req.query.key || parseCookies(req.headers.cookie)['whatsapp_api_key'];
  const instance = await getOrCreateInstance(userId);
  if (!instance) {
    return res.status(400).json({ error: 'Identificação de usuário necessária.' });
  }
  applyOwnerNameHint(userId.replace(/[^a-zA-Z0-9-_]/g, ''), instance, readOwnerNameHint(req));
  const ownerDisplayName = await ensureOwnerDisplayName(userId.replace(/[^a-zA-Z0-9-_]/g, ''), instance);

  res.json({
    status: instance.connectionStatus,
    connected: instance.connectionStatus === 'connected',
    qrAvailable: !!instance.currentQr,
    syncStatus: instance.syncStatus,
    messagesCount: instance.messagesProcessedCount,
    contactsCount: Object.keys(instance.contactsCache || {}).length,
    historySyncStats: instance.historySyncStats || null,
    lastSyncActivity: instance.lastSyncActivity ? new Date(instance.lastSyncActivity).toISOString() : null,
    retentionDays: MESSAGE_RETENTION_DAYS,
    persistence: {
      supabaseConfigured: !!getSupabaseConfig(),
      disabledTables: Array.from(supabaseDisabledTables),
      fallbackSnapshots: true
    },
    audioTranscription: {
      configured: !!getAudioTranscriptionConfig(),
      queueLength: audioTranscriptionQueue.filter(x => x.userId === userId).length,
      retrying: countScheduledRetriesForUser(audioTranscriptionQueue, userId),
      nextRetryInMs: nextRetryInMsForUser(audioTranscriptionQueue, userId),
      maxAttempts: MEDIA_PROCESSING_MAX_ATTEMPTS,
      running: !!instance.transcriptionRunning,
      completed: instance.transcriptionCompleted || 0,
      failed: instance.transcriptionFailed || 0,
      total: instance.transcriptionTotal || 0,
      lastError: instance.transcriptionLastError || null
    },
    imageInterpretation: {
      configured: !!getImageInterpretationConfig(),
      compressorAvailable: !!sharp,
      queueLength: imageInterpretationQueue.filter(x => x.userId === userId).length,
      retrying: countScheduledRetriesForUser(imageInterpretationQueue, userId),
      nextRetryInMs: nextRetryInMsForUser(imageInterpretationQueue, userId),
      maxAttempts: MEDIA_PROCESSING_MAX_ATTEMPTS,
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
    ownerDisplayNameSource: instance.myPushNameSource || 'fallback'
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

// Busca diagnostica pontual no cache de contatos sem despejar a lista completa
app.get('/diagnostics/contact-lookup', checkAuth, async (req, res) => {
  const userId = req.headers['x-api-key'] || req.query.key || parseCookies(req.headers.cookie)['whatsapp_api_key'];
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
app.get('/maintenance/resync', checkAuth, handleMaintenanceResync);
app.post('/maintenance/resync', checkAuth, handleMaintenanceResync);

// Retorna o QR Code em base64 ou status da conexão em JSON para modais
app.get('/qr-code', checkAuth, async (req, res) => {
  const userId = req.headers['x-api-key'] || req.query.key || parseCookies(req.headers.cookie)['whatsapp_api_key'];
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
  const userId = req.headers['x-api-key'] || req.query.key || parseCookies(req.headers.cookie)['whatsapp_api_key'];
  const instance = await getOrCreateInstance(userId);
  if (!instance) {
    return res.status(400).send('Erro: Identificação do usuário inválida.');
  }
  applyOwnerNameHint(userId.replace(/[^a-zA-Z0-9-_]/g, ''), instance, readOwnerNameHint(req));

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
    let activeInstance = instances[cleanUserId] || await getOrCreateInstance(cleanUserId);
    if (activeInstance) {
      applyOwnerNameHint(cleanUserId, activeInstance, readOwnerNameHint(req));
      activeInstance.contactsCache = mergeContactCaches(
        loadContactsFromFile(cleanUserId),
        await loadContactsFromSupabase(cleanUserId),
        activeInstance.contactsCache || {}
      );
      await ensureOwnerDisplayName(cleanUserId, activeInstance);
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

    const requestedFormat = String(req.query.format || '').toLowerCase();
    if (requestedFormat === 'json_grouped') {
      const contactsCache = mergeContactCaches(
        loadContactsFromFile(cleanUserId),
        await loadContactsFromSupabase(cleanUserId),
        activeInstance ? (activeInstance.contactsCache || {}) : {}
      );
      const conversations = buildMessageConversations(messages, contactsCache);
      const formattedConversations = conversations.map(chat => {
        return {
          chatKey: chat.chatKey,
          chatJid: chat.chatJid,
          isGroup: chat.isGroup,
          displayName: chat.displayName,
          messages: chat.messages.map(m => {
            const senderName = resolveMessageSenderName(
              m,
              contactsCache,
              chat.isGroup,
              activeInstance?.myPushName,
              activeInstance?.myPushNameSource
            );
            return {
              id: m.id,
              sender: m.sender,
              senderName: senderName,
              text: m.text || '',
              fromMe: !!m.fromMe,
              timestamp: m.timestamp
            };
          })
        };
      });
      return res.json({ date: dateStr, count: messages.length, conversations: formattedConversations });
    }

    if (requestedFormat === 'text' || requestedFormat === 'markdown' || requestedFormat === 'md') {
      const contactsCache = mergeContactCaches(
        loadContactsFromFile(cleanUserId),
        await loadContactsFromSupabase(cleanUserId),
        activeInstance ? (activeInstance.contactsCache || {}) : {}
      );
      const conversations = buildMessageConversations(messages, contactsCache);

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
            activeInstance?.myPushNameSource
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
app.get('/clear-logs', checkAuth, async (req, res) => {
  const userId = req.headers['x-api-key'] || req.query.key || parseCookies(req.headers.cookie)['whatsapp_api_key'];
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

app.listen(port, '0.0.0.0', () => {
  console.log(`WhatsApp Gateway ativo na porta ${port}`);
  console.log(`Pasta de dados configurada em: ${dataDir}`);
});
