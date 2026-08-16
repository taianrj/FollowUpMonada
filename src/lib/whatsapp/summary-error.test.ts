import { describe, expect, it } from 'vitest';
import {
  describeUnexpectedSummaryError,
  readSummaryResponseError,
} from './summary-error';

describe('detalhes do erro de geração do resumo', () => {
  it('formata a mensagem, as tentativas de IA e o identificador retornados pela API', async () => {
    const response = new Response(JSON.stringify({
      error: 'Os provedores de IA não conseguiram gerar o resumo.',
      code: 'AI_PROVIDER_FAILURE',
      requestId: 'request-123',
      details: {
        type: 'ai_provider',
        attempts: [
          {
            provider: 'gemini',
            category: 'rate_limit',
            status: 429,
            message: 'Cota diária excedida.',
          },
          {
            provider: 'groq',
            category: 'configuration',
            message: 'Chave não configurada.',
          },
        ],
      },
    }), { status: 502, statusText: 'Bad Gateway' });

    await expect(readSummaryResponseError(response, 'Erro genérico.')).resolves.toEqual({
      message: 'Os provedores de IA não conseguiram gerar o resumo.',
      diagnostics: [
        'Código: AI_PROVIDER_FAILURE',
        'Gemini (limite de requisições, HTTP 429): Cota diária excedida.',
        'Groq (configuração): Chave não configurada.',
        'ID da ocorrência: request-123',
        'Resposta HTTP: Bad Gateway',
      ],
    });
  });

  it('mostra uma resposta textual da API e remove credenciais', async () => {
    const response = new Response('Falha upstream; token=segredo', { status: 503 });

    const result = await readSummaryResponseError(response, 'Erro genérico.');

    expect(result.message).toBe('Falha upstream; token=[REMOVIDO]');
    expect(result.message).not.toContain('segredo');
  });

  it('explica falhas locais e informa quando o navegador está offline', () => {
    const result = describeUnexpectedSummaryError(new TypeError('Failed to fetch'), false);

    expect(result).toEqual([
      'Tipo da falha: TypeError',
      'O navegador está sem conexão com a internet.',
    ]);
  });
});
