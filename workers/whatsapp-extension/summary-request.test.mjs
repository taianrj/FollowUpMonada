import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSummaryRequest } from './summary-request.mjs';

const message = (id = 'one', type = 'chat') => ({ id, type, text: 'Texto sintético', chatJid: 'test@c.us', chatName: 'Teste', senderName: 'Pessoa', senderJid: 'test@c.us', fromMe: false, timestampMs: Date.parse('2026-11-19T12:00:00Z') });
const body = () => ({ jobId: 'job', date: '2026-11-19', accountKey: 'a'.repeat(64), transcribeAudio: true, partialChats: 0, confirmPending: false, confirmReplace: false, messages: [message()] });

test('valida mensagens novamente no servidor e deriva pendências das transcrições', async () => {
  const input = body(); input.messages.push(message('audio', 'ptt'));
  await assert.rejects(validateSummaryRequest(input), /Confirme/);
  input.confirmPending = true;
  const pending = await validateSummaryRequest(input);
  assert.equal(pending.consent.pendingAudio, 1);
  assert.equal(pending.messages[1].fromMe, false);
  input.messages[1].audio = { status: 'transcribed', transcription: 'Transcrição sintética' };
  input.confirmPending = false;
  const complete = await validateSummaryRequest(input);
  assert.equal(complete.consent.required, false);
  assert.match(complete.text, /Transcrição sintética/);
  assert.notEqual(complete.contentHash, pending.contentHash);
  input.messages[1].audio = { status: 'ignored', transcription: null };
  const ignored = await validateSummaryRequest(input);
  assert.equal(ignored.consent.required, false);
  assert.equal(ignored.consent.pendingAudio, 0);
  assert.deepEqual(ignored.warnings, []);
  assert.match(ignored.text, /Áudio ignorado pelo usuário/);
});

test('áudio desativado não inclui transcrição recebida e partialChats não bloqueia nem gera aviso', async () => {
  const input = body(); input.messages = [{ ...message('audio', 'ptt'), audio: { status: 'transcribed', transcription: 'Não incluir' } }]; input.transcribeAudio = false;
  assert.doesNotMatch((await validateSummaryRequest(input)).text, /Não incluir/);
  input.partialChats = 1;
  const validated = await validateSummaryRequest(input);
  assert.equal(validated.consent.required, false);
  assert.equal(validated.consent.partialHistory, false);
  assert.deepEqual(validated.warnings, ['Áudios não foram transcritos por opção do usuário.']);
});

test('recusa duplicatas, data impossível, autoria ambígua e status', async () => {
  for (const input of [ { ...body(), date: '2026-02-30' }, { ...body(), messages: [message(), message()] }, { ...body(), messages: [{ ...message(), fromMe: null }] }, { ...body(), messages: [{ ...message(), chatJid: 'status@broadcast' }] } ]) await assert.rejects(validateSummaryRequest(input));
});
