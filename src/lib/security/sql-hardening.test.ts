import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const schema = readFileSync(new URL('../../../supabase_schema.sql', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../../../supabase_auth_hardening.sql', import.meta.url), 'utf8');
const persistence = readFileSync(new URL('../../../supabase_whatsapp_persistence.sql', import.meta.url), 'utf8');

describe('hardening do Supabase', () => {
  it('nunca promove usuario a partir de metadados ou da ordem de cadastro', () => {
    for (const sql of [schema, migration]) {
      expect(sql).toContain("values (new.id, new.email, 'collaborator')");
      expect(sql).not.toContain('raw_user_meta_data');
      expect(sql).not.toContain('user_count');
    }
  });

  it('nao concede leitura das credenciais de sessao ao cliente autenticado', () => {
    for (const sql of [migration, persistence]) {
      expect(sql).toContain('revoke select on public.whatsapp_sessions from authenticated');
      expect(sql).not.toContain('using (id = auth.uid()::text)');
    }
  });
});
