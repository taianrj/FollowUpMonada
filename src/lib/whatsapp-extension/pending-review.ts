import type { ExtensionJob } from './contracts';

export interface PendingAudioItem {
  messageId: string;
  chatJid: string;
  chatName: string;
  senderName: string;
  fromMe: boolean;
  timestampMs: number;
  timeLabel: string;
  status: string;
  statusLabel: string;
  reason: string;
  canPlay: boolean;
}

export interface PendingReviewData {
  jobId: string;
  date: string;
  audioTotal: number;
  pendingAudioCount: number;
  pendingAudios: PendingAudioItem[];
}

const AUDIO_STATUS_LABELS: Record<string, string> = {
  failed: 'Falha na transcrição',
  unavailable: 'Indisponível no WhatsApp Web',
  expired: 'Expirado',
  pending: 'Pendente',
  ignored: 'Ignorado',
  disabled: 'Transcrição desativada',
};

const AUDIO_STATUS_DESCRIPTIONS: Record<string, string> = {
  failed: 'Falha na transcrição após tentativas. Você pode ouvir o áudio ou tentar novamente.',
  unavailable: 'Arquivo indisponível no cache/download do WhatsApp Web. Tente reproduzir o áudio no WhatsApp Web e coletar novamente.',
  expired: 'Arquivo temporário removido após sete dias. Colete a data novamente para tentar recuperá-lo.',
  pending: 'Aguardando transcrição.',
  ignored: 'Áudio ignorado pelo usuário.',
  disabled: 'Transcrição desativada nesta importação.',
};

function formatSaoPauloTime(timestampMs: number): string {
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) return '--:--';
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    hour: '2-digit',
    minute: '2-digit',
  }).format(timestampMs);
}

export function buildPendingReviewData(job: ExtensionJob): PendingReviewData {
  const messages = Array.isArray(job.messages) ? [...job.messages] : [];
  messages.sort((a, b) => a.timestampMs - b.timestampMs || a.id.localeCompare(b.id));

  const pendingAudios: PendingAudioItem[] = job.transcribeAudio
    ? messages
        .filter((m) => m.audio && m.audio.status !== 'transcribed' && m.audio.status !== 'ignored')
        .map((m) => {
          const audio = m.audio!;
          const status = audio.status || 'pending';
          return {
            messageId: m.id,
            chatJid: m.chatJid,
            chatName: m.chatName || m.chatJid,
            senderName: m.fromMe ? 'Você' : (m.senderName || m.chatName || 'Contato'),
            fromMe: m.fromMe,
            timestampMs: m.timestampMs,
            timeLabel: formatSaoPauloTime(m.timestampMs),
            status,
            statusLabel: AUDIO_STATUS_LABELS[status] || 'Pendente',
            reason: audio.reason || AUDIO_STATUS_DESCRIPTIONS[status] || 'Não transcrito.',
            canPlay: Number.isInteger(audio.chunks) && audio.chunks > 0 && (status === 'failed' || status === 'pending'),
          };
        })
    : [];

  return {
    jobId: job.id,
    date: job.date,
    audioTotal: job.audioTotal,
    pendingAudioCount: job.consent.pendingAudio,
    pendingAudios,
  };
}
