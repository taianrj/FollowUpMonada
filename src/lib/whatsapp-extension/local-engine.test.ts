import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { digest } from '../../../workers/whatsapp-extension/domain.mjs';
const state = vi.hoisted(() => ({ stores: new Map<string, Map<string, unknown>>(), contexts: new Map<string, unknown>(), sessions: new Map<number, string>(), alarms: new Map<string, { scheduledTime: number }>(), requests: [] as { user: string; action: string; body: Record<string, unknown> }[], pause: null as Promise<void> | null }));
function storage(namespace: string) {
  if (!state.stores.has(namespace)) state.stores.set(namespace, new Map());
  const values = state.stores.get(namespace)!;
  return {
    async get(key: string) { return structuredClone(values.get(key)); },
    async put(key: string, value: unknown) { values.set(key, structuredClone(value)); },
    async delete(key: string) { values.delete(key); },
    async list({ prefix }: { prefix: string }) { return new Map([...values].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key, structuredClone(value)])); },
    async getAlarm() { return state.alarms.get('local:' + namespace)?.scheduledTime || null; },
    async setAlarm(timestamp: number) { state.alarms.set('local:' + namespace, { scheduledTime: timestamp }); }
  };
}
vi.mock('../../../chrome-extension/storage.mjs', () => ({
  localStorage: (namespace: string) => storage(namespace), cleanOperations: vi.fn(),
  localTransaction: async (_mode: string, action: (store: unknown) => unknown) => action({ put(value: unknown, key: string) { state.contexts.set(key, value); }, get(key: string) { return state.contexts.get(key); } })
}));
vi.mock('../../../chrome-extension/session.mjs', () => ({ authenticatedTab: async (tab: number, _origin: string, expected?: string, action?: string, body?: Record<string, unknown>) => {
  const user = state.sessions.get(tab);
  if (!user || (expected && user !== expected)) throw new Error('Sessão inválida');
  if (!action) return { userId: user };
  state.requests.push({ user, action, body: body || {} });
  if (action === 'transcribe') { if (state.pause) await state.pause; return { text: 'Transcrição sintética' }; }
  return { id: 'summary-id', raw_text: '', summary_data: { summaries: [] } };
} }));
const origin = 'http://localhost:3000', accountId = 'test@c.us', date = '2026-11-19';
const message = (id: string, type = 'chat') => ({ id, type, text: 'Texto sintético', chatJid: 'person@c.us', chatName: 'Teste', senderName: 'Pessoa', senderJid: 'person@c.us', fromMe: false, timestampMs: Date.parse('2026-11-19T12:00:00Z') });
async function setup() {
  const integration = await import('../../../chrome-extension/local-engine.mjs');
  const call = (command: string, body: Record<string, unknown> = {}, tab = 1, userId = 'test-user') => integration.localCall(tab, origin, { command, body, userId });
  await call('binding', { accountId });
  return { ...integration, call };
}
async function audioImport(context: Awaited<ReturnType<typeof setup>>, duplicate = false) {
  await context.call('create', { operationId: 'job', accountId, date, transcribeAudio: true, autoGenerate: true });
  await context.call('append', { jobId: 'job', index: 0, messages: [message('text'), message('audio', 'ptt'), ...(duplicate ? [message('audio-copy', 'ptt')] : [])] });
  const bytes = new Uint8Array([79, 103, 103, 83]), hash = await digest(bytes);
  for (const id of duplicate ? ['audio', 'audio-copy'] : ['audio']) await context.call('audio', { jobId: 'job', messageId: id, index: 0, base64: 'T2dnUw==', hash });
  return context.call('seal', { jobId: 'job', pages: 1, messageCount: duplicate ? 3 : 2, partialChats: 0, audioManifest: (duplicate ? ['audio', 'audio-copy'] : ['audio']).map(id => ({ id, hash, byteLength: 4, chunks: 1, mimetype: 'audio/ogg' })) });
}
describe('orquestração persistente dentro da extensão', () => {
  beforeEach(async () => { vi.resetModules(); state.stores.clear(); state.contexts.clear(); state.alarms.clear(); state.sessions.clear(); state.sessions.set(1, 'test-user'); state.sessions.set(2, 'other-user'); state.requests = []; state.pause = null; vi.stubGlobal('chrome', { alarms: { clear: async (key: string) => state.alarms.delete(key) } }); });
  afterEach(() => vi.unstubAllGlobals());
  it('mantém lotes e transcrição localmente e envia ao servidor somente chamadas de IA', async () => {
    const context = await setup(); await audioImport(context);
    expect(state.requests).toHaveLength(0);
    await context.runLocalAlarm(await context.namespaceFor(origin, 'test-user'));
    expect(state.requests.map(r => r.action)).toEqual(['transcribe', 'summarize']);
    expect(state.requests[1].body).toMatchObject({ confirmPending: false, transcribeAudio: true });
    const day = await context.call('day', { date });
    expect(day.messages[1].audio.transcription).toBe('Transcrição sintética');
    expect(day.state).toBe('completed');
    const store = storage(await context.namespaceFor(origin, 'test-user'));
    expect((await store.list({ prefix: 'audio:' })).size).toBe(0);
    expect((await store.list({ prefix: 'transcription:' })).size).toBe(1);
  });
  it('reaproveita áudios idênticos da mesma conta sem repetir a IA', async () => {
    const context = await setup(); await audioImport(context, true);
    const namespace = await context.namespaceFor(origin, 'test-user');
    await context.runLocalAlarm(namespace);
    expect((await context.call('day', { date })).state).toBe('completed');
    expect(state.requests.filter(r => r.action === 'transcribe')).toHaveLength(1);
    expect((await context.call('day', { date })).audioTranscribed).toBe(2);
  });
  it('pausa sem consumir tentativas quando a sessão termina e retoma após reinício do worker', async () => {
    const context = await setup(); await audioImport(context);
    const namespace = await context.namespaceFor(origin, 'test-user');
    state.sessions.delete(1);
    await context.runLocalAlarm(namespace);
    expect(state.requests).toHaveLength(0);
    vi.resetModules(); state.sessions.set(1, 'test-user');
    const reloaded = await import('../../../chrome-extension/local-engine.mjs');
    await reloaded.runLocalAlarm(namespace);
    expect((await reloaded.localCall(1, origin, { command: 'get', userId: 'test-user', body: { jobId: 'job', includeMessages: true } })).state).toBe('completed');
  });
  it('isola usuários e origens e rejeita identidade forjada e comandos internos', async () => {
    const context = await setup(); await audioImport(context);
    await expect(context.call('status', {}, 1, 'other-user')).rejects.toThrow(/sessão/);
    await expect(context.call('claim', { jobId: 'job' })).rejects.toThrow(/não permitida/);
    expect((await context.call('status', {}, 2, 'other-user')).jobs).toHaveLength(0);
    expect(await context.namespaceFor(origin, 'test-user')).not.toBe(await context.namespaceFor('https://other.example', 'test-user'));
  });
  it('permite consultar durante IA e bloqueia escritas concorrentes', async () => {
    const context = await setup(); await audioImport(context);
    let release!: () => void; state.pause = new Promise(resolve => { release = resolve; });
    const running = context.runLocalAlarm(await context.namespaceFor(origin, 'test-user'));
    await vi.waitFor(() => expect(state.requests).toHaveLength(1));
    expect((await context.call('get', { jobId: 'job' })).state).toBe('processing');
    await expect(context.call('settings', { transcribeAudio: false })).rejects.toThrow(/andamento/);
    release(); await running;
  });
  it('exclusão exige confirmação e preserva o namespace de outro usuário', async () => {
    const context = await setup(); await audioImport(context);
    await context.call('binding', { accountId }, 2, 'other-user');
    await expect(context.call('forget')).rejects.toThrow(/Confirme/);
    await context.call('forget', { confirm: true });
    expect((await context.call('status')).jobs).toHaveLength(0);
    expect((await context.call('status', {}, 2, 'other-user')).binding.accountId).toBe(accountId);
  });
  it('limpa conversas/cache após 30 dias e áudio expirado mesmo sem chamada de IA', async () => {
    const context = await setup(); await audioImport(context);
    const store = storage(await context.namespaceFor(origin, 'test-user'));
    await context.pruneLocal(store, Date.now() + 8 * 86400000);
    expect((await store.list({ prefix: 'audio:' })).size).toBe(0);
    expect((await context.call('day', { date })).messages[1].audio.status).toBe('expired');
    await context.pruneLocal(store, Date.now() + 31 * 86400000);
    expect((await store.list({ prefix: 'job:' })).size).toBe(0);
    expect((await store.list({ prefix: 'messages:' })).size).toBe(0);
    expect((await store.list({ prefix: 'transcription:' })).size).toBe(0);
  });
});
