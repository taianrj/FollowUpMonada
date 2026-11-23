'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import type { WhatsappSummary } from '@/types';
import type { ExtensionController, ExtensionJob, ExtensionMessage, ExtensionStatus } from '@/lib/whatsapp-extension/contracts';
import { ExtensionRequestError, extensionLocalApi, extensionApi as serverApi, extensionInfo, sendToExtension as rawSendToExtension, versionCompatible, collectedDay, uploadCollectedDay, previewConversations, type ExtensionInfo, type ExtensionPing } from '@/lib/whatsapp-extension/browser';
import { buildPendingReviewData, type PendingReviewData } from '@/lib/whatsapp-extension/pending-review';
import { buildSelectableConversations, type ChatSelectionRequest, type ChatSelectionResult } from '@/lib/whatsapp-extension/chat-selection';

type Confirm = (title: string, message: string) => Promise<boolean>;
type ConfirmPendingReview = (review: PendingReviewData) => Promise<boolean>;
type SelectChats = (request: ChatSelectionRequest) => Promise<ChatSelectionResult | null>;
export function useChromeWhatsapp(enabled: boolean, userId: string, initialTranscribeAudio: boolean, confirm: Confirm, confirmPendingReview?: ConfirmPendingReview, selectChats?: SelectChats): ExtensionController & { installUrl: string | null; savedTranscribeAudio: boolean | null; jobState: string | null; hasPendingAudio: boolean } {
  const [savedTranscribeAudio, setSavedTranscribeAudio] = useState<boolean | null>(null);
  const [instruction, setInstruction] = useState<string | null>(null), [progress, setProgress] = useState<string | null>(null), [busy, setBusy] = useState(false), [available, setAvailable] = useState(false), [installUrl, setInstallUrl] = useState<string | null>(null);
  const [jobState, setJobState] = useState<string | null>(null), [hasPendingAudio, setHasPendingAudio] = useState(false);
  const transcriptionPreference = useRef<boolean | null>(null);
  const replaceApproved = useRef(new Set<string>());
  const mergeApproved = useRef(new Set<string>());
  const running = useRef(false), info = useRef<ExtensionInfo | null>(null), currentJob = useRef<ExtensionJob | null>(null);
  const confirmRef = useRef(confirm);
  const confirmPendingReviewRef = useRef(confirmPendingReview);
  const selectChatsRef = useRef(selectChats);
  const trackJob = (job: ExtensionJob | null) => {
    currentJob.current = job;
    setJobState(job?.state ?? null);
    setHasPendingAudio(Boolean(job?.consent?.pendingAudio));
  };
  const sendToExtension = <T,>(id: string, message: Record<string, unknown>) => rawSendToExtension<T>(id, { ...message, userId });
  const extensionApi = async <T,>(action: string, body: Record<string, unknown> = {}): Promise<T> => {
    const config = info.current || await extensionInfo();
    if (config.userId !== userId) throw new Error('Sua sessão mudou. Atualize o Mônada.');
    return extensionLocalApi<T>(config, action, body);
  };

  useEffect(() => { confirmRef.current = confirm; }, [confirm]);
  useEffect(() => { confirmPendingReviewRef.current = confirmPendingReview; }, [confirmPendingReview]);
  useEffect(() => { selectChatsRef.current = selectChats; }, [selectChats]);
  const check = useCallback(async () => {
    if (!enabled) return;
    try {
      const config = await extensionInfo();
      if (config.userId !== userId) { info.current = null; throw new Error('Sua sessão mudou. Atualize a página e entre na conta correta antes de coletar.'); }
      info.current = config; setInstallUrl(config.installUrl);
      const ping = await rawSendToExtension<ExtensionPing>(config.extensionId, { action: 'ping', userId });
      if (!versionCompatible(ping.version, config.minimumVersion)) throw new Error('Atualize a extensão do Mônada para continuar. Depois clique em Verificar novamente.');
      if (!ping.accountId) throw new Error(ping.instruction || 'Abra o WhatsApp Web e conecte sua conta.');
      const settings = await extensionLocalApi<ExtensionStatus & { transcribeAudio?: boolean }>(config, 'status');
      if (typeof settings.transcribeAudio === 'boolean') { transcriptionPreference.current = settings.transcribeAudio; setSavedTranscribeAudio(settings.transcribeAudio); }
      setAvailable(true); setInstruction(null);
    } catch (err) { info.current = null; setAvailable(false); setInstruction(err instanceof Error ? err.message : 'Verifique a extensão e o WhatsApp Web.'); }
  }, [enabled, userId]);
  useEffect(() => { if (enabled) { const timer = setTimeout(() => void check(), 0); return () => clearTimeout(timer); } }, [enabled, check]);
  const loadSummary = async (id: string) => {
    const db = createClient(); const { data, error } = await db.from('whatsapp_summaries').select('*').eq('id', id).eq('created_by', userId).single();
    if (error || !data) throw new Error('O resumo foi processado, mas não foi possível carregá-lo. Selecione a data novamente.'); return data as WhatsappSummary;
  };
  const finish = async (job: ExtensionJob): Promise<WhatsappSummary | null> => {
    trackJob(job);
    while (['processing', 'generating'].includes(job.state)) {
      setProgress(job.state === 'processing' ? `Transcrevendo áudios: ${job.audioTranscribed}/${job.audioTotal}. Mantenha o Chrome e uma aba do Mônada abertos; a retomada fica neste computador.` : 'Gerando e salvando o resumo…');
      await new Promise(resolve => setTimeout(resolve, 2000)); job = await extensionApi<ExtensionJob>('get', { jobId: job.id }); trackJob(job);
    }
    if (job.state === 'completed' && job.summary) { trackJob(null); setProgress(null); setInstruction(null); return job.summary.localSummary || loadSummary(job.summary.summaryId); }
    if (job.state === 'failed') throw new ExtensionRequestError(job.error || 'Não foi possível concluir. Clique em Gerar resumo para tentar novamente.', job.errorCode || undefined);
    if (['ready', 'awaiting_confirmation'].includes(job.state)) {
      const detail = [job.consent.pendingAudio ? `${job.consent.pendingAudio} de ${job.audioTotal} áudio(s) não estão transcritos e não entrarão no resumo.` : '', 'A ressalva ficará registrada no resumo salvo.'].filter(Boolean).join(' ');
      if (job.consent.required) setInstruction(detail);
      if (job.consent.required) {
        let approved = false;
        if (confirmPendingReviewRef.current) {
          const detailedJob = await extensionApi<ExtensionJob>('get', { jobId: job.id, includeMessages: true }).catch(() => job);
          approved = await confirmPendingReviewRef.current(buildPendingReviewData(detailedJob));
        } else {
          approved = await confirmRef.current('Gerar resumo com pendências?', detail);
        }
        if (!approved) { setProgress('Você pode tentar novamente as transcrições ou gerar com pendências quando desejar.'); return null; }
        job = await extensionApi<ExtensionJob>('get', { jobId: job.id });
        trackJob(job);
      }
      setInstruction(null);
      const { exists } = await serverApi<{ exists: boolean }>('summaryExists', { date: job.date });
      if (exists && !replaceApproved.current.has(job.id) && !mergeApproved.current.has(job.id)) {
        if (!await confirmRef.current('Substituir resumo existente?', 'Esta data já possui um resumo salvo. Deseja substituí-lo após gerar com sucesso?')) return null;
        replaceApproved.current.add(job.id);
      }
      const body = { jobId: job.id, revision: job.revision, confirmPending: job.consent.required, confirmReplace: replaceApproved.current.has(job.id) };
      try { return await finish(await extensionApi<ExtensionJob>('generate', body)); }
      catch (err) {
        if (!(err instanceof ExtensionRequestError) || err.code !== 'REPLACE_REQUIRED') throw err;
        if (!await confirmRef.current('Substituir resumo existente?', 'Esta data já possui um resumo salvo. Deseja substituí-lo usando as conversas importadas? O resumo anterior será preservado até o novo ser salvo com sucesso.')) return null;
        return await finish(await extensionApi<ExtensionJob>('generate', { ...body, confirmReplace: true }));
      }
    }
    return null;
  };
  const generate = async (date: string, options?: { existingIncludedChatJids?: string[]; hasExistingSummary?: boolean }) => {
    if (running.current) return null; running.current = true; setBusy(true);
    try {
      await check(); const config = info.current; if (!config) throw new Error('Verifique a extensão antes de coletar.');
      const transcribeAudio = transcriptionPreference.current ?? initialTranscribeAudio;
      const status = await extensionApi<ExtensionStatus>('status');
      const { exists: saved } = await serverApi<{ exists: boolean }>('summaryExists', { date });
      const existingJob = status.jobs.filter(j => j.date === date && j.accountId === status.binding?.accountId && (j.transcribeAudio === transcribeAudio || ['processing', 'generating'].includes(j.state)) && ['processing', 'generating', 'ready', 'awaiting_confirmation', 'failed'].includes(j.state)).sort((a, b) => b.createdAt - a.createdAt)[0];
      if (existingJob) {
        if (existingJob.state === 'failed') {
          const replace = saved && await confirmRef.current('Substituir resumo existente?', 'Já há um resumo salvo para esta data. Deseja substituí-lo após gerar com sucesso?');
          if (saved && !replace) return null;
          if (replace) replaceApproved.current.add(existingJob.id);
          return await finish(await extensionApi<ExtensionJob>('retry', { jobId: existingJob.id, confirmReplace: replace }));
        }
        if (existingJob.state === 'ready' || existingJob.state === 'awaiting_confirmation') {
          const resume = await confirmRef.current('Continuar importação existente?', 'Há uma importação já recebida para esta data. Deseja continuar com ela? Escolha cancelar para coletar novamente.');
          if (resume) return await finish(existingJob);
        } else return await finish(existingJob);
      }
      const ping = await rawSendToExtension<ExtensionPing>(config.extensionId, { action: 'ping', userId });
      if (!versionCompatible(ping.version, config.minimumVersion) || !ping.accountId) throw new Error(ping.instruction || 'Atualize a extensão ou conecte o WhatsApp Web.');
      if (status.binding?.accountId !== ping.accountId) {
        if (!await confirmRef.current(status.binding ? 'A conta do WhatsApp mudou' : 'Vincular WhatsApp ao Mônada?', `Vincular a conta ${ping.accountId.split('@')[0]} ao seu usuário? As conversas das datas escolhidas serão enviadas ao Mônada e aos provedores de IA para resumo e transcrição quando habilitada. O histórico de outras contas será preservado separadamente.`)) return null;
        await extensionApi('binding', { accountId: ping.accountId, confirmRebind: !!status.binding });
      }
      const hasExistingSummary = Boolean(saved || options?.hasExistingSummary);
      const previous = status.jobs.some(j => j.date === date && j.accountId === ping.accountId && j.state !== 'uploading');
      let selectedChatJids: string[] | undefined;
      let mergeExisting = false;
      let replaceExisting = Boolean(hasExistingSummary || previous);
      if (selectChatsRef.current) {
        const previewMessages = await previewConversations(date, userId, confirmRef.current, setProgress, extensionApi);
        const selectable = buildSelectableConversations(previewMessages, options?.existingIncludedChatJids || []);
        if (!selectable.length) throw new Error('Nenhuma conversa disponível no WhatsApp Web para esta data.');
        setProgress(null);
        const selection = await selectChatsRef.current({ date, conversations: selectable, hasExistingSummary });
        if (!selection || !selection.selectedChatJids.length) return null;
        selectedChatJids = selection.selectedChatJids;
        mergeExisting = hasExistingSummary && selection.mode === 'merge';
        replaceExisting = Boolean(hasExistingSummary || previous);
      } else if (replaceExisting && !await confirmRef.current('Substituir conversas e resumo?', `Já há conversas importadas ou um resumo salvo para ${date.split('-').reverse().join('/')}. A nova coleta substituirá as conversas e, após gerar com sucesso, o resumo dessa data. Deseja continuar?`)) {
        return null;
      }
      let pending = status.jobs.find(j => j.date === date && j.accountId === ping.accountId && j.state === 'uploading');
      if (pending && (pending.transcribeAudio !== transcribeAudio || selectedChatJids)) {
        await extensionApi('cancel', { jobId: pending.id });
        await sendToExtension(config.extensionId, { action: 'clear', operationId: pending.id }).catch(() => {});
        pending = undefined;
      }
      const operationId = pending?.id || crypto.randomUUID();
      if (mergeExisting) mergeApproved.current.add(operationId);
      else if (replaceExisting) replaceApproved.current.add(operationId);
      const job = await extensionApi<ExtensionJob>('create', { date, operationId, accountId: ping.accountId, replaceExisting, mergeExisting, autoGenerate: true, transcribeAudio });
      trackJob(job);
      setProgress(selectedChatJids ? `Coletando ${selectedChatJids.length} conversa(s) selecionada(s) no WhatsApp Web…` : 'Coletando todas as conversas disponíveis da data no WhatsApp Web…');
      await sendToExtension(config.extensionId, { action: 'start', operationId, date, accountId: ping.accountId, transcribeAudio: job.transcribeAudio, ...(selectedChatJids ? { selectedChatJids } : {}) });
      let state = 'collecting';
      while (state === 'collecting') { await new Promise(resolve => setTimeout(resolve, 1500)); const result = await sendToExtension<{ state: string; error?: string }>(config.extensionId, { action: 'status', operationId }); state = result.state; if (state === 'failed') throw new Error(result.error || 'A coleta falhou. Tente novamente.'); }
      const day = await collectedDay(config, operationId);
      const uploaded = await uploadCollectedDay(config, operationId, day, setProgress, extensionApi);
      await sendToExtension(config.extensionId, { action: 'clear', operationId });
      return await finish(uploaded);
    } catch (err) { const message = err instanceof Error ? err.message : 'Não foi possível concluir a coleta.'; setInstruction(message); setProgress(null); throw err; }
    finally { running.current = false; setBusy(false); }
  };
  return { instruction, progress, busy, available, installUrl, savedTranscribeAudio, jobState, hasPendingAudio, check, generate,
    async exportDay(date) {
      const job = await extensionApi<ExtensionJob | null>('day', { date });
      if (!job?.messages?.length) throw new Error('Não há uma importação local salva para esta data. Gere ou importe a data antes de exportar.');
      return job;
    },
    async readPendingAudio(jobId, messageId) {
      return extensionApi<{ base64: string; mimetype: string; byteLength: number }>('audioRead', { jobId, messageId });
    },
    async setAudioIgnored(jobId, messageId, ignored) {
      const updated = await extensionApi<ExtensionJob>('ignoreAudio', { jobId, messageId, ignored });
      trackJob(updated);
      return updated;
    },
    async conversations(date) {
      const job = await extensionApi<ExtensionJob | null>('day', { date });
      if (job?.messages?.length) return job.messages;
      const status = await extensionApi<ExtensionStatus>('status');
      const historical = status.jobs.filter(j => j.date === date && !['uploading', 'cancelled'].includes(j.state)).sort((a, b) => b.createdAt - a.createdAt)[0];
      if (historical && await confirmRef.current('Consultar conta anterior?', `Há conversas salvas da conta ${historical.accountId.split('@')[0]} para esta data. Deseja consultá-las? Isso não altera a conta vinculada.`)) return (await extensionApi<ExtensionJob>('get', { jobId: historical.id, includeMessages: true })).messages || [];
      // No modo extensão as conversas são consultadas somente neste computador.
      if (running.current) throw new Error('Já há uma coleta em andamento. Aguarde e consulte novamente.');
      running.current = true; setBusy(true);
      try {
        const messages = await previewConversations(date, userId, confirmRef.current, setProgress, extensionApi);
        setInstruction(null);
        return messages;
      } catch (err) {
        setInstruction(err instanceof Error ? err.message : 'Não foi possível consultar as conversas.');
        throw err;
      } finally { running.current = false; setBusy(false); setProgress(null); }
    },
    async restart() {
      const job = currentJob.current;
      if (!job || job.state !== 'uploading' || running.current) return;
      if (!await confirmRef.current('Reiniciar coleta interrompida?', 'Os blocos ainda não publicados desta tentativa serão removidos. Conversas e resumos anteriores permanecem salvos.')) return;
      await extensionApi('cancel', { jobId: job.id });
      if (info.current) await sendToExtension(info.current.extensionId, { action: 'clear', operationId: job.id }).catch(() => {});
      trackJob(null); setInstruction(null); setProgress('Clique em Gerar resumo para iniciar uma nova coleta.');
    },
    async retry() { if (!currentJob.current || running.current) return; await extensionApi('retry', { jobId: currentJob.current.id }); setInstruction(null); setProgress('Transcrições reenviadas. Clique em Gerar resumo para acompanhar.'); },
    async updateTranscription(value) { await extensionApi('settings', { transcribeAudio: value }); transcriptionPreference.current = value; setSavedTranscribeAudio(value); },
    async forget() {
      if (running.current || !await confirmRef.current('Apagar conversas deste computador?', 'Serão apagadas as conversas, transcrições, áudios e opções locais deste usuário e ambiente. Resumos salvos no Mônada e dados originais do WhatsApp serão preservados. Deseja continuar?')) return;
      await extensionApi('forget', { confirm: true }); transcriptionPreference.current = null; setSavedTranscribeAudio(null); trackJob(null); setInstruction(null); setProgress(null);
    }
  };
}

export function extensionConversations(messages: ExtensionMessage[]) {
  const audioDescriptions: Record<string, string> = {
    failed: 'Falha na transcrição. Tente novamente.', unavailable: 'Arquivo indisponível no WhatsApp Web.',
    expired: 'Arquivo temporário excluído após sete dias. Colete a data novamente para tentar recuperá-lo.',
    disabled: 'Transcrição desativada nesta importação.', pending: 'Aguardando transcrição.',
    ignored: 'Áudio ignorado pelo usuário.',
    not_requested: 'A consulta não inicia transcrição. Use Gerar Resumo para processar os áudios, se habilitado.'
  };
  const chats = new Map<string, { chatKey: string; chatJid: string; displayName: string; isGroup: boolean; lastTimestampMs: number; messages: { id: string; sender: string; senderName: string; text: string; fromMe: boolean; timestamp: string; timestampMs: number; isForwarded: boolean; quotedMessageId: string; quotedMessageSender: string; quotedMessageSenderJid: string; quotedMessageText: string }[] }>();
  for (const message of messages) {
    if (!chats.has(message.chatJid)) chats.set(message.chatJid, { chatKey: message.chatJid, chatJid: message.chatJid, displayName: message.chatName, isGroup: message.chatJid.endsWith('@g.us'), lastTimestampMs: 0, messages: [] });
    const chat = chats.get(message.chatJid)!;
    if (message.timestampMs > chat.lastTimestampMs) chat.lastTimestampMs = message.timestampMs;
    chat.messages.push({ id: message.id, sender: message.senderJid, senderName: message.senderName, text: message.audio ? message.audio.status === 'ignored' ? '[Áudio ignorado pelo usuário]' : message.audio.transcription ? '[Áudio transcrito] ' + message.audio.transcription : '[Áudio não transcrito] ' + (message.audio.reason || audioDescriptions[message.audio.status] || 'Pendente.') : message.text, fromMe: message.fromMe, timestamp: new Date(message.timestampMs).toISOString(), timestampMs: message.timestampMs, isForwarded: message.isForwarded, quotedMessageId: message.quotedMessageId, quotedMessageSender: '', quotedMessageSenderJid: '', quotedMessageText: '' });
  }
  return [...chats.values()]
    .sort((a, b) => b.lastTimestampMs - a.lastTimestampMs || a.displayName.localeCompare(b.displayName, 'pt-BR'))
    .map((chat) => ({
      chatKey: chat.chatKey,
      chatJid: chat.chatJid,
      displayName: chat.displayName,
      isGroup: chat.isGroup,
      messages: chat.messages
        .sort((a, b) => a.timestampMs - b.timestampMs || a.id.localeCompare(b.id))
        .map((m) => ({
          id: m.id,
          sender: m.sender,
          senderName: m.senderName,
          text: m.text,
          fromMe: m.fromMe,
          timestamp: m.timestamp,
          isForwarded: m.isForwarded,
          quotedMessageId: m.quotedMessageId,
          quotedMessageSender: m.quotedMessageSender,
          quotedMessageSenderJid: m.quotedMessageSenderJid,
          quotedMessageText: m.quotedMessageText,
        })),
    }));
}
