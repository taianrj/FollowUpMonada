import { ThinkingLevel } from '@google/genai';
import { describe, expect, it, vi } from 'vitest';
import { AI_MODELS } from './models';
import {
  AiProviderError,
  generateGroqText,
  generateStructuredWithFallback,
  getPublicAiErrorDetails,
} from './providers';
import { buildParseTasksSchema, parseTasksOutput } from './schemas';

const statuses = ['aguardando cliente'];
const validResponse = JSON.stringify({
  tasks: [{
    client_name: 'Acme',
    description: 'Enviar relatório',
    responsibles: [],
    status: 'aguardando cliente',
    observations: '',
  }],
});

describe('fallback dos provedores de IA', () => {
  it('usa e valida a resposta da Groq quando o Gemini falha', async () => {
    const generateGeminiText = vi.fn().mockRejectedValue(new Error('Gemini indisponível'));
    const generateGroqText = vi.fn().mockResolvedValue(validResponse);

    const result = await generateStructuredWithFallback({
      geminiApiKey: 'gemini-test-key',
      groqApiKey: 'groq-test-key',
      geminiModel: AI_MODELS.parseTasks,
      prompt: 'prompt',
      schema: buildParseTasksSchema(statuses),
      thinkingLevel: ThinkingLevel.MINIMAL,
      validate: (value) => parseTasksOutput(value, statuses),
    }, { generateGeminiText, generateGroqText });

    expect(generateGeminiText).toHaveBeenCalledOnce();
    expect(generateGroqText).toHaveBeenCalledOnce();
    expect(result.provider).toBe('groq');
    expect(result.model).toBe(AI_MODELS.groqFallback);
    expect(result.data.tasks).toHaveLength(1);
  });

  it('também aciona fallback quando o Gemini retorna estrutura semanticamente inválida', async () => {
    const generateGeminiText = vi.fn().mockResolvedValue('{"tasks":[{"status":"inválido"}]}');
    const generateGroqText = vi.fn().mockResolvedValue('{"tasks":[]}');

    const result = await generateStructuredWithFallback({
      geminiApiKey: 'gemini-test-key',
      groqApiKey: 'groq-test-key',
      geminiModel: AI_MODELS.parseTasks,
      prompt: 'prompt',
      schema: buildParseTasksSchema(statuses),
      thinkingLevel: ThinkingLevel.MINIMAL,
      validate: (value) => parseTasksOutput(value, statuses),
    }, { generateGeminiText, generateGroqText });

    expect(result).toMatchObject({ provider: 'groq', data: { tasks: [] } });
  });
});

describe('detalhes de erro dos provedores', () => {
  it('preserva a mensagem de erro retornada pela Groq', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: { message: 'O modelo solicitado foi descontinuado' },
    }), { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(generateGroqText({ apiKey: 'groq-test-key', prompt: 'prompt' })).rejects.toMatchObject({
      provider: 'groq',
      status: 400,
      message: 'A Groq respondeu com HTTP 400: O modelo solicitado foi descontinuado.',
    });

    vi.unstubAllGlobals();
  });

  it('remove credenciais dos detalhes que podem ser enviados ao navegador', () => {
    const error = new AiProviderError(
      'gemini',
      'provider_error',
      'Falha em https://example.test?key=chave-secreta Authorization: Bearer token-secreto',
      500,
    );

    const details = getPublicAiErrorDetails(error);

    expect(details.message).toContain('?key=[REMOVIDO]');
    expect(details.message).toContain('Bearer [REMOVIDO]');
    expect(details.message).not.toContain('chave-secreta');
    expect(details.message).not.toContain('token-secreto');
  });
});
