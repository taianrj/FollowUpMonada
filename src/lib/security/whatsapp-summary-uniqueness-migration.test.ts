import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = path.join(process.cwd(), 'supabase_whatsapp_summary_uniqueness.sql');
const migration = fs.readFileSync(migrationPath, 'utf8');

describe('unicidade dos resumos de WhatsApp', () => {
  it('impõe no banco um único resumo por usuário e data', () => {
    expect(migration).toMatch(/create unique index if not exists/i);
    expect(migration).toMatch(/on public\.whatsapp_summaries \(created_by, summary_date\)/i);
    expect(migration).toMatch(/where created_by is not null/i);
  });

  it('é aditiva e não altera ou remove resumos existentes', () => {
    expect(migration).not.toMatch(/delete from|drop table|truncate table/i);
  });
});
