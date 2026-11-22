import { describe, expect, it } from 'vitest';
import { buildComparisonExport } from './comparison-export';
import type { ExtensionJob } from './contracts';
const job = () => ({ date: '2026-11-18', partialChats: 1, transcribeAudio: true, messages: [{ id: 'test', type: 'ptt', chatJid: 'test@c.us', chatName: 'Teste', senderName: 'Pessoa', senderJid: 'test@c.us', fromMe: false, text: '', timestampMs: Date.parse('2026-11-18T12:00:00Z'), audio: { status: 'transcribed', transcription: 'Texto sintético', hash: 'private-hash', dataUrl: 'private-media', mediaKey: 'private-key' } }] }) as unknown as ExtensionJob;
describe('exportação privada para comparação', () => {
  it('preserva data/autoria/transcrição e exporta só campos permitidos, sem mídia/chaves', () => {
    const result = buildComparisonExport(job(), [], [{ id: 'waiting', name: 'Aguardando' }]);
    expect(result).toMatchObject({ format: 'monada-summary-comparison', version: 1, date: '2026-11-18', messages: [{ fromMe: false, audio: { transcription: 'Texto sintético' } }] });
    expect(JSON.stringify(result)).not.toMatch(/private-|dataUrl|mediaKey/);
  });
  it('não aceita outra data, status ou duplicatas como conversas válidas', () => {
    const input = job();
    expect(() => buildComparisonExport({ ...input, date: '2026-11-19' }, [], [])).toThrow();
    expect(() => buildComparisonExport({ ...input, messages: [...input.messages!, ...input.messages!] }, [], [])).toThrow();
    input.messages![0].chatJid = 'status@broadcast';
    expect(() => buildComparisonExport(input, [], [])).toThrow();
  });
});
