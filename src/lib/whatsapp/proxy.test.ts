import { describe, expect, it } from 'vitest';
import { buildWhatsappUpstreamUrl, getWhatsappProxyAllowedMethods } from './proxy';

describe('proxy do WhatsApp', () => {
  it('permite apenas os endpoints e métodos necessários', () => {
    expect(getWhatsappProxyAllowedMethods('messages')).toEqual(new Set(['GET']));
    expect(getWhatsappProxyAllowedMethods('logout')).toEqual(new Set(['POST']));
    expect(getWhatsappProxyAllowedMethods('maintenance/resync')).toEqual(new Set(['POST']));
    expect(getWhatsappProxyAllowedMethods('clear-logs')).toBeNull();
  });

  it('remove identidade e nome da URL para enviá-los somente em headers autenticados', () => {
    const url = buildWhatsappUpstreamUrl({
      baseUrl: 'https://whatsapp.example/',
      servicePath: 'messages',
      incomingUrl: 'https://app.example/api/whatsapp-service/messages?date=2026-07-09&format=json_grouped&key=atacante&ownerName=Outro'
    });

    expect(url.origin + url.pathname).toBe('https://whatsapp.example/messages');
    expect(url.searchParams.get('date')).toBe('2026-07-09');
    expect(url.searchParams.get('format')).toBe('json_grouped');
    expect(url.searchParams.get('key')).toBeNull();
    expect(url.searchParams.get('ownerName')).toBeNull();
  });

  it('não cria ownerName vazio nem duplica query strings', () => {
    const url = buildWhatsappUpstreamUrl({
      baseUrl: 'http://localhost:8080',
      servicePath: 'status',
      incomingUrl: 'http://localhost:3000/api/whatsapp-service/status?foo=1&foo=2'
    });

    expect(url.searchParams.get('ownerName')).toBeNull();
    expect(url.searchParams.getAll('foo')).toEqual(['2']);
  });
});
