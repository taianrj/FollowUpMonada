export const LIMITS = Object.freeze({ messages: 10000, text: 20000, audio: 16 * 1024 * 1024, chunk: 96 * 1024, chunks: 172, pendingDays: 7, userBytes: 200 * 1024 * 1024 });
const inputErrorBrand = Symbol.for('monada.extension.InputError');
export class InputError extends Error { constructor(message, status = 400, code = 'INVALID_INPUT') { super(message); this.status = status; this.code = code; this[inputErrorBrand] = true; } }
// O engine local sobrevive ao hot reload; sua classe pode pertencer a outra
// instância do módulo. A marca interna não pode ser forjada por JSON recebido.
export const isInputError = value => value?.[inputErrorBrand] === true && typeof value.message === 'string' && Number.isInteger(value.status) && value.status >= 400 && value.status <= 599 && typeof value.code === 'string';
export const requireValue = (condition, message, status = 400, code) => { if (!condition) throw new InputError(message, status, code); };
export const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value + 'T12:00:00Z')) && new Date(value + 'T12:00:00Z').toISOString().slice(0, 10) === value;
export const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
export async function digest(value) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', typeof value === 'string' ? new TextEncoder().encode(value) : value))).map(b => b.toString(16).padStart(2, '0')).join(''); }
export const safeText = (value, max = LIMITS.text) => { requireValue(typeof value === 'string' && value.length <= max, 'Texto inválido ou muito longo.'); return value; };
export function validateMessage(value, date) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value), 'Mensagem inválida.');
  const id = safeText(value.id, 300), chatJid = safeText(value.chatJid, 150);
  requireValue(id.length > 0 && /^[^\s/@]+@(c\.us|s\.whatsapp\.net|lid|g\.us|broadcast|newsletter)$/.test(chatJid) && chatJid !== 'status@broadcast', 'Conversa inválida.');
  requireValue(typeof value.fromMe === 'boolean', 'Mensagem sem autoria confirmada.');
  requireValue(Number.isFinite(value.timestampMs) && value.timestampMs > 0 && new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(value.timestampMs) === date, 'Mensagem fora da data escolhida.');
  const type = safeText(value.type, 50).toLowerCase();
  requireValue(!['protocol', 'message_edit_encrypted'].includes(type), 'Evento de controle não é mensagem.');
  const text = safeText(value.text);
  requireValue(!['chat', 'extended_text'].includes(type) || text.trim().length > 0, 'Há mensagens de texto que não puderam ser lidas. Tente coletar novamente.', 409, 'UNREADABLE_TEXT');
  const audio = ['audio', 'ptt'].includes(type);
  return { id, chatJid, chatName: safeText(value.chatName, 500), senderName: safeText(value.senderName, 500), senderJid: safeText(value.senderJid || '', 150), fromMe: value.fromMe, timestampMs: value.timestampMs, type, text, isForwarded: value.isForwarded === true, quotedMessageId: safeText(value.quotedMessageId || '', 300), audio: audio ? { status: 'pending', transcription: null, hash: null, chunks: 0, byteLength: 0, mimetype: 'audio/ogg', expiresAt: null, attempts: 0 } : null };
}
export function consentRequired(job) {
  const pending = job.transcribeAudio ? job.audioTotal - job.audioTranscribed - (job.audioIgnored || 0) : 0;
  return { pendingAudio: Math.max(0, pending), partialHistory: false, revision: job.revision, required: pending > 0 };
}
export function formattedMessages(messages, transcribeAudio) {
  return messages.map(m => `${new Date(m.timestampMs).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })} | ${m.chatName} | ${m.fromMe ? 'Você' : m.senderName}: ${m.audio ? (m.audio.status === 'ignored' ? '[Áudio ignorado pelo usuário]' : transcribeAudio && m.audio.transcription ? '[Áudio transcrito] ' + m.audio.transcription : '[Áudio não transcrito; conteúdo não incluído]') : m.text}`).join('\n');
}
