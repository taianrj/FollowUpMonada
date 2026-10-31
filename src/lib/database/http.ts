import { getTrustedAppOrigin } from '@/lib/security/app-origin';

export function validateSameOrigin(request: Request) {
  const expected = getTrustedAppOrigin({ requestUrl: request.url, nodeEnv: process.env.NODE_ENV, appUrl: process.env.APP_URL, vercelProductionUrl: process.env.VERCEL_PROJECT_PRODUCTION_URL });
  return !!expected && request.headers.get('origin') === expected && request.headers.get('content-type')?.split(';')[0].trim() === 'application/json';
}

export async function readBoundedJson(request: Request, maxBytes = 512000): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Corpo ausente.');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) throw new Error('Corpo muito grande.');
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(result));
}
