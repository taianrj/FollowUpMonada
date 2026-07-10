'use strict';

const DEFAULT_TIME_ZONE = 'America/Sao_Paulo';

function normalizeDisplayName(name) {
  if (!name || typeof name !== 'string') return '';
  return name
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanJid(jid) {
  if (!jid || typeof jid !== 'string') return '';
  const trimmed = jid.trim();
  const separator = trimmed.lastIndexOf('@');
  if (separator < 1) return trimmed;
  const user = trimmed.slice(0, separator).split(':')[0];
  const server = trimmed.slice(separator + 1).toLowerCase();
  return user && server ? `${user}@${server}` : '';
}

function jidNumber(jid) {
  return cleanJid(jid).split('@')[0] || '';
}

function ensureUserJid(value, preferredServer = 's.whatsapp.net') {
  if (!value || typeof value !== 'string') return '';
  const cleaned = cleanJid(value);
  if (!cleaned) return '';
  return cleaned.includes('@') ? cleaned : `${cleaned}@${preferredServer}`;
}

function uniqueJids(values) {
  const result = [];
  const seen = new Set();
  for (const value of values || []) {
    const jid = cleanJid(value);
    if (!jid || seen.has(jid)) continue;
    seen.add(jid);
    result.push(jid);
  }
  return result;
}

function isGroupJid(jid) {
  return cleanJid(jid).endsWith('@g.us');
}

function isPnJid(jid) {
  return cleanJid(jid).endsWith('@s.whatsapp.net');
}

function isLidJid(jid) {
  return cleanJid(jid).endsWith('@lid');
}

function isStatusBroadcastJid(jid) {
  return cleanJid(jid) === 'status@broadcast';
}

function isStatusBroadcastMessage(message) {
  const key = message?.key || {};
  return [
    key.remoteJid,
    key.remoteJidAlt,
    message?.remoteJid,
    message?.remoteJidAlt,
    message?.message?.deviceSentMessage?.destinationJid,
    message?.message?.senderKeyDistributionMessage?.groupId
  ].some(isStatusBroadcastJid);
}

function isStoredStatusMessage(message) {
  if (!message || typeof message !== 'object') return false;
  if (message.routingStatus === 'ignored-status' || message.routing_status === 'ignored-status') return true;
  return [
    message.chatJid,
    message.chat_jid,
    ...(Array.isArray(message.chatAliases) ? message.chatAliases : []),
    ...(Array.isArray(message.chat_aliases) ? message.chat_aliases : [])
  ].some(isStatusBroadcastJid);
}

function isSupportedChatJid(jid) {
  return isGroupJid(jid) || isPnJid(jid) || isLidJid(jid);
}

function jidCandidate(value) {
  if (!value || typeof value !== 'string') return '';
  if (value.includes('@')) return cleanJid(value);
  if (!/^\d+$/.test(value)) return '';
  return ensureUserJid(value, value.length >= 14 ? 'lid' : 's.whatsapp.net');
}

function messageChatAliases(message) {
  const key = message?.key || {};
  const deviceDestination = message?.message?.deviceSentMessage?.destinationJid;
  return uniqueJids([
    key.remoteJid,
    key.remoteJidAlt,
    message?.remoteJid,
    message?.remoteJidAlt,
    deviceDestination
  ].map(jidCandidate));
}

function messageParticipantAliases(message, fallbackJid = '') {
  const key = message?.key || {};
  return uniqueJids([
    key.participant,
    key.participantAlt,
    key.participantPn,
    key.participantLid,
    key.senderPn,
    key.senderLid,
    message?.participant,
    message?.participantAlt,
    message?.participantPn,
    message?.participantLid,
    message?.senderPn,
    message?.senderLid,
    fallbackJid
  ].map(jidCandidate));
}

function ownerJidsFromInstance(instance) {
  return uniqueJids([
    ensureUserJid(String(instance?.myJid || ''), 's.whatsapp.net'),
    ensureUserJid(String(instance?.myLid || ''), 'lid'),
    instance?.sock?.user?.id,
    instance?.sock?.user?.lid
  ]);
}

function chooseCanonicalJid(aliases) {
  const values = uniqueJids(aliases);
  return values.find(isGroupJid) || values.find(isPnJid) || values.find(isLidJid) || values[0] || '';
}

function isOwnerJid(jid, ownerJids) {
  const candidate = cleanJid(jid);
  if (!candidate) return false;
  return new Set(uniqueJids(ownerJids)).has(candidate);
}

function resolveMessageRoute(message, options = {}) {
  const ownerJids = uniqueJids(options.ownerJids || []);
  const rawChatAliases = messageChatAliases(message);
  const chatAliases = uniqueJids([...rawChatAliases, ...(options.chatAliases || [])]);
  const fromMe = Boolean(message?.key?.fromMe ?? message?.fromMe);

  if (isStatusBroadcastMessage(message)) {
    const participantAliases = uniqueJids([
      ...messageParticipantAliases(message),
      ...(options.participantAliases || [])
    ]);
    return {
      chatJid: 'status@broadcast',
      chatAliases: ['status@broadcast'],
      participantJid: chooseCanonicalJid(participantAliases),
      participantAliases,
      fromMe,
      routingStatus: 'ignored-status',
      routingIssue: 'Atualização de status do WhatsApp; não é uma conversa.'
    };
  }

  const groupJid = chatAliases.find(isGroupJid);

  if (groupJid) {
    const rawParticipantAliases = messageParticipantAliases(message);
    const participantAliases = uniqueJids([
      ...rawParticipantAliases,
      ...(options.participantAliases || []),
      ...(fromMe ? ownerJids : [])
    ]);
    return {
      chatJid: groupJid,
      chatAliases: uniqueJids([groupJid, ...chatAliases]),
      participantJid: chooseCanonicalJid(participantAliases),
      participantAliases,
      fromMe,
      routingStatus: 'resolved',
      routingIssue: ''
    };
  }

  const ownerSet = new Set(ownerJids);
  const rawParticipantAliases = messageParticipantAliases(message);
  const participantAliasesWithMappings = uniqueJids([
    ...rawParticipantAliases,
    ...(options.participantAliases || [])
  ]);
  const peerChatAliases = chatAliases.filter((jid) => !ownerSet.has(jid));
  const peerParticipantAliases = participantAliasesWithMappings.filter((jid) => !ownerSet.has(jid));
  const peerAliases = uniqueJids([
    ...peerChatAliases,
    ...(!fromMe ? peerParticipantAliases : [])
  ]);
  const resolvedChatAliases = peerAliases.length > 0 ? peerAliases : chatAliases;
  const hasAlternateRoute = Boolean(message?.key?.remoteJidAlt || message?.key?.participantAlt);
  const routingStatus = peerAliases.length > 0
    ? (hasAlternateRoute ? 'resolved-alt' : 'resolved')
    : 'ambiguous-self';
  const routingIssue = routingStatus === 'ambiguous-self'
    ? 'A mensagem direta aponta apenas para identidades do dono da conta.'
    : '';
  const resolvedParticipantAliases = fromMe
    ? ownerJids
    : (peerParticipantAliases.length > 0 ? peerParticipantAliases : peerAliases);

  return {
    chatJid: chooseCanonicalJid(resolvedChatAliases),
    chatAliases: resolvedChatAliases,
    participantJid: chooseCanonicalJid(resolvedParticipantAliases),
    participantAliases: resolvedParticipantAliases,
    fromMe,
    routingStatus,
    routingIssue
  };
}

function isAmbiguousOwnerMessage(message, ownerJids) {
  if (message?.routingStatus === 'ambiguous-self') return true;
  const owners = new Set(uniqueJids(ownerJids));
  if (owners.size === 0 || message?.fromMe) return false;
  const chatJid = cleanJid(message?.chatJid || message?.chat_jid || '');
  const participantJid = cleanJid(message?.participantJid || message?.participant_jid || '');
  return owners.has(chatJid) && (!participantJid || owners.has(participantJid));
}

function messageIdentityKey(message) {
  const id = String(message?.id || message?.message_id || '').trim();
  if (id) return `id:${id}`;
  const existing = String(message?.dedupeKey || message?.dedupe_key || '').trim();
  if (existing) return `dedupe:${existing}`;
  const chat = cleanJid(message?.chatJid || message?.chat_jid || '');
  const participant = cleanJid(message?.participantJid || message?.participant_jid || '');
  const timestamp = String(message?.timestamp || message?.message_timestamp || '');
  const text = String(message?.text || '');
  return `fallback:${chat}|${participant}|${timestamp}|${text}`;
}

function messageRouteScore(message) {
  const statusScore = {
    'resolved-alt': 40,
    mapped: 35,
    resolved: 30,
    legacy: 10,
    'ambiguous-self': 0
  }[message?.routingStatus] ?? 10;
  const aliases = uniqueJids(message?.chatAliases || message?.chat_aliases || []);
  const humanName = normalizeDisplayName(message?.chatName || message?.chat_name || '');
  return statusScore + aliases.length + (humanName && !humanName.includes('@') ? 2 : 0);
}

function preferMessageRoute(first, second) {
  return messageRouteScore(second) > messageRouteScore(first) ? second : first;
}

function conversationAliasKey(message) {
  const aliases = uniqueJids([
    message?.chatJid,
    message?.chat_jid,
    ...(message?.chatAliases || []),
    ...(message?.chat_aliases || [])
  ]);
  return chooseCanonicalJid(aliases) || String(message?.sender || message?.chat_number || '');
}

function dateInTimeZone(value = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  return new Intl.DateTimeFormat('fr-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date(value));
}

function isValidDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const [year, month, day] = String(value).split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

module.exports = {
  DEFAULT_TIME_ZONE,
  chooseCanonicalJid,
  cleanJid,
  conversationAliasKey,
  dateInTimeZone,
  ensureUserJid,
  isAmbiguousOwnerMessage,
  isGroupJid,
  isLidJid,
  isOwnerJid,
  isPnJid,
  isStatusBroadcastJid,
  isStatusBroadcastMessage,
  isStoredStatusMessage,
  isSupportedChatJid,
  isValidDate,
  jidNumber,
  messageChatAliases,
  messageIdentityKey,
  messageParticipantAliases,
  messageRouteScore,
  normalizeDisplayName,
  ownerJidsFromInstance,
  preferMessageRoute,
  resolveMessageRoute,
  uniqueJids
};
