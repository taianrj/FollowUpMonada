import { ThinkingLevel } from '@google/genai';
import { getGeminiClient, isConfiguredApiKey } from './gemini';
import { AI_MODELS } from './models';
import { AiProviderError, type StructuredGenerationResult } from './providers';
import { parseJsonResponse, StructuredOutputError, type JsonSchema } from './schemas';

interface SummaryOptions<T> {
  geminiApiKey: string | undefined;
  prompt: string;
  schema: JsonSchema;
  validate: (value: unknown) => T;
  onFailure?: (error: AiProviderError) => void;
}

// Uma chamada ao SDK, sempre Hydrogen. Somente o SDK oficial controla retries;
// não há loops, troca de modelo, provedor alternativo ou repetição de JSON inválido.
export async function generateWhatsappSummary<T>(options: SummaryOptions<T>): Promise<StructuredGenerationResult<T>> {
  try {
    if (!isConfiguredApiKey(options.geminiApiKey, 'your-gemini-api-key')) throw new AiProviderError('gemini', 'configuration', 'GEMINI_API_KEY não configurada.');
    const response = await getGeminiClient(options.geminiApiKey).models.generateContent({
      model: AI_MODELS.whatsappSummary,
      contents: options.prompt,
      config: {
        responseMimeType: 'application/json', responseJsonSchema: options.schema,
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        // No SDK instalado, omitir retryOptions desativa retries. O objeto vazio
        // habilita a política padrão oficial, sem duplicá-la na aplicação.
        httpOptions: { retryOptions: {}, timeout: 60000 },
        abortSignal: AbortSignal.timeout(180000),
      },
    });
    if (!response.text?.trim()) throw new AiProviderError('gemini', 'empty_response', 'O Gemini retornou uma resposta vazia.');
    const data = options.validate(parseJsonResponse(response.text));
    const actualModel = response.modelVersion;
    return { data, provider: 'gemini', model: typeof actualModel === 'string' && /^[a-zA-Z0-9_.-]{1,120}$/.test(actualModel) ? actualModel : AI_MODELS.whatsappSummary };
  } catch (error) {
    const status = typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number' ? error.status : undefined;
    const known = error instanceof AiProviderError ? error : new AiProviderError('gemini', status === 429 ? 'rate_limit' : error instanceof SyntaxError || error instanceof StructuredOutputError ? 'invalid_response' : 'provider_error',
      status === 429 ? 'O limite de uso do Gemini foi atingido. Tente novamente mais tarde.' : 'Não foi possível gerar o resumo com o Gemini Hydrogen. Tente novamente.', status);
    options.onFailure?.(known);
    throw known;
  }
}
