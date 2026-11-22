import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ saved: null as Record<string, unknown> | null, writes: [] as Record<string, unknown>[], filters: [] as unknown[][], activeUser: 'test-user' }));
vi.mock('@/lib/ai/whatsapp-summary', () => ({ generateWhatsappSummary: vi.fn(async () => ({ data: { summaries: [] }, provider: 'gemini', model: 'test-model' })) }));
vi.mock('./server', () => ({ isLocalExtension: () => false, requireExtensionAdmin: async () => actor(state.activeUser) }));
import { generateWhatsappSummary } from '@/lib/ai/whatsapp-summary';
import { generateExtensionSummary } from './stateless';
function actor(userId = 'test-user') {
  return { user: { id: userId }, profile: { id: userId, role: 'admin', is_active: true }, db: {
    from(table: string) {
      return {
        select() { return this; }, eq(...args: unknown[]) { state.filters.push([table, ...args]); return this; },
        async maybeSingle() { return { data: state.saved, error: null }; },
        async order() { return { data: [], error: null }; },
        update(payload: Record<string, unknown>) { state.writes.push(payload); return this; },
        insert(payload: Record<string, unknown>) { state.writes.push(payload); return this; },
        async single() { return { data: { ...state.writes.at(-1), id: 'summary', created_at: '2026-11-19T12:00:00Z' }, error: null }; }
      };
    }
  } };
}
const body = () => ({ jobId: 'job', date: '2026-11-19', accountKey: 'a'.repeat(64), transcribeAudio: true, partialChats: 0, confirmPending: false, confirmReplace: false, created_by: 'forged', messages: [{ id: 'one', type: 'chat', text: 'Mensagem original sintética', chatJid: 'test@c.us', chatName: 'Teste', senderName: 'Pessoa', senderJid: 'test@c.us', fromMe: false, timestampMs: Date.parse('2026-11-19T12:00:00Z') }] });
const typedActor = () => actor() as unknown as Parameters<typeof generateExtensionSummary>[0];
describe('resumo sem persistência das conversas', () => {
  beforeEach(() => { state.saved = null; state.writes = []; state.filters = []; state.activeUser = 'test-user'; vi.mocked(generateWhatsappSummary).mockClear(); });
  afterEach(() => vi.restoreAllMocks());
  it('grava apenas resultado, metadados e ator autenticado; nunca raw_text', async () => {
    const result = await generateExtensionSummary(typedActor(), body());
    expect(result).toMatchObject({ raw_text: '', created_by: 'test-user' });
    expect(state.writes).toHaveLength(1);
    expect(JSON.stringify(state.writes)).not.toContain('Mensagem original sintética');
    expect(state.filters).toContainEqual(['whatsapp_summaries', 'created_by', 'test-user']);
  });
  it('repetição do mesmo trabalho retorna o resultado salvo sem nova IA ou gravação', async () => {
    state.saved = await generateExtensionSummary(typedActor(), body()) as unknown as Record<string, unknown>;
    state.writes = []; vi.mocked(generateWhatsappSummary).mockClear();
    await generateExtensionSummary(typedActor(), body());
    expect(state.writes).toHaveLength(0);
    expect(generateWhatsappSummary).not.toHaveBeenCalled();
  });
  it('preserva resumo anterior sem confirmação e quando a IA falha', async () => {
    state.saved = { id: 'old', summary_data: { summaries: [] } };
    await expect(generateExtensionSummary(typedActor(), body())).rejects.toMatchObject({ code: 'REPLACE_REQUIRED' });
    vi.mocked(generateWhatsappSummary).mockRejectedValueOnce(new Error('Falha sintética'));
    await expect(generateExtensionSummary(typedActor(), { ...body(), confirmReplace: true })).rejects.toThrow('Falha sintética');
    expect(state.writes).toHaveLength(0);
  });
  it('não salva se a sessão mudar durante a chamada da IA', async () => {
    vi.mocked(generateWhatsappSummary).mockImplementationOnce(async () => { state.activeUser = 'other-user'; return { data: { summaries: [] }, provider: 'gemini', model: 'test-model' }; });
    await expect(generateExtensionSummary(typedActor(), body())).rejects.toMatchObject({ status: 403 });
    expect(state.writes).toHaveLength(0);
  });
  it('filtra apenas a análise, usa clientIndex e não persiste mensagens omitidas', async () => {
    const input = body();
    input.messages.push({ ...input.messages[0], id: 'newsletter', chatJid: 'canal@newsletter', text: 'Promoção privada omitida' });
    const original = JSON.stringify(input);
    await generateExtensionSummary(typedActor(), input);
    const options = vi.mocked(generateWhatsappSummary).mock.calls[0][0];
    expect(options.prompt).toContain('Mensagem original sintética'); expect(options.prompt).not.toContain('Promoção privada omitida');
    expect(JSON.stringify(options.schema)).toContain('clientIndex'); expect(JSON.stringify(options.schema)).not.toContain('client_id');
    expect(state.writes[0].summary_data).toMatchObject({ collection_metadata: { summaryInputVersion: 'compact-v1', summaryInput: { excludedNewsletters: 1, includedMessages: 1 } } });
    expect(JSON.stringify(input)).toBe(original);
  });
  it('não chama IA quando só há canais ou mídias vazias', async () => {
    const input = body(); input.messages[0].chatJid = 'canal@newsletter';
    await expect(generateExtensionSummary(typedActor(), input)).rejects.toMatchObject({ code: 'NO_SUMMARY_TEXT' });
    expect(generateWhatsappSummary).not.toHaveBeenCalled(); expect(state.writes).toHaveLength(0);
  });
  it('resumo da política anterior não é reutilizado silenciosamente nem substituído sem confirmação', async () => {
    state.saved = await generateExtensionSummary(typedActor(), body()) as unknown as Record<string, unknown>;
    const data = state.saved.summary_data as { collection_metadata: Record<string, unknown> };
    delete data.collection_metadata.summaryInputVersion;
    state.writes = []; vi.mocked(generateWhatsappSummary).mockClear();
    await expect(generateExtensionSummary(typedActor(), body())).rejects.toMatchObject({ code: 'REPLACE_REQUIRED' });
    expect(generateWhatsappSummary).not.toHaveBeenCalled(); expect(state.writes).toHaveLength(0);
  });
  it('mescla novas conversas no resumo do mesmo dia quando mergeExisting está ativo', async () => {
    vi.mocked(generateWhatsappSummary)
      .mockResolvedValueOnce({ data: { summaries: [{ client_name: 'Cliente 1', client_id: null, general_summary: 'Resumo 1', key_points: [], suggested_tasks: [] }] }, provider: 'gemini', model: 'test-model' })
      .mockResolvedValueOnce({ data: { summaries: [{ client_name: 'Cliente 2', client_id: null, general_summary: 'Resumo 2', key_points: [], suggested_tasks: [] }] }, provider: 'gemini', model: 'test-model' });
    state.saved = await generateExtensionSummary(typedActor(), body()) as unknown as Record<string, unknown>;
    const secondInput = {
      ...body(),
      jobId: 'job-2',
      mergeExisting: true,
      messages: [{ ...body().messages[0], id: 'two', chatJid: 'other@c.us', chatName: 'Outro Cliente', senderJid: 'other@c.us', senderName: 'Outro Cliente' }],
    };
    const merged = await generateExtensionSummary(typedActor(), secondInput);
    expect(merged.summary_data.summaries.map((s) => s.client_name)).toEqual(['Cliente 1', 'Cliente 2']);
    expect(merged.summary_data.collection_metadata?.includedChatJids).toEqual(['test@c.us', 'other@c.us']);
  });
});
