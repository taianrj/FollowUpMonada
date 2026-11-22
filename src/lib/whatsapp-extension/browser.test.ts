import { afterEach, describe, expect, it, vi } from 'vitest';
import { extensionApi, previewConversations, sendToExtension, uploadCollectedDay, versionCompatible } from './browser';
describe('protocolo da extensão', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  it('só bloqueia versões incompatíveis e rejeita versões malformadas', () => {
    expect(versionCompatible('0.2.0', '0.2.0')).toBe(true);
    expect(versionCompatible('0.3.0', '0.2.0')).toBe(true);
    expect(versionCompatible('0.1.9', '0.2.0')).toBe(false);
    expect(versionCompatible('invalid', '0.2.0')).toBe(false);
  });
  it('orienta instalação quando o Chrome não disponibiliza a extensão', async () => {
    vi.stubGlobal('window', {});
    await expect(sendToExtension('a'.repeat(32), { action: 'ping' })).rejects.toThrow(/Instale/);
  });
  it('não trata falha da extensão como coleta bem-sucedida', async () => {
    vi.stubGlobal('window', { chrome: { runtime: { sendMessage(_id: string, _msg: unknown, callback: (value: unknown) => void) { callback({ ok: false, error: 'WhatsApp fechado' }); } } } });
    await expect(sendToExtension('a'.repeat(32), { action: 'ping' })).rejects.toThrow('WhatsApp fechado');
  });
  it('preserva o motivo e o código de confirmação devolvidos pelo servidor', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: 'Confirme a substituição', code: 'REPLACE_REQUIRED' }, { status: 409 })));
    await expect(extensionApi('create')).rejects.toMatchObject({ code: 'REPLACE_REQUIRED' });
  });
});

describe('consulta independente do resumo', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
  const date = '2026-11-19';
  const accountId = 'test-account@c.us';
  function setup(options: { linked?: boolean; changedUser?: boolean; changedAccount?: boolean; failed?: boolean } = {}) {
    let reads = 0;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method !== 'POST') return Response.json({ extensionId: 'a'.repeat(32), minimumVersion: '1.0.0', userId: options.changedUser && ++reads > 1 ? 'other-user' : 'test-user' });
      throw new Error('A consulta não pode fazer POST ao servidor');
    });
    const sendMessage = vi.fn((_id: string, message: Record<string, unknown>, callback: (value: unknown) => void) => {
      const results: Record<string, unknown> = {
        local: { result: message.command === 'status' ? { binding: options.linked === false ? null : { accountId }, jobs: [] } : { linked: true } },
        ping: { version: '1.0.0', accountId }, start: { state: 'collecting' },
        status: options.failed ? { state: 'failed', error: 'Coleta interrompida' } : { state: 'collected' },
        metadata: { date, accountId: options.changedAccount ? 'other-account@c.us' : accountId, partialChats: 0, messages: [
          { id: 'text-1', chatJid: 'test-chat@c.us', text: 'Texto sintético', fromMe: false, audio: null },
          { id: 'audio-1', chatJid: 'test-chat@c.us', text: '', fromMe: true, audio: { status: 'disabled', mimetype: 'audio/ogg' } },
        ] }, clear: { cleared: true },
      };
      if (!(String(message.action) in results)) throw new Error('Ação de extensão inesperada');
      callback({ ok: true, ...results[String(message.action)] as object });
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('window', { chrome: { runtime: { sendMessage } } });
    vi.useFakeTimers();
    return { fetchMock, sendMessage };
  }
  it('lê mensagens sem importação, downloads, transcrição ou geração e limpa a coleta temporária', async () => {
    const { fetchMock, sendMessage } = setup();
    const confirm = vi.fn();
    const result = previewConversations(date, 'test-user', confirm, vi.fn());
    await vi.runAllTimersAsync();
    const messages = await result;
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ text: 'Texto sintético', fromMe: false });
    expect(messages[1].audio).toMatchObject({ status: 'not_requested', transcription: null, chunks: 0 });
    expect(confirm).not.toHaveBeenCalled();
    expect(sendMessage.mock.calls.map(([, message]) => message.action)).toEqual(['ping', 'local', 'start', 'status', 'metadata', 'clear']);
    expect(sendMessage.mock.calls[2][1]).toMatchObject({ date, accountId, transcribeAudio: false });
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST').map(([, init]) => JSON.parse(String(init?.body)).action)).toEqual([]);
  });
  it('não coleta se o usuário cancelar o primeiro vínculo', async () => {
    const { sendMessage } = setup({ linked: false });
    await expect(previewConversations(date, 'test-user', vi.fn().mockResolvedValue(false), vi.fn())).resolves.toEqual([]);
    expect(sendMessage.mock.calls.map(([, message]) => message.action)).toEqual(['ping', 'local']);
  });
  it.each([
    [{ changedUser: true }, /sessão mudou/],
    [{ changedAccount: true }, /conta ou a data/],
    [{ failed: true }, /Coleta interrompida/],
  ])('rejeita resultado inválido ou falha e limpa os dados temporários (%j)', async (options, error) => {
    const { sendMessage } = setup(options);
    const result = expect(previewConversations(date, 'test-user', vi.fn(), vi.fn())).rejects.toThrow(error);
    await vi.runAllTimersAsync();
    await result;
    expect(sendMessage.mock.calls.at(-1)?.[1].action).toBe('clear');
  });

  it('informa o total de áudios ao salvar no computador', async () => {
    const progressMessages: string[] = [];
    const sendMessage = vi.fn((_id: string, message: Record<string, unknown>, callback: (value: unknown) => void) => {
      if (message.action === 'audio') {
        callback({ ok: true, base64: 'T2dnUw==', chunks: 1, byteLength: 4, hash: 'h1', mimetype: 'audio/ogg' });
        return;
      }
      callback({ ok: true, result: { id: 'op-1', state: 'processing' } });
    });
    vi.stubGlobal('window', { chrome: { runtime: { sendMessage } } });
    const api = vi.fn(async () => ({ id: 'op-1', state: 'processing' }) as never);

    await uploadCollectedDay(
      { extensionId: 'a'.repeat(32), minimumVersion: '1.0.0', installUrl: null, local: true, userId: 'test-user' },
      'op-1',
      {
        date: '2026-11-19',
        accountId: 'test-account@c.us',
        partialChats: 0,
        messages: [
          { id: 'a1', chatJid: 'c1@c.us', chatName: 'C1', senderJid: 'c1@c.us', senderName: 'C1', timestampMs: 1000, fromMe: false, type: 'ptt', text: '', isForwarded: false, quotedMessageId: '', audio: { status: 'recovered', validation: 'decoded', byteLength: 4, mimetype: 'audio/ogg' } },
          { id: 'a2', chatJid: 'c1@c.us', chatName: 'C1', senderJid: 'c1@c.us', senderName: 'C1', timestampMs: 2000, fromMe: false, type: 'ptt', text: '', isForwarded: false, quotedMessageId: '', audio: { status: 'recovered', validation: 'decoded', byteLength: 4, mimetype: 'audio/ogg' } },
        ],
      },
      text => progressMessages.push(text),
      api,
    );

    expect(progressMessages).toContain('Salvando áudio no computador 1/2…');
    expect(progressMessages).toContain('Salvando áudio no computador 2/2…');
  });
});
