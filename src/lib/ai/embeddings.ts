import { getGeminiClient, isConfiguredApiKey } from './gemini';
import { AI_MODELS } from './models';

export const TASK_EMBEDDING_DIMENSIONS = 768;

// Ponto inicial conservador. Deve ser calibrado com exemplos reais de duplicatas
// e falsos positivos do domínio antes de qualquer redução.
export const SEMANTIC_DUPLICATE_THRESHOLD = 0.9;
export const EMBEDDING_BACKFILL_BATCH_SIZE = 50;

export interface TaskDuplicateCandidate {
  id?: string;
  description: string;
  similarity?: number;
}

export function formatTaskForSemanticSimilarity(description: string): string {
  return `task: sentence similarity | query: ${description.trim()}`;
}

export async function embedTaskDescriptions(
  descriptions: readonly string[],
  apiKey: string | undefined,
): Promise<number[][]> {
  if (!isConfiguredApiKey(apiKey, 'your-gemini-api-key')) {
    throw new Error('GEMINI_API_KEY não configurada para embeddings.');
  }
  if (descriptions.length === 0) return [];

  const ai = getGeminiClient(apiKey);
  const response = await ai.models.embedContent({
    model: AI_MODELS.embeddings,
    // Content objects separados garantem um embedding por descrição no
    // gemini-embedding-2, em vez de um único embedding agregado.
    contents: descriptions.map((description) => ({
      parts: [{ text: formatTaskForSemanticSimilarity(description) }],
    })),
    config: { outputDimensionality: TASK_EMBEDDING_DIMENSIONS },
  });

  const embeddings = response.embeddings ?? [];
  if (embeddings.length !== descriptions.length) {
    throw new Error('A API de embeddings retornou uma quantidade inesperada de vetores.');
  }

  return embeddings.map((embedding) => {
    const values = embedding.values;
    if (
      !values
      || values.length !== TASK_EMBEDDING_DIMENSIONS
      || values.some((value) => !Number.isFinite(value))
    ) {
      throw new Error('A API de embeddings retornou um vetor inválido.');
    }
    return values;
  });
}

export function formatPgVector(embedding: readonly number[]): string {
  if (
    embedding.length !== TASK_EMBEDDING_DIMENSIONS
    || embedding.some((value) => !Number.isFinite(value))
  ) {
    throw new Error(`O embedding deve conter ${TASK_EMBEDDING_DIMENSIONS} números finitos.`);
  }
  return `[${embedding.join(',')}]`;
}

export function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  if (left.length === 0 || left.length !== right.length) return 0;

  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftMagnitude += left[index] ** 2;
    rightMagnitude += right[index] ** 2;
  }

  if (leftMagnitude === 0 || rightMagnitude === 0) return 0;
  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}

function cleanText(text: string): string[] {
  const normalized = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[.,/#!$%^&*;:{}=\-_`~()?"']/g, ' ');

  const stopWords = new Set([
    'a', 'o', 'as', 'os', 'de', 'do', 'da', 'dos', 'das', 'em', 'um', 'uma', 'uns', 'umas',
    'para', 'com', 'por', 'sobre', 'que', 'se', 'e', 'ao', 'aos', 'no', 'na', 'nos', 'nas', 'pra',
  ]);

  return normalized.split(/\s+/).filter((word) => word.length > 2 && !stopWords.has(word));
}

export function isLexicalDuplicate(newDescription: string, existingDescription: string): boolean {
  const words1 = cleanText(newDescription);
  const words2 = cleanText(existingDescription);
  if (words1.length === 0 || words2.length === 0) return false;

  const set1 = new Set(words1);
  const set2 = new Set(words2);
  const intersection = new Set([...set1].filter((word) => set2.has(word)));
  const union = new Set([...set1, ...set2]);
  const jaccard = intersection.size / union.size;
  const overlap = intersection.size / Math.min(set1.size, set2.size);

  if (words1.join(' ') === words2.join(' ')) return true;

  // A proteção lexical fica deliberadamente conservadora: verbos diferentes
  // podem indicar ações opostas sobre o mesmo objeto (por exemplo, criar vs.
  // cancelar um relatório). Sinônimos ficam a cargo do embedding.
  const sameLeadingAction = words1[0] === words2[0];
  return sameLeadingAction
    && intersection.size >= 2
    && (jaccard >= 0.55 || overlap >= 0.75);
}

export function findDuplicateTask(
  newDescription: string,
  candidates: readonly TaskDuplicateCandidate[],
  threshold = SEMANTIC_DUPLICATE_THRESHOLD,
): TaskDuplicateCandidate | undefined {
  return candidates.find((candidate) => (
    isLexicalDuplicate(newDescription, candidate.description)
    || (typeof candidate.similarity === 'number' && candidate.similarity >= threshold)
  ));
}
