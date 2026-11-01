import { createWhatsappServiceAuthHeaders } from './service-auth';

export async function readReadyWhatsappMessages(userId: string, date: string) {
  const baseUrl = (process.env.WHATSAPP_SERVICE_URL || process.env.NEXT_PUBLIC_WHATSAPP_SERVICE_URL || '').trim();
  const secret = process.env.WHATSAPP_SERVICE_SECRET;
  if (!baseUrl || !secret) return { ok: false as const, status: 503, error: 'Integração do WhatsApp não configurada.' };
  try {
    const url = new URL(`${baseUrl.replace(/\/$/, '')}/messages`);
    url.search = new URLSearchParams({ date, format: 'text', requireReady: '1' }).toString();
    const response = await fetch(url, {
      headers: createWhatsappServiceAuthHeaders({ secret, userId, method: 'GET', url: url.toString() }),
      cache: 'no-store', signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      return { ok: false as const, status: response.status === 409 ? 409 : 503,
        error: response.status === 409
          ? 'O dia ainda não está liberado: há histórico ou áudios pendentes. Consulte o progresso da data.'
          : 'Não foi possível verificar as mensagens do WhatsApp.' };
    }
    const text = await response.text();
    if (!text.trim()) return { ok: false as const, status: 409, error: 'Não há mensagens para esta data.' };
    return { ok: true as const, text };
  } catch {
    return { ok: false as const, status: 503, error: 'Serviço do WhatsApp indisponível para verificar o dia.' };
  }
}
