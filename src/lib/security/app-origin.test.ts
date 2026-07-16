import { describe, expect, it } from 'vitest';
import { getTrustedAppOrigin, normalizeInternalRedirectPath } from './app-origin';

describe('origem confiavel da aplicacao', () => {
  it('usa APP_URL em producao e exige HTTPS', () => {
    expect(getTrustedAppOrigin({
      requestUrl: 'https://host-injetado.example/callback',
      nodeEnv: 'production',
      appUrl: 'https://app.example/path'
    })).toBe('https://app.example');
    expect(getTrustedAppOrigin({
      requestUrl: 'https://host-injetado.example/callback',
      nodeEnv: 'production',
      appUrl: 'http://app.example'
    })).toBeNull();
  });

  it('usa a URL de producao da Vercel sem confiar no host da requisicao', () => {
    expect(getTrustedAppOrigin({
      requestUrl: 'https://host-injetado.example/callback',
      nodeEnv: 'production',
      vercelProductionUrl: 'followup.example'
    })).toBe('https://followup.example');
  });

  it('permite a origem local somente fora de producao', () => {
    expect(getTrustedAppOrigin({
      requestUrl: 'http://localhost:3000/auth/callback',
      nodeEnv: 'development'
    })).toBe('http://localhost:3000');
    expect(getTrustedAppOrigin({
      requestUrl: 'https://nao-confiavel.example/auth/callback',
      nodeEnv: 'production'
    })).toBeNull();
  });

  it('aceita somente caminhos internos de redirecionamento', () => {
    expect(normalizeInternalRedirectPath('/login?mode=reset')).toBe('/login?mode=reset');
    expect(normalizeInternalRedirectPath('https://evil.example')).toBe('/');
    expect(normalizeInternalRedirectPath('//evil.example')).toBe('/');
    expect(normalizeInternalRedirectPath('/\\evil.example')).toBe('/');
  });
});
