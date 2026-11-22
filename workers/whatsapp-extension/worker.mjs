import { ExtensionEngine } from './engine.mjs';
import { transcribeAudio } from './providers.mjs';
import { InputError, isInputError, requireValue, validId, digest } from './domain.mjs';

export async function readJson(request, max = 3000000) {
  const reader = request.body?.getReader(); requireValue(reader, 'Corpo ausente.');
  const chunks = []; let size = 0;
  try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; requireValue(size <= max, 'Requisição muito grande.', 413); chunks.push(value); } }
  finally { await reader.cancel(); }
  const all = new Uint8Array(size); let offset = 0; for (const c of chunks) { all.set(c, offset); offset += c.length; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(all)); } catch { throw new InputError('JSON inválido.'); }
}
export async function secretMatches(request, secret) {
  if (typeof secret !== 'string' || secret.length < 32) return false;
  return await digest(request.headers.get('authorization') || '') === await digest('Bearer ' + secret);
}
export default {
  async fetch(request, env) {
    if (request.method !== 'POST') return Response.json({ error: 'Método não permitido.' }, { status: 405, headers: { Allow: 'POST' } });
    if (!await secretMatches(request, env.EXTENSION_WORKER_SECRET)) return Response.json({ error: 'Não autorizado.' }, { status: 401 });
    try {
      const actor = request.headers.get('x-monada-user'); requireValue(validId(actor), 'Usuário inválido.');
      const command = await readJson(request);
      const object = env.USERS.get(env.USERS.idFromName(actor));
      return object.fetch(new Request('https://internal/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...command, actor }) }));
    } catch (err) { return failure(err); }
  }
};
function failure(err) { const known = isInputError(err); return Response.json({ error: known ? err.message : 'Falha no processamento. Os dados existentes foram preservados.', code: known ? err.code : 'PROCESSING_FAILURE' }, { status: known ? err.status : 500 }); }

export class ExtensionUser {
  constructor(ctx, env) {
    this.ctx = ctx; this.env = env;
    this.engine = new ExtensionEngine(ctx.storage, {
      transcribe: async (bytes, mimetype) => {
        const origin = new URL(env.MONADA_ORIGIN);
        requireValue(origin.protocol === 'https:' && origin.pathname === '/', 'Origem de callback inválida.');
        const response = await fetch(new URL('/api/whatsapp-extension/process', origin), { method: 'POST', headers: { authorization: 'Bearer ' + env.EXTENSION_WORKER_SECRET, 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'authorize', userId: await ctx.storage.get('actor') }), signal: AbortSignal.timeout(15000), redirect: 'error' });
        if (!response.ok) throw new Error('Usuário não autorizado a processar mídia.');
        return transcribeAudio(bytes, mimetype, env);
      },
      generate: async (jobId, token) => {
        const origin = new URL(env.MONADA_ORIGIN);
        requireValue(origin.protocol === 'https:' && origin.pathname === '/', 'Origem de callback inválida.');
        const actor = await ctx.storage.get('actor');
        const response = await fetch(new URL('/api/whatsapp-extension/process', origin), { method: 'POST', headers: { authorization: 'Bearer ' + env.EXTENSION_WORKER_SECRET, 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: actor, jobId, token }), signal: AbortSignal.timeout(240000), redirect: 'error' });
        if (!response.ok) throw new Error('Falha na geração.'); return response.json();
      }
    });
  }
  async fetch(request) {
    try {
      const command = await readJson(request);
      return await this.ctx.blockConcurrencyWhile(async () => {
        const actor = await this.ctx.storage.get('actor'); requireValue(!actor || actor === command.actor, 'Acesso negado.', 403);
        await this.ctx.storage.put('actor', command.actor);
        return Response.json(await this.engine.call(command.action, command.body));
      });
    } catch (err) { return failure(err); }
  }
  async alarm() { await this.engine.tick(); }
}
