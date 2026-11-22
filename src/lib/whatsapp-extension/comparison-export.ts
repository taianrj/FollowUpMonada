import { validateMessage, validDate } from '../../../workers/whatsapp-extension/domain.mjs';
import type { ExtensionJob } from './contracts';

export function buildComparisonExport(job: ExtensionJob, clients: { id: string; name: string }[], statuses: { id: string; name: string }[]) {
  if (!validDate(job.date) || !job.messages?.length) throw new Error('Não há uma importação local para exportar nesta data.');
  const seen = new Set<string>();
  const messages = job.messages.map(raw => {
    const message = validateMessage(raw, job.date);
    if (seen.has(message.id)) throw new Error('A importação contém mensagens duplicadas.');
    seen.add(message.id);
    const text = raw.audio?.transcription;
    return { ...message, audio: message.audio ? {
      status: raw.audio?.status === 'transcribed' && typeof text === 'string' && text.trim() && text.length <= 20000 ? 'transcribed' : 'pending',
      transcription: raw.audio?.status === 'transcribed' && typeof text === 'string' && text.trim() && text.length <= 20000 ? text : null,
    } : null };
  });
  return { format: 'monada-summary-comparison', version: 1, date: job.date, partialChats: job.partialChats,
    transcribeAudio: job.transcribeAudio, messages,
    clients: clients.map(({ id, name }) => ({ id, name })), statuses: statuses.map(({ id, name }) => ({ id, name })) };
}
