import { afterEach, describe, expect, it, vi } from 'vitest';
import { readBoundedJson, validateSameOrigin } from './http';

afterEach(() => vi.unstubAllEnvs());

describe('gateway de dados', () => {
  it('exige origem configurada e JSON, sem aceitar a origem fornecida pelo corpo', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('APP_URL', 'https://app.example.test');
    expect(validateSameOrigin(new Request('https://app.example.test/api/backend/query', { method: 'POST', headers: { origin: 'https://app.example.test', 'content-type': 'application/json' } }))).toBe(true);
    for (const origin of ['https://attacker.example', 'null', '']) {
      expect(validateSameOrigin(new Request('https://app.example.test/api/backend/query', { method: 'POST', headers: { origin, 'content-type': 'application/json' } }))).toBe(false);
    }
    expect(validateSameOrigin(new Request('https://app.example.test/api/backend/query', { method: 'POST', headers: { origin: 'https://app.example.test', 'content-type': 'text/plain' } }))).toBe(false);
  });

  it('limita o corpo real mesmo quando content-length esta ausente ou incorreto', async () => {
    const good = new Request('https://app.example.test', { method: 'POST', body: '{"ok":true}' });
    expect(await readBoundedJson(good, 20)).toEqual({ ok: true });
    const large = new Request('https://app.example.test', { method: 'POST', body: JSON.stringify({ data: 'x'.repeat(100) }), headers: { 'content-length': '1' } });
    await expect(readBoundedJson(large, 20)).rejects.toThrow('grande');
  });
});
