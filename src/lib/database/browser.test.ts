import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ native: vi.fn() }));
vi.mock('@supabase/ssr', () => ({ createBrowserClient: mocks.native }));
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); vi.resetAllMocks(); });

describe('cliente selecionado por configuracao do servidor', () => {
  it('preserva as opcoes do fluxo Supabase de recuperacao de senha', async () => {
    const reset = vi.fn().mockResolvedValue({ data: {}, error: null });
    mocks.native.mockReturnValue({ auth: { resetPasswordForEmail: reset } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ provider: 'supabase' })));
    const { createDatabaseBrowserClient } = await import('./browser');
    const options = { redirectTo: 'https://app.example.test/auth/callback' };
    await createDatabaseBrowserClient().auth.resetPasswordForEmail('user@example.test', options);
    expect(reset).toHaveBeenCalledWith('user@example.test', options);
  });

  it('no D1 envia apenas descritores ao gateway sem inicializar Supabase', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => Promise.resolve(Response.json(url.endsWith('/config') ? { provider: 'd1' } : { data: [], error: null })));
    vi.stubGlobal('fetch', fetchMock);
    const { createDatabaseBrowserClient } = await import('./browser');
    const result = await createDatabaseBrowserClient().from('tasks').select('id').eq('status', 'open');
    expect(result.error).toBeNull();
    expect(mocks.native).not.toHaveBeenCalled();
    const options = fetchMock.mock.calls[1][1];
    expect(JSON.parse(options.body)).toMatchObject({ table: 'tasks', operation: 'select', filters: [{ field: 'status', operator: 'eq', value: 'open' }] });
    expect(options.credentials).toBe('same-origin');
    expect(options.body).not.toContain('SELECT');
  });
});
