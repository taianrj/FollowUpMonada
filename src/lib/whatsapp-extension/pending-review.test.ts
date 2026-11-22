import { describe, expect, it } from 'vitest';
import type { ExtensionJob } from './contracts';
import { buildPendingReviewData } from './pending-review';

const baseJob = (): ExtensionJob => ({
  id: 'job-1',
  date: '2026-11-12',
  accountId: '5511999999999@c.us',
  state: 'awaiting_confirmation',
  transcribeAudio: true,
  messageCount: 3,
  audioTotal: 2,
  audioTranscribed: 0,
  partialChats: 0,
  revision: 1,
  error: null,
  summary: null,
  consent: { pendingAudio: 2, partialHistory: false, revision: 1, required: true },
  createdAt: Date.parse('2026-11-12T15:00:00Z'),
  messages: [
    {
      id: 'm1',
      chatJid: '5511111111111@c.us',
      chatName: 'Cliente A',
      senderName: 'Cliente A',
      senderJid: '5511111111111@c.us',
      timestampMs: Date.parse('2026-11-12T13:15:00Z'),
      fromMe: false,
      type: 'ptt',
      text: '[Áudio]',
      isForwarded: false,
      quotedMessageId: '',
      audio: { status: 'failed', transcription: null, hash: 'h1', chunks: 2, byteLength: 1000, mimetype: 'audio/ogg', expiresAt: null, attempts: 3, reason: 'Erro 503 na IA.' },
    },
    {
      id: 'm2',
      chatJid: '5511111111111@c.us',
      chatName: 'Cliente A',
      senderName: 'Você',
      senderJid: 'self',
      timestampMs: Date.parse('2026-11-12T13:20:00Z'),
      fromMe: true,
      type: 'chat',
      text: 'Recebido, vou verificar.',
      isForwarded: false,
      quotedMessageId: '',
      audio: null,
    },
    {
      id: 'm3',
      chatJid: '120363000000000001@g.us',
      chatName: 'Grupo B',
      senderName: 'Maria',
      senderJid: '5511222222222@c.us',
      timestampMs: Date.parse('2026-11-12T14:00:00Z'),
      fromMe: false,
      type: 'ptt',
      text: '[Áudio]',
      isForwarded: false,
      quotedMessageId: '',
      audio: { status: 'unavailable', transcription: null, hash: null, chunks: 0, byteLength: 0, mimetype: 'audio/ogg', expiresAt: null, attempts: 0 },
    },
  ],
});

describe('buildPendingReviewData', () => {
  it('separa áudios com falha (reproduzíveis) dos indisponíveis em ordem cronológica', () => {
    const review = buildPendingReviewData(baseJob());
    expect(review.pendingAudioCount).toBe(2);
    expect(review.audioTotal).toBe(2);
    expect(review.pendingAudios).toHaveLength(2);
    expect(review.pendingAudios[0]).toMatchObject({
      messageId: 'm1',
      chatName: 'Cliente A',
      status: 'failed',
      reason: 'Erro 503 na IA.',
      canPlay: true,
      timeLabel: '10:15',
    });
    expect(review.pendingAudios[1]).toMatchObject({
      messageId: 'm3',
      chatName: 'Grupo B',
      status: 'unavailable',
      canPlay: false,
      timeLabel: '11:00',
    });
  });

  it('não lista áudios pendentes quando transcrição está desativada ou já foram ignorados', () => {
    const job = baseJob();
    job.transcribeAudio = false;
    job.consent.pendingAudio = 0;
    expect(buildPendingReviewData(job).pendingAudios).toEqual([]);

    const ignoredJob = baseJob();
    ignoredJob.messages![0].audio!.status = 'ignored';
    ignoredJob.consent.pendingAudio = 1;
    const review = buildPendingReviewData(ignoredJob);
    expect(review.pendingAudios.map((a) => a.messageId)).toEqual(['m3']);
  });
});
