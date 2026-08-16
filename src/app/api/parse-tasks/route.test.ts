import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  generateStructuredWithFallback: vi.fn(),
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
import { AI_MODELS } from '@/lib/ai/models';

function createSupabaseMock() {
  return {
    auth: {
      getUser: vi.fn(async () => ({ data: { user: { id: 'admin-id' } } })),
    },
    from: vi.fn((table: string) => {
      if (table === 'profiles') {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({
                data: { role: 'admin', is_active: true },
                error: null,
              }),
            }),
          }),
        };
      }
      if (['statuses', 'collaborators', 'clients'].includes(table)) {
        return {
          select: () => ({
            order: async () => ({ data: [], error: null }),
          }),
        };
      }
      throw new Error(`Tabela inesperada no teste: ${table}`);
    }),
  };
}

describe('POST /api/parse-tasks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('GEMINI_API_KEY', 'gemini-test-key');
    vi.stubEnv('GROQ_API_KEY', 'groq-test-key');
    mocks.createClient.mockResolvedValue(createSupabaseMock());
    mocks.generateStructuredWithFallback.mockResolvedValue({
      data: { tasks: [] },
      provider: 'groq',
      model: AI_MODELS.groqFallback,
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('continua configurando o fallback Groq sem usar o helper Gemini-only do resumo', async () => {
    const response = await POST(new Request('http://localhost/api/parse-tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Criar uma demanda de teste' }),
    }));

    expect(response.status).toBe(200);
    expect(mocks.generateStructuredWithFallback).toHaveBeenCalledWith(expect.objectContaining({
      geminiApiKey: 'gemini-test-key',
      groqApiKey: 'groq-test-key',
      geminiModel: AI_MODELS.parseTasks,
    }));
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      count: 0,
      tasks: [],
    });
  });
});
