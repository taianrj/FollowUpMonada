/**
 * FollowUp Mônada — PoC WhatsApp Web (Ponte MAIN World — Somente Leitura)
 *
 * Executado apenas quando o usuário habilita explicitamente o uso de módulos
 * internos do WhatsApp Web para:
 *  1. Diagnosticar quais módulos internos existem (nomes/assinaturas, sem PII);
 *  2. Ler o texto descriptografado (body/caption) das mensagens da amostra que
 *     estão criptografadas em repouso em msgRowOpaqueData no IndexedDB;
 *  3. Recuperar áudios da amostra que não estavam no Cache Storage, sem nunca
 *     exportar mediaKey, directPath ou credenciais.
 */
(() => {
  'use strict';

  function safeRequire(moduleName) {
    try {
      if (typeof window.require === 'function') {
        return window.require(moduleName);
      }
    } catch {
      // Módulo inexistente ou ainda não inicializado nesta build
    }
    return null;
  }

  function listKnownModuleNames() {
    const found = [];
    try {
      const debugModules = window.require?.__debug?.modulesMap;
      if (debugModules && typeof debugModules === 'object') {
        for (const name of Object.keys(debugModules)) {
          if (/MsgCollection|ChatCollection|TableMessage|MessageTable|Opaque|DownloadManager|MediaStorage|Decrypt/i.test(name)) {
            found.push(name);
            if (found.length >= 60) break;
          }
        }
      }
    } catch {
      // Sem __debug.modulesMap disponível
    }
    return found;
  }

  function uint8ArrayToBase64(bytes) {
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  }

  const media = window.MonadaWaPocMedia;
  if (!media) throw new Error('Validador de mídia não carregado.');
  const decryptWhatsAppAudioBytes = media.decryptAudio;

  function openModelStorageReadonly() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('model-storage');
      req.onupgradeneeded = () => { req.transaction.abort(); reject(new Error('model-storage inexistente.')); };
      req.onerror = () => reject(req.error || new Error('Falha ao abrir model-storage no MAIN world.'));
      req.onsuccess = () => resolve(req.result);
    });
  }

  function readMessagesByIdsReadonly(db, ids) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction('message', 'readonly');
      const store = tx.objectStore('message');
      const out = new Array(ids.length).fill(null);
      let completed = 0;
      if (ids.length === 0) {
        resolve(out);
        return;
      }
      ids.forEach((id, index) => {
        const req = store.get(id);
        req.onsuccess = () => {
          out[index] = req.result || null;
          completed += 1;
          if (completed === ids.length) resolve(out);
        };
        req.onerror = () => {
          completed += 1;
          if (completed === ids.length) resolve(out);
        };
      });
      tx.onerror = () => reject(tx.error || new Error('Erro na transação readonly de message.'));
    });
  }

  function extractSafeTextFields(msgObj) {
    if (!msgObj || typeof msgObj !== 'object') return null;
    const body = typeof msgObj.body === 'string' ? msgObj.body : '';
    const caption = typeof msgObj.caption === 'string' ? msgObj.caption : '';
    const filename = typeof msgObj.filename === 'string' ? msgObj.filename : '';
    const hasMediaKey = Boolean(msgObj.mediaKey);
    const hasDownloadPath = Boolean(msgObj.directPath || msgObj.deprecatedMms3Url);
    if (!body && !caption && !filename && !hasMediaKey && !hasDownloadPath) return null;
    return { body, caption, filename, hasMediaKey, hasDownloadPath };
  }

  async function resolveViaMainWorld(request) {
    const messageIds = Array.isArray(request?.messageIds) ? request.messageIds : [];
    const audioIdsNeedingRecovery = new Set(Array.isArray(request?.audioIdsNeedingRecovery) ? request.audioIdsNeedingRecovery : []);
    const allowExplicitMediaDownload = request?.allowExplicitMediaDownload === true;

    const dependenciesUsed = new Set();
    const diagnostics = {
      hasWindowRequire: typeof window.require === 'function',
      hasRequireLazy: typeof window.requireLazy === 'function',
      hasWebpackChunk: Array.isArray(window.webpackChunkwhatsapp_web_client),
      probedModules: {},
      matchingModuleNames: listKnownModuleNames(),
      resolvedTextsFromMsgCollection: 0,
      resolvedTextsFromGetMessagesById: 0,
      resolvedTextsFromOpaqueDecrypt: 0,
      resolvedTextsFromMessageTable: 0,
      resolvedAudiosFromMainWorld: 0
    };

    const candidateModuleNames = [
      'WAWebMsgCollection',
      'WAWebChatCollection',
      'WAWebTableMessage',
      'WAWebMessageTable',
      'WAWebDBCreateMessage',
      'WAWebMsgOpaqueData',
      'WAWebMsgModel',
      'WAWebDownloadManager',
      'WAWebMediaStorage'
    ];

    const loaded = {};
    for (const name of candidateModuleNames) {
      const mod = safeRequire(name);
      if (mod) {
        loaded[name] = mod;
        diagnostics.probedModules[name] = Object.keys(mod).slice(0, 15);
      } else {
        diagnostics.probedModules[name] = null;
      }
    }

    const msgCollection = loaded.WAWebMsgCollection?.MsgCollection || loaded.WAWebMsgCollection?.default || null;
    const opaqueDataMod = loaded.WAWebMsgOpaqueData || null;
    const decryptDataInMsgModel = typeof opaqueDataMod?.decryptDataInMsgModel === 'function'
      ? opaqueDataMod.decryptDataInMsgModel
      : null;
    const tableMessageMod = loaded.WAWebTableMessage || loaded.WAWebMessageTable || null;
    const messageTable = typeof tableMessageMod?.getMessageTable === 'function'
      ? tableMessageMod.getMessageTable()
      : null;
    const downloadManager = loaded.WAWebDownloadManager?.downloadManager || loaded.WAWebDownloadManager?.default || null;

    if (decryptDataInMsgModel) {
      diagnostics.decryptFnSource = String(decryptDataInMsgModel).slice(0, 600);
    }
    if (msgCollection) {
      try {
        const proto = Object.getPrototypeOf(msgCollection);
        diagnostics.msgCollectionMethods = proto
          ? Object.getOwnPropertyNames(proto).filter((k) => /msg|get|load|fetch|id|db|table|query/i.test(k)).slice(0, 30)
          : [];
      } catch {
        // ignora
      }
    }

    const textById = {};
    const audioById = {};
    const unresolvedIds = [];
    const rawMsgObjectsForAudio = new Map();
    const audioObjSourceById = new Map();
    const mediaStorageMod = loaded.WAWebMediaStorage || null;

    // 1) Tenta primeiro mensagens já hidratadas em memória (WAWebMsgCollection)
    if (msgCollection && typeof msgCollection.get === 'function') {
      dependenciesUsed.add('main-world:WAWebMsgCollection');
      for (const id of messageIds) {
        try {
          const item = msgCollection.get(id);
          const extracted = extractSafeTextFields(item);
          if (extracted && (extracted.body || extracted.caption || extracted.filename)) {
            textById[id] = {
              body: extracted.body,
              caption: extracted.caption,
              filename: extracted.filename,
              source: 'main-world:WAWebMsgCollection'
            };
            diagnostics.resolvedTextsFromMsgCollection += 1;
          } else {
            unresolvedIds.push(id);
          }
          if (item && audioIdsNeedingRecovery.has(id)) {
            rawMsgObjectsForAudio.set(id, item);
            audioObjSourceById.set(id, 'MsgCollection.get');
          }
        } catch {
          unresolvedIds.push(id);
        }
      }
    } else {
      unresolvedIds.push(...messageIds);
    }

    // 2) Para o restante (não carregado em memória), usa MsgCollection.getMessagesById (que lê e descriptografa msgRowOpaqueData internamente)
    const idsNeedingHydration = Array.from(new Set([
      ...unresolvedIds,
      ...Array.from(audioIdsNeedingRecovery).filter((id) => !rawMsgObjectsForAudio.has(id))
    ]));

    if (msgCollection && typeof msgCollection.getMessagesById === 'function' && idsNeedingHydration.length > 0) {
      dependenciesUsed.add('main-world:WAWebMsgCollection.getMessagesById');
      const chunkSize = 100;
      for (let i = 0; i < idsNeedingHydration.length; i += chunkSize) {
        const batchIds = idsNeedingHydration.slice(i, i + chunkSize);
        try {
          const result = await msgCollection.getMessagesById(batchIds);
          const hydratedList = Array.isArray(result)
            ? result
            : (Array.isArray(result?.messages) ? result.messages : []);

          for (const item of hydratedList) {
            if (!item) continue;
            const itemId = typeof item.id === 'string'
              ? item.id
              : (typeof item.id?._serialized === 'string' ? item.id._serialized : '');
            if (!itemId) continue;
            const extracted = extractSafeTextFields(item);
            if (extracted && (extracted.body || extracted.caption || extracted.filename) && !textById[itemId]) {
              textById[itemId] = {
                body: extracted.body,
                caption: extracted.caption,
                filename: extracted.filename,
                source: 'main-world:WAWebMsgCollection.getMessagesById'
              };
              diagnostics.resolvedTextsFromGetMessagesById += 1;
            }
            if (audioIdsNeedingRecovery.has(itemId) && !rawMsgObjectsForAudio.has(itemId)) {
              rawMsgObjectsForAudio.set(itemId, item);
              audioObjSourceById.set(itemId, 'getMessagesById');
            }
          }

          // Também checa se getMessagesById hidratou itens na própria coleção
          if (typeof msgCollection.get === 'function') {
            for (const id of batchIds) {
              if (textById[id] && (!audioIdsNeedingRecovery.has(id) || rawMsgObjectsForAudio.has(id))) continue;
              const item = msgCollection.get(id);
              if (!item) continue;
              const extracted = extractSafeTextFields(item);
              if (extracted && (extracted.body || extracted.caption || extracted.filename) && !textById[id]) {
                textById[id] = {
                  body: extracted.body,
                  caption: extracted.caption,
                  filename: extracted.filename,
                  source: 'main-world:WAWebMsgCollection.getMessagesById'
                };
                diagnostics.resolvedTextsFromGetMessagesById += 1;
              }
              if (audioIdsNeedingRecovery.has(id) && !rawMsgObjectsForAudio.has(id)) {
                rawMsgObjectsForAudio.set(id, item);
                audioObjSourceById.set(id, 'MsgCollection.afterHydrate');
              }
            }
          }
        } catch (err) {
          if (!diagnostics.getMessagesByIdError) {
            diagnostics.getMessagesByIdError = err?.message || String(err);
          }
        }
      }
    }

    // 2b) Fallback secundário: WAWebMsgOpaqueData.decryptDataInMsgModel caso getMessagesById não tenha resolvido
    const idsNeedingOpaqueDecrypt = idsNeedingHydration.filter(
      (id) => !textById[id] || (audioIdsNeedingRecovery.has(id) && !rawMsgObjectsForAudio.has(id))
    );

    if (decryptDataInMsgModel && idsNeedingOpaqueDecrypt.length > 0) {
      dependenciesUsed.add('main-world:WAWebMsgOpaqueData');
      let db = null;
      try {
        db = await openModelStorageReadonly();
        try {
          const txInfo = db.transaction('message', 'readonly');
          diagnostics.messageStoreKeyPath = txInfo.objectStore('message').keyPath;
        } catch {
          // ignora
        }
        const chunkSize = 200;
        let rawHitsCount = 0;
        for (let i = 0; i < idsNeedingOpaqueDecrypt.length; i += chunkSize) {
          const batchIds = idsNeedingOpaqueDecrypt.slice(i, i + chunkSize);
          const rawRows = await readMessagesByIdsReadonly(db, batchIds);
          for (let idx = 0; idx < batchIds.length; idx += 1) {
            const id = batchIds[idx];
            const rawRow = rawRows[idx];
            if (!rawRow) continue;
            rawHitsCount += 1;
            try {
              const rowCopy = { ...rawRow };
              const decryptedResult = await decryptDataInMsgModel(rowCopy);
              const hydrated = (decryptedResult && typeof decryptedResult === 'object') ? decryptedResult : rowCopy;
              if (!diagnostics.sampleDecryptDebug && String(rawRow.type || '').toLowerCase() === 'chat') {
                diagnostics.sampleDecryptDebug = {
                  hadMsgRowOpaqueData: Boolean(rawRow.msgRowOpaqueData),
                  returnedType: decryptedResult === null ? 'null' : typeof decryptedResult,
                  hydratedBodyType: typeof hydrated?.body,
                  hydratedBodyLen: typeof hydrated?.body === 'string' ? hydrated.body.length : 0,
                  hydratedNewKeys: Object.keys(hydrated || {}).filter((k) => !(k in rawRow)).slice(0, 20)
                };
              }
              const extracted = extractSafeTextFields(hydrated);
              if (extracted && (extracted.body || extracted.caption || extracted.filename) && !textById[id]) {
                textById[id] = {
                  body: extracted.body,
                  caption: extracted.caption,
                  filename: extracted.filename,
                  source: 'main-world:WAWebMsgOpaqueData'
                };
                diagnostics.resolvedTextsFromOpaqueDecrypt += 1;
              }
              if (audioIdsNeedingRecovery.has(id) && !rawMsgObjectsForAudio.has(id)) {
                rawMsgObjectsForAudio.set(id, hydrated);
                audioObjSourceById.set(id, 'opaqueFallback');
              }
            } catch (err) {
              if (!diagnostics.firstOpaqueDecryptError) {
                diagnostics.firstOpaqueDecryptError = err?.message || String(err);
              }
            }
          }
        }
        diagnostics.opaqueDecryptRawHits = rawHitsCount;
      } catch (err) {
        diagnostics.opaqueDecryptDbError = err?.message || String(err);
      } finally {
        if (db) db.close();
      }
    }

    // 2b) Fallback secundário caso WAWebTableMessage exista em outra build
    if (messageTable && unresolvedIds.length > 0 && diagnostics.resolvedTextsFromOpaqueDecrypt === 0) {
      const hasBulkGet = typeof messageTable.bulkGet === 'function';
      const hasGet = typeof messageTable.get === 'function';
      if (hasBulkGet || hasGet) {
        dependenciesUsed.add('main-world:WAWebTableMessage');
        const chunkSize = 200;
        for (let i = 0; i < unresolvedIds.length; i += chunkSize) {
          const batchIds = unresolvedIds.slice(i, i + chunkSize);
          let rows = [];
          try {
            if (hasBulkGet) {
              rows = await messageTable.bulkGet(batchIds);
            } else {
              rows = await Promise.all(batchIds.map((id) => messageTable.get(id).catch(() => null)));
            }
          } catch (err) {
            diagnostics.messageTableError = err?.message || String(err);
            break;
          }
          for (let idx = 0; idx < batchIds.length; idx += 1) {
            const id = batchIds[idx];
            const row = rows?.[idx];
            if (!row) continue;
            const extracted = extractSafeTextFields(row);
            if (!textById[id] && extracted && (extracted.body || extracted.caption || extracted.filename)) {
              textById[id] = {
                body: extracted.body,
                caption: extracted.caption,
                filename: extracted.filename,
                source: 'main-world:WAWebTableMessage'
              };
              diagnostics.resolvedTextsFromMessageTable += 1;
            }
            if (audioIdsNeedingRecovery.has(id) && !rawMsgObjectsForAudio.has(id)) {
              rawMsgObjectsForAudio.set(id, row);
            }
          }
        }
      }
    }

    // 3) Recupera áudios pendentes da amostra (somente se allowExplicitMediaDownload === true)
    diagnostics.pendingAudioDiagnostics = [];
    const readMediaField = (msgObj, mediaObj, field) => {
      for (const source of [msgObj, msgObj?.mediaData, msgObj?.mediaObject, mediaObj]) {
        if (!source || typeof source !== 'object') continue;
        if (source[field] !== undefined && source[field] !== null && source[field] !== '') return source[field];
        if (typeof source.get === 'function') {
          try {
            const val = source.get(field);
            if (val !== undefined && val !== null && val !== '') return val;
          } catch {
            // ignora
          }
        }
      }
      return undefined;
    };

    const coerceDecryptedBytes = async (payload) => {
      if (!payload) return null;
      if (payload instanceof Uint8Array) return payload;
      if (payload instanceof ArrayBuffer) return new Uint8Array(payload);
      if (ArrayBuffer.isView(payload)) return new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
      if (typeof Blob !== 'undefined' && payload instanceof Blob) {
        return new Uint8Array(await payload.arrayBuffer());
      }
      if (typeof payload.forceToBlob === 'function') {
        const blob = await payload.forceToBlob();
        if (blob) return coerceDecryptedBytes(blob);
      }
      if (payload._blob) return coerceDecryptedBytes(payload._blob);
      if (typeof payload.arrayBuffer === 'function') {
        return new Uint8Array(await payload.arrayBuffer());
      }
      if (payload.data) return coerceDecryptedBytes(payload.data);
      return null;
    };

    const findAudioInBrowserCaches = async (hash) => {
      if (!hash || typeof caches === 'undefined' || typeof caches.keys !== 'function') return null;
      try {
        const cacheNames = await caches.keys();
        for (const name of cacheNames) {
          const cache = await caches.open(name);
          const keys = await cache.keys();
          for (const req of keys) {
            const url = req.url || '';
            if (url.includes(encodeURIComponent(hash)) || url.includes(hash)) {
              const res = await cache.match(req);
              if (res && res.ok) {
                return new Uint8Array(await res.arrayBuffer());
              }
            }
          }
        }
      } catch {
        // ignora
      }
      return null;
    };

    if (allowExplicitMediaDownload && audioIdsNeedingRecovery.size > 0) {
      for (const id of audioIdsNeedingRecovery) {
        const msgObj = rawMsgObjectsForAudio.get(id);
        const rawFilehash = readMediaField(msgObj, null, 'filehash');
        let mediaObj = null;
        if (rawFilehash && typeof mediaStorageMod?.getOrCreateMediaObject === 'function') {
          try {
            mediaObj = mediaStorageMod.getOrCreateMediaObject(rawFilehash);
          } catch {
            mediaObj = null;
          }
        }

        const directPath = readMediaField(msgObj, mediaObj, 'directPath');
        const deprecatedMms3Url = readMediaField(msgObj, mediaObj, 'deprecatedMms3Url') || readMediaField(msgObj, mediaObj, 'clientUrl');
        const mediaKey = readMediaField(msgObj, mediaObj, 'mediaKey');
        const encFilehash = readMediaField(msgObj, mediaObj, 'encFilehash');
        const filehash = rawFilehash;
        const mediaKeyTimestamp = readMediaField(msgObj, mediaObj, 'mediaKeyTimestamp');
        const isViewOnce = Boolean(readMediaField(msgObj, mediaObj, 'isViewOnce'));
        const mimetype = typeof readMediaField(msgObj, mediaObj, 'mimetype') === 'string'
          ? readMediaField(msgObj, mediaObj, 'mimetype')
          : 'audio/ogg';
        const cleanMime = mimetype.split(';')[0].trim() || 'audio/ogg';

        const audioDiag = {
          foundMsgObj: Boolean(msgObj),
          objSource: audioObjSourceById.get(id) || 'none',
          isViewOnce,
          hasPathFlag: Boolean(directPath),
          hasLegacyUrlFlag: Boolean(deprecatedMms3Url),
          hasKeyFlag: Boolean(mediaKey),
          hasEncHashFlag: Boolean(encFilehash),
          hasFilehashFlag: Boolean(filehash),
          hasMediaObj: Boolean(mediaObj),
          hasDownloadMediaFn: typeof msgObj?.downloadMedia === 'function',
          outcome: 'unresolved'
        };
        diagnostics.pendingAudioDiagnostics.push(audioDiag);

        if (!msgObj) continue;

        if (isViewOnce && !directPath && !deprecatedMms3Url && !mediaKey) {
          audioDiag.outcome = 'view-once-unavailable';
          audioById[id] = {
            status: 'failed',
            source: 'none',
            dependency: 'main-world:WAWebMsgCollection.getMessagesById',
            reason: 'Áudio de visualização única (isViewOnce) — indisponível após visualização.',
            byteLength: 0,
            dataUrl: null
          };
          continue;
        }

        // 3a) Tenta o método nativo msgObj.downloadMedia() (usa chaves internas sem expô-las)
        if (typeof msgObj.downloadMedia === 'function') {
          try {
            dependenciesUsed.add('main-world:Msg.downloadMedia');
            const downloadPromise = Promise.resolve(
              msgObj.downloadMedia({
                downloadEvenIfExpensive: true,
                rmrReason: 1,
                isUserInitiated: true
              })
            );
            let downloadTimer;
            const timeoutPromise = new Promise((_, reject) =>
              downloadTimer = setTimeout(() => reject(new Error('Tempo limite ao chamar msgObj.downloadMedia.')), 15_000)
            );
            const downloadReturn = await Promise.race([downloadPromise, timeoutPromise]).finally(() => clearTimeout(downloadTimer));

            let bytes =
              (await coerceDecryptedBytes(downloadReturn)) ||
              (await coerceDecryptedBytes(msgObj.mediaData?.mediaBlob)) ||
              (await coerceDecryptedBytes(msgObj.mediaObject?.contentInfo?.blob)) ||
              (await coerceDecryptedBytes(mediaObj?.contentInfo?.blob)) ||
              (await findAudioInBrowserCaches(filehash));

            if (bytes && bytes.length > 0) {
              audioDiag.outcome = 'recovered-msg-downloadMedia';
              audioById[id] = {
                status: 'recovered',
                source: 'explicit-whatsapp-download',
                dependency: 'main-world:Msg.downloadMedia',
                reason: 'Áudio baixado e descriptografado via Msg.downloadMedia do WhatsApp Web (download explícito da amostra).',
                byteLength: bytes.length,
                validation: 'decoded',
                dataUrl: await media.validatedDataUrl(bytes, cleanMime, readMediaField(msgObj, mediaObj, 'duration'))
              };
              diagnostics.resolvedAudiosFromMainWorld += 1;
              continue;
            }
            audioDiag.downloadMediaEmpty = true;
          } catch (err) {
            audioDiag.downloadMediaError = err?.message || String(err);
          }
        }

        // 3b) Tenta downloadManager interno do WhatsApp Web se disponível
        if (downloadManager && typeof downloadManager.downloadAndMaybeDecrypt === 'function' && directPath && mediaKey) {
          try {
            dependenciesUsed.add('main-world:WAWebDownloadManager');
            const decrypted = await downloadManager.downloadAndMaybeDecrypt({
              directPath,
              encFilehash,
              filehash,
              mediaKey,
              mediaKeyTimestamp,
              type: readMediaField(msgObj, mediaObj, 'type') || 'ptt',
              signal: AbortSignal.timeout(15_000)
            });
            const bytes = await coerceDecryptedBytes(decrypted);
            if (bytes && bytes.length > 0) {
              audioDiag.outcome = 'recovered-download-manager';
              audioById[id] = {
                status: 'recovered',
                source: 'explicit-whatsapp-download',
                dependency: 'main-world:WAWebDownloadManager',
                reason: 'Áudio recuperado via downloadManager interno do WhatsApp Web (download explícito da amostra).',
                byteLength: bytes.length,
                validation: 'decoded',
                dataUrl: await media.validatedDataUrl(bytes, cleanMime, readMediaField(msgObj, mediaObj, 'duration'))
              };
              diagnostics.resolvedAudiosFromMainWorld += 1;
              continue;
            }
            audioDiag.downloadManagerReturnedType = decrypted === null ? 'null' : typeof decrypted;
          } catch (err) {
            audioDiag.downloadManagerError = err?.message || String(err);
            diagnostics.lastDownloadManagerError = err?.message || String(err);
          }
        }

        // 3b) Fallback: download explícito direto do CDN usando directPath/mediaKey descriptografados em memória + Web Crypto
        const downloadUrl = media.whatsappMediaUrl(directPath, deprecatedMms3Url);

        if (downloadUrl && mediaKey) {
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
              audioDiag.outcome = `cdn-http-${response.status}`;
              audioById[id] = {
                status: 'failed',
                source: 'none',
                dependency: 'main-world-metadata + explicit-whatsapp-cdn-download',
                reason: `Falha no download explícito (${hint}).`,
                byteLength: 0,
                dataUrl: null
              };
              continue;
            }
            const encryptedBuf = await response.arrayBuffer();
            const plainBytes = await decryptWhatsAppAudioBytes(encryptedBuf, mediaKey);
            audioDiag.outcome = 'recovered-cdn-webcrypto';
            audioById[id] = {
              status: 'recovered',
              source: 'explicit-whatsapp-download',
              dependency: 'main-world-metadata + explicit-whatsapp-cdn-download + webcrypto-hkdf-aes-cbc',
              reason: 'Áudio baixado explicitamente do WhatsApp e descriptografado localmente no navegador.',
              byteLength: plainBytes.length,
              validation: 'decoded',
              dataUrl: await media.validatedDataUrl(plainBytes, cleanMime, readMediaField(msgObj, mediaObj, 'duration'))
            };
            diagnostics.resolvedAudiosFromMainWorld += 1;
          } catch (err) {
            audioDiag.outcome = 'cdn-error';
            audioDiag.cdnError = err?.message || String(err);
            audioById[id] = {
              status: 'failed',
              source: 'none',
              dependency: 'main-world-metadata + explicit-whatsapp-cdn-download',
              reason: `Falha ao baixar/descriptografar áudio (${err?.message || 'erro desconhecido'}).`,
              byteLength: 0,
              dataUrl: null
            };
          }
        }
      }
    }

    return {
      dependenciesUsed: Array.from(dependenciesUsed),
      diagnostics,
      textById,
      audioById
    };
  }

  window.__MONADA_WA_POC_MAIN__ = {
    resolveViaMainWorld
  };
})();
