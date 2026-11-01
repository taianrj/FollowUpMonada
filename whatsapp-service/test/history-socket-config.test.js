'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createHistorySocketConfig } = require('../lib/history-socket-config');

test('payload real de pareamento usa WEB_BROWSER e continua solicitando histórico completo', async () => {
  const baileys = await import('baileys');
  const { DEFAULT_CONNECTION_CONFIG } = await import('baileys/lib/Defaults/index.js');
  const config = { ...DEFAULT_CONNECTION_CONFIG, ...createHistorySocketConfig({
    Browsers: baileys.Browsers, fullSyncType: baileys.proto.HistorySync.HistorySyncType.FULL, retentionDays: 30
  }) };
  const payload = baileys.generateRegistrationNode(baileys.initAuthCreds(), config);
  assert.equal(payload.webInfo.webSubPlatform, baileys.proto.ClientPayload.WebInfo.WebSubPlatform.WEB_BROWSER);
  const props = baileys.proto.DeviceProps.decode(payload.devicePairingData.deviceProps);
  assert.equal(props.requireFullSync, true);
  assert.equal(config.shouldSyncHistoryMessage({ syncType: baileys.proto.HistorySync.HistorySyncType.FULL }), true);
  const legacy = createHistorySocketConfig({ Browsers: baileys.Browsers,
    fullSyncType: baileys.proto.HistorySync.HistorySyncType.FULL, retentionDays: 2 });
  assert.equal(legacy.shouldSyncHistoryMessage({ syncType: baileys.proto.HistorySync.HistorySyncType.FULL }), false);
});

test('fechamento de socket não apaga dados, credenciais ou diretórios automaticamente', () => {
  const source = fs.readFileSync(require.resolve('../server'), 'utf8');
  const closeHandler = source.slice(source.indexOf("if (connection === 'close')"), source.indexOf("} else if (connection === 'open')"));
  assert.ok(closeHandler.length > 0);
  for (const destructiveCall of ['deleteCredsFromSupabase(', 'clearAllUserData(', 'fs.rmSync(', 'fs.unlinkSync(']) {
    assert.equal(closeHandler.includes(destructiveCall), false, destructiveCall);
  }
  const logoutHandler = source.slice(source.indexOf("app.post('/logout'"));
  assert.ok(logoutHandler.includes('clearAllUserData('), 'logout explícito mantém o contrato anterior');
});
