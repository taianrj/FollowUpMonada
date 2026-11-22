import { LIMITS, InputError, isInputError, requireValue, validDate, validId, digest, safeText, validateMessage, consentRequired, formattedMessages } from './domain.mjs';

// O armazenamento é privado por usuário. O Worker externo escolhe o namespace
// somente depois de autenticar o servidor Next; nunca a partir de um campo público.
export class ExtensionEngine {
  constructor(storage, providers, clock = Date.now) { this.storage = storage; this.providers = providers; this.clock = clock; }
  async job(id) { requireValue(validId(id), 'Importação inválida.'); const job = await this.storage.get('job:' + id); requireValue(job, 'Importação não encontrada.', 404); return job; }
  async messages(job) { const list = []; for (let i = 0; i < job.pages; i++) list.push(...(await this.storage.get(`messages:${job.id}:${i}`) || [])); return list; }
  async save(job) { await this.storage.put('job:' + job.id, job); }
  async call(action, body = {}) {
    if (action === 'status') {
      const jobs = Array.from((await this.storage.list({ prefix: 'job:' })).values());
      if (jobs.some(job => ['processing', 'generating', 'uploading'].includes(job.state))) await this.wake();
      return { binding: await this.storage.get('binding') || null, transcribeAudio: await this.storage.get('transcribeAudio'), jobs: Array.from((await this.storage.list({ prefix: 'job:' })).values()).map(j => this.publicJob(j)) };
    }
    if (action === 'settings') { requireValue(typeof body.transcribeAudio === 'boolean', 'Opção de transcrição inválida.'); await this.storage.put('transcribeAudio', body.transcribeAudio); return { saved: true }; }
    if (action === 'localSummaries') return Array.from((await this.storage.list({ prefix: 'local-summary:' })).values());
    if (action === 'day') {
      requireValue(validDate(body.date), 'Data inválida.');
      const binding = await this.storage.get('binding');
      if (!binding) return null;
      const accountKey = await digest(binding.accountId);
      const id = await this.storage.get(`active:${accountKey}:${body.date}`);
      if (!id) return null;
      const job = await this.job(id); return { ...this.publicJob(job), messages: await this.messages(job) };
    }
    if (action === 'binding') {
      const accountId = safeText(body.accountId, 150); requireValue(/^[^\s/@]+@(c\.us|s\.whatsapp\.net|lid)$/.test(accountId), 'Não foi possível identificar a conta do WhatsApp.');
      const previous = await this.storage.get('binding');
      requireValue(!previous || previous.accountId === accountId || body.confirmRebind === true, 'A conta do WhatsApp mudou. Confirme a nova vinculação.', 409, 'ACCOUNT_CHANGED');
      await this.storage.put('binding', { accountId, linkedAt: this.clock() }); return { linked: true };
    }
    if (action === 'create') {
      requireValue(validDate(body.date) && validId(body.operationId), 'Data ou operação inválida.');
      const binding = await this.storage.get('binding'); requireValue(binding && binding.accountId === body.accountId, 'Vincule a conta do WhatsApp antes de importar.', 409, 'ACCOUNT_CHANGED');
      const existing = await this.storage.get('job:' + body.operationId);
      if (existing) {
        requireValue(existing.accountId === binding.accountId && existing.date === body.date, 'Operação pertence a outra coleta.', 409);
        requireValue(existing.transcribeAudio === (body.transcribeAudio === true), 'A opção de transcrição mudou. Reinicie a coleta interrompida.', 409, 'RESTART_REQUIRED');
        return this.publicJob(existing);
      }
      const accountKey = await digest(binding.accountId); const active = await this.storage.get(`active:${accountKey}:${body.date}`);
      requireValue(!active || body.replaceExisting === true, 'Já há conversas para esta data. Confirme a substituição.', 409, 'REPLACE_REQUIRED');
      const jobs = Array.from((await this.storage.list({ prefix: 'job:' })).values());
      requireValue(!jobs.some(j => j.accountId === binding.accountId && j.date === body.date && ['uploading', 'processing', 'generating'].includes(j.state)), 'Já existe uma operação em andamento para esta data.', 409, 'BUSY');
      requireValue(jobs.filter(j => j.state === 'uploading').length < 3, 'Conclua ou cancele as importações pendentes antes de iniciar outra.', 409);
      const job = { id: body.operationId, date: body.date, accountId: binding.accountId, accountKey, transcribeAudio: body.transcribeAudio === true, replaceExisting: body.replaceExisting === true, mergeExisting: body.mergeExisting === true, partialChats: 0, state: 'uploading', pages: 0, messageCount: 0, audioTotal: 0, audioTranscribed: 0, audioIgnored: 0, revision: 0, createdAt: this.clock(), error: null, summary: null, autoGenerate: body.autoGenerate === true };
      await this.save(job); await this.wake(); return this.publicJob(job);
    }
    const job = await this.job(body.jobId);
    if (action === 'saveLocalSummary') { requireValue(job.state === 'generating' && job.summaryClaimed, 'Geração indisponível.', 409); await this.storage.put(`local-summary:${job.date}`, body.summary); return { saved: true }; }
    if (action === 'get') return { ...this.publicJob(job), messages: body.includeMessages ? await this.messages(job) : undefined };
    if (action === 'audioRead') {
      const message = (await this.messages(job)).find(m => m.id === body.messageId && m.audio);
      requireValue(message, 'Áudio não encontrado nesta importação.', 404);
      requireValue(Number.isInteger(message.audio.chunks) && message.audio.chunks > 0, 'Arquivo de áudio indisponível localmente.', 404);
      const chunks = await this.audioChunks(job, message.id, message.audio.chunks);
      requireValue(chunks.every(Boolean), 'Arquivo de áudio indisponível localmente.', 404);
      const bytes = this.combine(chunks);
      let binary = '';
      for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
      return { base64: btoa(binary), mimetype: message.audio.mimetype || 'audio/ogg', byteLength: bytes.length };
    }
    if (action === 'ignoreAudio') {
      requireValue(['awaiting_confirmation', 'ready', 'failed'].includes(job.state), 'Aguarde o processamento antes de alterar pendências.', 409);
      requireValue(typeof body.ignored === 'boolean', 'Opção de ignorar áudio inválida.');
      const messages = await this.messages(job);
      const message = messages.find(m => m.id === body.messageId && m.audio);
      requireValue(message, 'Áudio não encontrado nesta importação.', 404);
      requireValue(message.audio.status !== 'transcribed', 'Áudios já transcritos não podem ser ignorados.', 409);
      if (body.ignored) {
        if (message.audio.status !== 'ignored') {
          message.audio.previousStatus = message.audio.status;
          message.audio.status = 'ignored';
        }
      } else if (message.audio.status === 'ignored') {
        message.audio.status = message.audio.previousStatus || 'failed';
        delete message.audio.previousStatus;
      }
      await this.writeMessages(job, messages);
      await this.refresh(job);
      job.revision++;
      await this.save(job);
      return this.publicJob(job);
    }
    if (action === 'cancel') {
      requireValue(job.state === 'uploading', 'Só uma coleta ainda não concluída pode ser reiniciada.', 409);
      for (const message of await this.messages(job)) if (message.audio) await this.deleteAudio(job, message);
      for (let i = 0; i < job.pages; i++) await this.storage.delete(`messages:${job.id}:${i}`);
      job.state = 'cancelled'; job.pages = 0; job.messageCount = 0; job.audioTotal = 0;
      await this.save(job); return this.publicJob(job);
    }
    if (action === 'append') {
      requireValue(job.state === 'uploading' && Number.isInteger(body.index) && body.index >= 0 && body.index <= job.pages, 'Ordem de envio inválida.', 409);
      requireValue(Array.isArray(body.messages) && body.messages.length > 0 && body.messages.length <= 100, 'Lote de mensagens inválido.');
      const page = body.messages.map(m => validateMessage(m, job.date));
      if (body.index < job.pages) { requireValue(JSON.stringify(await this.storage.get(`messages:${job.id}:${body.index}`)) === JSON.stringify(page), 'Lote repetido com conteúdo diferente.', 409); return this.publicJob(job); }
      requireValue(job.messageCount + page.length <= LIMITS.messages, 'A data excede o limite de mensagens desta versão.');
      const textBytes = new TextEncoder().encode(JSON.stringify(page)).length;
      requireValue((job.textBytes || 0) + textBytes <= 8 * 1024 * 1024, 'A data excede o limite de 8 MiB de mensagens desta versão. Os dados anteriores foram preservados.', 413, 'IMPORT_LIMIT');
      const seen = new Set((await this.messages(job)).map(m => m.id));
      for (const m of page) { requireValue(!seen.has(m.id), 'Mensagem duplicada no lote.'); seen.add(m.id); }
      await this.storage.put(`messages:${job.id}:${job.pages}`, page); job.pages++; job.textBytes = (job.textBytes || 0) + textBytes; job.messageCount += page.length; job.audioTotal += page.filter(m => m.audio).length; await this.save(job); return this.publicJob(job);
    }
    if (action === 'audio') {
      requireValue(job.state === 'uploading' && job.transcribeAudio, 'Esta importação não aceita arquivos de áudio.', 409);
      requireValue(Number.isInteger(body.index) && body.index >= 0 && body.index < LIMITS.chunks && /^[a-f0-9]{64}$/.test(body.hash), 'Bloco de áudio inválido.');
      requireValue(typeof body.base64 === 'string' && body.base64.length <= LIMITS.chunk * 4 / 3 && /^[A-Za-z0-9+/]*={0,2}$/.test(body.base64) && body.base64.length % 4 === 0, 'Áudio muito grande ou inválido.');
      requireValue((await this.messages(job)).some(m => m.id === body.messageId && m.audio), 'Áudio não pertence à importação.');
      const bytes = Uint8Array.from(atob(body.base64), c => c.charCodeAt(0)); requireValue(bytes.length > 0, 'Bloco vazio.');
      const key = `audio:${job.id}:${await digest(body.messageId)}:${body.index}`;
      const old = await this.storage.get(key);
      if (old) { requireValue(old.hash === body.hash && old.base64 === body.base64, 'Bloco repetido com conteúdo diferente.', 409); return { accepted: true }; }
      const usage = (await this.storage.get('audioBytes')) || 0; requireValue(usage + bytes.length <= LIMITS.userBytes, 'Limite gratuito de armazenamento da aplicação atingido. Aguarde a limpeza dos áudios pendentes.', 429, 'FREE_LIMIT');
      await this.storage.put(key, { base64: body.base64, hash: body.hash, length: bytes.length, uploadedAt: this.clock() }); await this.storage.put('audioBytes', usage + bytes.length); await this.wake(); return { accepted: true };
    }
    if (action === 'seal') {
      if (job.state !== 'uploading') return this.publicJob(job);
      requireValue(job.messageCount > 0 && body.messageCount === job.messageCount && body.pages === job.pages, 'Envio incompleto. Os dados anteriores foram preservados.', 409, 'INCOMPLETE_UPLOAD');
      requireValue(Array.isArray(body.audioManifest) && body.audioManifest.length <= job.audioTotal && Number.isInteger(body.partialChats) && body.partialChats >= 0 && body.partialChats <= job.messageCount, 'Manifesto inválido.');
      const manifest = new Map(body.audioManifest.map(a => [a.id, a])); const messages = await this.messages(job);
      for (const message of messages.filter(m => m.audio)) {
        const info = manifest.get(message.id);
        if (!job.transcribeAudio) { message.audio.status = 'disabled'; continue; }
        if (!info) { message.audio.status = 'unavailable'; continue; }
        requireValue(Number.isInteger(info.chunks) && info.chunks > 0 && info.chunks <= LIMITS.chunks && Number.isInteger(info.byteLength) && info.byteLength > 0 && info.byteLength <= LIMITS.audio && /^[a-f0-9]{64}$/.test(info.hash) && /^audio\/(ogg|opus|mpeg|mp4|aac|wav|webm)$/.test(info.mimetype), 'Metadados de áudio inválidos.');
        const chunks = await this.audioChunks(job, message.id, info.chunks); requireValue(chunks.every(c => c && c.hash === info.hash) && chunks.reduce((n, c) => n + c.length, 0) === info.byteLength, 'Faltam blocos de áudio. Retome o envio.', 409, 'INCOMPLETE_UPLOAD');
        const bytes = this.combine(chunks); requireValue(await digest(bytes) === info.hash, 'Integridade do áudio não confirmada. Reenvie a coleta.', 409);
        Object.assign(message.audio, { ...info, status: 'pending', attempts: 0, transcription: null, expiresAt: Math.min(...chunks.map(c => c.uploadedAt)) + LIMITS.pendingDays * 86400000 });
        const cached = await this.storage.get(`transcription:${job.accountKey}:${info.hash}`); if (cached) { message.audio.transcription = cached; message.audio.status = 'transcribed'; await this.deleteAudio(job, message); }
      }
      await this.writeMessages(job, messages);
      job.partialChats = 0; job.state = 'processing'; job.revision++; await this.refresh(job);
      // Só publica as conversas depois de validar TODO o envio. Resumos antigos
      // permanecem no banco até a nova geração ser salva com sucesso.
      await this.storage.put(`active:${job.accountKey}:${job.date}`, job.id); await this.save(job); await this.wake(); return this.publicJob(job);
    }
    if (action === 'generate') {
      requireValue(['ready', 'awaiting_confirmation', 'failed'].includes(job.state), 'Aguarde o processamento antes de gerar.', 409);
      requireValue(!job.summary || body.confirmReplace === true || job.replaceExisting, 'Confirme a substituição do resumo salvo.', 409, 'REPLACE_REQUIRED');
      if (body.confirmReplace === true) job.replaceExisting = true;
      const consent = consentRequired(job);
      requireValue(body.revision === job.revision, 'Os dados mudaram. Confira as pendências novamente.', 409);
      requireValue(!consent.required || body.confirmPending === true, 'Confirme a geração com áudios pendentes.', 409, 'CONFIRM_PENDING');
      job.consent = { ...consent, confirmedAt: this.clock(), explicit: body.confirmPending === true }; job.state = 'generating'; job.summaryClaimed = false; job.generationToken = crypto.randomUUID(); job.error = null; await this.save(job); await this.wake(); return this.publicJob(job);
    }
    if (action === 'claim') {
      requireValue(job.state === 'generating' && body.token === job.generationToken && !job.summaryClaimed, 'Geração indisponível ou já assumida.', 409);
      const active = await this.storage.get(`active:${job.accountKey}:${job.date}`); requireValue(active === job.id, 'Esta importação foi substituída.', 409);
      job.summaryClaimed = true; await this.save(job); return { ...this.publicJob(job), text: formattedMessages(await this.messages(job), job.transcribeAudio), consent: job.consent, accountKey: job.accountKey, replaceExisting: job.replaceExisting, mergeExisting: job.mergeExisting === true };
    }
    if (action === 'retry') {
      requireValue(['awaiting_confirmation', 'ready', 'failed', 'completed'].includes(job.state), 'Há processamento em andamento.', 409);
      const messages = await this.messages(job); for (const m of messages) if (m.audio?.status === 'failed' && m.audio.expiresAt > this.clock()) { m.audio.status = 'pending'; m.audio.attempts = 0; m.audio.retryAt = 0; }
      await this.writeMessages(job, messages); job.autoGenerate = false; job.error = null; job.revision++; await this.refresh(job); await this.save(job); await this.wake(); return this.publicJob(job);
    }
    throw new InputError('Operação não permitida.', 405);
  }
  publicJob(job) { return { id: job.id, date: job.date, accountId: job.accountId, state: job.state, transcribeAudio: job.transcribeAudio, messageCount: job.messageCount, audioTotal: job.audioTotal, audioTranscribed: job.audioTranscribed, audioIgnored: job.audioIgnored || 0, partialChats: 0, revision: job.revision, error: job.error, errorCode: job.errorCode, summary: job.summary, consent: consentRequired(job), createdAt: job.createdAt }; }
  async audioChunks(job, id, count) { const hash = await digest(id); const chunks = []; for (let i = 0; i < count; i++) chunks.push(await this.storage.get(`audio:${job.id}:${hash}:${i}`)); return chunks; }
  combine(chunks) { const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0)); let offset = 0; for (const c of chunks) { const part = Uint8Array.from(atob(c.base64), s => s.charCodeAt(0)); bytes.set(part, offset); offset += part.length; } return bytes; }
  async deleteAudio(job, message) { const prefix = `audio:${job.id}:${await digest(message.id)}:`; const chunks = await this.storage.list({ prefix }); let removed = 0; for (const [key, chunk] of chunks) { await this.storage.delete(key); removed += chunk.length; } await this.storage.put('audioBytes', Math.max(0, ((await this.storage.get('audioBytes')) || 0) - removed)); }
  async writeMessages(job, messages) { let offset = 0; for (let i = 0; i < job.pages; i++) { const original = await this.storage.get(`messages:${job.id}:${i}`); await this.storage.put(`messages:${job.id}:${i}`, messages.slice(offset, offset + original.length)); offset += original.length; } }
  async refresh(job) { const messages = await this.messages(job); job.audioTranscribed = messages.filter(m => m.audio?.status === 'transcribed').length; job.audioIgnored = messages.filter(m => m.audio?.status === 'ignored').length; const pending = messages.some(m => m.audio?.status === 'pending'); job.state = pending ? 'processing' : consentRequired(job).required ? 'awaiting_confirmation' : 'ready'; }
  async wake() { const alarm = await this.storage.getAlarm(); if (!alarm || alarm > this.clock() + 1000) await this.storage.setAlarm(this.clock() + 1000); }
  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try { await this.processTick(); } finally { this.ticking = false; }
  }
  async processTick() {
    const jobs = Array.from((await this.storage.list({ prefix: 'job:' })).values());
    for (const job of jobs) {
      if (job.state === 'uploading' && job.createdAt + LIMITS.pendingDays * 86400000 <= this.clock()) {
        for (const message of await this.messages(job)) if (message.audio) await this.deleteAudio(job, message);
        job.state = 'cancelled'; await this.save(job);
      }
      const messages = await this.messages(job); let changed = false;
      for (const message of messages) if (message.audio?.expiresAt && message.audio.expiresAt <= this.clock() && message.audio.status !== 'transcribed') { await this.deleteAudio(job, message); message.audio.status = 'expired'; changed = true; }
      if (changed) { await this.writeMessages(job, messages); if (job.state === 'processing') await this.refresh(job); await this.save(job); }
      if (job.state === 'processing') {
        const message = messages.find(m => m.audio?.status === 'pending' && (!m.audio.retryAt || m.audio.retryAt <= this.clock()));
        if (message) {
          try { const chunks = await this.audioChunks(job, message.id, message.audio.chunks); requireValue(chunks.every(Boolean), 'Áudio indisponível.'); const cached = await this.storage.get(`transcription:${job.accountKey}:${message.audio.hash}`); const text = cached || await this.providers.transcribe(this.combine(chunks), message.audio.mimetype); requireValue(typeof text === 'string' && text.trim().length > 0 && text.length <= LIMITS.text, 'Transcrição vazia ou inválida.'); message.audio.transcription = text.trim(); message.audio.status = 'transcribed'; await this.storage.put(`transcription:${job.accountKey}:${message.audio.hash}`, text.trim()); await this.writeMessages(job, messages); await this.deleteAudio(job, message); }
          catch (error) { message.audio.reason = isInputError(error) ? error.message : 'Falha temporária na transcrição. Tente novamente.'; message.audio.attempts++; message.audio.retryAt = this.clock() + Math.min(60000, 1000 * 2 ** message.audio.attempts); if (message.audio.attempts >= 3) message.audio.status = 'failed'; await this.writeMessages(job, messages); }
        }
        await this.refresh(job); job.revision++; await this.save(job);
      }
      if (job.state === 'ready' && job.autoGenerate) { job.consent = { ...consentRequired(job), explicit: false }; job.state = 'generating'; job.summaryClaimed = false; job.generationToken = crypto.randomUUID(); await this.save(job); }
      if (job.state === 'generating') {
        try { const result = await this.providers.generate(job.id, job.generationToken); job.summary = result; job.state = 'completed'; job.error = null; }
        catch (error) { job.state = 'failed'; job.error = isInputError(error) ? error.message : 'Não foi possível concluir a geração. Seus dados anteriores foram preservados. Tente novamente.'; job.errorCode = isInputError(error) ? error.code : null; }
        await this.save(job);
      }
    }
    const audio = await this.storage.list({ prefix: 'audio:' });
    // Limpa também envios abandonados, que nunca chegaram à etapa seal.
    for (const [key, chunk] of audio) if (chunk.uploadedAt + LIMITS.pendingDays * 86400000 <= this.clock()) { await this.storage.delete(key); await this.storage.put('audioBytes', Math.max(0, ((await this.storage.get('audioBytes')) || 0) - chunk.length)); }
    const unfinished = jobs.some(j => j.state === 'processing' || j.state === 'generating');
    if (unfinished || (await this.storage.list({ prefix: 'audio:' })).size) await this.storage.setAlarm(this.clock() + (unfinished ? 10000 : 3600000));
  }
}
