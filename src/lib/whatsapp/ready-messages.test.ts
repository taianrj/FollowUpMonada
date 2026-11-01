import { afterEach, describe, expect, it, vi } from 'vitest';
import { readReadyWhatsappMessages } from './ready-messages';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('leitura de mensagens prontas no servidor', () => {
  it('assina a identidade confiável e exige a validação do dia no serviço', async () => {
    vi.stubEnv('WHATSAPP_SERVICE_URL', 'https://service.example');
    vi.stubEnv('WHATSAPP_SERVICE_SECRET', 'test-secret-with-more-than-thirty-two-characters');
    const fetcher = vi.fn(async () => new Response('Texto salvo'));
    vi.stubGlobal('fetch', fetcher);
    await expect(readReadyWhatsappMessages('trusted-user', '2026-10-28')).resolves.toEqual({ ok: true, text: 'Texto salvo' });
    const [url, options] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.searchParams.get('requireReady')).toBe('1');
    expect(url.searchParams.get('date')).toBe('2026-10-28');
    expect(options.headers).toMatchObject({ 'x-api-key': 'trusted-user' });
    expect(options.cache).toBe('no-store');
  });

  it.each([409, 500, 401])('falha de forma fechada e não repassa o corpo upstream no HTTP %s', async status => {
    vi.stubEnv('WHATSAPP_SERVICE_URL', 'https://service.example');
    vi.stubEnv('WHATSAPP_SERVICE_SECRET', 'test-secret-with-more-than-thirty-two-characters');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('informação privada', { status })));
    const result = await readReadyWhatsappMessages('trusted-user', '2026-10-28');
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('informação privada');
  });

  it('indisponibilidade e resposta vazia não liberam geração', async () => {
    vi.stubEnv('WHATSAPP_SERVICE_URL', 'https://service.example');
    vi.stubEnv('WHATSAPP_SERVICE_SECRET', 'test-secret-with-more-than-thirty-two-characters');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    expect((await readReadyWhatsappMessages('trusted-user', '2026-10-28')).ok).toBe(false);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('')));
    expect((await readReadyWhatsappMessages('trusted-user', '2026-10-28')).ok).toBe(false);
  });
});
