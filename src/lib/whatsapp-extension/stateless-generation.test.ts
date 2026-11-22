import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ saved: [] as Record<string, unknown>[], filters: [] as unknown[][] }));
const clientId = '10000000-0000-4000-8000-000000000001';
vi.mock('./server', () => ({ isLocalExtension: () => false, requireExtensionAdmin: async () => actor() }));
import { generateExtensionSummary } from './stateless';

function actor() {
  return { user: { id: 'authenticated-owner' }, profile: { role: 'admin', is_active: true }, db: {
    from(table: string) {
      return {
        select() { return this; }, eq(...args: unknown[]) { state.filters.push([table, ...args]); return this; },
        async maybeSingle() { return { data: null, error: null }; },
        async order() { return { data: table === 'clients' ? [{ id: clientId, name: 'Empresa sintética' }] : [{ id: 'waiting', name: 'Aguardando' }], error: null }; },
        insert(payload: Record<string, unknown>) { state.saved.push(payload); return this; },
        async single() { return { data: { ...state.saved.at(-1), id: 'saved-summary' }, error: null }; },
      };
    },
  } };
}
function input() {
  const base = { id: 'one', type: 'chat', text: 'Demanda operacional sintética', chatJid: 'business@g.us', chatName: 'Empresa sintética',
    senderName: 'Pessoa', senderJid: 'sender@c.us', fromMe: false, timestampMs: Date.parse('2026-11-19T12:00:00Z') };
  return { jobId: 'integration-job', date: '2026-11-19', accountKey: 'a'.repeat(64), transcribeAudio: true,
    partialChats: 0, confirmPending: false, confirmReplace: false, created_by: 'untrusted-actor', messages: [base,
      { ...base, id: 'channel', chatJid: 'channel@newsletter', text: 'Promoção que não deve ir para IA' },
      { ...base, id: 'sticker', type: 'sticker', text: '[Figurinha]' },
      { ...base, id: 'caption', type: 'image', text: '[image] Legenda operacional útil' },
      { ...base, id: 'audio', type: 'ptt', text: '', audio: { status: 'transcribed', transcription: 'Transcrição operacional útil' } },
    ] };
}
function response(clientIndex: number) {
  return { summaries: [{ clientIndex, client_name: 'Empresa sintética', general_summary: 'Resumo sintético', key_points: ['Ponto'],
    suggested_tasks: [{ description: 'Demanda sintética', responsibles: [], status: 'waiting', observations: '' }] }] };
}

describe('geração integrada da extensão com entrada compacta e SDK real', () => {
  beforeEach(() => { state.saved = []; state.filters = []; vi.stubEnv('GEMINI_API_KEY', 'synthetic-integration-key'); });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it('envia Hydrogen/LOW com índices e texto filtrado, e salva UUID somente do cadastro autenticado', async () => {
    const request = vi.fn(async (url: unknown, init?: RequestInit) => {
      expect(String(url)).toContain('/models/gemini-4-hydrogen:generateContent');
      const payload = JSON.parse(String(init?.body));
      expect(payload.generationConfig.thinkingConfig.thinkingLevel).toBe('LOW');
      const prompt = payload.contents[0].parts[0].text as string;
      expect(prompt).toContain('Demanda operacional sintética'); expect(prompt).toContain('Legenda operacional útil');
      expect(prompt).toContain('Transcrição operacional útil'); expect(prompt).toContain('[1,"Empresa sintética"]');
      expect(prompt).not.toContain('Promoção que não deve ir para IA'); expect(prompt).not.toContain('[Figurinha]');
      expect(JSON.stringify(payload)).not.toContain(clientId);
      expect(JSON.stringify(payload.generationConfig.responseJsonSchema)).toContain('clientIndex');
      return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(response(1)) }] }, finishReason: 'STOP' }], modelVersion: 'gemini-4-hydrogen' });
    });
    vi.stubGlobal('fetch', request);
    const body = input(); const unchanged = JSON.stringify(body);
    const saved = await generateExtensionSummary(actor() as unknown as Parameters<typeof generateExtensionSummary>[0], body);
    expect(request).toHaveBeenCalledOnce(); expect(state.saved).toHaveLength(1);
    expect(saved).toMatchObject({ created_by: 'authenticated-owner', raw_text: '', ai_model: 'gemini-4-hydrogen',
      summary_data: { summaries: [{ client_id: clientId }], collection_metadata: { summaryInputVersion: 'compact-v1', summaryInput: { includedMessages: 3, excludedNewsletters: 1, excludedEmpty: 1 } } } });
    expect(JSON.stringify(saved.summary_data.summaries)).not.toContain('clientIndex');
    expect(JSON.stringify(state.saved)).not.toContain('Transcrição operacional útil');
    expect(state.filters).toContainEqual(['whatsapp_summaries', 'created_by', 'authenticated-owner']);
    expect(JSON.stringify(body)).toBe(unchanged);
  });

  it('recusa índice não cadastrado sem persistir ou tentar outro modelo', async () => {
    const request = vi.fn(async () => Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(response(2)) }] } }] }));
    vi.stubGlobal('fetch', request);
    await expect(generateExtensionSummary(actor() as unknown as Parameters<typeof generateExtensionSummary>[0], input())).rejects.toMatchObject({ category: 'invalid_response' });
    expect(request).toHaveBeenCalledOnce(); expect(state.saved).toHaveLength(0);
  });
});
