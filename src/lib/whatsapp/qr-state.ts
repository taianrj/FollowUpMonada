export type WhatsappQrStatus =
  | 'waiting'
  | 'qrcode'
  | 'connected'
  | 'pairing_reset_required'
  | 'disconnected'
  | 'error';

export interface WhatsappQrState {
  status: WhatsappQrStatus;
  qrCode: string | null;
  message: string | null;
  detail: string | null;
  disconnectCode: number | null;
}

function readOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function readOptionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function formatQrDisconnectDetail(disconnectCode: number | null, detail: string | null): string | null {
  if (disconnectCode !== null && detail) {
    return `Código ${disconnectCode}: ${detail}`;
  }
  if (disconnectCode !== null) {
    return `Código de desconexão: ${disconnectCode}`;
  }
  return detail;
}

export function parseQrCodePayload(payload: unknown): WhatsappQrState {
  if (!payload || typeof payload !== 'object') {
    return {
      status: 'error',
      qrCode: null,
      message: 'Resposta inválida do serviço do WhatsApp ao solicitar o QR Code.',
      detail: null,
      disconnectCode: null,
    };
  }

  const data = payload as Record<string, unknown>;
  const status = data.status;
  const disconnectCode = readOptionalNumber(data.disconnectCode);
  const rawDetail = readOptionalString(data.detail);
  const detail = formatQrDisconnectDetail(disconnectCode, rawDetail);
  const message = readOptionalString(data.message);

  if (status === 'connected') {
    return { status: 'connected', qrCode: null, message: null, detail: null, disconnectCode: null };
  }

  if (status === 'qrcode') {
    const qrCode = readOptionalString(data.qrCode);
    if (qrCode) {
      return { status: 'qrcode', qrCode, message: null, detail: null, disconnectCode: null };
    }
    return {
      status: 'waiting',
      qrCode: null,
      message: null,
      detail,
      disconnectCode,
    };
  }

  if (status === 'pairing_reset_required') {
    return {
      status: 'pairing_reset_required',
      qrCode: null,
      message:
        message ||
        'A sessão anterior do WhatsApp foi encerrada. Suas mensagens e contatos foram preservados. Confirme abaixo para gerar um novo QR Code.',
      detail,
      disconnectCode,
    };
  }

  if (status === 'disconnected') {
    return {
      status: 'disconnected',
      qrCode: null,
      message:
        message ||
        'A conexão com o WhatsApp está parada. Clique em "Tentar novamente" para iniciar o pareamento.',
      detail,
      disconnectCode,
    };
  }

  if (status === 'waiting') {
    return {
      status: 'waiting',
      qrCode: null,
      message,
      detail,
      disconnectCode,
    };
  }

  return {
    status: 'error',
    qrCode: null,
    message:
      readOptionalString(data.error) ||
      message ||
      'Não foi possível obter o estado do QR Code no serviço do WhatsApp.',
    detail,
    disconnectCode,
  };
}

export function describeQrHttpError(status: number, bodyError?: unknown): string {
  const serverMessage = readOptionalString(bodyError);

  if (status === 401 || status === 403) {
    return serverMessage || 'Sessão expirada ou sem permissão para conectar o WhatsApp. Recarregue a página e tente novamente.';
  }
  if (status === 503) {
    return serverMessage || 'O serviço do WhatsApp não está configurado ou está temporariamente indisponível.';
  }
  if (status === 504) {
    return serverMessage || 'O serviço do WhatsApp demorou para responder ao gerar o QR Code.';
  }
  if (status === 502) {
    return serverMessage || 'Não foi possível alcançar o serviço do WhatsApp (erro 502).';
  }

  return serverMessage || `Falha ao solicitar o QR Code (HTTP ${status}).`;
}

export function describeQrNetworkError(error: unknown): string {
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return 'A requisição do QR Code expirou. Verifique se o serviço do WhatsApp está ativo e tente novamente.';
  }
  return 'Falha de conexão ao buscar o QR Code. Verifique sua rede ou a disponibilidade do serviço do WhatsApp.';
}
