'use strict';

function createHistorySyncState({ expectsHistory = true, now = Date.now() } = {}) {
  return {
    expectsHistory: !!expectsHistory,
    pendingNotificationsReceived: false,
    pendingBatches: 0,
    explicitRecentComplete: false,
    finalBatchObservedAfterCompletion: false,
    initialBootstrapComplete: false,
    paused: false,
    processingFailed: false,
    lastProcessingError: null,
    startedAt: now,
    lastBatchStartedAt: null,
    lastBatchFinishedAt: null,
    completedAt: null,
    completionSource: null
  };
}

function markPendingNotifications(state, now = Date.now()) {
  if (!state) return;
  state.pendingNotificationsReceived = true;
  state.lastSignalAt = now;
}

function beginHistoryBatch(state, now = Date.now()) {
  if (!state) return;
  state.pendingBatches = Math.max(0, Number(state.pendingBatches || 0)) + 1;
  if (state.explicitRecentComplete) state.finalBatchObservedAfterCompletion = true;
  state.paused = false;
  state.completedAt = null;
  state.lastBatchStartedAt = now;
}

function finishHistoryBatch(state, now = Date.now()) {
  if (!state) return;
  state.pendingBatches = Math.max(0, Number(state.pendingBatches || 0) - 1);
  state.lastBatchFinishedAt = now;
}

function failHistoryBatch(state, error, now = Date.now()) {
  if (!state) return;
  state.processingFailed = true;
  state.lastProcessingError = String(error?.message || error || 'history batch failed');
  state.lastBatchFailedAt = now;
}

function applyHistoryStatus(state, { isRecent = false, isInitialBootstrap = false, status, explicit } = {}, now = Date.now()) {
  if (!state) return;
  state.lastSignalAt = now;

  if (isInitialBootstrap && status === 'complete') {
    state.initialBootstrapComplete = true;
  }

  if (!isRecent) return;
  if (status === 'paused') {
    state.paused = true;
    state.completionSource = explicit ? 'baileys-recent-paused-explicit' : 'baileys-recent-paused-timeout';
    return;
  }

  if (status === 'complete' && explicit === true) {
    state.explicitRecentComplete = true;
    state.finalBatchObservedAfterCompletion = false;
    state.paused = false;
    state.completionSource = 'baileys-recent-progress-100';
  }
}

function canFinalizeHistorySync(state) {
  if (!state || state.paused || state.processingFailed || Number(state.pendingBatches || 0) > 0) return false;
  if (state.expectsHistory) {
    return state.explicitRecentComplete === true && state.finalBatchObservedAfterCompletion === true;
  }
  return state.pendingNotificationsReceived === true;
}

function finalizeHistorySync(state, now = Date.now()) {
  if (!canFinalizeHistorySync(state)) return false;
  state.completedAt = now;
  if (!state.completionSource) {
    state.completionSource = state.expectsHistory
      ? 'baileys-recent-progress-100'
      : 'baileys-reconnect-pending-notifications';
  }
  return true;
}

function rawMessageDedupeKey(message) {
  if (!message || typeof message !== 'object') return '';
  const key = message.key || {};
  if (key.id) {
    return [key.remoteJidAlt || key.remoteJid || '', key.participantAlt || key.participant || '', key.id].join('|');
  }
  return '';
}

function collectHistoryMessages({ messages = [], chats = [], retentionThreshold = 0, getTimestampMs } = {}) {
  const result = [];
  const seenKeys = new Set();
  const seenObjects = new WeakSet();
  let candidates = 0;
  let filteredOut = 0;
  let duplicatesSkipped = 0;

  const append = (message) => {
    if (!message || typeof message !== 'object') return;
    candidates++;
    if (typeof getTimestampMs === 'function' && getTimestampMs(message) < retentionThreshold) {
      filteredOut++;
      return;
    }

    const key = rawMessageDedupeKey(message);
    if (key ? seenKeys.has(key) : seenObjects.has(message)) {
      duplicatesSkipped++;
      return;
    }
    if (key) seenKeys.add(key);
    else seenObjects.add(message);
    result.push(message);
  };

  for (const message of Array.isArray(messages) ? messages : []) append(message);
  for (const chat of Array.isArray(chats) ? chats : []) {
    for (const message of Array.isArray(chat?.messages) ? chat.messages : []) append(message);
  }

  return {
    messages: result,
    candidates,
    filteredOut,
    duplicatesSkipped
  };
}

module.exports = {
  applyHistoryStatus,
  beginHistoryBatch,
  canFinalizeHistorySync,
  collectHistoryMessages,
  createHistorySyncState,
  finalizeHistorySync,
  failHistoryBatch,
  finishHistoryBatch,
  markPendingNotifications,
  rawMessageDedupeKey
};
