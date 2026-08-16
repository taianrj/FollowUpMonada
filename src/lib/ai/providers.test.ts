import { ThinkingLevel } from '@google/genai';
import { describe, expect, it, vi } from 'vitest';
import { AI_MODELS } from './models';
import {
  AiProviderError,
  describeAiError,
  generateGroqText,
  generateStructuredWithGeminiFallbacks,
  generateStructuredWithFallback,
  getPublicAiErrorDetails,
} from './providers';
import {
  buildParseTasksSchema,
  buildWhatsappSummarySchema,
  parseTasksOutput,
  parseWhatsappSummaryOutput,
} from './schemas';

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

const validSummaryResponse = JSON.stringify({
  summaries: [{
    client_name: 'Acme',
    client_id: null,
    general_summary: 'Resumo válido',
    key_points: ['Ponto principal'],
    suggested_tasks: [{
      description: 'Enviar relatório',
      responsibles: [],
      status: 'aguardando cliente',
      observations: '',
    }],
  }],
});

const summaryModels = [
  { model: AI_MODELS.whatsappSummary, retries: 3 },
  { model: AI_MODELS.whatsappSummaryFallback, retries: 1 },
  { model: AI_MODELS.whatsappSummaryLastFallback, retries: 0 },
] as const;

function summaryOptions() {
  return {
    geminiApiKey: 'gemini-test-key',
    models: summaryModels,
    prompt: 'prompt',
    schema: buildWhatsappSummarySchema(statuses),
    thinkingLevel: ThinkingLevel.MEDIUM,
    validate: (value: unknown) => parseWhatsappSummaryOutput(value, statuses),
  };
}

function summaryDependencies(generateGeminiText: ReturnType<typeof vi.fn>) {
  return {
    generateGeminiText,
    sleep: vi.fn(async () => undefined),
    random: vi.fn(() => 0.5),
  };
}

function transientError(status: 429 | 503): AiProviderError {
  return new AiProviderError('gemini', 'provider_error', `HTTP ${status}`, status);
}

describe('fallbacks Gemini do resumo de WhatsApp', () => {
  it('usa o Gemini 3.7 na primeira tentativa com schema e validação compartilhados', async () => {
    const generateGeminiText = vi.fn().mockResolvedValue(validSummaryResponse);
    const dependencies = summaryDependencies(generateGeminiText);

    const result = await generateStructuredWithGeminiFallbacks(
      summaryOptions(),
      dependencies,
    );

    expect(generateGeminiText).toHaveBeenCalledOnce();
    expect(generateGeminiText).toHaveBeenCalledWith(expect.objectContaining({
      model: AI_MODELS.whatsappSummary,
      schema: buildWhatsappSummarySchema(statuses),
      thinkingLevel: ThinkingLevel.MEDIUM,
    }));
    expect(result).toMatchObject({
      provider: 'gemini',
      model: AI_MODELS.whatsappSummary,
      data: { summaries: [{ client_id: null }] },
    });
    expect(dependencies.sleep).not.toHaveBeenCalled();
  });

  it.each([503, 429] as const)(
    'repete o Gemini 3.7 após HTTP %s sem esperar o tempo real',
    async (status) => {
      const generateGeminiText = vi.fn()
        .mockRejectedValueOnce(transientError(status))
        .mockResolvedValueOnce(validSummaryResponse);
      const dependencies = summaryDependencies(generateGeminiText);

      const result = await generateStructuredWithGeminiFallbacks(
        summaryOptions(),
        dependencies,
      );

      expect(generateGeminiText).toHaveBeenCalledTimes(2);
      expect(dependencies.sleep).toHaveBeenCalledWith(1_000);
      expect(result.model).toBe(AI_MODELS.whatsappSummary);
    },
  );

  it('não repete nem troca de modelo diante de erro não transitório', async () => {
    const generateGeminiText = vi.fn().mockRejectedValue(new AiProviderError(
      'gemini',
      'provider_error',
      'Requisição inválida',
      400,
    ));
    const dependencies = summaryDependencies(generateGeminiText);

    await expect(generateStructuredWithGeminiFallbacks(
      summaryOptions(),
      dependencies,
    )).rejects.toMatchObject({ status: 400 });

    expect(generateGeminiText).toHaveBeenCalledOnce();
    expect(dependencies.sleep).not.toHaveBeenCalled();
  });

  it('troca do 3.7 para o 3.6 após os retries transitórios', async () => {
    const generateGeminiText = vi.fn()
      .mockRejectedValueOnce(transientError(503))
      .mockRejectedValueOnce(transientError(503))
      .mockRejectedValueOnce(transientError(503))
      .mockRejectedValueOnce(transientError(503))
      .mockResolvedValueOnce(validSummaryResponse);
    const dependencies = summaryDependencies(generateGeminiText);

    const onAttemptFailure = vi.fn();
    const onModelFallback = vi.fn();
    const result = await generateStructuredWithGeminiFallbacks(
      { ...summaryOptions(), onAttemptFailure, onModelFallback },
      dependencies,
    );

    expect(generateGeminiText.mock.calls.map(([options]) => options.model)).toEqual([
      AI_MODELS.whatsappSummary,
      AI_MODELS.whatsappSummary,
      AI_MODELS.whatsappSummary,
      AI_MODELS.whatsappSummary,
      AI_MODELS.whatsappSummaryFallback,
    ]);
    expect(dependencies.sleep.mock.calls).toEqual([[1_000], [2_000], [4_000]]);
    expect(onAttemptFailure).toHaveBeenNthCalledWith(1, expect.objectContaining({
      model: AI_MODELS.whatsappSummary,
      attempt: 1,
      maxAttempts: 4,
      willRetry: true,
      retryDelayMs: 1_000,
      error: expect.objectContaining({ status: 503 }),
    }));
    expect(onModelFallback).toHaveBeenCalledWith(expect.objectContaining({
      fromModel: AI_MODELS.whatsappSummary,
      toModel: AI_MODELS.whatsappSummaryFallback,
      error: expect.objectContaining({ status: 503 }),
    }));
    expect(result.model).toBe(AI_MODELS.whatsappSummaryFallback);
  });

  it('faz um retry no 3.6 quando ele recebe erro transitório', async () => {
    const generateGeminiText = vi.fn()
      .mockRejectedValueOnce(transientError(503))
      .mockRejectedValueOnce(transientError(503))
      .mockRejectedValueOnce(transientError(503))
      .mockRejectedValueOnce(transientError(503))
      .mockRejectedValueOnce(transientError(429))
      .mockResolvedValueOnce(validSummaryResponse);
    const dependencies = summaryDependencies(generateGeminiText);

    const result = await generateStructuredWithGeminiFallbacks(
      summaryOptions(),
      dependencies,
    );

    expect(dependencies.sleep.mock.calls).toEqual([[1_000], [2_000], [4_000], [1_000]]);
    expect(generateGeminiText).toHaveBeenCalledTimes(6);
    expect(result.model).toBe(AI_MODELS.whatsappSummaryFallback);
  });

  it('usa o 3.5 uma única vez depois que 3.7 e 3.6 esgotam suas tentativas', async () => {
    const generateGeminiText = vi.fn()
      .mockRejectedValueOnce(transientError(503))
      .mockRejectedValueOnce(transientError(503))
      .mockRejectedValueOnce(transientError(503))
      .mockRejectedValueOnce(transientError(503))
      .mockRejectedValueOnce(transientError(429))
      .mockRejectedValueOnce(transientError(429))
      .mockResolvedValueOnce(validSummaryResponse);
    const dependencies = summaryDependencies(generateGeminiText);

    const result = await generateStructuredWithGeminiFallbacks(
      summaryOptions(),
      dependencies,
    );

    expect(generateGeminiText).toHaveBeenLastCalledWith(expect.objectContaining({
      model: AI_MODELS.whatsappSummaryLastFallback,
      schema: buildWhatsappSummarySchema(statuses),
    }));
    expect(result.model).toBe(AI_MODELS.whatsappSummaryLastFallback);
    expect(result.data.summaries[0].suggested_tasks[0].status).toBe(statuses[0]);
  });

  it('retorna erro tratado quando os três modelos falham', async () => {
    const generateGeminiText = vi.fn().mockRejectedValue(transientError(503));
    const dependencies = summaryDependencies(generateGeminiText);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    try {
      await expect(generateStructuredWithGeminiFallbacks(
        summaryOptions(),
        dependencies,
      )).rejects.toMatchObject({
        provider: 'gemini',
        status: 503,
      });

      expect(generateGeminiText).toHaveBeenCalledTimes(7);
      expect(generateGeminiText.mock.calls.map(([options]) => options.model)).not.toContain(
        AI_MODELS.groqFallback,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('não tenta outro modelo quando a validação server-side rejeita a resposta', async () => {
    const generateGeminiText = vi.fn().mockResolvedValue('{"summaries":[{"client_id":"inválido"}]}');
    const dependencies = summaryDependencies(generateGeminiText);

    await expect(generateStructuredWithGeminiFallbacks(
      summaryOptions(),
      dependencies,
    )).rejects.toMatchObject({ category: 'invalid_response' });

    expect(generateGeminiText).toHaveBeenCalledOnce();
    expect(dependencies.sleep).not.toHaveBeenCalled();
  });
});

describe('fallback dos provedores de IA', () => {
  it('mantém o fallback Groq usado por parse-tasks quando o Gemini falha', async () => {
    const generateGeminiText = vi.fn().mockRejectedValue(new Error('Gemini indisponível'));
    const generateGroqText = vi.fn().mockResolvedValue(validResponse);
    const schema = buildParseTasksSchema(statuses);

    const result = await generateStructuredWithFallback({
      geminiApiKey: 'gemini-test-key',
      groqApiKey: 'groq-test-key',
      geminiModel: AI_MODELS.parseTasks,
      prompt: 'prompt',
      schema,
      thinkingLevel: ThinkingLevel.MINIMAL,
      validate: (value) => parseTasksOutput(value, statuses),
    }, { generateGeminiText, generateGroqText });

    expect(generateGeminiText).toHaveBeenCalledOnce();
    expect(generateGroqText).toHaveBeenCalledWith({
      apiKey: 'groq-test-key',
      prompt: 'prompt',
      schema,
    });
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

  it('rejeita pela validação comum uma resposta inválida da Groq', async () => {
    const generateGeminiText = vi.fn().mockRejectedValue(new Error('Gemini indisponível'));
    const generateGroqText = vi.fn().mockResolvedValue(JSON.stringify({
      tasks: [{
        client_name: 'Acme',
        description: 'Enviar relatório',
        responsibles: [],
        status: 'status inexistente',
        observations: '',
      }],
    }));

    await expect(generateStructuredWithFallback({
      geminiApiKey: 'gemini-test-key',
      groqApiKey: 'groq-test-key',
      geminiModel: AI_MODELS.parseTasks,
      prompt: 'prompt',
      schema: buildParseTasksSchema(statuses),
      thinkingLevel: ThinkingLevel.MINIMAL,
      validate: (value) => parseTasksOutput(value, statuses),
    }, { generateGeminiText, generateGroqText })).rejects.toMatchObject({
      provider: 'groq',
      category: 'invalid_response',
    });
  });
});

describe('detalhes de erro dos provedores', () => {
  it('chama o GPT-OSS 120B com JSON Schema estrito e temperatura compatível', async () => {
    const schema = buildParseTasksSchema(statuses);
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: validResponse } }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    try {
      await expect(generateGroqText({
        apiKey: 'groq-test-key',
        prompt: 'prompt',
        schema,
      })).resolves.toBe(validResponse);

      const request = fetchMock.mock.calls[0][1] as RequestInit;
      expect(JSON.parse(request.body as string)).toMatchObject({
        model: AI_MODELS.groqFallback,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'parse_tasks_response',
            strict: true,
            schema,
          },
        },
        temperature: 0.1,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('preserva a mensagem de erro retornada pela Groq', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: { message: 'O modelo solicitado foi descontinuado' },
    }), { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(generateGroqText({
      apiKey: 'groq-test-key',
      prompt: 'prompt',
      schema: buildParseTasksSchema(statuses),
    })).rejects.toMatchObject({
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

  it('também remove credenciais dos detalhes gravados em logs server-side', () => {
    const error = new AiProviderError(
      'gemini',
      'provider_error',
      'Falha com secret=segredo-do-log e token=outro-segredo',
      503,
    );

    const details = describeAiError(error);

    expect(details.message).toBe('Falha com secret=[REMOVIDO] e token=[REMOVIDO]');
  });
});
