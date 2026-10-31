import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ session: vi.fn(), execute: vi.fn(), provider: vi.fn() }));
vi.mock('@/lib/database/runtime', () => ({ currentD1Session: mocks.session, d1Services: () => ({ execute: mocks.execute }), databaseProvider: mocks.provider }));
import { POST } from './route';

function request(body: unknown, origin = 'https://app.example.test') {
  return new Request('https://app.example.test/api/backend/query', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('APP_URL', 'https://app.example.test');
  mocks.provider.mockReturnValue('d1');
  mocks.session.mockResolvedValue({ actor: { id: 'u', role: 'collaborator', is_active: true } });
});
afterEach(() => vi.unstubAllEnvs());

describe('POST /api/backend/query', () => {
  it('rejeita CSRF e acesso sem sessao antes de consultar o banco', async () => {
    expect((await POST(request({}, 'https://attacker.example'))).status).toBe(403);
    expect(mocks.session).not.toHaveBeenCalled();
    mocks.session.mockResolvedValue(null);
    expect((await POST(request({}))).status).toBe(401);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('nao aceita SQL, credenciais de WhatsApp ou papel administrativo fornecidos pelo cliente', async () => {
    const response = await POST(request({ table: 'whatsapp_sessions', operation: 'select', actor: { id: 'u', role: 'admin' }, service: true, sql: 'SELECT * FROM monada_auth_users' }));
    expect(response.status).toBe(403);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('aplica isolamento pelo usuario da sessao em vez do identificador enviado', async () => {
    mocks.execute.mockResolvedValue([{ success: true, results: [] }]);
    const response = await POST(request({ table: 'whatsapp_summaries', operation: 'select', filters: [{ field: 'created_by', operator: 'eq', value: 'other' }], order: [] }));
    expect(response.status).toBe(200);
    const statement = mocks.execute.mock.calls[0][0][0];
    expect(statement.params).toContain('u');
    expect(statement.sql).toContain('"created_by" = ? AND "created_by" = ?');
  });

  it('falha sem expor mensagens do provedor ou tokens', async () => {
    mocks.session.mockRejectedValue(new Error('private-key-and-user-content'));
    const response = await POST(request({}));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('private-key');
  });
});
