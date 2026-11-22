/**
 * FollowUp Mônada — Prova de Conceito (Coletor Local para DevTools do WhatsApp Web)
 *
 * - Somente leitura no IndexedDB do WhatsApp Web (sem cliques, sem rolagens, sem envio de mensagens).
 * - Sem envio para o FollowUp Mônada, sem provedores de transcrição e sem serviços externos.
 * - Tenta primeiro recuperar áudios do cache local do navegador; download explícito do CDN do WhatsApp
 *   só ocorre quando allowExplicitMediaDownload: true e estritamente para as datas selecionadas.
 * - Nenhuma credencial ou chave de mídia (mediaKey, directPath, tokens) é exportada no JSON.
 */
(() => {
  'use strict';

  const core = window.MonadaWaPocCore;
  const media = window.MonadaWaPocMedia;
  if (!core || !media) throw new Error('Carregue lib/poc-core.js e lib/poc-media.js antes do coletor.');
  const { SAO_PAULO_TZ, defaultClosedDates, extractJidString, extractFromMe, extractTimestampMs, formatSaoPauloParts, isStatusBroadcastJid, extractMessageId, sanitizeObjectForExport } = core;
  const AUDIO_TYPES = new Set(['ptt', 'audio']);
  const SENSITIVE_KEY_PATTERN = /mediaKey|encFilehash|fileEncSha256|directPath|deprecatedMms3Url|token|cookie|secret|password|auth/i;

  function describeRecordFieldTypes(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const summary = {};
    for (const [key, val] of Object.entries(raw)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        summary[key] = '[sensitive-present]';
      } else if (val === null) {
        summary[key] = 'null';
      } else if (Array.isArray(val)) {
        summary[key] = `Array(${val.length})`;
      } else if (val instanceof ArrayBuffer) {
        summary[key] = `ArrayBuffer(${val.byteLength})`;
      } else if (ArrayBuffer.isView(val)) {
        summary[key] = `${val.constructor?.name || 'TypedArray'}(${val.byteLength})`;
      } else if (typeof val === 'string') {
        summary[key] = `string(len=${val.length})`;
      } else if (typeof val === 'object') {
        summary[key] = `object(${Object.keys(val).slice(0, 8).join(',')})`;
      } else {
        summary[key] = typeof val;
      }
    }
    return summary;
  }

  function openIdbReadonly(name) {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(name);
      req.onupgradeneeded = () => { req.transaction.abort(); reject(new Error('Banco local inexistente: nenhuma base foi criada.')); };
      req.onerror = () => reject(req.error || new Error(`Falha ao abrir IndexedDB "${name}"`));
      req.onsuccess = () => resolve(req.result);
    });
  }

  function readAllStoreRecords(db, storeName) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const req = store.getAll();
      req.onerror = () => reject(req.error || new Error(`Falha ao ler store "${storeName}"`));
      req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : []);
    });
  }

  const decryptWhatsAppAudioBytes = media.decryptAudio;
  const toAudioDataUrl = media.validatedDataUrl;

  async function inspectLocalAudioCache(targetAudioRawMessages, dependenciesUsed, limitations) {
    const localBytesByHash = new Map();
    const wantedHashes = new Set();
    for (const raw of targetAudioRawMessages) {
      if (typeof raw.filehash === 'string' && raw.filehash) wantedHashes.add(raw.filehash);
      if (typeof raw.encFilehash === 'string' && raw.encFilehash) wantedHashes.add(raw.encFilehash);
    }
    if (wantedHashes.size === 0) return localBytesByHash;

    // 1) Tenta IndexedDB lru-media-storage-idb (somente leitura)
    try {
      const dbs = typeof indexedDB.databases === 'function' ? await indexedDB.databases() : [];
      const hasLruDb = dbs.some((d) => d?.name === 'lru-media-storage-idb');
      if (hasLruDb) {
        const lruDb = await openIdbReadonly('lru-media-storage-idb');
        try {
          for (const storeName of Array.from(lruDb.objectStoreNames)) {
            const records = await readAllStoreRecords(lruDb, storeName);
            for (const rec of records) {
              const keyCandidates = [rec?.filehash, rec?.encFilehash, rec?.id, rec?.key].filter((v) => typeof v === 'string');
              const matchedHash = keyCandidates.find((k) => wantedHashes.has(k));
              if (!matchedHash) continue;
              const blobCandidate = rec?.blob || rec?.data || rec?.file || rec?.content;
              if (blobCandidate instanceof Blob) {
                localBytesByHash.set(matchedHash, new Uint8Array(await blobCandidate.arrayBuffer()));
                dependenciesUsed.add('indexeddb:lru-media-storage-idb');
              } else if (blobCandidate instanceof ArrayBuffer) {
                localBytesByHash.set(matchedHash, new Uint8Array(blobCandidate));
                dependenciesUsed.add('indexeddb:lru-media-storage-idb');
              } else if (ArrayBuffer.isView(blobCandidate)) {
                localBytesByHash.set(matchedHash, new Uint8Array(blobCandidate.buffer, blobCandidate.byteOffset, blobCandidate.byteLength));
                dependenciesUsed.add('indexeddb:lru-media-storage-idb');
              }
            }
          }
        } finally {
          lruDb.close();
        }
      }
    } catch (err) {
      limitations.push(`Não foi possível inspecionar lru-media-storage-idb: ${err?.message || String(err)}`);
    }

    // 2) Tenta Cache Storage do navegador (somente leitura)
    try {
      if (typeof caches !== 'undefined' && typeof caches.keys === 'function') {
        const cacheNames = await caches.keys();
        for (const name of cacheNames) {
          const cache = await caches.open(name);
          const keys = await cache.keys();
          for (const req of keys) {
            const url = req.url || '';
            for (const hash of wantedHashes) {
              if (localBytesByHash.has(hash)) continue;
              if (url.includes(encodeURIComponent(hash)) || url.includes(hash)) {
                const res = await cache.match(req);
                if (res && res.ok) {
                  localBytesByHash.set(hash, new Uint8Array(await res.arrayBuffer()));
                  dependenciesUsed.add('browser:cache-storage');
                }
              }
            }
          }
        }
      }
    } catch (err) {
      limitations.push(`Não foi possível inspecionar Cache Storage: ${err?.message || String(err)}`);
    }

    return localBytesByHash;
  }

  async function recoverAudiosForSample(targetAudioEntries, options, dependenciesUsed, limitations) {
    const results = new Map();
    const allowDownload = Boolean(options.allowExplicitMediaDownload);
    const localCacheMap = await inspectLocalAudioCache(
      targetAudioEntries.map((entry) => entry.raw),
      dependenciesUsed,
      limitations
    );

    const queue = [...targetAudioEntries];
    const concurrency = 2;

    async function worker() {
      while (queue.length > 0) {
        const entry = queue.shift();
        if (!entry) break;
        const { messageId, raw } = entry;
        const mimetype = typeof raw.mimetype === 'string' ? raw.mimetype : 'audio/ogg';

        // 1) Primeiro tenta arquivo já presente no cache local
        const cachedPlain = (raw.filehash && localCacheMap.get(raw.filehash)) || null;
        const cachedEnc = (!cachedPlain && raw.encFilehash && localCacheMap.get(raw.encFilehash)) || null;
        if (cachedPlain && cachedPlain.length > 0) {
          try {
          results.set(messageId, {
            status: 'recovered',
            source: 'local-cache',
            dependency: 'indexeddb-or-browser-cache',
            reason: 'Áudio recuperado diretamente do cache local do navegador.',
            byteLength: cachedPlain.length,
            validation: 'decoded',
            dataUrl: await toAudioDataUrl(cachedPlain, mimetype, raw.duration)
          });
          continue;
          } catch { /* Cache inválido: tentar recuperação explícita. */ }
        }
        if (cachedEnc && cachedEnc.length > 0 && raw.mediaKey) {
          try {
            const decrypted = await decryptWhatsAppAudioBytes(cachedEnc.slice().buffer, raw.mediaKey);
            dependenciesUsed.add('webcrypto:hkdf-aes-cbc');
            results.set(messageId, {
              status: 'recovered',
              source: 'local-cache',
              dependency: 'indexeddb-or-browser-cache + webcrypto-hkdf-aes-cbc',
              reason: 'Áudio descriptografado a partir do cache local do navegador.',
              byteLength: decrypted.length,
              validation: 'decoded',
              dataUrl: await toAudioDataUrl(decrypted, mimetype, raw.duration)
            });
            continue;
          } catch {
            // Se falhar no cache local criptografado, cai para o passo seguinte
          }
        }

        // 2) Se download explícito estiver desativado, marca como pendente
        if (!allowDownload) {
          results.set(messageId, {
            status: 'pending',
            source: 'none',
            dependency: 'indexeddb-metadata-only',
            reason: 'Arquivo não encontrado no cache local e download explícito está desativado.',
            byteLength: 0,
            dataUrl: null
          });
          continue;
        }

        // 3) Download explícito do CDN do WhatsApp + descriptografia local via Web Crypto
        const downloadUrl = media.whatsappMediaUrl(raw.directPath, raw.deprecatedMms3Url);

        if (!downloadUrl || !raw.mediaKey) {
          results.set(messageId, {
            status: 'failed',
            source: 'none',
            dependency: 'indexeddb-metadata-only',
            reason: 'Metadados de mídia ausentes no IndexedDB (sem caminho de download ou chave local).',
            byteLength: 0,
            dataUrl: null
          });
          continue;
        }

        try {
          dependenciesUsed.add('explicit-whatsapp-cdn-download');
          dependenciesUsed.add('webcrypto:hkdf-aes-cbc');
          const response = await fetch(downloadUrl, {
            method: 'GET',
            credentials: 'omit',
            redirect: 'error',
            signal: AbortSignal.timeout(15_000)
          });
          if (!response.ok) {
            const hint = response.status === 404 || response.status === 410
              ? 'mídia expirada ou indisponível no servidor do WhatsApp'
              : `erro HTTP ${response.status}`;
            results.set(messageId, {
              status: 'failed',
              source: 'none',
              dependency: 'explicit-whatsapp-cdn-download',
              reason: `Falha no download explícito (${hint}).`,
              byteLength: 0,
              dataUrl: null
            });
            continue;
          }
          const encryptedBuf = await response.arrayBuffer();
          const plainBytes = await decryptWhatsAppAudioBytes(encryptedBuf, raw.mediaKey);
          results.set(messageId, {
            status: 'recovered',
            source: 'explicit-whatsapp-download',
            dependency: 'explicit-whatsapp-cdn-download + webcrypto-hkdf-aes-cbc',
            reason: 'Áudio baixado explicitamente do WhatsApp e descriptografado localmente no navegador.',
            byteLength: plainBytes.length,
            validation: 'decoded',
            dataUrl: await toAudioDataUrl(plainBytes, mimetype, raw.duration)
          });
        } catch (err) {
          const msg = err?.name === 'TimeoutError' || err?.name === 'AbortError'
            ? 'Tempo limite excedido ao baixar o áudio.'
            : `Falha ao baixar/descriptografar áudio (${err?.message || 'erro desconhecido'}).`;
          results.set(messageId, {
            status: 'failed',
            source: 'none',
            dependency: 'explicit-whatsapp-cdn-download + webcrypto-hkdf-aes-cbc',
            reason: msg,
            byteLength: 0,
            dataUrl: null
          });
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length || 1) }, () => worker()));
    return results;
  }

  function triggerJsonDownload(report, filename) {
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  async function run(options = {}) {
    if (location.origin !== 'https://web.whatsapp.com') {
      throw new Error('Execute este script exclusivamente na aba https://web.whatsapp.com.');
    }

    const targetDates = Array.isArray(options.dates) && options.dates.length > 0
      ? options.dates
      : defaultClosedDates();
    core.parseDates(targetDates.join(','));
    const roundLabel = String(options.roundLabel || 'rodada-1-inicial').trim();
    const allowExplicitMediaDownload = options.allowExplicitMediaDownload === true;
    const autoDownloadJson = options.autoDownloadJson !== false;

    const dependenciesUsed = new Set();
    const limitations = [];

    console.info(`[Mônada PoC] Iniciando coleta (${roundLabel}) para datas:`, targetDates, '| download explícito de áudios:', allowExplicitMediaDownload);

    const db = await openIdbReadonly('model-storage');
    let rawMessages = [];
    let rawChats = [];
    let rawContacts = [];
    let storeNames = [];

    try {
      storeNames = Array.from(db.objectStoreNames);
      dependenciesUsed.add('indexeddb:model-storage');

      if (storeNames.includes('message')) {
        rawMessages = await readAllStoreRecords(db, 'message');
      } else {
        limitations.push('Object store "message" não encontrada em model-storage.');
      }

      if (storeNames.includes('chat')) {
        rawChats = await readAllStoreRecords(db, 'chat');
      } else {
        limitations.push('Object store "chat" não encontrada em model-storage; nomes de conversas podem ficar incompletos.');
      }

      if (storeNames.includes('contact')) {
        rawContacts = await readAllStoreRecords(db, 'contact');
      } else {
        limitations.push('Object store "contact" não encontrada em model-storage; nomes de remetentes podem ficar incompletos.');
      }
    } finally {
      db.close();
    }

    const targetDateSet = new Set(targetDates);
    const chatsById = new Map();
    const contactsById = new Map();
    for (const chat of rawChats) {
      const id = extractJidString(chat?.id);
      if (id) chatsById.set(id, chat);
    }
    for (const contact of rawContacts) {
      const id = extractJidString(contact?.id);
      if (id) contactsById.set(id, contact);
    }

    // Identifica áudios das datas selecionadas antes de montar o relatório final
    const targetAudioEntries = [];
    for (const raw of rawMessages) {
      if (!raw || typeof raw !== 'object') continue;
      const fromJid = extractJidString(raw.from);
      const toJid = extractJidString(raw.to);
      const remoteJid = extractJidString(raw.id?.remote);
      const chatJid = remoteJid || (extractFromMe(raw) ? toJid : fromJid) || fromJid || toJid;
      if (isStatusBroadcastJid(chatJid) || isStatusBroadcastJid(fromJid) || isStatusBroadcastJid(toJid)) continue;
      const ts = extractTimestampMs(raw);
      if (!ts) continue;
      const sp = formatSaoPauloParts(ts);
      if (!sp || !targetDateSet.has(sp.date)) continue;
      if (!AUDIO_TYPES.has(String(raw.type || '').toLowerCase())) continue;
      const messageId = extractMessageId(raw);
      if (messageId) targetAudioEntries.push({ messageId, raw });
    }

    const audioResults = options.collectAudio === false ? new Map() : await recoverAudiosForSample(
      targetAudioEntries,
      { allowExplicitMediaDownload },
      dependenciesUsed,
      limitations
    );

    const normalized = core.normalizeIndexedDbSnapshot({ rawMessages, rawChats, rawContacts, targetDates, audioResultsByMessageId: audioResults });
    const { days, ignoredStatusCount, ignoredProtocolEventsCount, invalidTimestampCount } = normalized;
    const sampleChatFieldTypes = describeRecordFieldTypes(rawMessages.find(m => m?.type === 'chat'));
    const sampleAudioFieldTypes = describeRecordFieldTypes(rawMessages.find(m => AUDIO_TYPES.has(m?.type)));
    for (const day of days) day.collection = core.summarizeCollection(day);

    const report = sanitizeObjectForExport({
      schemaVersion: 2,
      extensionVersion: options.extensionVersion || null,
      collectionOptions: { useMainWorld: options.useMainWorld === true, allowExplicitMediaDownload },
      pocMode: 'devtools-indexeddb-local',
      roundLabel,
      collectedAt: new Date().toISOString(),
      timeZone: SAO_PAULO_TZ,
      targetDates,
      allowExplicitMediaDownload,
      disclaimer: 'Os dados abaixo refletem apenas o que estava acessível localmente no WhatsApp Web nesta rodada e não garantem completude em relação ao celular.',
      dependenciesUsed: Array.from(dependenciesUsed),
      limitations,
      inventory: {
        modelStorageStores: storeNames,
        totalRawMessagesScanned: rawMessages.length,
        totalRawChatsScanned: rawChats.length,
        totalRawContactsScanned: rawContacts.length,
        ignoredStatusCount,
        ignoredProtocolEventsCount,
        invalidTimestampCount,
        sampleChatFieldTypes,
        sampleAudioFieldTypes
      },
      days
    });

    window.__MONADA_WA_POC__.lastReport = report;

    console.table(
      days.map((d) => ({
        Data: d.date,
        Conversas: d.messageCoverage.conversationCount,
        Mensagens: d.messageCoverage.messageCount,
        PossivelmenteParciais: d.messageCoverage.possiblyTruncatedConversations.length,
        AudiosLocais: d.audioRecovery.totalAudiosFoundLocally,
        RecuperadosCache: d.audioRecovery.recoveredLocalCache,
        RecuperadosDownload: d.audioRecovery.recoveredExplicitDownload,
        Pendentes: d.audioRecovery.pendingCount,
        Falhos: d.audioRecovery.failedCount,
        ColetaValidada: d.collection.collected ? 'SIM (sem transcrição)' : 'PENDENTE'
      }))
    );

    if (autoDownloadJson) {
      const safeRound = roundLabel.replace(/[^a-zA-Z0-9-_]+/g, '-').toLowerCase();
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      triggerJsonDownload(report, `monada-wa-poc-${safeRound}-${stamp}.json`);
    }

    return report;
  }

  window.__MONADA_WA_POC__ = {
    defaultClosedDates,
    run,
    lastReport: null
  };

  console.info(
    [
      '[Mônada PoC] Coletor carregado com sucesso (somente leitura no IndexedDB).',
      'Datas encerradas sugeridas (America/Sao_Paulo): ' + defaultClosedDates().join(', '),
      '',
      'Exemplo 1 (somente cache local, sem baixar áudios):',
      '  await window.__MONADA_WA_POC__.run({ roundLabel: "rodada-1-inicial", allowExplicitMediaDownload: false })',
      '',
      'Exemplo 2 (tentando cache local primeiro e baixando explicitamente áudios faltantes da amostra):',
      '  await window.__MONADA_WA_POC__.run({ roundLabel: "rodada-1-inicial", allowExplicitMediaDownload: true })',
      '',
      'Exemplo 3 (escolhendo datas encerradas específicas):',
      '  await window.__MONADA_WA_POC__.run({ roundLabel: "rodada-2-pos-reload", dates: ["2026-11-18", "2026-11-17"], allowExplicitMediaDownload: true })'
    ].join('\n')
  );
})();
