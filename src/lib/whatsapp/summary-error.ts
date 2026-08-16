export interface SummaryResponseError {
  message: string;
  diagnostics: string[];
}

interface ErrorPayload {
  error?: unknown;
  message?: unknown;
  code?: unknown;
  requestId?: unknown;
  details?: unknown;
}

interface AiAttemptPayload {
  provider?: unknown;
  category?: unknown;
  status?: unknown;
  message?: unknown;
}

const MAX_RESPONSE_DETAIL_LENGTH = 800;

const providerLabels: Record<string, string> = {
  gemini: 'Gemini',
  groq: 'Groq',
};

const categoryLabels: Record<string, string> = {
  configuration: 'configuração',
  rate_limit: 'limite de requisições',
  empty_response: 'resposta vazia',
  invalid_response: 'resposta inválida',
  provider_error: 'erro do provedor',
};

function clipped(value: string): string {
  return value
    .trim()
    .replace(/(authorization\s*:\s*bearer\s+)[^\s,;]+/gi, '$1[REMOVIDO]')
    .replace(/((?:api[_ -]?key|token|secret)\s*[=:]\s*)[^\s,;]+/gi, '$1[REMOVIDO]')
    .replace(/([?&]key=)[^&\s]+/gi, '$1[REMOVIDO]')
    .slice(0, MAX_RESPONSE_DETAIL_LENGTH);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsePayload(rawBody: string): ErrorPayload | null {
  try {
    const parsed: unknown = JSON.parse(rawBody);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function formatAiAttempt(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const attempt = value as AiAttemptPayload;
  const provider = typeof attempt.provider === 'string'
    ? (providerLabels[attempt.provider] ?? attempt.provider)
    : 'Provedor de IA';
  const category = typeof attempt.category === 'string'
    ? (categoryLabels[attempt.category] ?? attempt.category)
    : null;
  const status = typeof attempt.status === 'number' ? `HTTP ${attempt.status}` : null;
  const message = typeof attempt.message === 'string' ? clipped(attempt.message) : '';
  const classification = [category, status].filter(Boolean).join(', ');

  if (!message && !classification) return null;
  return `${provider}${classification ? ` (${classification})` : ''}${message ? `: ${message}` : ''}`;
}

export async function readSummaryResponseError(
  response: Response,
  fallbackMessage: string,
): Promise<SummaryResponseError> {
  const rawBody = await response.text().catch(() => '');
  const payload = parsePayload(rawBody);
  const diagnostics: string[] = [];

  const payloadMessage = typeof payload?.error === 'string'
    ? clipped(payload.error)
    : typeof payload?.message === 'string'
      ? clipped(payload.message)
      : '';
  const isPlainText = Boolean(rawBody.trim()) && !rawBody.trim().startsWith('<');
  const message = payloadMessage || (isPlainText && !payload ? clipped(rawBody) : fallbackMessage);

  if (typeof payload?.code === 'string' && payload.code.trim()) {
    diagnostics.push(`Código: ${clipped(payload.code)}`);
  }

  const details = payload?.details;
  if (isRecord(details)) {
    const detailMessage = details.message;
    if (typeof detailMessage === 'string' && clipped(detailMessage) !== message) {
      diagnostics.push(clipped(detailMessage));
    }
    if (Array.isArray(details.attempts)) {
      diagnostics.push(...details.attempts.map(formatAiAttempt).filter((item): item is string => Boolean(item)));
    }
  } else if (typeof details === 'string' && clipped(details) !== message) {
    diagnostics.push(clipped(details));
  }

  const requestId = typeof payload?.requestId === 'string'
    ? payload.requestId
    : response.headers.get('x-request-id');
  if (requestId?.trim()) diagnostics.push(`ID da ocorrência: ${clipped(requestId)}`);

  if (!payload && rawBody.trim().startsWith('<')) {
    diagnostics.push('O servidor retornou uma página HTML em vez de uma resposta de erro estruturada.');
  } else if (!rawBody.trim()) {
    diagnostics.push('O servidor não retornou um corpo com detalhes do erro.');
  }

  if (response.statusText) diagnostics.push(`Resposta HTTP: ${clipped(response.statusText)}`);

  return { message, diagnostics: [...new Set(diagnostics)] };
}

export function describeUnexpectedSummaryError(error: unknown, isOnline?: boolean): string[] {
  const diagnostics: string[] = [];
  if (error instanceof Error) {
    diagnostics.push(`Tipo da falha: ${error.name || 'Error'}`);
    if (error.cause instanceof Error && error.cause.message !== error.message) {
      diagnostics.push(`Causa: ${clipped(error.cause.message)}`);
    } else if (typeof error.cause === 'string' && error.cause !== error.message) {
      diagnostics.push(`Causa: ${clipped(error.cause)}`);
    }
  } else {
    diagnostics.push(`Valor recebido: ${clipped(String(error))}`);
  }
  if (isOnline === false) diagnostics.push('O navegador está sem conexão com a internet.');
  return diagnostics;
}
