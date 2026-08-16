import { GoogleGenAI } from '@google/genai';

let cachedApiKey: string | undefined;
let cachedClient: GoogleGenAI | undefined;

export function isConfiguredApiKey(apiKey: string | undefined, placeholder: string): apiKey is string {
  return Boolean(apiKey && apiKey !== placeholder);
}

export function getGeminiClient(apiKey: string): GoogleGenAI {
  if (!cachedClient || cachedApiKey !== apiKey) {
    cachedApiKey = apiKey;
    cachedClient = new GoogleGenAI({ apiKey });
  }

  return cachedClient;
}
