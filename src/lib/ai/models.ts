export const AI_MODELS = {
  parseTasks: 'gemini-3.5-flash-lite',
  whatsappSummary: 'gemini-3.7-flash',
  embeddings: 'gemini-embedding-2',
  groqFallback: 'llama-3.3-70b-versatile',
} as const;

export const AI_PROVIDER_LABELS = {
  gemini: 'gemini',
  groq: 'groq',
} as const;

export type AiProvider = keyof typeof AI_PROVIDER_LABELS;
