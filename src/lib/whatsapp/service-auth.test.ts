import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildWhatsappServiceCanonicalRequest,
  createWhatsappServiceAuthHeaders,
  hashWhatsappServiceBody
} from './service-auth';

const secret = 'segredo-de-teste-com-pelo-menos-32-caracteres';

describe('autenticacao do microsservico WhatsApp', () => {
  it('assina identidade, metodo, caminho, query e corpo sem enviar o segredo', () => {
    const body = JSON.stringify({ transcribe_audio: true });
    const timestamp = 1_752_688_800_000;
    const nonce = '00000000-0000-4000-8000-000000000099';
    const url = 'https://whatsapp.example/settings?mode=safe';
    const headers = createWhatsappServiceAuthHeaders({
      secret,
      userId: '00000000-0000-4000-8000-000000000001',
      method: 'POST',
      url,
      body,
      timestamp,
      nonce
    });

    const bodyHash = createHash('sha256').update(body).digest('hex');
    const canonicalRequest = [
      'v1',
      String(timestamp),
      nonce,
      '00000000-0000-4000-8000-000000000001',
      'POST',
      '/settings?mode=safe',
      bodyHash
    ].join('\n');
    const expectedSignature = createHmac('sha256', secret)
      .update(canonicalRequest)
      .digest('hex');

    expect(headers['x-service-signature']).toBe(expectedSignature);
    expect(headers['x-service-body-sha256']).toBe(bodyHash);
    expect(Object.values(headers)).not.toContain(secret);
    expect(headers).not.toHaveProperty('x-service-token');
  });

  it('altera a assinatura quando caminho, corpo ou identidade mudam', () => {
    const base = {
      secret,
      userId: '00000000-0000-4000-8000-000000000001',
      method: 'POST',
      url: 'https://whatsapp.example/settings',
      body: '{}',
      timestamp: 1_752_688_800_000,
      nonce: '00000000-0000-4000-8000-000000000099'
    };

    const original = createWhatsappServiceAuthHeaders(base)['x-service-signature'];
    expect(createWhatsappServiceAuthHeaders({ ...base, body: '{"x":1}' })['x-service-signature']).not.toBe(original);
    expect(createWhatsappServiceAuthHeaders({ ...base, url: 'https://whatsapp.example/logout' })['x-service-signature']).not.toBe(original);
    expect(createWhatsappServiceAuthHeaders({ ...base, userId: '00000000-0000-4000-8000-000000000002' })['x-service-signature']).not.toBe(original);
  });

  it('rejeita segredo curto e produz a mesma requisicao canonica do protocolo', () => {
    expect(() => createWhatsappServiceAuthHeaders({
      secret: 'curto',
      userId: '00000000-0000-4000-8000-000000000001',
      method: 'GET',
      url: 'https://whatsapp.example/status'
    })).toThrow(/pelo menos 32/);

    const bodyHash = hashWhatsappServiceBody('');
    expect(buildWhatsappServiceCanonicalRequest({
      userId: 'usuario',
      method: 'get',
      url: 'https://whatsapp.example/status?date=2026-07-16',
      bodyHash,
      timestamp: 123,
      nonce: 'nonce'
    })).toBe(`v1\n123\nnonce\nusuario\nGET\n/status?date=2026-07-16\n${bodyHash}`);
  });
});
