import { describe, expect, it } from 'vitest';
import {
  SEMANTIC_DUPLICATE_THRESHOLD,
  cosineSimilarity,
  findDuplicateTask,
  formatTaskForSemanticSimilarity,
  isLexicalDuplicate,
} from './embeddings';

describe('deduplicação semântica de demandas', () => {
  it('usa a instrução simétrica recomendada pelo Gemini Embedding 2', () => {
    expect(formatTaskForSemanticSimilarity('Corrigir relatório'))
      .toBe('task: sentence similarity | query: Corrigir relatório');
  });

  it('identifica descrições semanticamente próximas com embeddings mockados', () => {
    const newDescription = 'Corrigir relatório de faturamento';
    const existingDescription = 'Ajustar erros no relatório mensal de faturamento';
    const newEmbedding = [1, 0.1, 0];
    const existingEmbedding = [0.99, 0.1, 0.01];
    const similarity = cosineSimilarity(newEmbedding, existingEmbedding);

    expect(similarity).toBeGreaterThan(SEMANTIC_DUPLICATE_THRESHOLD);
    expect(findDuplicateTask(newDescription, [{
      description: existingDescription,
      similarity,
    }])).toBeDefined();
  });

  it('não confunde ações diferentes apenas por compartilharem o mesmo objeto', () => {
    const create = 'Criar relatório mensal de faturamento';
    const cancel = 'Cancelar relatório mensal de faturamento';

    expect(isLexicalDuplicate(create, cancel)).toBe(false);
    expect(findDuplicateTask(create, [{ description: cancel, similarity: 0.42 }])).toBeUndefined();
  });
});
