import { ThinkingLevel } from '@google/genai';
import { describe, expect, it, vi } from 'vitest';
import { AI_MODELS } from './models';
import { generateStructuredWithFallback } from './providers';
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
