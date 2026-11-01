'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'monada-readiness-'));
process.env.DATA_DIR = data;
process.env.SUPABASE_URL = '';
process.env.NEXT_PUBLIC_SUPABASE_URL = '';
process.env.WHATSAPP_SERVICE_SECRET = 'test-secret-with-more-than-thirty-two-characters';
const { app, __test: service } = require('../server');
const history = require('../lib/history-sync');
const user = '00000000-0000-4000-8000-000000000001';
let server, base;
function headers(url, id = user) {
  const timestamp = Date.now(), nonce = crypto.randomUUID();
  const bodyHash = crypto.createHash('sha256').update('').digest('hex');
  const canonical = ['v1', timestamp, nonce, id, 'GET', url, bodyHash].join('\n');
  return { 'x-api-key': id, 'x-service-timestamp': String(timestamp), 'x-service-nonce': nonce,
    'x-service-body-sha256': bodyHash,
    'x-service-signature': crypto.createHmac('sha256', process.env.WHATSAPP_SERVICE_SECRET).update(canonical).digest('hex') };
}
test.before(async () => {
  const state = history.createHistorySyncState({ expectsHistory: false });
  history.markPendingNotifications(state);
  const session = { connectionStatus: 'connected', syncStatus: 'completed', historySyncState: state,
    historyImportComplete: true, historyReceiptIdentity: 'fixture-pairing', transcribeAudioSetting: true };
  service.instances[user] = session;
  service.instances['00000000-0000-4000-8000-000000000002'] = { ...session };
  const dir = path.join(data, 'messages', user);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'messages-2026-10-28.json'), JSON.stringify([
    { id: 'audio', chatJid: 'fixture@s.whatsapp.net', timestamp: '2026-10-28T12:00:00Z', text: '[Áudio]', mediaKind: 'audio' }
  ]));
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(data, { recursive: true, force: true });
});
test('prontidão exige autenticação, GET e data válida', async () => {
  assert.equal((await fetch(`${base}/summary-readiness?date=2026-10-28`)).status, 401);
  const url = '/summary-readiness?date=2026-02-30';
  assert.equal((await fetch(base + url, { headers: headers(url) })).status, 400);
  assert.equal((await fetch(`${base}/summary-readiness`, { method: 'POST' })).status, 404);
});
test('dia com áudio sem transcrição é bloqueado também no endpoint de mensagens', async () => {
  const url = '/summary-readiness?date=2026-10-28';
  const result = await (await fetch(base + url, { headers: headers(url) })).json();
  assert.equal(result.ready, false);
  assert.equal(result.pendingAudio, 1);
  const messages = '/messages?date=2026-10-28&format=text&requireReady=1';
  const response = await fetch(base + messages, { headers: headers(messages) });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'SUMMARY_DAY_NOT_READY');
});
test('contagens de um usuário não aparecem na prontidão de outro', async () => {
  const url = '/summary-readiness?date=2026-10-28';
  const result = await (await fetch(base + url, { headers: headers(url, '00000000-0000-4000-8000-000000000002') })).json();
  assert.equal(result.messages, 0);
  assert.equal(result.pendingAudio, 0);
});
test('recibo local é persistente e uma importação pendente invalida o sucesso anterior', () => {
  assert.equal(service.readHistoryImportReceipt(user), false);
  assert.equal(service.saveHistoryImportReceipt(user, true), true);
  assert.equal(service.readHistoryImportReceipt(user), true);
  service.instances[user].historyReceiptIdentity = 'other-pairing';
  assert.equal(service.readHistoryImportReceipt(user), false);
  service.instances[user].historyReceiptIdentity = 'fixture-pairing';
  service.saveHistoryImportReceipt(user, false);
  assert.equal(service.readHistoryImportReceipt(user), false);
});
