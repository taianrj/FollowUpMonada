'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { __test: service } = require('../server');

test('usa o release oficial mais recente do Baileys 7', () => {
  const packageJson = require('../package.json');
  assert.equal(packageJson.dependencies.baileys, '7.0.0-rc13');
});

test('auth state persiste os tres tipos obrigatorios da migracao v7 com BufferJSON', async t => {
  const baileys = await import('baileys');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'monada-baileys-v7-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const { state } = await baileys.useMultiFileAuthState(directory);
  await state.keys.set({
    'lid-mapping': { '5511999999999@s.whatsapp.net': '123456789012345@lid' },
    'device-list': { '123456789012345@lid': ['0', '1'] },
    tctoken: {
      '123456789012345@lid': {
        token: Buffer.from([10, 20, 30]),
        timestamp: '2026-07-10T00:00:00.000Z'
      }
    }
  });

  const lidMapping = await state.keys.get('lid-mapping', ['5511999999999@s.whatsapp.net']);
  const deviceList = await state.keys.get('device-list', ['123456789012345@lid']);
  const tcToken = await state.keys.get('tctoken', ['123456789012345@lid']);

  assert.equal(lidMapping['5511999999999@s.whatsapp.net'], '123456789012345@lid');
  assert.deepEqual(deviceList['123456789012345@lid'], ['0', '1']);
  assert.equal(Buffer.isBuffer(tcToken['123456789012345@lid'].token), true);
  assert.deepEqual([...tcToken['123456789012345@lid'].token], [10, 20, 30]);
});

test('expõe os eventos e campos de enderecamento exigidos pelo v7', async () => {
  const baileys = await import('baileys');
  const key = baileys.proto.MessageKey.create({
    remoteJid: '123@lid',
    remoteJidAlt: '5511999999999@s.whatsapp.net',
    participant: '456@lid',
    participantAlt: '5521888888888@s.whatsapp.net'
  });

  assert.equal(key.remoteJidAlt, '5511999999999@s.whatsapp.net');
  assert.equal(key.participantAlt, '5521888888888@s.whatsapp.net');
  assert.equal(baileys.proto.HistorySync.HistorySyncType.RECENT, 3);
});

test('bundle comprimido consolida o multi-file auth state sem perder BufferJSON', () => {
  const files = [
    { file: 'creds.json', content: '{"registered":true}' },
    { file: 'lid-mapping-abc.json', content: '{"type":"Buffer","data":"AQID"}' },
    { file: '../escape.json', content: '{}' }
  ];
  const bundle = service.buildAuthStateBundle(files);
  const restored = service.parseAuthStateBundle(bundle);

  assert.equal(bundle.fileCount, 2);
  assert.deepEqual(restored, files.slice(0, 2));
  assert.ok(bundle.data.length < JSON.stringify(files).length * 2);
});

test('listener lid-mapping do v7 não é registrado dentro da persistência de mensagens', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const persistenceBlock = source.slice(
    source.indexOf('async function persistMessagesToSupabase'),
    source.indexOf('async function loadMessagesFromSupabase')
  );

  assert.doesNotMatch(persistenceBlock, /sock\.ev\.on/);
  assert.match(source, /sock\.ev\.on\('lid-mapping\.update'/);
  assert.match(source, /sock\.ev\.on\('messaging-history\.status'/);
});
