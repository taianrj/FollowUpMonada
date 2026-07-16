import { describe, expect, it } from 'vitest';
import nextConfig from '../../../next.config';

describe('headers de seguranca do Next.js', () => {
  it('remove identificacao do framework e protege todas as rotas', async () => {
    expect(nextConfig.poweredByHeader).toBe(false);
    expect(nextConfig.headers).toBeTypeOf('function');

    const rules = await nextConfig.headers!();
    expect(rules).toHaveLength(1);
    expect(rules[0].source).toBe('/:path*');
    const headers = new Map(rules[0].headers.map(header => [header.key, header.value]));
    expect(headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
    expect(headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(headers.get('X-Frame-Options')).toBe('DENY');
    expect(headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
  });
});
