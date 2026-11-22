import { describe, expect, it } from 'vitest';
import { prepareWhatsappSummaryInput, decodeWhatsappSummaryClients } from './whatsapp-summary-input';

const clients = [{ id: '10000000-0000-4000-8000-000000000001', name: 'Cliente Teste' }];
const statuses = [{ id: 'waiting', name: 'Aguardando' }, { id: 'done', name: 'Resolvido' }];
const message = (overrides = {}) => ({ chatJid: 'a@c.us', chatName: 'Nome repetido', senderJid: 'sender@c.us', senderName: 'Pessoa', fromMe: false,
  timestampMs: Date.parse('2026-11-18T12:00:00Z'), type: 'chat', text: 'Demanda concreta sintética', audio: null, ...overrides });
const job = (messages = [message()]) => ({ date: '2026-11-18', messages, transcribeAudio: true, warnings: [] });
const summary = (clientIndex: unknown = 1) => ({ summaries: [{ clientIndex, client_name: 'Cliente Teste', general_summary: 'Resumo', key_points: [], suggested_tasks: [] }] });

describe('entrada enxuta do resumo, sem alterar histórico', () => {
  it('omite somente canais/sem conteúdo e preserva legenda, texto de tipo desconhecido e transcrição', () => {
    const input = job([message({ chatJid: 'channel@newsletter', text: 'promoção omitida' }), message({ type: 'sticker', text: '[Figurinha]' }),
      message({ type: 'image', text: '[image] Legenda útil' }), message({ type: 'unknown', text: 'Texto útil desconhecido' }),
      message({ type: 'ptt', text: '', audio: { transcription: 'Transcrição útil' } })]);
    const original = JSON.stringify(input);
    const prepared = prepareWhatsappSummaryInput(input, clients, statuses);
    expect(prepared.stats).toMatchObject({ originalMessages: 5, includedMessages: 3, excludedNewsletters: 1, excludedEmpty: 1 });
    expect(prepared.prompt).not.toContain('promoção omitida'); expect(prepared.prompt).not.toContain('[Figurinha]');
    for (const content of ['Legenda útil', 'Texto útil desconhecido', 'Transcrição útil']) expect(prepared.prompt).toContain(content);
    expect(JSON.stringify(input)).toBe(original);
  });
  it('não recupera áudio desativado e mantém ressalvas mesmo após excluir placeholders', () => {
    const input = { ...job([message({ type: 'ptt', text: '', audio: { transcription: 'Não enviar' } })]), transcribeAudio: false,
      warnings: ['Áudios não foram transcritos por opção do usuário.'] };
    const prepared = prepareWhatsappSummaryInput(input, [], statuses);
    expect(prepared.prompt).not.toContain('Não enviar'); expect(prepared.prompt).toContain(input.warnings[0]);
    expect(prepared.stats.includedMessages).toBe(0);
  });
  it('agrupa por ID de conversa, preserva horários/autoria e usa referências sem perder destinatários', () => {
    const long = 'Comunicado longo sintético. '.repeat(20);
    const prepared = prepareWhatsappSummaryInput(job([message({ text: long }), message({ chatJid: 'b@g.us', text: long, fromMe: true }),
      message({ chatJid: 'c@g.us', text: long }), message({ chatJid: 'c@g.us', text: 'Aprovado', fromMe: true })]), [], statuses);
    expect(prepared.prompt.split(long)).toHaveLength(3); // pessoa compartilha uma definição; conta é outro autor
    expect(prepared.prompt).toContain('[Conversa C1: Nome repetido]'); expect(prepared.prompt).toContain('[Conversa C3: Nome repetido]');
    expect(prepared.prompt).toContain('09:00:00 Pessoa: @R1'); expect(prepared.prompt).toContain('09:00:00 Você: Aprovado');
    expect(prepared.stats).toMatchObject({ repeatedReferences: 2, sharedTexts: 1, includedMessages: 4, chats: 3 });
    expect(prepared.prompt).not.toContain('sender@c.us');
  });
  it('não colapsa autores sem identidade, mensagens curtas nem repetições só na mesma conversa', () => {
    const long = 'Texto longo. '.repeat(30);
    for (const messages of [[message({ text: long }), message({ text: long })],
      [message({ text: long, senderJid: '' }), message({ chatJid: 'b@g.us', text: long, senderJid: '' })],
      [message({ text: 'Sim' }), message({ chatJid: 'b@g.us', text: 'Sim' })]]) {
      expect(prepareWhatsappSummaryInput(job(messages), [], statuses).stats.sharedTexts).toBe(0);
    }
  });
  it('envia índices, nunca UUIDs, e restaura somente UUIDs do cadastro confiável', () => {
    const prepared = prepareWhatsappSummaryInput(job(), clients, statuses);
    expect(prepared.prompt).toContain('[1,"Cliente Teste"]'); expect(JSON.stringify(prepared.schema)).toContain('clientIndex');
    expect(prepared.prompt + JSON.stringify(prepared.schema)).not.toContain(clients[0].id);
    expect(decodeWhatsappSummaryClients(summary(), prepared.clientMap, ['waiting'])).toMatchObject({ summaries: [{ client_id: clients[0].id }] });
    expect(decodeWhatsappSummaryClients(summary(null), [], ['waiting'])).toMatchObject({ summaries: [{ client_id: null }] });
  });
  it.each([0, -1, 2, 1.5, true, '1', undefined])('rejeita índice inválido sem inferir outro cliente: %s', index => {
    expect(() => decodeWhatsappSummaryClients({ summaries: [{ ...summary().summaries[0], clientIndex: index }] }, clients.map(c => c.id), ['waiting'])).toThrow();
  });
  it('rejeita UUID devolvido pela IA e conserva validação de status', () => {
    const input = summary(); Object.assign(input.summaries[0], { client_id: clients[0].id });
    expect(() => decodeWhatsappSummaryClients(input, clients.map(c => c.id), ['waiting'])).toThrow();
    expect(() => decodeWhatsappSummaryClients({ summaries: [{ ...summary().summaries[0], suggested_tasks: [{ description: 'Tarefa', responsibles: [], status: 'forged', observations: '' }] }] }, clients.map(c => c.id), ['waiting'])).toThrow();
  });
});
