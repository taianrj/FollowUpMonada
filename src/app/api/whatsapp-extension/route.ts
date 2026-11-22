import { NextResponse } from 'next/server';
import { requireExtensionAdmin, isLocalExtension } from '@/lib/whatsapp-extension/server';
import { generateExtensionSummary, findExtensionSummary } from '@/lib/whatsapp-extension/stateless';
import { transcribeAudio } from '../../../../workers/whatsapp-extension/providers.mjs';
import { requireValue } from '../../../../workers/whatsapp-extension/domain.mjs';
import { getWhatsappIntegrationMode } from '@/lib/whatsapp/integration-mode';
import { validateSameOrigin, readBoundedJson } from '@/lib/database/http';
import { InputError, isInputError, validDate } from '../../../../workers/whatsapp-extension/domain.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET() {
  try {
    const { user } = await requireExtensionAdmin();
    return NextResponse.json({ userId: user.id, mode: getWhatsappIntegrationMode(), extensionId: process.env.NEXT_PUBLIC_WHATSAPP_EXTENSION_ID || '', minimumVersion: '1.0.0', installUrl: installationUrl(), local: isLocalExtension() }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) { return failure(err); }
}
function installationUrl() {
  try { const url = new URL(process.env.WHATSAPP_EXTENSION_INSTALL_URL || ''); return url.protocol === 'https:' && url.hostname === 'chromewebstore.google.com' && url.pathname.startsWith('/detail/') ? url.href : null; } catch { return null; }
}
export async function POST(request: Request) {
  try {
    if (!validateSameOrigin(request)) throw new InputError('Origem inválida.', 403);
    const actor = await requireExtensionAdmin();
    const { user, db } = actor;
    let payload: { action?: string; body?: Record<string, unknown>; expectedUserId?: unknown };
    try { payload = await readBoundedJson(request, 3000000) as typeof payload; }
    catch (error) { throw new InputError('Requisição inválida ou muito grande.', error instanceof Error && error.message === 'Corpo muito grande.' ? 413 : 400); }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || (payload.body !== undefined && (!payload.body || typeof payload.body !== 'object' || Array.isArray(payload.body)))) throw new InputError('Requisição inválida.');
    if (payload?.action === 'history') {
      const date = payload.body?.date;
      if (!validDate(date)) throw new InputError('Data inválida.');
      const messages = [];
      for (let offset = 0; ; offset += 200) {
        const { data, error } = await db.from('whatsapp_messages').select('*').eq('user_id', user.id).eq('message_date', date).order('message_timestamp').range(offset, offset + 199);
        if (error) throw new InputError('Não foi possível consultar as conversas salvas.', 503);
        for (const row of data || []) {
          if (row.chat_jid === 'status@broadcast' || typeof row.from_me !== 'boolean') continue;
          const timestampMs = Date.parse(row.message_timestamp);
          if (!Number.isFinite(timestampMs)) continue;
          messages.push({ id: row.message_id || row.dedupe_key, chatJid: row.chat_jid, chatName: row.chat_name || row.chat_jid, senderJid: row.participant_jid || '', senderName: row.display_name || '', fromMe: row.from_me, timestampMs, type: 'chat', text: row.text || '', isForwarded: row.is_forwarded === true, quotedMessageId: row.quoted_message_id || '', audio: null });
        }
        if (!data || data.length < 200) break;
      }
      return NextResponse.json({ source: 'baileys', messages }, { headers: { 'Cache-Control': 'no-store' } });
    }
    if (getWhatsappIntegrationMode() !== 'chrome_extension') throw new InputError('A integração pela extensão está desativada.', 409);
    if (!['transcribe', 'summarize', 'summaryExists'].includes(payload.action || '')) throw new InputError('Os dados agora ficam na extensão. Atualize a extensão e o Mônada para continuar.', 410, 'EXTENSION_UPDATE_REQUIRED');
    const body = payload.body || {};
    if (payload.action === 'summaryExists') {
      if (!validDate(body.date)) throw new InputError('Data inválida.');
      return NextResponse.json({ exists: !!await findExtensionSummary(actor, body.date as string) }, { headers: { 'Cache-Control': 'no-store' } });
    }
    // Confere contra a sessão real; este campo só impede corrida de troca de
    // login entre GET e POST, nunca define quem está autorizado.
    if (payload.expectedUserId !== user.id) throw new InputError('Sua sessão mudou. Entre na conta correta.', 403);
    if (payload.action === 'transcribe') {
      requireValue(typeof body.base64 === 'string' && body.base64.length > 0 && body.base64.length <= Math.ceil(2 * 1024 * 1024 / 3) * 4 && /^[A-Za-z0-9+/]*={0,2}$/.test(body.base64) && body.base64.length % 4 === 0, 'Áudio inválido ou maior que 2 MiB.');
      requireValue(typeof body.mimetype === 'string' && /^audio\/(ogg|opus|mpeg|mp4|aac|wav|webm)$/.test(body.mimetype), 'Tipo de áudio inválido.');
      const bytes = Uint8Array.from(atob(body.base64 as string), c => c.charCodeAt(0));
      requireValue(bytes.length > 0 && bytes.length <= 2 * 1024 * 1024, 'Áudio inválido ou maior que 2 MiB.');
      const text = await transcribeAudio(bytes, body.mimetype as string, process.env);
      const current = await requireExtensionAdmin();
      if (current.user.id !== user.id) throw new InputError('Sua sessão mudou. Entre na conta correta.', 403);
      return NextResponse.json({ text }, { headers: { 'Cache-Control': 'no-store' } });
    }
    return NextResponse.json(await generateExtensionSummary(actor, body), { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) { return failure(err); }
}
function failure(err: unknown) {
  const known = isInputError(err) ? err as InputError : null;
  return NextResponse.json({ error: known ? known.message : 'Não foi possível concluir a operação. Os dados anteriores foram preservados.', code: known ? known.code : 'EXTENSION_FAILURE' }, { status: known ? known.status : 500 });
}
