'use strict';

(function initMonadaWaPocCore(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.MonadaWaPocCore = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createMonadaWaPocCore() {
  const SAO_PAULO_TZ = 'America/Sao_Paulo';
  const AUDIO_TYPES = new Set(['ptt', 'audio']);
  const PROTOCOL_CONTROL_TYPES = new Set(['message_edit_encrypted', 'protocol']);
  const SENSITIVE_KEY_PATTERN = /mediaKey|encFilehash|fileEncSha256|directPath|deprecatedMms3Url|token|cookie|secret|password|auth/i;

  function parseDates(raw) {
    const values = String(raw || '').split(/[,\s;]+/).filter(Boolean);
    if (!values.length || values.length > 31) throw new Error('Informe de 1 a 31 datas válidas.');
    for (const value of values) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value + 'T12:00:00Z')) || new Date(value + 'T12:00:00Z').toISOString().slice(0, 10) !== value) throw new Error('Data de calendário inválida: ' + value);
    }
    return [...new Set(values)];
  }

  function summarizeCollection(day) {
    const messages = (day.conversations || []).flatMap(c => c.messages || []);
    const missingTexts = messages.filter(m => ['chat', 'extended_text'].includes(String(m.type).toLowerCase()) && !String(m.text || '').trim()).length;
    const audios = messages.filter(m => m.audio);
    const unvalidatedAudios = audios.filter(m => m.audio.status !== 'recovered' || m.audio.validation !== 'decoded').length;
    return {
      missingTexts, unvalidatedAudios,
      collected: messages.length > 0 && missingTexts === 0 && unvalidatedAudios === 0,
      summaryReady: false,
      note: 'Coleta local apenas: não confirma histórico completo nem transcrição. Esta PoC não libera resumos.'
    };
  }

  function comparisonConfiguration(report) {
    if (!report?.extensionVersion || !report?.collectionOptions || report.schemaVersion !== 2) return null;
    return JSON.stringify({ version: report.extensionVersion, schema: report.schemaVersion, dates: [...(report.targetDates || [])].sort(), main: report.collectionOptions.useMainWorld === true, download: report.collectionOptions.allowExplicitMediaDownload === true });
  }

  function markAudioPlaybackFailed(day, message) {
    if (!message.audio) return;
    const wasRecovered = message.audio.status === 'recovered';
    message.audio.validation = 'failed';
    message.audio.status = 'failed';
    message.audio.reason = 'Falha de reprodução: áudio não validado.';
    if (wasRecovered && day.audioRecovery) {
      day.audioRecovery.recoveredTotal = Math.max(0, day.audioRecovery.recoveredTotal - 1);
      const sourceCount = message.audio.source === 'local-cache' ? 'recoveredLocalCache' : 'recoveredExplicitDownload';
      day.audioRecovery[sourceCount] = Math.max(0, (day.audioRecovery[sourceCount] || 0) - 1);
      day.audioRecovery.failedCount = (day.audioRecovery.failedCount || 0) + 1;
    }
    day.collection = summarizeCollection(day);
  }

  function formatSaoPauloParts(epochMs) {
    if (!Number.isFinite(epochMs)) return null;
    const date = new Date(epochMs);
    if (!Number.isFinite(date.getTime())) return null;

    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: SAO_PAULO_TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });

    const parts = Object.fromEntries(
      formatter.formatToParts(date).map((part) => [part.type, part.value])
    );
    const hour = parts.hour === '24' ? '00' : parts.hour;
    return {
      date: `${parts.year}-${parts.month}-${parts.day}`,
      time: `${hour}:${parts.minute}:${parts.second}`,
      iso: date.toISOString()
    };
  }

  function shiftCalendarDate(dateStr, deltaDays) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
    if (!match) return null;
    const utc = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + deltaDays);
    const shifted = new Date(utc);
    const year = shifted.getUTCFullYear();
    const month = String(shifted.getUTCMonth() + 1).padStart(2, '0');
    const day = String(shifted.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function defaultClosedDates(nowMs = Date.now(), offsets = [1, 2, 7, 15]) {
    const today = formatSaoPauloParts(nowMs)?.date;
    if (!today) return [];
    return offsets
      .map((daysAgo) => shiftCalendarDate(today, -Math.abs(daysAgo)))
      .filter(Boolean);
  }

  function extractJidString(value) {
    if (!value) return '';
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'object') {
      if (typeof value._serialized === 'string') return value._serialized.trim();
      if (typeof value.id === 'string') return value.id.trim();
      if (typeof value.user === 'string' && typeof value.server === 'string') {
        return `${value.user}@${value.server}`;
      }
    }
    return '';
  }

  function isStatusBroadcastJid(jid) {
    const normalized = extractJidString(jid).toLowerCase();
    return normalized === 'status@broadcast' || normalized.startsWith('status@');
  }

  function isGroupJid(jid) {
    return extractJidString(jid).toLowerCase().endsWith('@g.us');
  }

  function extractMessageId(raw) {
    if (!raw || typeof raw !== 'object') return '';
    if (typeof raw.id === 'string') return raw.id;
    if (raw.id && typeof raw.id === 'object') {
      if (typeof raw.id._serialized === 'string') return raw.id._serialized;
      if (typeof raw.id.id === 'string') return raw.id.id;
    }
    return '';
  }

  function extractFromMe(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (typeof raw.fromMe === 'boolean') return raw.fromMe;
    if (raw.id && typeof raw.id === 'object' && typeof raw.id.fromMe === 'boolean') {
      return raw.id.fromMe;
    }
    if (typeof raw.id === 'string') {
      if (raw.id.startsWith('true_')) return true;
      if (raw.id.startsWith('false_')) return false;
    }
    return null;
  }

  function extractTimestampMs(raw) {
    const candidate = Number(raw?.t ?? raw?.timestamp ?? raw?.messageTimestamp);
    if (!Number.isFinite(candidate) || candidate <= 0) return null;
    return candidate > 1e12 ? candidate : candidate * 1000;
  }

  function resolveDisplayName(jid, contactsById, chatsById, fallbackPushName) {
    const cleanJid = extractJidString(jid);
    const contact = contactsById.get(cleanJid);
    const chat = chatsById.get(cleanJid);
    const candidates = [
      chat?.name,
      chat?.formattedTitle,
      contact?.name,
      contact?.shortName,
      contact?.verifiedName,
      contact?.pushname,
      fallbackPushName,
      cleanJid.replace(/@.*/, '')
    ];
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim()) {
        return candidate.trim();
      }
    }
    return 'Desconhecido';
  }

  function extractMessageText(raw) {
    const type = String(raw?.type || 'chat').toLowerCase();
    if (type === 'revoked' || raw?.isRevoked) {
      return '[Mensagem apagada]';
    }
    if (AUDIO_TYPES.has(type)) {
      const duration = Number(raw?.duration);
      return Number.isFinite(duration) && duration > 0
        ? `[Áudio - ${Math.round(duration)}s]`
        : '[Áudio]';
    }
    const body = typeof raw?.body === 'string' ? raw.body.trim() : '';
    const caption = typeof raw?.caption === 'string' ? raw.caption.trim() : '';
    if (type === 'chat' || type === 'extended_text') {
      return body || caption || '';
    }
    const labels = {
      image: '[Imagem]',
      video: '[Vídeo]',
      sticker: '[Figurinha]',
      document: '[Documento]',
      location: '[Localização]',
      vcard: '[Contato]',
      multi_vcard: '[Contatos]',
      call_log: '[Chamada]',
      poll_creation: '[Enquete]'
    };
    const prefix = labels[type] || `[${type}]`;
    const textPart = caption || (type === 'document' && raw?.filename ? String(raw.filename) : '');
    return textPart ? `${prefix} ${textPart}` : prefix;
  }

  function isAudioMessageRecord(raw) {
    return AUDIO_TYPES.has(String(raw?.type || '').toLowerCase());
  }

  function sanitizeObjectForExport(value) {
    if (Array.isArray(value)) {
      return value.map((item) => sanitizeObjectForExport(item));
    }
    if (value && typeof value === 'object') {
      const out = {};
      for (const [key, val] of Object.entries(value)) {
        if (SENSITIVE_KEY_PATTERN.test(key)) continue;
        out[key] = sanitizeObjectForExport(val);
      }
      return out;
    }
    return value;
  }

  function normalizeIndexedDbSnapshot({
    rawMessages = [],
    rawChats = [],
    rawContacts = [],
    targetDates = [],
    audioResultsByMessageId = new Map()
  }) {
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

    let ignoredStatusCount = 0;
    let ignoredProtocolEventsCount = 0;
    let invalidTimestampCount = 0;
    const earliestTimestampByChat = new Map();
    const selectedByDate = new Map(targetDates.map((date) => [date, []]));
    const seenIdsByDate = new Map(targetDates.map((date) => [date, new Set()]));
    const duplicateIdsByDate = new Map(targetDates.map((date) => [date, []]));

    for (const raw of rawMessages) {
      if (!raw || typeof raw !== 'object') continue;
      const lowerType = String(raw.type || '').toLowerCase();
      if (PROTOCOL_CONTROL_TYPES.has(lowerType)) {
        ignoredProtocolEventsCount += 1;
        continue;
      }
      const fromJid = extractJidString(raw.from);
      const toJid = extractJidString(raw.to);
      const remoteJid = extractJidString(raw.id?.remote);
      const rawChatJid = remoteJid || (extractFromMe(raw) ? toJid : fromJid) || fromJid || toJid;

      if (isStatusBroadcastJid(rawChatJid) || isStatusBroadcastJid(fromJid) || isStatusBroadcastJid(toJid)) {
        ignoredStatusCount += 1;
        continue;
      }

      const timestampMs = extractTimestampMs(raw);
      if (!timestampMs) {
        invalidTimestampCount += 1;
        continue;
      }

      const prevEarliest = earliestTimestampByChat.get(rawChatJid);
      if (prevEarliest === undefined || timestampMs < prevEarliest) {
        earliestTimestampByChat.set(rawChatJid, timestampMs);
      }

      const sp = formatSaoPauloParts(timestampMs);
      if (!sp || !targetDateSet.has(sp.date)) continue;

      const messageId = extractMessageId(raw) || `${rawChatJid}:${timestampMs}:${selectedByDate.get(sp.date).length}`;
      const seenSet = seenIdsByDate.get(sp.date);
      if (seenSet.has(messageId)) {
        duplicateIdsByDate.get(sp.date).push(messageId);
        continue;
      }
      seenSet.add(messageId);

      const fromMe = extractFromMe(raw);
      const group = isGroupJid(rawChatJid);
      const participantJid = group
        ? extractJidString(raw.author || raw.participant || (fromMe ? '' : fromJid))
        : (fromMe ? '' : rawChatJid);
      const chatName = resolveDisplayName(rawChatJid, contactsById, chatsById, raw.notifyName);
      const senderName = fromMe === true
        ? 'Você'
        : resolveDisplayName(participantJid || rawChatJid, contactsById, chatsById, raw.notifyName);

      const isAudio = isAudioMessageRecord(raw);
      const audioOutcome = isAudio ? (audioResultsByMessageId.get(messageId) || null) : null;

      selectedByDate.get(sp.date).push({
        id: messageId,
        chatJid: rawChatJid,
        chatName,
        isGroup: group,
        date: sp.date,
        time: sp.time,
        timestampIso: sp.iso,
        timestampMs,
        fromMe,
        senderJid: participantJid || (fromMe ? 'self' : rawChatJid),
        senderName,
        type: String(raw.type || 'chat'),
        text: extractMessageText(raw),
        isEdited: Boolean(raw.latestEditMsgKey || raw.editMsgType),
        isRevoked: String(raw.type || '').toLowerCase() === 'revoked' || Boolean(raw.isRevoked),
        isForwarded: Boolean(raw.isForwarded),
        quotedMessageId: extractMessageId({ id: raw.quotedStanzaID || raw.quotedMsgId || '' }) || (typeof raw.quotedStanzaID === 'string' ? raw.quotedStanzaID : ''),
        audio: isAudio ? {
          durationSec: Number.isFinite(Number(raw.duration)) ? Number(raw.duration) : null,
          mimetype: typeof raw.mimetype === 'string' ? raw.mimetype : 'audio/ogg',
          hasLocalMediaMetadata: Boolean(raw.filehash || raw.encFilehash || raw.directPath || raw.deprecatedMms3Url || raw.mediaKey),
          status: audioOutcome?.status || 'pending',
          source: audioOutcome?.source || 'none',
          dependency: audioOutcome?.dependency || 'indexeddb-metadata-only',
          reason: audioOutcome?.reason || 'Áudio ainda não processado.',
          byteLength: audioOutcome?.byteLength || 0,
          validation: audioOutcome?.validation || 'unverified',
          dataUrl: audioOutcome?.dataUrl || null
        } : null
      });
    }

    const days = targetDates.map((date) => {
      const messages = selectedByDate.get(date) || [];
      messages.sort((a, b) => a.timestampMs - b.timestampMs || a.id.localeCompare(b.id));

      const conversationsMap = new Map();
      for (const msg of messages) {
        if (!conversationsMap.has(msg.chatJid)) {
          const earliestMs = earliestTimestampByChat.get(msg.chatJid);
          const earliestSp = earliestMs ? formatSaoPauloParts(earliestMs) : null;
          const possiblyTruncated = Boolean(earliestSp && earliestSp.date === date);
          conversationsMap.set(msg.chatJid, {
            chatJid: msg.chatJid,
            chatName: msg.chatName,
            isGroup: msg.isGroup,
            earliestLocalDate: earliestSp?.date || null,
            earliestLocalTime: earliestSp?.time || null,
            possiblyTruncatedOnDate: possiblyTruncated,
            messageCount: 0,
            audioCount: 0,
            messages: []
          });
        }
        const conv = conversationsMap.get(msg.chatJid);
        conv.messages.push(msg);
        conv.messageCount += 1;
        if (msg.audio) conv.audioCount += 1;
      }

      const conversations = Array.from(conversationsMap.values()).sort((a, b) => {
        const lastA = a.messages[a.messages.length - 1]?.timestampMs || 0;
        const lastB = b.messages[b.messages.length - 1]?.timestampMs || 0;
        return lastB - lastA;
      });

      const audioMessages = messages.filter((msg) => Boolean(msg.audio));
      const recoveredLocalCache = audioMessages.filter((msg) => msg.audio.status === 'recovered' && msg.audio.source === 'local-cache').length;
      const recoveredExplicitDownload = audioMessages.filter((msg) => msg.audio.status === 'recovered' && msg.audio.source === 'explicit-whatsapp-download').length;
      const recoveredTotal = audioMessages.filter((msg) => msg.audio.status === 'recovered').length;
      const pendingAudio = audioMessages.filter((msg) => msg.audio.status === 'pending').length;
      const failedAudio = audioMessages.filter((msg) => msg.audio.status === 'failed').length;
      const blockedByAudio = pendingAudio > 0 || failedAudio > 0;

      return {
        date,
        messageCoverage: {
          conversationCount: conversations.length,
          messageCount: messages.length,
          duplicateIdsDetected: duplicateIdsByDate.get(date) || [],
          possiblyTruncatedConversations: conversations
            .filter((conv) => conv.possiblyTruncatedOnDate)
            .map((conv) => ({
              chatJid: conv.chatJid,
              chatName: conv.chatName,
              earliestLocalTime: conv.earliestLocalTime
            })),
          note: 'Dados obtidos apenas do armazenamento local do WhatsApp Web; não garantem histórico completo do celular.'
        },
        audioRecovery: {
          totalAudiosFoundLocally: audioMessages.length,
          recoveredTotal,
          recoveredLocalCache,
          recoveredExplicitDownload,
          pendingCount: pendingAudio,
          failedCount: failedAudio,
          wouldBeReadyUnderBlockingRule: false,
          blockingReason: messages.length === 0
            ? 'Nenhuma mensagem encontrada localmente nesta data.'
            : blockedByAudio
              ? `${pendingAudio} pendente(s) e ${failedAudio} com falha — dia ficaria bloqueado pela regra atual.`
              : null
        },
        conversations
      };
    });

    return sanitizeObjectForExport({
      ignoredStatusCount,
      ignoredProtocolEventsCount,
      invalidTimestampCount,
      days
    });
  }

  function indexMessagesById(dayReport) {
    const map = new Map();
    for (const conv of dayReport?.conversations || []) {
      for (const msg of conv.messages || []) {
        map.set(msg.id, msg);
      }
    }
    return map;
  }

  function compareRounds(baselineReport, candidateReport) {
    const configurationCompatible = comparisonConfiguration(baselineReport) !== null && comparisonConfiguration(baselineReport) === comparisonConfiguration(candidateReport);
    const baselineDays = new Map((baselineReport?.days || []).map((day) => [day.date, day]));
    const candidateDays = new Map((candidateReport?.days || []).map((day) => [day.date, day]));
    const allDates = Array.from(new Set([...baselineDays.keys(), ...candidateDays.keys()])).sort();

    const perDate = allDates.map((date) => {
      const baseDay = baselineDays.get(date);
      const nextDay = candidateDays.get(date);
      const baseMessages = indexMessagesById(baseDay);
      const nextMessages = indexMessagesById(nextDay);

      const missingInCandidate = [];
      const addedInCandidate = [];
      const realMessageChanges = [];
      const collectionInconsistencies = [];
      const audioStatusChanges = [];

      for (const [id, baseMsg] of baseMessages.entries()) {
        const nextMsg = nextMessages.get(id);
        if (!nextMsg) {
          missingInCandidate.push({
            id,
            chatName: baseMsg.chatName,
            time: baseMsg.time,
            senderName: baseMsg.senderName,
            textPreview: String(baseMsg.text || '').slice(0, 80)
          });
          continue;
        }

        if (baseMsg.fromMe !== nextMsg.fromMe || baseMsg.chatJid !== nextMsg.chatJid || baseMsg.timestampMs !== nextMsg.timestampMs) {
          collectionInconsistencies.push({
            id,
            chatName: nextMsg.chatName,
            reason: 'Metadados estruturais divergentes para o mesmo ID (fromMe, chatJid ou timestamp).'
          });
        }

        if (baseMsg.text !== nextMsg.text) {
          if ((nextMsg.isRevoked && !baseMsg.isRevoked) || (nextMsg.isEdited && !baseMsg.isEdited)) {
            realMessageChanges.push({
              id,
              chatName: nextMsg.chatName,
              time: nextMsg.time,
              changeType: nextMsg.isRevoked ? 'apagada' : 'editada'
            });
          } else {
            collectionInconsistencies.push({
              id,
              chatName: nextMsg.chatName,
              reason: 'Texto divergiu sem marcador de edição ou apagamento.'
            });
          }
        }

        if (baseMsg.audio || nextMsg.audio) {
          const baseStatus = baseMsg.audio?.status || 'none';
          const nextStatus = nextMsg.audio?.status || 'none';
          const baseSource = baseMsg.audio?.source || 'none';
          const nextSource = nextMsg.audio?.source || 'none';
          if (baseStatus !== nextStatus || baseSource !== nextSource) {
            audioStatusChanges.push({
              id,
              chatName: nextMsg.chatName,
              time: nextMsg.time,
              from: `${baseStatus} (${baseSource})`,
              to: `${nextStatus} (${nextSource})`
            });
          }
        }
      }

      for (const [id, nextMsg] of nextMessages.entries()) {
        if (!baseMessages.has(id)) {
          addedInCandidate.push({
            id,
            chatName: nextMsg.chatName,
            time: nextMsg.time,
            senderName: nextMsg.senderName,
            textPreview: String(nextMsg.text || '').slice(0, 80)
          });
        }
      }

      const duplicatesInCandidate = nextDay?.messageCoverage?.duplicateIdsDetected || [];
      const consistentMessages = configurationCompatible &&
        missingInCandidate.length === 0 &&
        addedInCandidate.length === 0 &&
        collectionInconsistencies.length === 0 &&
        duplicatesInCandidate.length === 0;

      return {
        date,
        baselineMessageCount: baseDay?.messageCoverage?.messageCount || 0,
        candidateMessageCount: nextDay?.messageCoverage?.messageCount || 0,
        baselineAudioTotal: baseDay?.audioRecovery?.totalAudiosFoundLocally || 0,
        candidateAudioTotal: nextDay?.audioRecovery?.totalAudiosFoundLocally || 0,
        baselineAudioRecovered: baseDay?.audioRecovery?.recoveredTotal || 0,
        candidateAudioRecovered: nextDay?.audioRecovery?.recoveredTotal || 0,
        missingInCandidate,
        addedInCandidate,
        realMessageChanges,
        collectionInconsistencies,
        duplicatesInCandidate,
        audioStatusChanges,
        consistentMessages
      };
    });

    return {
      configurationCompatible,
      configurationWarning: configurationCompatible ? null : 'Rodadas de versões/opções diferentes ou sem versão: comparação apenas informativa; repita as rodadas na mesma versão.',
      baselineLabel: baselineReport?.roundLabel || 'Rodada base',
      candidateLabel: candidateReport?.roundLabel || 'Rodada comparada',
      perDate
    };
  }

  return {
    SAO_PAULO_TZ,
    parseDates,
    summarizeCollection,
    comparisonConfiguration,
    markAudioPlaybackFailed,
    formatSaoPauloParts,
    shiftCalendarDate,
    defaultClosedDates,
    extractJidString,
    isStatusBroadcastJid,
    isGroupJid,
    extractMessageId,
    extractFromMe,
    extractTimestampMs,
    extractMessageText,
    isAudioMessageRecord,
    sanitizeObjectForExport,
    normalizeIndexedDbSnapshot,
    compareRounds
  };
});
