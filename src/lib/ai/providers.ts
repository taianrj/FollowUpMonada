import type { ThinkingLevel } from '@google/genai';
import { getGeminiClient, isConfiguredApiKey } from './gemini';
import { AI_MODELS, type AiProvider } from './models';
import { StructuredOutputError, parseJsonResponse, type JsonSchema } from './schemas';

export type AiErrorCategory =
  | 'configuration'
  | 'rate_limit'
  | 'empty_response'
  | 'invalid_response'
  | 'provider_error';

export class AiProviderError extends Error {
  constructor(
    public readonly provider: AiProvider,
    public readonly category: AiErrorCategory,
    message: string,
    public readonly status?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'AiProviderError';
  }
}

export interface PublicAiErrorDetails {
  provider: AiProvider;
  model?: string;
  category: AiErrorCategory;
  status?: number;
  message: string;
}

export interface StructuredGenerationResult<T> {
  data: T;
  provider: AiProvider;
  model: string;
}

interface GeminiGenerationOptions {
  apiKey: string;
  model: string;
  prompt: string;
  schema: JsonSchema;
  thinkingLevel: ThinkingLevel;
}

interface GroqGenerationOptions {
  apiKey: string;
  prompt: string;
  schema: JsonSchema;
}

interface StructuredGenerationDependencies {
  generateGeminiText: (options: GeminiGenerationOptions) => Promise<string>;
  generateGroqText: (options: GroqGenerationOptions) => Promise<string>;
}

interface StructuredGenerationOptions<T> {
  geminiApiKey: string | undefined;
  groqApiKey: string | undefined;
  geminiModel: string;
  prompt: string;
  schema: JsonSchema;
  thinkingLevel: ThinkingLevel;
  validate: (value: unknown) => T;
  onGeminiFailure?: (error: AiProviderError) => void;
}

export interface GeminiFallbackModel {
  model: string;
  retries: number;
}

export interface GeminiAttemptFailure {
  model: string;
  attempt: number;
  maxAttempts: number;
  error: AiProviderError;
  willRetry: boolean;
  retryDelayMs?: number;
}

export interface GeminiModelFallback {
  fromModel: string;
  toModel: string;
  error: AiProviderError;
}

interface GeminiFallbackOptions<T> {
  geminiApiKey: string | undefined;
  models: readonly GeminiFallbackModel[];
  prompt: string;
  schema: JsonSchema;
  thinkingLevel: ThinkingLevel;
  validate: (value: unknown) => T;
  onAttemptFailure?: (failure: GeminiAttemptFailure) => void;
  onModelFallback?: (fallback: GeminiModelFallback) => void;
}

interface GeminiFallbackDependencies {
  generateGeminiText: (options: GeminiGenerationOptions) => Promise<string>;
  sleep: (milliseconds: number) => Promise<void>;
  random: () => number;
}

function getStatus(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null && 'status' in error) {
    const status = (error as { status?: unknown }).status;
    return typeof status === 'number' ? status : undefined;
  }
  return undefined;
}

function toProviderError(provider: AiProvider, error: unknown): AiProviderError {
  if (error instanceof AiProviderError) return error;

  const status = getStatus(error);
  const message = error instanceof Error ? error.message : 'Falha desconhecida do provedor.';
  const category: AiErrorCategory = status === 429
    ? 'rate_limit'
    : message.toLowerCase().includes('vazia') || message.toLowerCase().includes('empty')
      ? 'empty_response'
      : error instanceof SyntaxError || error instanceof StructuredOutputError
        ? 'invalid_response'
        : 'provider_error';

  return new AiProviderError(provider, category, message, status, { cause: error });
}

const MAX_PUBLIC_ERROR_MESSAGE_LENGTH = 800;

function sanitizePublicErrorMessage(message: string): string {
  return message
    .replace(/(authorization\s*:\s*bearer\s+)[^\s,;]+/gi, '$1[REMOVIDO]')
    .replace(/((?:api[_ -]?key|token|secret)\s*[=:]\s*)[^\s,;]+/gi, '$1[REMOVIDO]')
    .replace(/([?&]key=)[^&\s]+/gi, '$1[REMOVIDO]')
    .slice(0, MAX_PUBLIC_ERROR_MESSAGE_LENGTH);
}

export function describeAiError(error: AiProviderError): Record<string, unknown> {
  return {
    provider: error.provider,
    category: error.category,
    status: error.status,
    message: sanitizePublicErrorMessage(error.message),
  };
}

export function getPublicAiErrorDetails(
  error: AiProviderError,
  model?: string,
): PublicAiErrorDetails {
  return {
    provider: error.provider,
    ...(model ? { model } : {}),
    category: error.category,
    status: error.status,
    message: sanitizePublicErrorMessage(error.message),
  };
}

export async function generateGeminiText(options: GeminiGenerationOptions): Promise<string> {
  const ai = getGeminiClient(options.apiKey);
  const response = await ai.models.generateContent({
    model: options.model,
    contents: options.prompt,
    config: {
      responseMimeType: 'application/json',
      responseJsonSchema: options.schema,
      thinkingConfig: {
        thinkingLevel: options.thinkingLevel,
      },
      // Os retries deste fluxo são controlados pela aplicação para preservar
      // a contagem, o backoff e a auditoria por modelo.
      httpOptions: {
        retryOptions: { attempts: 1 },
      },
    },
  });

  const text = response.text;
  if (!text?.trim()) {
    throw new AiProviderError('gemini', 'empty_response', 'O Gemini retornou uma resposta vazia.');
  }
  return text;
}

const TRANSIENT_GEMINI_STATUSES = new Set([429, 503]);
const GEMINI_RETRY_BASE_DELAY_MS = 1_000;
const GEMINI_RETRY_JITTER_RATIO = 0.2;

function getGeminiRetryDelayMs(retryNumber: number, random: () => number): number {
  const exponentialDelay = GEMINI_RETRY_BASE_DELAY_MS * (2 ** (retryNumber - 1));
  const jitterMultiplier = 1 - GEMINI_RETRY_JITTER_RATIO
    + (random() * GEMINI_RETRY_JITTER_RATIO * 2);
  return Math.round(exponentialDelay * jitterMultiplier);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function generateStructuredWithGeminiFallbacks<T>(
  options: GeminiFallbackOptions<T>,
  dependencies: GeminiFallbackDependencies = {
    generateGeminiText,
    sleep,
    random: Math.random,
  },
): Promise<StructuredGenerationResult<T>> {
  if (!isConfiguredApiKey(options.geminiApiKey, 'your-gemini-api-key')) {
    throw new AiProviderError('gemini', 'configuration', 'GEMINI_API_KEY não configurada.');
  }
  if (options.models.length === 0) {
    throw new AiProviderError('gemini', 'configuration', 'Nenhum modelo Gemini foi configurado.');
  }

  for (let modelIndex = 0; modelIndex < options.models.length; modelIndex += 1) {
    const modelConfig = options.models[modelIndex];
    const maxAttempts = modelConfig.retries + 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const text = await dependencies.generateGeminiText({
          apiKey: options.geminiApiKey,
          model: modelConfig.model,
          prompt: options.prompt,
          schema: options.schema,
          thinkingLevel: options.thinkingLevel,
        });
        return {
          data: options.validate(parseJsonResponse(text)),
          provider: 'gemini',
          model: modelConfig.model,
        };
      } catch (error) {
        const providerError = toProviderError('gemini', error);
        const isTransient = providerError.status !== undefined
          && TRANSIENT_GEMINI_STATUSES.has(providerError.status);
        const willRetry = isTransient && attempt < maxAttempts;
        const retryDelayMs = willRetry
          ? getGeminiRetryDelayMs(attempt, dependencies.random)
          : undefined;

        options.onAttemptFailure?.({
          model: modelConfig.model,
          attempt,
          maxAttempts,
          error: providerError,
          willRetry,
          retryDelayMs,
        });

        if (willRetry && retryDelayMs !== undefined) {
          await dependencies.sleep(retryDelayMs);
          continue;
        }

        const nextModel = options.models[modelIndex + 1];
        if (isTransient && nextModel) {
          options.onModelFallback?.({
            fromModel: modelConfig.model,
            toModel: nextModel.model,
            error: providerError,
          });
          break;
        }

        throw providerError;
      }
    }
  }

  throw new AiProviderError(
    'gemini',
    'provider_error',
    'Não foi possível gerar o resumo com os modelos Gemini configurados.',
  );
}

export async function generateGroqText(options: GroqGenerationOptions): Promise<string> {
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${options.apiKey}`,
    },
    body: JSON.stringify({
      model: AI_MODELS.groqFallback,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'parse_tasks_response',
          strict: true,
          schema: options.schema,
        },
      },
      messages: [{ role: 'user', content: options.prompt }],
      temperature: 0.1,
    }),
  });

  if (!response.ok) {
    const responseBody = await response.text().catch(() => '');
    let providerMessage = '';
    try {
      const parsed = JSON.parse(responseBody) as {
        error?: { message?: unknown };
        message?: unknown;
      };
      const candidate = parsed.error?.message ?? parsed.message;
      providerMessage = typeof candidate === 'string' ? candidate.trim() : '';
    } catch {
      providerMessage = responseBody.trim().startsWith('<') ? '' : responseBody.trim();
    }
    const detail = providerMessage ? `: ${providerMessage.slice(0, MAX_PUBLIC_ERROR_MESSAGE_LENGTH)}` : '';
    throw new AiProviderError(
      'groq',
      response.status === 429 ? 'rate_limit' : 'provider_error',
      `A Groq respondeu com HTTP ${response.status}${detail}.`,
      response.status,
    );
  }

  const body = await response.json() as {
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  const text = body.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) {
    throw new AiProviderError('groq', 'empty_response', 'A Groq retornou uma resposta vazia.');
  }
  return text;
}

export async function generateStructuredWithFallback<T>(
  options: StructuredGenerationOptions<T>,
  dependencies: StructuredGenerationDependencies = { generateGeminiText, generateGroqText },
): Promise<StructuredGenerationResult<T>> {
  let geminiFailure: AiProviderError;

  try {
    if (!isConfiguredApiKey(options.geminiApiKey, 'your-gemini-api-key')) {
      throw new AiProviderError('gemini', 'configuration', 'GEMINI_API_KEY não configurada.');
    }
    const text = await dependencies.generateGeminiText({
      apiKey: options.geminiApiKey,
      model: options.geminiModel,
      prompt: options.prompt,
      schema: options.schema,
      thinkingLevel: options.thinkingLevel,
    });
    return {
      data: options.validate(parseJsonResponse(text)),
      provider: 'gemini',
      model: options.geminiModel,
    };
  } catch (error) {
    geminiFailure = toProviderError('gemini', error);
    options.onGeminiFailure?.(geminiFailure);
  }

  if (!isConfiguredApiKey(options.groqApiKey, 'your-groq-api-key')) {
    throw new AiProviderError(
      'groq',
      'configuration',
      'Nenhum provedor de IA configurado conseguiu processar a solicitação.',
      undefined,
      { cause: geminiFailure },
    );
  }

  try {
    const text = await dependencies.generateGroqText({
      apiKey: options.groqApiKey,
      prompt: options.prompt,
      schema: options.schema,
    });
    return {
      data: options.validate(parseJsonResponse(text)),
      provider: 'groq',
      model: AI_MODELS.groqFallback,
    };
  } catch (error) {
    throw toProviderError('groq', error);
  }
}
