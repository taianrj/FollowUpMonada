import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = path.join(process.cwd(), 'supabase_ai_embeddings.sql');
const migration = fs.readFileSync(migrationPath, 'utf8');

describe('migration de embeddings de demandas', () => {
  it('é aditiva e habilita pgvector sem recriar tabelas', () => {
    expect(migration).toMatch(/create extension if not exists vector/i);
    expect(migration).toMatch(/alter table public\.tasks[\s\S]*add column if not exists description_embedding/i);
    expect(migration).not.toMatch(/drop table|truncate table/i);
  });

  it('limita a busca a tarefas ativas do mesmo cliente e respeita RLS', () => {
    expect(migration).toMatch(/security invoker/i);
    expect(migration).toMatch(/tasks\.client_id = match_client_id/i);
    expect(migration).toMatch(/tasks\.is_archived = false/i);
    expect(migration).toMatch(/description_embedding_model = match_embedding_model/i);
  });

  it('invalida o vetor quando a descrição muda e registra auditoria do resumo', () => {
    expect(migration).toMatch(/before update of description on public\.tasks/i);
    expect(migration).toMatch(/new\.description_embedding = null/i);
    expect(migration).toMatch(/add column if not exists ai_provider text/i);
    expect(migration).toMatch(/add column if not exists ai_model text/i);
  });
});
