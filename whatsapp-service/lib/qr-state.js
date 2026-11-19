'use strict';

function buildQrCodeResponse(instance, options = {}) {
  const loggedOutCode = options.loggedOutCode ?? 401;
  const qrCodeImage = options.qrCodeImage || null;
  const disconnectCode = instance?.lastDisconnectCode ?? null;
  const disconnectError = typeof instance?.lastDisconnectError === 'string' && instance.lastDisconnectError.trim()
    ? instance.lastDisconnectError.trim()
    : null;

  if (instance?.connectionStatus === 'connected') {
    return { status: 'connected' };
  }

  if (qrCodeImage) {
    return { status: 'qrcode', qrCode: qrCodeImage };
  }

  if (instance?.connectionStatus === 'disconnected') {
    if (disconnectCode === loggedOutCode) {
      return {
        status: 'pairing_reset_required',
        reason: 'logged_out',
        disconnectCode,
        detail: disconnectError,
        message: 'A sessão anterior do WhatsApp foi encerrada. Suas mensagens e contatos foram preservados. Confirme abaixo para gerar um novo QR Code.'
      };
    }

    return {
      status: 'disconnected',
      reason: instance.intentionalLogout ? 'intentional_logout' : 'disconnected',
      disconnectCode,
      detail: disconnectError,
      message: 'A conexão com o WhatsApp está parada. Clique em "Tentar novamente" para iniciar o pareamento.'
    };
  }

  return {
    status: 'waiting',
    disconnectCode,
    detail: disconnectError
  };
}

module.exports = {
  buildQrCodeResponse
};
