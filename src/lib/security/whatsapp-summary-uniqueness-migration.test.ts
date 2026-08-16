import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = path.join(process.cwd(), 'supabase_whatsapp_summary_uniqueness.sql');
const migration = fs.readFileSync(migrationPath, 'utf8');
const deduplicationPath = path.join(process.cwd(), 'supabase_whatsapp_summary_deduplicate.sql');
const deduplication = fs.readFileSync(deduplicationPath, 'utf8');

describe('unicidade dos resumos de WhatsApp', () => {
  it('impõe no banco um único resumo por usuário e data', () => {
    expect(migration).toMatch(/create unique index if not exists/i);
    expect(migration).toMatch(/on public\.whatsapp_summaries \(created_by, summary_date\)/i);
    expect(migration).toMatch(/where created_by is not null/i);
  });

  it('é aditiva e não altera ou remove resumos existentes', () => {
    expect(migration).not.toMatch(/delete from|drop table|truncate table/i);
  });

  it('orienta executar primeiro a migração de deduplicação', () => {
    expect(migration).toContain('supabase_whatsapp_summary_deduplicate.sql');
  });
});

describe('limpeza de resumos duplicados existentes', () => {
  it('mantém o resumo mais recente por usuário e data', () => {
    expect(deduplication).toMatch(/partition by created_by, summary_date/i);
    expect(deduplication).toMatch(/order by created_at desc, id desc/i);
    expect(deduplication).toMatch(/ranked\.position > 1/i);
  });

  it('arquiva cada registro antes de removê-lo da tabela principal', () => {
    expect(deduplication).toMatch(/begin;[\s\S]*commit;/i);
    expect(deduplication).toMatch(/lock table public\.whatsapp_summaries/i);
    expect(deduplication).toMatch(/insert into public\.whatsapp_summaries_duplicate_archive/i);
    expect(deduplication).toMatch(/to_jsonb\(summary\)/i);
    expect(deduplication).toMatch(/delete from public\.whatsapp_summaries/i);
    expect(deduplication.indexOf('insert into public.whatsapp_summaries_duplicate_archive'))
      .toBeLessThan(deduplication.indexOf('delete from public.whatsapp_summaries'));
  });

  it('protege o arquivo contra acesso dos papéis da aplicação', () => {
    expect(deduplication).toMatch(/enable row level security/i);
    expect(deduplication).toMatch(/revoke all[\s\S]*from anon, authenticated/i);
  });
});
