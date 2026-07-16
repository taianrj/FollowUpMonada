import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { normalizeManagedUserRole } from './roles';

const createUserRoute = readFileSync(
  new URL('../../app/api/admin/create-user/route.ts', import.meta.url),
  'utf8'
);
const resendInviteRoute = readFileSync(
  new URL('../../app/api/admin/resend-invite/route.ts', import.meta.url),
  'utf8'
);

describe('papeis gerenciados', () => {
  it('aceita somente os dois papeis persistidos pelo schema', () => {
    expect(normalizeManagedUserRole('admin')).toBe('admin');
    expect(normalizeManagedUserRole('collaborator')).toBe('collaborator');
    expect(normalizeManagedUserRole('owner')).toBeNull();
    expect(normalizeManagedUserRole({ role: 'admin' })).toBeNull();
  });

  it('atribui papel somente pela operacao administrativa server-side', () => {
    for (const route of [createUserRoute, resendInviteRoute]) {
      expect(route).toContain(".from('profiles')");
      expect(route).toContain('.upsert(');
      expect(route).not.toMatch(/data:\s*\{[^}]*\brole\b/s);
      expect(route).not.toContain('new URL(request.url).origin');
    }
  });
});
