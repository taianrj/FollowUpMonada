// Read-only bridge: uses the installed application sources/SDK, never its database.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import crypto from 'node:crypto';
import ts from 'typescript';
import { validateSummaryRequest } from '../../workers/whatsapp-extension/summary-request.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const modules = new Map();
async function loadSource(name) {
  if (modules.has(name)) return modules.get(name);
  const source = fs.readFileSync(path.join(root, 'src/lib/ai', name + '.ts'), 'utf8');
  let js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const imports = [...js.matchAll(/from ['"]([^'"]+)['"]/g)];
  for (const match of imports) {
    const target = match[1].startsWith('./') ? await sourceUrl(match[1].slice(2)) : import.meta.resolve(match[1]);
    js = js.replace(match[0], `from ${JSON.stringify(target)}`);
  }
  const url = 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');
  modules.set(name, url);
  return url;
}
const sourceUrl = loadSource;
const moduleValue = async name => import(await loadSource(name));
const emit = event => process.stdout.write(JSON.stringify({ event }) + '\n');

export async function prepare(data) {
  const job = await validateSummaryRequest({ jobId: 'comparison', date: data.date, accountKey: '0'.repeat(64),
    transcribeAudio: data.transcribeAudio !== false, partialChats: data.partialChats,
    confirmPending: true, confirmReplace: false, messages: data.messages.map(m => ({ ...m,
      audio: m.audio ? { status: m.audio.transcription ? 'transcribed' : 'pending', transcription: m.audio.transcription } : null })) });
  const clients = data.clients || [];
  const validStatuses = data.statuses?.length ? data.statuses.map(s => String(s.id)) : ['aguardando cliente', 'aguardando texto', 'ajuste', 'aguardando aprovação', 'resolvido'];
  const { prepareWhatsappSummaryInput } = await moduleValue('whatsapp-summary-input');
  const optimized = prepareWhatsappSummaryInput(job, clients, data.statuses?.length ? data.statuses : validStatuses.map(id => ({ id, name: id })));
  if (!optimized.stats.includedMessages) throw Object.assign(new Error('Sem texto útil.'), { status: 422 });
  const { prompt } = optimized;
  if (prompt.length > 600000) throw new Error('Entrada muito grande.');
  const { AI_MODELS } = await moduleValue('models');
  // Resolve the production generator offline too, so missing SDK/source changes
  // fail before launching either provider. Importing it makes no network calls.
  await moduleValue('whatsapp-summary');
  return { prompt, schema: optimized.schema, clientMap: optimized.clientMap, validStatuses: optimized.validStatuses, optimization: optimized.stats, inputPolicy: optimized.version, model: AI_MODELS.whatsappSummary,
    warnings: job.warnings, inputHash: crypto.createHash('sha256').update(prompt).digest('hex'),
    source: 'src/lib/ai/whatsapp-summary-input.ts (usado pelo fluxo stateless)' , sdkVersion: JSON.parse(fs.readFileSync(path.join(root, 'node_modules/@google/genai/package.json'), 'utf8')).version,
    settings: { thinkingLevel: 'LOW', temperature: 'default',
      timeoutPerAttempt: 60000, timeoutTotal: 180000, retry: 'SDK oficial padrão', streaming: false } };
}

export function createObservedFetch(originalFetch, requests, notify = emit) {
  // Observe only this child process. Do not change retry policy, requests or bodies.
  return async (...args) => {
    const url = new URL(typeof args[0] === 'string' || args[0] instanceof URL ? args[0] : args[0].url);
    if (url.hostname !== 'generativelanguage.googleapis.com') return originalFetch(...args);
    const item = { number: requests.length + 1, startedAt: new Date().toISOString(), status: null };
    requests.push(item); notify({ type: 'http_start', number: item.number });
    const started = performance.now();
    try {
      const response = await originalFetch(...args);
      item.status = response.status;
      item.headersElapsed = (performance.now() - started) / 1000;
      const retryAfter = response.headers.get('retry-after');
      if (retryAfter && /^\d{1,6}$/.test(retryAfter)) item.retryAfterSeconds = Number(retryAfter);
      notify({ type: 'http_response', ...item });
      return response;
    } catch (error) {
      item.headersElapsed = (performance.now() - started) / 1000;
      item.networkFailure = true;
      notify({ type: 'http_response', ...item });
      throw error;
    }
  };
}

export function comparisonModelRequest(args, sourceModel, requestedModel = sourceModel) {
  if (args.model !== sourceModel || ![sourceModel, 'gemini-3.8-flash'].includes(requestedModel)) throw new Error('Modelo de comparação não permitido.');
  // Override only this isolated test request, never AI_MODELS or repository files.
  return { ...args, model: requestedModel };
}

async function generate(input) {
  const requests = [];
  globalThis.fetch = createObservedFetch(globalThis.fetch, requests);
  const { AI_MODELS } = await moduleValue('models');
  if (AI_MODELS.whatsappSummary !== input.prepared.model) throw new Error('Modelo mudou após preparação.');
  const requestedModel = comparisonModelRequest({ model: AI_MODELS.whatsappSummary }, AI_MODELS.whatsappSummary, input.model).model;
  const { getGeminiClient } = await moduleValue('gemini');
  const { generateWhatsappSummary } = await moduleValue('whatsapp-summary');
  const { decodeWhatsappSummaryClients } = await moduleValue('whatsapp-summary-input');
  const client = getGeminiClient(input.key);
  const original = client.models.generateContent.bind(client.models);
  let usage = {}, finishReason = null, responseId = null, returnedModel = null;
  client.models.generateContent = async args => {
    const result = await original(comparisonModelRequest(args, AI_MODELS.whatsappSummary, requestedModel));
    returnedModel = typeof result.modelVersion === 'string' && /^[a-zA-Z0-9_.-]{1,120}$/.test(result.modelVersion) ? result.modelVersion : null;
    usage = result.usageMetadata || {}; finishReason = result.candidates?.[0]?.finishReason || null;
    responseId = typeof result.responseId === 'string' && /^[a-zA-Z0-9_.:-]{1,200}$/.test(result.responseId) ? result.responseId : null;
    return result;
  };
  const started = performance.now();
  const result = await generateWhatsappSummary({ geminiApiKey: input.key, prompt: input.prepared.prompt,
    schema: input.prepared.schema, validate: value => input.prepared.clientMap ? decodeWhatsappSummaryClients(value, input.prepared.clientMap, input.prepared.validStatuses) : value });
  return { data: result.data, model: returnedModel || requestedModel, requestedModel, elapsed: (performance.now() - started) / 1000,
    usage: { input: usage.promptTokenCount, output: usage.candidatesTokenCount, reasoning: usage.thoughtsTokenCount },
    api: { requests, observedHttpCalls: requests.length, totalTokens: usage.totalTokenCount ?? null,
      cachedTokens: usage.cachedContentTokenCount ?? null, responseId, billingPlan: 'Não informado pela resposta de geração', cost: 'Não informado pela resposta de geração' },
    finishReason, promptHash: input.prepared.inputHash, blocks: 1 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    let raw = '';
    for await (const part of process.stdin) { raw += part; if (raw.length > 16 * 1024 * 1024) throw new Error('Entrada excedida.'); }
    const input = JSON.parse(raw);
    const result = input.operation === 'prepare' ? await prepare(input.data) : input.operation === 'generate' ? await generate(input) : null;
    if (!result) throw new Error('Operação inválida.');
    process.stdout.write(JSON.stringify({ ok: true, result }));
  } catch (error) {
    // Provider exceptions may contain content/credentials: expose only an HTTP code.
    process.stdout.write(JSON.stringify({ ok: false, status: Number.isInteger(error?.status) ? error.status : null }));
    process.exitCode = 1;
  }
}
