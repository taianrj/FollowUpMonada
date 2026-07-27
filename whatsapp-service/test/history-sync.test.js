'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const historySync = require('../lib/history-sync');
const { __test: service } = require('../server');

test('nao conclui primeira sincronizacao por inatividade ou bootstrap isolado', () => {
  const state = historySync.createHistorySyncState({ expectsHistory: true, now: 1 });
  historySync.markPendingNotifications(state, 2);
  historySync.applyHistoryStatus(state, {
    isInitialBootstrap: true,
    status: 'complete',
    explicit: true
  }, 3);

  assert.equal(historySync.canFinalizeHistorySync(state), false);
  assert.equal(historySync.finalizeHistorySync(state, 90_000), false);
});

test('conclui somente apos progresso RECENT 100 e processamento do ultimo lote', () => {
  const state = historySync.createHistorySyncState({ expectsHistory: true });
  historySync.applyHistoryStatus(state, { isRecent: true, status: 'complete', explicit: true });
  historySync.beginHistoryBatch(state);

  assert.equal(historySync.canFinalizeHistorySync(state), false);
  historySync.finishHistoryBatch(state);
  assert.equal(historySync.finalizeHistorySync(state, 123), true);
  assert.equal(state.completedAt, 123);
  assert.equal(state.completionSource, 'baileys-recent-progress-100');
});

test('preserva RECENT 100 recebido antes de connection.open', () => {
  const instance = {};
  service.initializeUserSyncState(instance, true);
  const generationState = instance.historySyncState;

  historySync.applyHistoryStatus(generationState, {
    isRecent: true,
    status: 'complete',
    explicit: true
  });

  service.markUserSyncConnected(instance, true);
  historySync.beginHistoryBatch(instance.historySyncState);
  historySync.finishHistoryBatch(instance.historySyncState);

  assert.equal(instance.historySyncState, generationState);
  assert.equal(instance.historySyncState.explicitRecentComplete, true);
  assert.equal(historySync.finalizeHistorySync(instance.historySyncState), true);
});

test('nao conclui entre o status RECENT e o download do lote final', () => {
  const state = historySync.createHistorySyncState({ expectsHistory: true });
  historySync.applyHistoryStatus(state, { isRecent: true, status: 'complete', explicit: true });
  assert.equal(historySync.canFinalizeHistorySync(state), false);
  historySync.beginHistoryBatch(state);
  historySync.finishHistoryBatch(state);
  assert.equal(historySync.canFinalizeHistorySync(state), true);
});

test('status paused inferido pelo Baileys nao gera falso sincronizado', () => {
  const state = historySync.createHistorySyncState({ expectsHistory: true });
  historySync.applyHistoryStatus(state, { isRecent: true, status: 'paused', explicit: false });
  assert.equal(state.paused, true);
  assert.equal(historySync.canFinalizeHistorySync(state), false);
});

test('falha local de persistencia impede falso sincronizado', () => {
  const state = historySync.createHistorySyncState({ expectsHistory: true });
  historySync.applyHistoryStatus(state, { isRecent: true, status: 'complete', explicit: true });
  historySync.beginHistoryBatch(state);
  historySync.failHistoryBatch(state, new Error('supabase indisponivel'));
  historySync.finishHistoryBatch(state);

  assert.equal(state.processingFailed, true);
  assert.match(state.lastProcessingError, /supabase/);
  assert.equal(historySync.finalizeHistorySync(state), false);
});

test('reconexao ja sincronizada conclui apos notificacoes pendentes', () => {
  const state = historySync.createHistorySyncState({ expectsHistory: false });
  assert.equal(historySync.canFinalizeHistorySync(state), false);
  historySync.markPendingNotifications(state);
  assert.equal(historySync.finalizeHistorySync(state), true);
  assert.equal(state.completionSource, 'baileys-reconnect-pending-notifications');
});

test('combina e deduplica mensagens globais e legadas por chat em um unico lote', () => {
  const duplicate = { key: { id: 'A', remoteJid: '1@s.whatsapp.net' }, messageTimestamp: 20 };
  const old = { key: { id: 'OLD', remoteJid: '1@s.whatsapp.net' }, messageTimestamp: 1 };
  const second = { key: { id: 'B', remoteJid: '2@s.whatsapp.net' }, messageTimestamp: 30 };
  const result = historySync.collectHistoryMessages({
    messages: [duplicate, old],
    chats: [{ messages: [duplicate, second] }],
    retentionThreshold: 10,
    getTimestampMs: message => message.messageTimestamp
  });

  assert.deepEqual(result.messages, [duplicate, second]);
  assert.equal(result.candidates, 4);
  assert.equal(result.filteredOut, 1);
  assert.equal(result.duplicatesSkipped, 1);
});
