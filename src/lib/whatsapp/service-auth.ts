import { createHash, createHmac, randomUUID } from 'node:crypto';

export const WHATSAPP_SERVICE_AUTH_VERSION = 'v1';

export type WhatsappServiceAuthInput = {
  secret: string;
  userId: string;
  method: string;
  url: string;
  body?: string;
  timestamp?: number;
  nonce?: string;
};

export function hashWhatsappServiceBody(body = '') {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

export function buildWhatsappServiceCanonicalRequest(input: {
  userId: string;
  method: string;
  url: string;
  bodyHash: string;
  timestamp: number;
  nonce: string;
}) {
  const targetUrl = new URL(input.url);
  const pathAndQuery = `${targetUrl.pathname}${targetUrl.search}`;

  return [
    WHATSAPP_SERVICE_AUTH_VERSION,
    String(input.timestamp),
    input.nonce,
    input.userId,
    input.method.toUpperCase(),
    pathAndQuery,
    input.bodyHash
  ].join('\n');
}

export function createWhatsappServiceAuthHeaders(input: WhatsappServiceAuthInput) {
  if (input.secret.length < 32) {
    throw new Error('WHATSAPP_SERVICE_SECRET deve ter pelo menos 32 caracteres.');
  }

  const timestamp = input.timestamp ?? Date.now();
  const nonce = input.nonce ?? randomUUID();
  const bodyHash = hashWhatsappServiceBody(input.body);
  const canonicalRequest = buildWhatsappServiceCanonicalRequest({
    userId: input.userId,
    method: input.method,
    url: input.url,
    bodyHash,
    timestamp,
    nonce
  });
  const signature = createHmac('sha256', input.secret)
    .update(canonicalRequest, 'utf8')
    .digest('hex');

  return {
    'x-api-key': input.userId,
    'x-service-timestamp': String(timestamp),
    'x-service-nonce': nonce,
    'x-service-body-sha256': bodyHash,
    'x-service-signature': signature
  } as const;
}
