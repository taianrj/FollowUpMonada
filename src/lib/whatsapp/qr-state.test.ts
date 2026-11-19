import { describe, expect, it } from 'vitest';
import {
  describeQrHttpError,
  describeQrNetworkError,
  parseQrCodePayload,
} from './qr-state';

describe('estado do QR Code do WhatsApp', () => {
  it('interpreta estados válidos de pareamento, desconexão e recuperação explícita', () => {
    expect(parseQrCodePayload({ status: 'connected' })).toEqual({
      status: 'connected',
      qrCode: null,
      message: null,
      detail: null,
      disconnectCode: null,
    });

    expect(parseQrCodePayload({ status: 'qrcode', qrCode: 'data:image/png;base64,xyz' })).toEqual({
      status: 'qrcode',
      qrCode: 'data:image/png;base64,xyz',
      message: null,
      detail: null,
      disconnectCode: null,
    });

    expect(
      parseQrCodePayload({
        status: 'pairing_reset_required',
        disconnectCode: 401,
        detail: 'Logged Out',
        message: 'Sessão encerrada.',
      })
    ).toEqual({
      status: 'pairing_reset_required',
      qrCode: null,
      message: 'Sessão encerrada.',
      detail: 'Código 401: Logged Out',
      disconnectCode: 401,
    });

    expect(
      parseQrCodePayload({
        status: 'disconnected',
        disconnectCode: 428,
      })
    ).toMatchObject({
      status: 'disconnected',
      detail: 'Código de desconexão: 428',
      disconnectCode: 428,
    });
  });

  it('trata payloads inválidos ou inesperados como erro explícito', () => {
    expect(parseQrCodePayload(null).status).toBe('error');
    expect(parseQrCodePayload({ error: 'Falha interna' })).toMatchObject({
      status: 'error',
      message: 'Falha interna',
    });
  });

  it('formata mensagens claras para erros HTTP e falhas de rede/timeout', () => {
    expect(describeQrHttpError(503)).toMatch(/indisponível|configurado/i);
    expect(describeQrHttpError(504)).toMatch(/demorou/i);
    expect(describeQrHttpError(401)).toMatch(/expirada|permissão/i);
    expect(describeQrHttpError(502, 'Servico do WhatsApp indisponivel')).toBe('Servico do WhatsApp indisponivel');

    const timeoutErr = new Error('Timeout');
    timeoutErr.name = 'TimeoutError';
    expect(describeQrNetworkError(timeoutErr)).toMatch(/expirou/i);
    expect(describeQrNetworkError(new Error('Failed to fetch'))).toMatch(/conexão/i);
  });
});
