import test from 'node:test';
import assert from 'node:assert/strict';
import { ExtensionEngine } from './engine.mjs';
import worker from './worker.mjs';
import { digest, validateMessage, isInputError } from './domain.mjs';

class Storage {
  constructor() { this.values = new Map(); this.alarm = null; }
  async get(key) { return structuredClone(this.values.get(key)); }
  async put(key, value) { this.values.set(key, structuredClone(value)); }
  async delete(key) { this.values.delete(key); }
  async list({ prefix }) { return new Map([...this.values].filter(([key]) => key.startsWith(prefix)).map(([k, v]) => [k, structuredClone(v)])); }
  async getAlarm() { return this.alarm; }
  async setAlarm(value) { this.alarm = value; }
}
const date = '2026-11-18', accountId = '123@s.whatsapp.net';
const message = (id = 'one', type = 'chat') => ({ id, chatJid: '456@s.whatsapp.net', chatName: 'Cliente de teste', senderName: 'Pessoa de teste', senderJid: '456@s.whatsapp.net', fromMe: false, timestampMs: Date.parse('2026-11-18T14:00:00Z'), type, text: type === 'chat' ? 'Mensagem de teste' : '[Áudio]' });
async function setup(options = {}) {
  const storage = options.storage || new Storage(); let now = Date.parse('2026-11-19T12:00:00Z');
  const providers = { transcribe: async () => 'Transcrição de teste', generate: async () => ({ summaryId: 'summary' }), ...options.providers };
  const engine = new ExtensionEngine(storage, providers, () => now);
  await engine.call('binding', { accountId });
  const create = async (id = 'job', transcribeAudio = true, extra = {}) => engine.call('create', { operationId: id, date, accountId, transcribeAudio, ...extra });
  return { storage, engine, create, setNow(value) { now = value; } };
}
async function textImport(context, id = 'job', extra = {}) {
  await context.create(id, true, extra);
  await context.engine.call('append', { jobId: id, index: 0, messages: [message()] });
  return context.engine.call('seal', { jobId: id, pages: 1, messageCount: 1, partialChats: 0, audioManifest: [] });
}

test('valida autoria, calendário de São Paulo, texto vazio e filtro de status', () => {
  assert.equal(validateMessage(message(), date).fromMe, false);
  for (const invalid of [{ ...message(), fromMe: null }, { ...message(), text: '' }, { ...message(), chatJid: 'status@broadcast' }, { ...message(), timestampMs: Date.parse('2026-11-19T03:00:00Z') }]) assert.throws(() => validateMessage(invalid, date));
});

test('importa canais newsletter junto com conversas, preservando identidade e autoria', async () => {
  const context = await setup(); await context.create();
  const channel = { ...message('channel-message'), chatJid: 'test-channel@newsletter', senderJid: 'test-channel@newsletter' };
  await context.engine.call('append', { jobId: 'job', index: 0, messages: [message(), channel] });
  await context.engine.call('seal', { jobId: 'job', pages: 1, messageCount: 2, partialChats: 0, audioManifest: [] });
  const result = await context.engine.call('day', { date });
  assert.equal(result.messages.length, 2);
  assert.equal(result.messages[1].chatJid, channel.chatJid);
  assert.equal(result.messages[1].fromMe, false);
  assert.throws(() => validateMessage({ ...channel, chatJid: 'unknown@invalid' }, date), /Conversa inválida/);
  assert.throws(() => validateMessage({ ...channel, chatJid: 'status@broadcast' }, date), /Conversa inválida/);
});

test('reconhece erros internos de outra instância do módulo sem aceitar objetos de JSON', async () => {
  const reloaded = await import('./domain.mjs?reload-regression');
  assert.equal(isInputError(new reloaded.InputError('Conversa inválida.', 400)), true);
  assert.equal(isInputError(JSON.parse('{"message":"secret","status":400,"code":"INVALID_INPUT"}')), false);
  assert.equal(isInputError(new Error('private failure')), false);
  assert.equal(isInputError(null), false);
});
test('exige vinculação, não mistura contas e recusa troca sem confirmação', async () => {
  const { engine, create } = await setup();
  await assert.rejects(engine.call('binding', { accountId: '789@s.whatsapp.net' }), /mudou/);
  await assert.rejects(engine.call('create', { operationId: 'bad', date, accountId: '789@s.whatsapp.net' }), /Vincule/);
  await create();
  await engine.call('binding', { accountId: '789@s.whatsapp.net', confirmRebind: true });
  assert.equal((await engine.call('get', { jobId: 'job' })).accountId, accountId);
});

test('retomada não ignora a escolha atual de transcrever ou não baixar áudio', async () => {
  const context = await setup(); await context.create('job', true);
  await assert.rejects(context.create('job', false), error => error.code === 'RESTART_REQUIRED');
  assert.equal((await context.engine.call('get', { jobId: 'job' })).transcribeAudio, true);
  await context.engine.call('cancel', { jobId: 'job' });
  assert.equal((await context.create('new-job', false)).transcribeAudio, false);
});
test('importação incompleta não substitui conversas anteriores e envio repetido é idempotente', async () => {
  const c = await setup(); await textImport(c);
  await assert.rejects(c.create('new'), /substituição/);
  await c.create('new', true, { replaceExisting: true });
  const body = { jobId: 'new', index: 0, messages: [message('new-message')] };
  await c.engine.call('append', body); await c.engine.call('append', body);
  await assert.rejects(c.engine.call('seal', { jobId: 'new', pages: 1, messageCount: 2, partialChats: 0, audioManifest: [] }), /incompleto/);
  assert.equal((await c.engine.call('day', { date })).id, 'job');
  assert.equal((await c.engine.call('get', { jobId: 'new' })).messageCount, 1);
});
test('bloqueia concorrência por data e mensagens duplicadas', async () => {
  const c = await setup(); await c.create();
  await assert.rejects(c.create('other'), /andamento/);
  await assert.rejects(c.engine.call('append', { jobId: 'job', index: 0, messages: [message(), message()] }), /duplicada/);
});
test('limita volume agregado e permite cancelar apenas rascunhos sem apagar a versão ativa', async () => {
  const c = await setup(); await textImport(c);
  await c.create('draft', true, { replaceExisting: true });
  const draft = await c.storage.get('job:draft'); draft.textBytes = 8 * 1024 * 1024; await c.storage.put('job:draft', draft);
  await assert.rejects(c.engine.call('append', { jobId: 'draft', index: 0, messages: [message()] }), /8 MiB/);
  await c.engine.call('cancel', { jobId: 'draft' });
  assert.equal((await c.engine.call('day', { date })).id, 'job');
  await assert.rejects(c.engine.call('cancel', { jobId: 'job' }), /rascunho|não concluída/);
});
test('retém paginação de tamanhos variáveis e ignora configurações de prontidão do navegador', async () => {
  const c = await setup(); await c.create();
  await c.engine.call('append', { jobId: 'job', index: 0, messages: [message('a')] });
  await c.engine.call('append', { jobId: 'job', index: 1, messages: [message('b', 'ptt')] });
  const result = await c.engine.call('seal', { jobId: 'job', pages: 2, messageCount: 2, partialChats: 2, audioManifest: [], ready: true });
  assert.equal(result.state, 'awaiting_confirmation');
  assert.equal(result.consent.pendingAudio, 1);
  assert.equal(result.consent.partialHistory, false);
  assert.equal((await c.engine.call('get', { jobId: 'job', includeMessages: true })).messages.length, 2);
  await assert.rejects(c.engine.call('generate', { jobId: 'job', revision: result.revision }), /Confirme/);
  await assert.rejects(c.engine.call('generate', { jobId: 'job', revision: result.revision - 1, confirmPending: true }), /mudaram/);
  await c.engine.call('generate', { jobId: 'job', revision: result.revision, confirmPending: true });
  await c.engine.tick(); assert.equal((await c.engine.call('get', { jobId: 'job' })).state, 'completed');
});
test('transcrição desligada não aceita uploads e não bloqueia resumo', async () => {
  const c = await setup(); await c.create('job', false);
  await c.engine.call('append', { jobId: 'job', index: 0, messages: [message('audio', 'ptt')] });
  await assert.rejects(c.engine.call('audio', { jobId: 'job' }), /não aceita/);
  const result = await c.engine.call('seal', { jobId: 'job', pages: 1, messageCount: 1, partialChats: 0, audioManifest: [] });
  assert.equal(result.state, 'ready'); assert.equal(result.consent.required, false);
});
test('após envio confirmado a geração automática continua sem navegador e não duplica a execução', async () => {
  const c = await setup(); let generations = 0;
  c.engine.providers.generate = async (jobId, token) => {
    generations++;
    const claim = await c.engine.call('claim', { jobId, token });
    assert.match(claim.text, /Mensagem de teste/); assert.equal(claim.consent.required, false);
    return { summaryId: 'generated-without-browser' };
  };
  await textImport(c, 'job', { autoGenerate: true });
  await c.engine.tick(); await c.engine.tick();
  const result = await c.engine.call('get', { jobId: 'job' });
  assert.equal(result.state, 'completed'); assert.equal(result.summary.summaryId, 'generated-without-browser'); assert.equal(generations, 1);
});
test('áudio indisponível exige confirmação e registra contagens na autorização', async () => {
  const c = await setup(); await c.create(); await c.engine.call('append', { jobId: 'job', index: 0, messages: [message('audio', 'ptt')] });
  const job = await c.engine.call('seal', { jobId: 'job', pages: 1, messageCount: 1, partialChats: 0, audioManifest: [] });
  assert.equal(job.consent.pendingAudio, 1);
  await assert.rejects(c.engine.call('generate', { jobId: 'job', revision: job.revision }), /Confirme/);
  await c.engine.call('generate', { jobId: 'job', revision: job.revision, confirmPending: true });
  const internal = await c.storage.get('job:job');
  const claim = await c.engine.call('claim', { jobId: 'job', token: internal.generationToken });
  assert.equal(claim.consent.pendingAudio, 1); assert.match(claim.text, /não transcrito/);
  await assert.rejects(c.engine.call('claim', { jobId: 'job', token: internal.generationToken }), /assumida/);
});
async function audioImport(c) {
  await c.create(); await c.engine.call('append', { jobId: 'job', index: 0, messages: [message('audio', 'ptt')] });
  const bytes = new TextEncoder().encode('áudio sintético de teste'); const hash = await digest(bytes);
  const base64 = btoa(String.fromCharCode(...bytes));
  await c.engine.call('audio', { jobId: 'job', messageId: 'audio', index: 0, hash, base64 });
  return { hash, base64, manifest: { jobId: 'job', pages: 1, messageCount: 1, partialChats: 0, audioManifest: [{ id: 'audio', chunks: 1, byteLength: bytes.length, hash, mimetype: 'audio/ogg' }] } };
}
test('confere integridade de blocos, retoma envio e remove áudio após transcrição', async () => {
  const c = await setup(); const audio = await audioImport(c);
  await c.engine.call('audio', { jobId: 'job', messageId: 'audio', index: 0, hash: audio.hash, base64: audio.base64 });
  const invalid = structuredClone(audio.manifest); invalid.audioManifest[0].hash = '0'.repeat(64);
  await assert.rejects(c.engine.call('seal', invalid), /blocos/);
  await c.engine.call('seal', audio.manifest);
  // Uma nova instância usa o mesmo estado persistido, sem o Chrome ou um socket.
  const restarted = new ExtensionEngine(c.storage, { transcribe: async () => 'Transcrição persistida', generate: async () => ({ summaryId: 's' }) });
  await restarted.tick();
  const job = await restarted.call('get', { jobId: 'job', includeMessages: true });
  assert.equal(job.audioTranscribed, 1); assert.equal(job.messages[0].audio.transcription, 'Transcrição persistida');
  assert.equal((await c.storage.list({ prefix: 'audio:' })).size, 0);
});
test('alarmes sobrepostos não iniciam duas transcrições do mesmo áudio', async () => {
  let release; let calls = 0;
  const wait = new Promise(resolve => { release = resolve; });
  const c = await setup({ providers: { transcribe: async () => { calls++; await wait; return 'Transcrição única'; } } });
  const audio = await audioImport(c); await c.engine.call('seal', audio.manifest);
  const first = c.engine.tick(); await c.engine.tick(); release(); await first;
  assert.equal(calls, 1);
  assert.equal((await c.engine.call('get', { jobId: 'job' })).audioTranscribed, 1);
});
test('falhas de transcrição têm tentativas limitadas, permitem leitura local do áudio e expiram após sete dias', async () => {
  const c = await setup({ providers: { transcribe: async () => { throw new Error('falha'); } } }); const audio = await audioImport(c); await c.engine.call('seal', audio.manifest);
  await c.engine.tick(); c.setNow(Date.parse('2026-11-19T12:00:05Z')); await c.engine.tick(); c.setNow(Date.parse('2026-11-19T12:00:10Z')); await c.engine.tick();
  assert.equal((await c.engine.call('get', { jobId: 'job' })).state, 'awaiting_confirmation');
  const ignored = await c.engine.call('ignoreAudio', { jobId: 'job', messageId: 'audio', ignored: true });
  assert.equal(ignored.state, 'ready');
  assert.equal(ignored.audioIgnored, 1);
  assert.equal(ignored.consent.pendingAudio, 0);
  assert.equal(ignored.consent.required, false);
  const restored = await c.engine.call('ignoreAudio', { jobId: 'job', messageId: 'audio', ignored: false });
  assert.equal(restored.state, 'awaiting_confirmation');
  assert.equal(restored.audioIgnored, 0);
  assert.equal(restored.consent.pendingAudio, 1);
  const localAudio = await c.engine.call('audioRead', { jobId: 'job', messageId: 'audio' });
  assert.equal(localAudio.base64, audio.base64);
  assert.equal(localAudio.mimetype, 'audio/ogg');
  await assert.rejects(c.engine.call('audioRead', { jobId: 'job', messageId: 'inexistente' }), /Áudio não encontrado/);
  c.setNow(Date.parse('2026-11-27T12:00:00Z')); await c.engine.tick();
  const job = await c.engine.call('get', { jobId: 'job', includeMessages: true });
  assert.equal(job.messages[0].audio.status, 'expired'); assert.equal((await c.storage.list({ prefix: 'audio:' })).size, 0);
  await assert.rejects(c.engine.call('audioRead', { jobId: 'job', messageId: 'audio' }), /indisponível localmente/);
});
test('worker exige segredo de servidor e não aceita acesso anônimo nem métodos indevidos', async () => {
  const secret = 'a'.repeat(32); let called = false;
  const env = { EXTENSION_WORKER_SECRET: secret, USERS: { idFromName(id) { return id; }, get(id) { assert.equal(id, 'trusted-user'); return { async fetch(request) { called = true; const b = await request.json(); assert.equal(b.actor, 'trusted-user'); return Response.json({ accepted: true }); } }; } } };
  assert.equal((await worker.fetch(new Request('https://worker', { method: 'POST', body: '{}' }), env)).status, 401);
  assert.equal((await worker.fetch(new Request('https://worker'), env)).status, 405);
  assert.equal(called, false);
  const response = await worker.fetch(new Request('https://worker', { method: 'POST', headers: { authorization: 'Bearer ' + secret, 'x-monada-user': 'trusted-user' }, body: JSON.stringify({ actor: 'forged-user', action: 'status' }) }), env);
  assert.equal(response.status, 200); assert.equal(called, true);
});
