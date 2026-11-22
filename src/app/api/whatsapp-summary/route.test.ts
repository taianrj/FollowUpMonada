import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  generateWhatsappSummary: vi.fn(),
  insertSummary: vi.fn(),
  updateSummary: vi.fn(),
  readReadyWhatsappMessages: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: mocks.createClient,
}));
vi.mock('@/lib/whatsapp/ready-messages', () => ({
  readReadyWhatsappMessages: mocks.readReadyWhatsappMessages,
}));

vi.mock('@/lib/ai/whatsapp-summary', () => ({ generateWhatsappSummary: mocks.generateWhatsappSummary }));

import { POST } from './route';
import { AiProviderError } from '@/lib/ai/providers';
import { AI_MODELS } from '@/lib/ai/models';

const USER_ID = '0bb5af37-1d24-4e0c-8596-80f582906674';
const SUMMARY_DATE = '2026-08-16';

function createSupabaseMock(existingSummaryId: string | null) {
  const lookupFilters: Array<[string, unknown]> = [];
  const summaryLookup = {
    select: vi.fn(() => summaryLookup),
    eq: vi.fn((column: string, value: unknown) => {
      lookupFilters.push([column, value]);
      return summaryLookup;
    }),
    order: vi.fn(() => summaryLookup),
    limit: vi.fn(() => summaryLookup),
    maybeSingle: vi.fn(async () => ({
      data: existingSummaryId ? { id: existingSummaryId } : null,
      error: null,
    })),
  };

  const insertResult = {
    select: vi.fn(() => insertResult),
    single: vi.fn(async () => ({ data: { id: 'new-summary-id' }, error: null })),
  };
  const updateResult = {
    eq: vi.fn(() => updateResult),
    select: vi.fn(() => updateResult),
    single: vi.fn(async () => ({ data: { id: existingSummaryId }, error: null })),
  };
  mocks.insertSummary.mockImplementation(() => insertResult);
  mocks.updateSummary.mockImplementation(() => updateResult);

  const supabase = {
    auth: {
      getUser: vi.fn(async () => ({ data: { user: { id: USER_ID } } })),
    },
    from: vi.fn((table: string) => {
      if (table === 'profiles') {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({ data: { role: 'admin', is_active: true }, error: null }),
            }),
          }),
        };
      }
      if (table === 'clients' || table === 'statuses') {
        return {
          select: () => ({
            order: async () => ({ data: [], error: null }),
          }),
        };
      }
      if (table === 'whatsapp_summaries') {
        return {
          ...summaryLookup,
          insert: mocks.insertSummary,
          update: mocks.updateSummary,
        };
      }
      throw new Error(`Tabela inesperada no teste: ${table}`);
    }),
  };

  return { supabase, lookupFilters };
}

function summaryRequest(replaceExisting?: boolean) {
  return new Request('http://localhost/api/whatsapp-summary', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: 'Conversa válida para resumir',
      date: SUMMARY_DATE,
      saveToDb: true,
      ...(replaceExisting === undefined ? {} : { replaceExisting }),
    }),
  });
}

describe('POST /api/whatsapp-summary', () => {
  it('não chama a IA se o servidor do WhatsApp ainda bloqueia o dia', async () => {
    mocks.createClient.mockResolvedValue(createSupabaseMock(null).supabase);
    mocks.readReadyWhatsappMessages.mockResolvedValue({ ok: false, status: 409, error: 'Áudio pendente' });
    const response = await POST(new Request('http://localhost/api/whatsapp-summary', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'texto do cliente', date: SUMMARY_DATE, source: 'whatsapp' }),
    }));
    expect(response.status).toBe(409);
    expect(mocks.generateWhatsappSummary).not.toHaveBeenCalled();
    expect(mocks.readReadyWhatsappMessages).toHaveBeenCalledWith(USER_ID, SUMMARY_DATE);
  });

  it('usa as mensagens prontas do servidor em vez do texto fornecido pelo navegador', async () => {
    mocks.createClient.mockResolvedValue(createSupabaseMock(null).supabase);
    mocks.readReadyWhatsappMessages.mockResolvedValue({ ok: true, text: 'conteúdo verificado no servidor' });
    const response = await POST(new Request('http://localhost/api/whatsapp-summary', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'texto injetado pelo navegador', date: SUMMARY_DATE, source: 'whatsapp' }),
    }));
    expect(response.status).toBe(200);
    const prompt = mocks.generateWhatsappSummary.mock.calls[0][0].prompt;
    expect(prompt).toContain('conteúdo verificado no servidor');
    expect(prompt).not.toContain('texto injetado pelo navegador');
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.generateWhatsappSummary.mockResolvedValue({
      data: { summaries: [] },
      provider: 'gemini',
      model: AI_MODELS.whatsappSummary,
    });
  });

  it('bloqueia um segundo resumo do mesmo usuário e dia antes de chamar a IA', async () => {
    const { supabase, lookupFilters } = createSupabaseMock('existing-summary-id');
    mocks.createClient.mockResolvedValue(supabase);

    const response = await POST(summaryRequest());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: 'SUMMARY_ALREADY_EXISTS',
      summaryDate: SUMMARY_DATE,
    });
    expect(lookupFilters).toContainEqual(['created_by', USER_ID]);
    expect(lookupFilters).toContainEqual(['summary_date', SUMMARY_DATE]);
    expect(mocks.generateWhatsappSummary).not.toHaveBeenCalled();
    expect(mocks.insertSummary).not.toHaveBeenCalled();
    expect(mocks.updateSummary).not.toHaveBeenCalled();
  });

  it('substitui o registro existente somente após autorização explícita', async () => {
    const { supabase } = createSupabaseMock('existing-summary-id');
    mocks.createClient.mockResolvedValue(supabase);

    const response = await POST(summaryRequest(true));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      savedInDb: true,
      replacedExisting: true,
      summaryId: 'existing-summary-id',
    });
    expect(mocks.generateWhatsappSummary).toHaveBeenCalledOnce();
    expect(mocks.updateSummary).toHaveBeenCalledOnce();
    expect(mocks.insertSummary).not.toHaveBeenCalled();
  });

  it.each([
    AI_MODELS.whatsappSummary,
    'gemini-4-hydrogen-001',
    'gemini-4-hydrogen-002',
  ])('registra em ai_model o modelo que realmente gerou a resposta: %s', async (model) => {
    const { supabase } = createSupabaseMock(null);
    mocks.createClient.mockResolvedValue(supabase);
    mocks.generateWhatsappSummary.mockResolvedValue({
      data: { summaries: [] },
      provider: 'gemini',
      model,
    });

    const response = await POST(summaryRequest(false));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      savedInDb: true,
      replacedExisting: false,
      summaryId: 'new-summary-id',
    });
    expect(mocks.insertSummary).toHaveBeenCalledWith(expect.objectContaining({
      ai_provider: 'gemini',
      ai_model: model,
    }));
    expect(mocks.updateSummary).not.toHaveBeenCalled();
  });

  it('delega ao gerador Hydrogen centralizado sem configuração de fallback da aplicação', async () => {
    mocks.createClient.mockResolvedValue(createSupabaseMock(null).supabase);
    await POST(summaryRequest(false));
    expect(mocks.generateWhatsappSummary).toHaveBeenCalledOnce();
    const generationOptions = mocks.generateWhatsappSummary.mock.calls[0][0];
    expect(generationOptions).toMatchObject({ geminiApiKey: process.env.GEMINI_API_KEY });
    expect(generationOptions).not.toHaveProperty('groqApiKey');
    expect(generationOptions).not.toHaveProperty('models');
    expect(generationOptions).not.toHaveProperty('retries');
  });

  it('retorna erro amigável e detalhes seguros após o SDK esgotar o Hydrogen', async () => {
    mocks.createClient.mockResolvedValue(createSupabaseMock(null).supabase);
    mocks.generateWhatsappSummary.mockImplementation(async (options) => {
      const error = new AiProviderError('gemini', 'provider_error', 'Falha HTTP 503; api_key=segredo-nao-pode-vazar', 503);
      options.onFailure?.(error);
      throw error;
    });
    const response = await POST(summaryRequest(false));
    const body = await response.json();
    expect(response.status).toBe(502);
    expect(body).toMatchObject({
      error: 'Não foi possível gerar o resumo com o Gemini Hydrogen.',
      code: 'AI_PROVIDER_FAILURE',
      details: { type: 'ai_provider', attempts: [{ provider: 'gemini', model: AI_MODELS.whatsappSummary,
        category: 'provider_error', status: 503, message: 'Falha HTTP 503; api_key=[REMOVIDO]' }] },
    });
    expect(body.requestId).toEqual(expect.any(String));
    expect(JSON.stringify(body)).not.toContain('segredo-nao-pode-vazar');
    expect(mocks.insertSummary).not.toHaveBeenCalled();
    expect(mocks.updateSummary).not.toHaveBeenCalled();
  });

  it('inclui um identificador e diagnóstico seguro quando a falha não vem da API de IA', async () => {
    mocks.createClient.mockRejectedValue(new Error('falha interna com dados que não devem sair'));

    const response = await POST(summaryRequest(false));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      code: 'SUMMARY_PROCESSING_FAILURE',
      details: {
        type: 'application',
        message: 'Falha interna fora da comunicação com os provedores de IA.',
      },
      requestId: expect.any(String),
    });
  });
});
