import type { ExtensionJob, ExtensionMessage, ExtensionStatus } from './contracts';

type ChromeRuntime = { sendMessage(id: string, message: unknown, callback: (response: Record<string, unknown> | undefined) => void): void; lastError?: { message: string } };
export interface ExtensionInfo { extensionId: string; minimumVersion: string; installUrl: string | null; local: boolean; userId: string }
export interface CollectedMessage extends Omit<ExtensionMessage, 'audio'> { audio: null | { status: string; validation: string; sha256?: string; byteLength: number; mimetype: string } }
export interface CollectedDay { date: string; accountId: string; messages: CollectedMessage[]; partialChats: number }
export class ExtensionRequestError extends Error { constructor(message: string, public code?: string) { super(message); } }

export async function extensionApi<T>(action: string, body: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch('/api/whatsapp-extension', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, body }), signal: AbortSignal.timeout(35000) });
  const data = await response.json(); if (!response.ok) throw new ExtensionRequestError(data.error || 'Não foi possível concluir a operação.', data.code); return data as T;
}
export async function extensionInfo(): Promise<ExtensionInfo> {
  const response = await fetch('/api/whatsapp-extension', { cache: 'no-store', signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error('Não foi possível verificar a integração. Faça login novamente.'); return response.json();
}
export function sendToExtension<T>(id: string, message: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    const runtime = (window as unknown as { chrome?: { runtime?: ChromeRuntime } }).chrome?.runtime;
    if (!runtime || !/^[a-p]{32}$/.test(id)) { reject(new Error('Instale e ative a extensão do Mônada neste Chrome.')); return; }
    const timer = setTimeout(() => reject(new Error('A extensão não respondeu. Verifique se está instalada e atualizada.')), 20000);
    runtime.sendMessage(id, message, response => {
      clearTimeout(timer);
      if (runtime.lastError || !response) { reject(new Error('Instale ou atualize a extensão do Mônada e clique em Verificar novamente.')); return; }
      if (response.ok !== true) { reject(new ExtensionRequestError(String(response.error || 'Falha na extensão.'), typeof response.code === 'string' ? response.code : undefined)); return; }
      resolve(response as T);
    });
  });
}
export const versionCompatible = (actual: string, minimum: string) => {
  const a = actual.split('.').map(Number), b = minimum.split('.').map(Number);
  if (a.some(n => !Number.isInteger(n)) || a.length !== 3) return false;
  for (let i = 0; i < 3; i++) { if (a[i] > b[i]) return true; if (a[i] < b[i]) return false; } return true;
};
export async function collectedDay(info: ExtensionInfo, operationId: string): Promise<CollectedDay> {
  return sendToExtension<CollectedDay>(info.extensionId, { action: 'metadata', operationId, userId: info.userId });
}
export async function extensionLocalApi<T>(info: ExtensionInfo, command: string, body: Record<string, unknown> = {}): Promise<T> {
  const response = await sendToExtension<{ result: T }>(info.extensionId, { action: 'local', userId: info.userId, command, body });
  return response.result;
}
export async function uploadCollectedDay(info: ExtensionInfo, operationId: string, day: CollectedDay, onProgress: (text: string) => void, api?: typeof extensionApi) {
  const call = api || (<T,>(action: string, body: Record<string, unknown> = {}) => extensionLocalApi<T>(info, action, body));
  let pages = 0;
  for (let i = 0; i < day.messages.length; i += 100) { onProgress(`Salvando conversas no computador: ${Math.min(i + 100, day.messages.length)}/${day.messages.length}`); await call('append', { jobId: operationId, index: pages++, messages: day.messages.slice(i, i + 100).map(({ id, chatJid, chatName, senderName, senderJid, timestampMs, fromMe, type, text, isForwarded, quotedMessageId }) => ({ id, chatJid, chatName, senderName, senderJid, timestampMs, fromMe, type, text, isForwarded, quotedMessageId })) }); }
  const manifest: { id: string; chunks: number; byteLength: number; hash: string; mimetype: string }[] = [];
  const audiosToSave = day.messages.filter(m => m.audio?.status === 'recovered' && m.audio.validation === 'decoded');
  let audioIndex = 0;
  for (const message of audiosToSave) {
    onProgress(`Salvando áudio no computador ${++audioIndex}/${audiosToSave.length}…`);
    const first = await sendToExtension<{ base64: string; chunks: number; byteLength: number; hash: string; mimetype: string }>(info.extensionId, { action: 'audio', operationId, userId: info.userId, messageId: message.id, index: 0 });
    if (first.byteLength > 16 * 1024 * 1024) throw new Error('Um áudio excede o limite de 16 MiB desta versão. Reinicie a coleta com transcrição desativada ou use uma data com arquivos menores.');
    for (let index = 0; index < first.chunks; index++) {
      const chunk = index === 0 ? first : await sendToExtension<{ base64: string }>(info.extensionId, { action: 'audio', operationId, userId: info.userId, messageId: message.id, index });
      await call('audio', { jobId: operationId, messageId: message.id, index, hash: first.hash, base64: chunk.base64 });
    }
    manifest.push({ id: message.id, chunks: first.chunks, byteLength: first.byteLength, hash: first.hash, mimetype: first.mimetype });
  }
  return call<ExtensionJob>('seal', { jobId: operationId, messageCount: day.messages.length, pages, partialChats: 0, audioManifest: manifest });
}
export type ExtensionPing = { version: string; accountId: string | null; instruction: string | null };
export type ExtensionStatusResponse = ExtensionStatus;

// A consulta é somente uma prévia local: não cria importação, não envia áudio,
// não chama IA e não substitui conversas ou resumos persistidos.
export async function previewConversations(
  date: string,
  userId: string,
  confirm: (title: string, message: string) => Promise<boolean>,
  onProgress: (message: string) => void,
  api?: typeof extensionApi,
): Promise<ExtensionMessage[]> {
  const info = await extensionInfo();
  const call = api || (<T,>(action: string, body: Record<string, unknown> = {}) => extensionLocalApi<T>(info, action, body));
  if (info.userId !== userId) throw new Error('Sua sessão mudou. Atualize a página antes de consultar as conversas.');
  const ping = await sendToExtension<ExtensionPing>(info.extensionId, { action: 'ping', userId: info.userId });
  if (!versionCompatible(ping.version, info.minimumVersion)) throw new Error('Atualize a extensão do Mônada e clique em Verificar novamente.');
  if (!ping.accountId) throw new Error(ping.instruction || 'Abra o WhatsApp Web e conecte sua conta.');
  const { binding } = await call<ExtensionStatus>('status');
  if (binding?.accountId !== ping.accountId) {
    const approved = await confirm(binding ? 'A conta do WhatsApp mudou' : 'Vincular WhatsApp ao Mônada?', `Vincular a conta ${ping.accountId.split('@')[0]} ao seu usuário? Esta consulta lê os textos localmente, sem gerar resumo ou transcrever áudios. Ao usar Gerar Resumo, as conversas serão enviadas ao Mônada e aos provedores de IA para resumo e transcrição quando habilitada. Imagens não serão analisadas. O histórico de outras contas será preservado separadamente.`);
    if (!approved) return [];
    await call('binding', { accountId: ping.accountId, confirmRebind: !!binding });
  }
  const operationId = crypto.randomUUID();
  try {
    onProgress('Lendo as conversas disponíveis desta data no WhatsApp Web…');
    let { state } = await sendToExtension<{ state: string }>(info.extensionId, { action: 'start', operationId, userId: info.userId, date, accountId: ping.accountId, transcribeAudio: false });
    const deadline = Date.now() + 300000;
    while (state === 'collecting') {
      if (Date.now() >= deadline) throw new Error('A consulta demorou mais que o esperado. Tente novamente.');
      await new Promise(resolve => setTimeout(resolve, 1000));
      const result = await sendToExtension<{ state: string; error?: string }>(info.extensionId, { action: 'status', operationId, userId: info.userId });
      if (result.state === 'failed') throw new Error(result.error || 'Não foi possível ler as conversas desta data.');
      state = result.state;
    }
    if (state !== 'collected') throw new Error('A consulta foi interrompida. Tente novamente.');
    const day = await collectedDay(info, operationId);
    if (day.date !== date || day.accountId !== ping.accountId || !Array.isArray(day.messages)) throw new Error('A conta ou a data da consulta mudou. Tente novamente.');
    if ((await extensionInfo()).userId !== userId) throw new Error('Sua sessão mudou. Atualize a página antes de consultar as conversas.');
    return day.messages.map(message => ({
      ...message,
      audio: message.audio ? { status: 'not_requested', transcription: null, hash: null, chunks: 0, byteLength: 0, mimetype: message.audio.mimetype || 'audio/ogg', expiresAt: null, attempts: 0 } : null,
    }));
  } finally { await sendToExtension(info.extensionId, { action: 'clear', operationId, userId: info.userId }).catch(() => {}); }
}
