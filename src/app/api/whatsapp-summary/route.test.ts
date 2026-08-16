import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  generateStructuredWithFallback: vi.fn(),
  insertSummary: vi.fn(),
  updateSummary: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: mocks.createClient,
}));

vi.mock('@/lib/ai/providers', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/ai/providers')>();
  return {
    ...original,
    generateStructuredWithFallback: mocks.generateStructuredWithFallback,
  };
});

import { POST } from './route';
import { AiProviderError } from '@/lib/ai/providers';

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
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.generateStructuredWithFallback.mockResolvedValue({
      data: { summaries: [] },
      provider: 'gemini',
      model: 'gemini-test',
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
    expect(mocks.generateStructuredWithFallback).not.toHaveBeenCalled();
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
    expect(mocks.generateStructuredWithFallback).toHaveBeenCalledOnce();
    expect(mocks.updateSummary).toHaveBeenCalledOnce();
    expect(mocks.insertSummary).not.toHaveBeenCalled();
  });

  it('insere normalmente quando ainda não existe resumo para a data', async () => {
    const { supabase } = createSupabaseMock(null);
    mocks.createClient.mockResolvedValue(supabase);

    const response = await POST(summaryRequest(false));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      savedInDb: true,
      replacedExisting: false,
      summaryId: 'new-summary-id',
    });
    expect(mocks.insertSummary).toHaveBeenCalledOnce();
    expect(mocks.updateSummary).not.toHaveBeenCalled();
  });

  it('retorna os detalhes seguros de cada provedor de IA que falhou', async () => {
    const { supabase } = createSupabaseMock(null);
    mocks.createClient.mockResolvedValue(supabase);
    mocks.generateStructuredWithFallback.mockImplementation(async (options) => {
      options.onGeminiFailure?.(new AiProviderError(
        'gemini',
        'rate_limit',
        'Cota excedida; api_key=segredo-nao-pode-vazar',
        429,
      ));
      throw new AiProviderError('groq', 'provider_error', 'Modelo temporariamente indisponível.', 503);
    });

    const response = await POST(summaryRequest(false));
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body).toMatchObject({
      error: 'Os provedores de IA não conseguiram gerar o resumo.',
      code: 'AI_PROVIDER_FAILURE',
      details: {
        type: 'ai_provider',
        attempts: [
          {
            provider: 'gemini',
            category: 'rate_limit',
            status: 429,
            message: 'Cota excedida; api_key=[REMOVIDO]',
          },
          {
            provider: 'groq',
            category: 'provider_error',
            status: 503,
            message: 'Modelo temporariamente indisponível.',
          },
        ],
      },
    });
    expect(body.requestId).toEqual(expect.any(String));
    expect(JSON.stringify(body)).not.toContain('segredo-nao-pode-vazar');
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
