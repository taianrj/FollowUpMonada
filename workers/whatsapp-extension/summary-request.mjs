import { LIMITS, requireValue, validId, validDate, validateMessage, digest, consentRequired, formattedMessages } from './domain.mjs';

export async function validateSummaryRequest(body) {
  requireValue(validId(body.jobId) && validDate(body.date) && /^[a-f0-9]{64}$/.test(body.accountKey || ''), 'Importação inválida.');
  requireValue(typeof body.transcribeAudio === 'boolean' && typeof body.confirmPending === 'boolean' && typeof body.confirmReplace === 'boolean', 'Confirmações inválidas.');
  requireValue(Array.isArray(body.messages) && body.messages.length > 0 && body.messages.length <= LIMITS.messages, 'Mensagens inválidas.');
  requireValue(Number.isInteger(body.partialChats) && body.partialChats >= 0 && body.partialChats <= body.messages.length, 'Histórico parcial inválido.');
  const seen = new Set();
  const messages = body.messages.map(raw => {
    const message = validateMessage(raw, body.date);
    requireValue(!seen.has(message.id), 'Mensagem duplicada.'); seen.add(message.id);
    if (message.audio && body.transcribeAudio && raw.audio?.status === 'transcribed') {
      requireValue(typeof raw.audio.transcription === 'string' && raw.audio.transcription.trim() && raw.audio.transcription.length <= LIMITS.text, 'Transcrição inválida.');
      message.audio.transcription = raw.audio.transcription.trim(); message.audio.status = 'transcribed';
    } else if (message.audio && body.transcribeAudio && raw.audio?.status === 'ignored') {
      message.audio.status = 'ignored';
    }
    return message;
  });
  const includedChatJids = Array.from(new Set(messages.map(m => m.chatJid).filter(jid => !jid.toLowerCase().endsWith('@newsletter'))));
  const mergeExisting = body.mergeExisting === true;
  const job = { id: body.jobId, date: body.date, accountKey: body.accountKey, transcribeAudio: body.transcribeAudio, partialChats: 0,
    audioTotal: messages.filter(m => m.audio).length, audioTranscribed: messages.filter(m => m.audio?.status === 'transcribed').length, audioIgnored: messages.filter(m => m.audio?.status === 'ignored').length, revision: 0 };
  const consent = consentRequired(job);
  requireValue(!consent.required || body.confirmPending === true, 'Confirme a geração com áudios pendentes.', 409, 'CONFIRM_PENDING');
  const warnings = [!job.transcribeAudio && job.audioTotal ? 'Áudios não foram transcritos por opção do usuário.' : consent.pendingAudio ? `${consent.pendingAudio} áudio(s) não transcrito(s); geração parcial autorizada.` : ''].filter(Boolean);
  const contentHash = await digest(JSON.stringify({ date: job.date, accountKey: job.accountKey, transcribeAudio: job.transcribeAudio, partialChats: 0, mergeExisting, messages }));
  return { ...job, messages, includedChatJids, mergeExisting, consent, warnings, contentHash, text: formattedMessages(messages, job.transcribeAudio), confirmReplace: body.confirmReplace };
}
