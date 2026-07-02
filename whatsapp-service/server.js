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

// Configuração do diretório de dados persistentes
const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
const authDir = path.join(dataDir, 'auth');

// Garante que os diretórios existam
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(authDir, { recursive: true });

// Logger silencioso para o Baileys para não sujar o console do Fly.io
const logger = pino({ level: 'warn' });

// Estado global da conexão
let sock = null;
let currentQr = null;
let connectionStatus = 'connecting'; // 'connecting' | 'qrcode' | 'connected' | 'disconnected'
let syncStatus = 'pending'; // 'pending' | 'syncing' | 'completed'
let messagesProcessedCount = 0;
const contactsCache = {};

// Helper para atualizar retroativamente os nomes das mensagens em arquivos físicos diários
function updateMessageNamesInFiles(userId, contactId, contactName) {
  const senderNumber = contactId.split('@')[0];
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
          const msgSender = m.participant || m.sender;
          if (msgSender === senderNumber && !m.fromMe && m.name !== contactName) {
            m.name = contactName;
            modified = true;
          }
        }
        
        if (modified) {
          fs.writeFileSync(filePath, JSON.stringify(messages, null, 2), 'utf8');
        }
      }
    }
  } catch (err) {
    console.error(`Erro ao atualizar retroativamente contatos do remetente ${senderNumber} para o usuário ${userId}:`, err);
  }
}

// Helper para adicionar contato ao cache e disparar atualização nos logs diários
function addContactToCache(userId, instance, id, name) {
  if (!id || !name) return;
  instance.contactsCache[id] = name;
  updateMessageNamesInFiles(userId, id, name);
}

// Inicia a conexão com o WhatsApp para um usuário específico de forma isolada
async function connectUserWhatsApp(userId) {
  const instance = instances[userId];
  if (!instance) return;

  console.log(`Iniciando conexão com o WhatsApp para o usuário: ${userId}`);
  instance.connectionStatus = 'connecting';

  const userAuthDir = path.join(dataDir, 'auth', userId);
  fs.mkdirSync(userAuthDir, { recursive: true });

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
    syncFullHistory: true, // Força o envio do histórico recente completo do celular ao parear
    printQRInTerminal: false, // Desativado (evita avisos no log)
    logger: logger,
    browser: ['FollowUp Mônada', 'Chrome', '1.0'] // Customiza a exibição no celular do usuário
  });

  instance.sock = sock;

  // Salva as credenciais a cada alteração de autenticação
  sock.ev.on('creds.update', saveCreds);

  // Monitora alterações na conexão
  sock.ev.on('connection.update', (update) => {
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
        setTimeout(() => connectUserWhatsApp(userId), 5000);
      } else {
        console.log(`[${userId}] Desconectado permanentemente (Sessão encerrada pelo celular). Excluindo credenciais...`);
        instance.connectionStatus = 'disconnected';
        try {
          fs.rmSync(userAuthDir, { recursive: true, force: true });
          fs.mkdirSync(userAuthDir, { recursive: true });
        } catch (e) {
          console.error(`[${userId}] Erro ao limpar pasta de auth:`, e);
        }
        console.log(`[${userId}] Reiniciando conexão em 3 segundos para gerar novo QR Code...`);
        setTimeout(() => connectUserWhatsApp(userId), 3000);
      }
    } else if (connection === 'open') {
      instance.currentQr = null;
      instance.connectionStatus = 'connected';
      instance.syncStatus = 'syncing';
      console.log(`[${userId}] WhatsApp conectado com sucesso!`);
      resetUserSyncTimer(userId);
    }
  });

  // Sincroniza a lista de contatos quando houver novos contatos adicionados
  sock.ev.on('contacts.upsert', (contacts) => {
    for (const contact of contacts) {
      const name = contact.name || contact.verifiedName;
      if (contact.id && name) {
        addContactToCache(userId, instance, contact.id, name);
      }
    }
    resetUserSyncTimer(userId);
  });

  // Atualiza dados dos contatos da agenda caso mudem de nome
  sock.ev.on('contacts.update', (contacts) => {
    for (const contact of contacts) {
      const name = contact.name || contact.verifiedName;
      if (contact.id && name) {
        addContactToCache(userId, instance, contact.id, name);
      }
    }
    resetUserSyncTimer(userId);
  });

  // Função auxiliar para processar e salvar um lote de mensagens
  function processUserMessages(messagesList) {
    if (!messagesList || messagesList.length === 0) return;
    instance.messagesProcessedCount += messagesList.length;
    resetUserSyncTimer(userId);
    
    for (const msg of messagesList) {
      try {
        if (!msg.key || !msg.key.remoteJid) continue;
        
        const sender = msg.key.remoteJid;
        
        // Mantém chats privados (@s.whatsapp.net) e grupos (@g.us).
        if (!sender.endsWith('@s.whatsapp.net') && !sender.endsWith('@g.us')) continue;

        const fromMe = msg.key.fromMe;
        
        // Determina o nome do remetente individual
        const participantJid = msg.key.participant || msg.participant || msg.key.remoteJid;
        
        let pushName = 'Eu';
        if (!fromMe) {
          const savedName = instance.contactsCache[participantJid];
          pushName = savedName || msg.pushName || participantJid.split('@')[0];
        }
        const text = getMessageText(msg);

        // Ignora se não houver texto legível (ex: figurinhas, reações, chamadas de áudio)
        if (!text.trim()) continue;

        const timestamp = (msg.messageTimestamp ? new Date(msg.messageTimestamp * 1000) : new Date());
        
        const formatter = new Intl.DateTimeFormat('fr-CA', {
          timeZone: 'America/Sao_Paulo',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit'
        });
        const dateStr = formatter.format(timestamp); // YYYY-MM-DD
        
        const messageObject = {
          id: msg.key.id,
          sender: sender.split('@')[0],
          participant: participantJid.split('@')[0], // Identifica quem de fato enviou (essencial para grupos e atualizações retroativas)
          name: pushName,
          text: text,
          fromMe: fromMe,
          timestamp: timestamp.toISOString()
        };

        saveUserMessageToFile(userId, dateStr, messageObject);

      } catch (err) {
        console.error(`[${userId}] Erro ao processar mensagem do lote:`, err);
      }
    }
  }

  // Escuta novas mensagens (enviadas e recebidas em tempo real)
  sock.ev.on('messages.upsert', async (m) => {
    if (m.type !== 'notify') return;
    processUserMessages(m.messages);
  });

  // Escuta o histórico de mensagens inicial enviado pelo WhatsApp na sincronização
  sock.ev.on('messaging-history.set', async ({ chats, contacts, messages }) => {
    let totalMessages = 0;
    
    // 0. Sincroniza a lista de contatos da agenda inicial do celular
    if (contacts && contacts.length > 0) {
      for (const contact of contacts) {
        const name = contact.name || contact.verifiedName;
        if (contact.id && name) {
          addContactToCache(userId, instance, contact.id, name);
        }
      }
      console.log(`[${userId}] Sincronizados ${contacts.length} contatos da agenda.`);
    }
    
    // 1. Processa mensagens do array global (se houver)
    if (messages && messages.length > 0) {
      processUserMessages(messages);
      totalMessages += messages.length;
    }
    
    // 2. Extrai e processa mensagens do histórico de cada chat (onde o Baileys agrupa o histórico real)
    if (chats && chats.length > 0) {
      let chatMsgsCount = 0;
      for (const chat of chats) {
        if (chat.messages && chat.messages.length > 0) {
          const chatMsgs = chat.messages.map(m => m.message).filter(Boolean);
          if (chatMsgs.length > 0) {
            processUserMessages(chatMsgs);
            chatMsgsCount += chatMsgs.length;
          }
        }
      }
      totalMessages += chatMsgsCount;
    }
    
    console.log(`[${userId}] Carga de histórico finalizada. Total de mensagens processadas: ${totalMessages}`);
  });
}

// Extrai texto de diferentes tipos de mensagens do Baileys
function getMessageText(msg) {
  if (!msg.message) return '';
  
  const content = msg.message;
  
  // Trata mensagem de texto simples
  if (content.conversation) return content.conversation;
  
  // Trata mensagem de texto formatada / respostas / links
  if (content.extendedTextMessage) return content.extendedTextMessage.text || '';
  
  // Trata mensagem de imagem com legenda
  if (content.imageMessage) return content.imageMessage.caption || '';
  
  // Trata mensagem de vídeo com legenda
  if (content.videoMessage) return content.videoMessage.caption || '';
  
  // Trata mensagem com botões ou interações
  if (content.buttonsResponseMessage) return content.buttonsResponseMessage.selectedButtonId || '';
  if (content.templateButtonReplyMessage) return content.templateButtonReplyMessage.selectedId || '';

  return '';
}

// Salva mensagens localmente em arquivos JSON por data e isolado por usuário
function saveUserMessageToFile(userId, dateStr, messageObject) {
  const userMsgDir = path.join(dataDir, 'messages', userId);
  fs.mkdirSync(userMsgDir, { recursive: true });
  const filePath = path.join(userMsgDir, `messages-${dateStr}.json`);
  let messages = [];

  try {
    if (fs.existsSync(filePath)) {
      const rawData = fs.readFileSync(filePath, 'utf8');
      messages = JSON.parse(rawData);
    }
  } catch (e) {
    console.error(`Erro ao ler mensagens de ${dateStr} do usuário ${userId}:`, e);
  }

  // Previne salvar duplicatas
  const isDuplicate = messages.some(m => m.id === messageObject.id);
  if (!isDuplicate) {
    messages.push(messageObject);
    try {
      fs.writeFileSync(filePath, JSON.stringify(messages, null, 2), 'utf8');
    } catch (e) {
      console.error(`Erro ao gravar mensagens de ${dateStr} do usuário ${userId}:`, e);
    }
  }
}

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
    }, 12000); // 12 segundos de tolerância à inatividade de dados
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
  
  const instanceState = {
    sock: null,
    currentQr: null,
    connectionStatus: 'connecting',
    syncStatus: 'pending',
    messagesProcessedCount: 0,
    contactsCache: {},
    lastSyncActivity: Date.now(),
    syncTimer: null
  };

  instances[cleanUserId] = instanceState;
  
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
    user: instance.sock && instance.sock.user ? {
      id: instance.sock.user.id,
      name: instance.sock.user.name
    } : null
  });
});

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

  if (!fs.existsSync(filePath)) {
    return res.json({ date: dateStr, count: 0, messages: [] });
  }

  try {
    const rawData = fs.readFileSync(filePath, 'utf8');
    const messages = JSON.parse(rawData);
    
    // Sempre ordena cronologicamente por timestamp (crescente: do mais antigo ao mais recente)
    messages.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    const formatText = req.query.format === 'text';
    if (formatText) {
      // Agrupa por remetente/conversa para a IA processar sem misturas
      const grouped = {};
      messages.forEach(m => {
        const chatKey = m.sender;
        if (!grouped[chatKey]) {
          grouped[chatKey] = {
            name: m.name || m.sender,
            messages: []
          };
        }
        grouped[chatKey].messages.push(m);
      });

      // Obtém contatos da instância ativa na memória para extrair nomes reais de conversas
      const instance = instances[cleanUserId];
      const contactsCache = instance ? (instance.contactsCache || {}) : {};

      const formattedChats = [];
      for (const chatKey in grouped) {
        const chat = grouped[chatKey];
        const isGroup = chatKey.includes('-');

        // 1. Tenta pegar o nome da conversa pelo cache de contatos
        const jid = isGroup ? `${chatKey}@g.us` : `${chatKey}@s.whatsapp.net`;
        let displayName = contactsCache[jid];
        
        // 2. Para chats individuais, se não estiver no cache, procura nas mensagens desse chat o nome do contato
        if (!displayName && !isGroup) {
          const nonMeMessage = chat.messages.find(m => !m.fromMe);
          if (nonMeMessage) {
            displayName = nonMeMessage.name;
          }
        }
        
        // 3. Se ainda assim não achar, ou se for o JID puro, ou se for "Eu", define fallbacks
        if (!displayName || displayName === 'Eu' || displayName.includes('@')) {
          displayName = isGroup ? 'Grupo' : 'Contato';
        }

        const chatMessagesText = chat.messages.map(m => {
          const dateTimeStr = new Date(m.timestamp).toLocaleString('pt-BR', {
            timeZone: 'America/Sao_Paulo',
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
          });
          const senderName = m.fromMe ? 'Eu' : (m.name || m.sender);
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
