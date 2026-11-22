import { generateWhatsappSummary } from '@/lib/ai/whatsapp-summary';
import { prepareWhatsappSummaryInput, decodeWhatsappSummaryClients, SUMMARY_INPUT_VERSION } from '@/lib/ai/whatsapp-summary-input';
import { InputError } from '../../../workers/whatsapp-extension/domain.mjs';
import { validateSummaryRequest } from '../../../workers/whatsapp-extension/summary-request.mjs';
import { summaryStore } from '../../../workers/whatsapp-extension/summary-store.mjs';
import { isLocalExtension, requireExtensionAdmin } from './server';
import type { WhatsappSummary } from '@/types';

export async function findExtensionSummary(actor: Awaited<ReturnType<typeof requireExtensionAdmin>>, date: string) {
  const { user, db } = actor;
  const { data: remote, error } = await db.from('whatsapp_summaries').select('*').eq('created_by', user.id).eq('summary_date', date).maybeSingle();
  if (error) throw new InputError('Não foi possível consultar o resumo salvo.', 503);
  let existing = remote as WhatsappSummary | null;
  if (isLocalExtension()) {
    const store = await summaryStore(user.id);
    try { existing = store.all().find((s: WhatsappSummary) => s.summary_date === date) || existing; } finally { store.close(); }
  }
  return existing;
}
export async function generateExtensionSummary(actor: Awaited<ReturnType<typeof requireExtensionAdmin>>, body: Record<string, unknown>) {
  const job = await validateSummaryRequest(body);
  const { user, db } = actor;
  const existing = await findExtensionSummary(actor, job.date);
  const previous = existing?.summary_data.collection_metadata as { jobId?: string; contentHash?: string; summaryInputVersion?: string } | undefined;
  if (previous && previous.jobId === job.id && previous.contentHash === job.contentHash && previous.summaryInputVersion === SUMMARY_INPUT_VERSION) return existing;
  if (existing && !job.confirmReplace && !job.mergeExisting) throw new InputError('Já existe um resumo. Confirme a substituição.', 409, 'REPLACE_REQUIRED');
  const [{ data: clients, error: clientsError }, { data: statuses, error: statusesError }] = await Promise.all([
    db.from('clients').select('id,name').order('name'), db.from('statuses').select('id,name').order('created_at'),
  ]);
  if (clientsError || statusesError) throw new InputError('Não foi possível consultar os cadastros.', 503);
  const validStatuses = statuses?.length ? statuses.map(s => String(s.id)) : ['aguardando cliente', 'aguardando texto', 'ajuste', 'aguardando aprovação', 'resolvido'];
  const prepared = prepareWhatsappSummaryInput(job, clients || [], statuses?.length ? statuses : validStatuses.map(id => ({ id, name: id })));
  if (!prepared.stats.includedMessages) throw new InputError('Não há texto útil para resumir após filtrar canais e mídias sem conteúdo.', 422, 'NO_SUMMARY_TEXT');
  const generation = await generateWhatsappSummary({ geminiApiKey: process.env.GEMINI_API_KEY,
    prompt: prepared.prompt, schema: prepared.schema,
    validate: value => decodeWhatsappSummaryClients(value, prepared.clientMap, prepared.validStatuses),
  });
  const current = await requireExtensionAdmin();
  if (current.user.id !== user.id) throw new InputError('Sua sessão mudou. Entre na conta correta.', 403);
  const buildPayload = (base: WhatsappSummary | null | undefined) => {
    const shouldMerge = Boolean(job.mergeExisting && base);
    const baseMeta = shouldMerge ? base?.summary_data.collection_metadata : undefined;
    const baseSummaries = shouldMerge && Array.isArray(base?.summary_data.summaries) ? base.summary_data.summaries : [];
    const includedChatJids = Array.from(new Set([...(baseMeta?.includedChatJids || []), ...job.includedChatJids]));
    const warnings = Array.from(new Set([...(baseMeta?.warnings || []), ...job.warnings]));
    const pendingAudio = (baseMeta?.pendingAudio || 0) + job.consent.pendingAudio;
    const metadata = {
      source: 'chrome_extension' as const,
      jobId: job.id,
      accountKey: job.accountKey,
      pendingAudio,
      partialHistory: false,
      transcribeAudio: job.transcribeAudio,
      warnings,
      includedChatJids,
      summaryInput: prepared.stats,
      summaryInputVersion: prepared.version,
      contentHash: job.contentHash,
    };
    return {
      summary_date: job.date,
      raw_text: '',
      summary_data: {
        ...generation.data,
        summaries: [...baseSummaries, ...generation.data.summaries],
        collection_metadata: metadata,
      },
      created_by: user.id,
      ai_provider: generation.provider,
      ai_model: generation.model,
    };
  };
  // Nunca persistir o texto original nem uma cópia integral das transcrições.
  if (isLocalExtension()) {
    const store = await summaryStore(user.id);
    try {
      const latest = store.all().find((s: WhatsappSummary) => s.summary_date === job.date) as WhatsappSummary | undefined;
      if (latest && !job.confirmReplace && !job.mergeExisting) throw new InputError('Já existe um resumo. Confirme a substituição.', 409, 'REPLACE_REQUIRED');
      const payload = buildPayload(latest || existing);
      const summary = { ...payload, id: latest?.id || existing?.id || crypto.randomUUID(), created_at: latest?.created_at || existing?.created_at || new Date().toISOString() };
      store.save(summary); return summary;
    } finally { store.close(); }
  }
  // Revalida a existência após a IA: uma criação concorrente não pode ser
  // substituída sem confirmação. A restrição única por usuário/data permanece.
  const { data: latest, error: latestError } = await current.db.from('whatsapp_summaries').select('*').eq('created_by', user.id).eq('summary_date', job.date).maybeSingle();
  if (latestError) throw new InputError('Não foi possível verificar o resumo salvo.', 503);
  if (latest && !job.confirmReplace && !job.mergeExisting) throw new InputError('Já existe um resumo. Confirme a substituição.', 409, 'REPLACE_REQUIRED');
  const payload = buildPayload((latest as WhatsappSummary | null) || existing);
  const result = latest ? await current.db.from('whatsapp_summaries').update(payload).eq('id', latest.id).eq('created_by', user.id).select('*').single() : await current.db.from('whatsapp_summaries').insert(payload).select('*').single();
  if (result.error || !result.data) throw new InputError('Não foi possível salvar o resumo. O anterior foi preservado.', 503);
  return result.data as WhatsappSummary;
}
