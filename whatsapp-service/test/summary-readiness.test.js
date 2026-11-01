'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { getDayReadiness, processInBatches } = require('../lib/summary-readiness');
const history = require('../lib/history-sync');

const base = { date: '2026-10-28', connected: true, historyComplete: true, importComplete: true,
  audioConfigured: true, audioEnabled: true };

test('somente mensagens recebidas e contadores não liberam um dia', () => {
  for (const missing of [{ historyComplete: false }, { importComplete: false }, { connected: false }]) {
    assert.equal(getDayReadiness({ ...base, ...missing, messages: [{ text: 'Texto' }] }).ready, false);
  }
});

test('libera cada dia pelos próprios áudios, incluindo legado e falhas fora da fila', () => {
  const pending = [{ mediaKind: 'audio', text: '[Áudio]' }];
  assert.equal(getDayReadiness({ ...base, messages: pending }).state, 'audio_pending');
  assert.equal(getDayReadiness({ ...base, messages: [{ text: '[Áudio]' }] }).ready, false);
  const ready = getDayReadiness({ ...base, messages: [{ text: '[Áudio transcrito por Gemini] Texto' }] });
  assert.equal(ready.ready, true);
  assert.equal(ready.audioTranscribed, 1);
  // Um áudio de outra data não é entrada deste cálculo e não bloqueia o dia.
  assert.equal(getDayReadiness({ ...base, date: '2026-10-29', messages: [{ text: 'Texto' }] }).ready, true);
});

test('áudio desativado ou sem provedor e dias vazios nunca são prontos', () => {
  assert.equal(getDayReadiness({ ...base }).state, 'empty');
  for (const setting of [{ audioEnabled: false }, { audioConfigured: false }]) {
    assert.equal(getDayReadiness({ ...base, ...setting, messages: [{ text: '[Áudio]' }] }).state, 'audio_unavailable');
  }
  assert.throws(() => getDayReadiness({ ...base, date: '2026-02-30' }));
});

test('interpretação habilitada aguarda apenas as imagens do próprio dia', () => {
  const messages = [{ mediaKind: 'image', text: '[Imagem]' }];
  assert.equal(getDayReadiness({ ...base, imagesEnabled: true, messages }).state, 'image_pending');
  assert.equal(getDayReadiness({ ...base, imagesEnabled: false, messages }).ready, true);
});

test('importação ampliada exige RECENT explícito, FULL final e drenagem de todos os lotes', () => {
  const state = history.createHistorySyncState({ expectsHistory: true, expectsFullHistory: true });
  history.applyHistoryStatus(state, { isRecent: true, status: 'complete', explicit: true });
  history.beginHistoryBatch(state);
  history.finishHistoryBatch(state);
  assert.equal(history.canFinalizeHistorySync(state), false);
  history.beginHistoryBatch(state);
  state.fullHistoryFinalBatchProcessed = true;
  assert.equal(history.canFinalizeHistorySync(state), false);
  history.finishHistoryBatch(state);
  assert.equal(history.canFinalizeHistorySync(state), true);
  history.failHistoryBatch(state, new Error('gravação falhou'));
  assert.equal(history.canFinalizeHistorySync(state), false);
});

test('processamento usa blocos sequenciais e preserva todos os itens uma única vez', async () => {
  const items = Array.from({ length: 751 }, (_, index) => index);
  const sizes = [], processed = [];
  let running = 0;
  await processInBatches(items, async batch => {
    assert.equal(++running, 1);
    sizes.push(batch.length);
    processed.push(...batch);
    await new Promise(resolve => setImmediate(resolve));
    running--;
  });
  assert.deepEqual(sizes, [250, 250, 250, 1]);
  assert.deepEqual(processed, items);
});

test('interrupção de geração e falha em bloco não são sucesso', async () => {
  await assert.rejects(processInBatches([1], async () => {}, { isCurrent: () => false }));
  await assert.rejects(processInBatches([1, 2], async () => { throw new Error('falha'); }), /falha/);
});
