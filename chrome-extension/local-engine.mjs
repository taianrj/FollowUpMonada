import { ExtensionEngine } from '../workers/whatsapp-extension/engine.mjs';
import { digest, validId, requireValue, InputError } from '../workers/whatsapp-extension/domain.mjs';
import { localStorage, localTransaction, cleanOperations } from './storage.mjs';
import { authenticatedTab } from './session.mjs';

const engines = new Map();
const actions = new Set(['status', 'binding', 'create', 'append', 'audio', 'audioRead', 'ignoreAudio', 'seal', 'get', 'generate', 'retry', 'day', 'cancel', 'settings', 'forget']);
export async function namespaceFor(origin, userId) { return digest(origin + '\n' + userId); }
export async function localCall(tabId, origin, message) {
  requireValue(actions.has(message.command), 'Operação local não permitida.', 405);
  const session = await authenticatedTab(tabId, origin);
  requireValue(validId(session.userId) && session.userId === message.userId, 'Sua sessão mudou. Atualize o Mônada.', 403);
  const namespace = await namespaceFor(origin, session.userId);
  const context = { origin, userId: session.userId, tabId };
  await localTransaction('readwrite', store => store.put(context, 'context:' + namespace));
  const entry = await engineFor(namespace, context);
  entry.context = context;
  const body = message.body || {};
  requireValue(!entry.clearing, 'Aguarde a exclusão dos dados locais.', 409);
  if (message.command === 'forget') {
    requireValue(body.confirm === true, 'Confirme a exclusão dos dados locais.');
    requireValue(!entry.running, 'Aguarde o processamento antes de apagar os dados locais.', 409);
    entry.clearing = true;
    try {
      if (entry.requests) await entry.requests;
      for (const key of (await entry.storage.list({ prefix: '' })).keys()) await entry.storage.delete(key);
      await cleanOperations(session.userId, origin);
      await chrome.alarms.clear('local:' + namespace);
      return { cleared: true };
    } finally { entry.clearing = false; }
  }
  // Leituras não esperam uma chamada longa de IA. Escritas não podem concorrer
  // com tick; isso evita sobrescrever transcrições ou gerar duas vezes.
  if (!['status', 'get', 'day', 'audioRead'].includes(message.command)) requireValue(!entry.running, 'Há processamento em andamento. Aguarde e tente novamente.', 409);
  if (['status', 'get', 'day', 'audioRead'].includes(message.command)) return entry.engine.call(message.command, body);
  const previous = entry.requests || Promise.resolve();
  const result = previous.then(async () => {
    if (message.command === 'retry' && body.confirmReplace === true) { const job = await entry.engine.job(body.jobId); job.replaceExisting = true; await entry.engine.save(job); }
    return entry.engine.call(message.command, body);
  });
  entry.requests = result.catch(() => {});
  return result;
}
async function engineFor(namespace, context) {
  if (engines.has(namespace)) return engines.get(namespace);
  const pending = createEngine(namespace, context);
  engines.set(namespace, pending);
  try { return await pending; } catch (error) { engines.delete(namespace); throw error; }
}
async function createEngine(namespace, context) {
  const storage = localStorage(namespace), entry = { context, storage, running: false };
  const engine = new ExtensionEngine(storage, {
    async transcribe(bytes, mimetype) {
      // Um arquivo por requisição, sem upload persistente ou chave no navegador.
      requireValue(bytes.length <= 2 * 1024 * 1024, 'Áudio excede 2 MiB. Gere com pendências ou tente um arquivo menor.');
      let binary = ''; for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
      try { return (await authenticatedTab(entry.context.tabId, entry.context.origin, entry.context.userId, 'transcribe', { base64: btoa(binary), mimetype })).text; }
      catch (error) { throw new InputError(error.message, 503, error.code || 'AI_FAILURE'); }
    },
    async generate(jobId, token) {
      const job = await engine.call('claim', { jobId, token });
      const messages = (await engine.messages(await engine.job(jobId))).map(m => ({ ...m, audio: m.audio ? { status: m.audio.status, transcription: m.audio.transcription } : null }));
      requireValue(new TextEncoder().encode(JSON.stringify(messages)).length < 2800000, 'A data excede o limite de envio à IA desta versão (2,8 MB). Nenhum resumo foi substituído.', 413, 'IMPORT_LIMIT');
      let result;
      try { result = await authenticatedTab(entry.context.tabId, entry.context.origin, entry.context.userId, 'summarize', {
        jobId, date: job.date, accountKey: job.accountKey, messages,
        partialChats: 0, transcribeAudio: job.transcribeAudio,
        confirmPending: job.consent.explicit === true, confirmReplace: job.replaceExisting, mergeExisting: job.mergeExisting === true,
      }); } catch (error) { throw new InputError(error.message, 503, error.code || 'AI_FAILURE'); }
      return { summaryId: result.id, localSummary: result };
    }
  });
  entry.engine = engine;
  // Após suspensão/reinício só este novo worker pode reassumir a geração. O
  // servidor reconhece o mesmo jobId/conteúdo para não salvar o resumo duas vezes.
  for (const job of (await storage.list({ prefix: 'job:' })).values()) if (job.state === 'generating') { job.summaryClaimed = false; await engine.save(job); }
  return entry;
}
export async function runLocalAlarm(namespace) {
  const context = await localTransaction('readonly', s => s.get('context:' + namespace));
  if (!context) return;
  const entry = await engineFor(namespace, context);
  if (entry.running || entry.clearing) return;
  const jobs = [...(await entry.storage.list({ prefix: 'job:' })).values()];
  if (jobs.some(job => job.state === 'uploading' && job.createdAt + 7 * 86400000 > Date.now()) && !jobs.some(job => ['processing', 'generating'].includes(job.state))) {
    // Nunca interrompe os lotes locais por um alarme que disparou antes do seal.
    await entry.storage.setAlarm(Date.now() + 60000); return;
  }
  entry.running = true;
  if (entry.requests) await entry.requests;
  try {
    await cleanOperations(null, null, true);
    await pruneLocal(entry.storage);
    if (!(await entry.storage.list({ prefix: 'job:' })).size) return;
    try { await authenticatedTab(entry.context.tabId, entry.context.origin, entry.context.userId); }
    catch { await entry.storage.setAlarm(Date.now() + 60000); return; }
    // Alarmes do Chrome têm granularidade de 30 s. Processa uma rodada limitada
    // de trabalho imediato para não impor essa espera entre todos os áudios.
    const deadline = Date.now() + 20000;
    do {
      await entry.engine.tick();
      let immediate = false;
      for (const job of (await entry.storage.list({ prefix: 'job:' })).values()) {
        if (job.state === 'generating') immediate = true;
        if (job.state === 'processing' && (await entry.engine.messages(job)).some(m => m.audio?.status === 'pending' && (!m.audio.retryAt || m.audio.retryAt <= Date.now()))) immediate = true;
      }
      if (!immediate) break;
    } while (Date.now() < deadline);
    // A limpeza continua agendada mesmo depois que a última IA terminou.
    if (!await entry.storage.getAlarm()) await entry.storage.setAlarm(Date.now() + 86400000);
  }
  finally { entry.running = false; }
}
export async function restoreLocalAlarms() {
  const contexts = await localTransaction('readonly', s => s.getAllKeys(IDBKeyRange.bound('context:', 'context:\uffff')));
  for (const key of contexts) if (!await chrome.alarms.get('local:' + key.slice(8))) await chrome.alarms.create('local:' + key.slice(8), { when: Date.now() + 30000 });
}
export async function pruneLocal(storage, now = Date.now()) {
  // Retenção explícita: conversas/transcrições por 30 dias da coleta. Áudios
  // pendentes continuam com o prazo menor de 7 dias do engine compartilhado.
  const jobs = [...(await storage.list({ prefix: 'job:' })).values()];
  for (const job of jobs) if (job.createdAt + 30 * 86400000 <= now) {
    for (const prefix of ['messages:' + job.id + ':', 'audio:' + job.id + ':']) for (const key of (await storage.list({ prefix })).keys()) await storage.delete(key);
    const active = `active:${job.accountKey}:${job.date}`;
    if (await storage.get(active) === job.id) await storage.delete(active);
    await storage.delete('job:' + job.id);
  }
  // Cache sem retenção independente: reaproveita somente hashes ainda usados.
  const retained = new Set(); let audioBytes = 0;
  for (const job of (await storage.list({ prefix: 'job:' })).values()) {
    let changed = false;
    for (let i = 0; i < job.pages; i++) {
      const key = `messages:${job.id}:${i}`, messages = await storage.get(key) || [];
      for (const message of messages) {
        if (message.audio?.hash) retained.add(`transcription:${job.accountKey}:${message.audio.hash}`);
        if (message.audio?.expiresAt && message.audio.expiresAt <= now && message.audio.status !== 'transcribed' && message.audio.status !== 'expired') {
          const prefix = `audio:${job.id}:${await digest(message.id)}:`;
          for (const key of (await storage.list({ prefix })).keys()) await storage.delete(key);
          message.audio.status = 'expired'; changed = true;
        }
      }
      if (changed) await storage.put(key, messages);
    }
    if (changed) {
      job.revision++;
      if (job.state === 'processing') {
        let pending = false;
        for (let i = 0; i < job.pages; i++) if ((await storage.get(`messages:${job.id}:${i}`) || []).some(m => m.audio?.status === 'pending')) pending = true;
        job.state = pending ? 'processing' : 'awaiting_confirmation';
      }
      await storage.put('job:' + job.id, job);
    }
  }
  for (const key of (await storage.list({ prefix: 'transcription:' })).keys()) if (!retained.has(key)) await storage.delete(key);
  for (const [key, chunk] of await storage.list({ prefix: 'audio:' })) if (chunk.uploadedAt + 7 * 86400000 <= now) await storage.delete(key);
  for (const chunk of (await storage.list({ prefix: 'audio:' })).values()) audioBytes += chunk.length;
  await storage.put('audioBytes', audioBytes);
}
