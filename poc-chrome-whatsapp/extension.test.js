'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const core = require('./lib/poc-core');
const media = require('./lib/poc-media');
const read = name => fs.readFileSync(path.join(__dirname, name), 'utf8');
const base = { id: 'false_123@c.us_TEST', from: '123@c.us', fromMe: false, t: Date.parse('2026-11-18T15:00:00Z') / 1000, type: 'chat', body: '' };

function oggPage(payload, sequence = 0, flags = 2) {
  const bytes = new Uint8Array(28 + payload.length);
  bytes.set(Buffer.from('OggS')); bytes[5] = flags; bytes[26] = 1; bytes[27] = payload.length;
  new DataView(bytes.buffer).setUint32(18, sequence, true); bytes.set(payload, 28);
  let crc = 0;
  for (const value of bytes) {
    crc = (crc ^ (value << 24)) >>> 0;
    for (let bit = 0; bit < 8; bit++) crc = ((crc & 0x80000000) ? (crc << 1) ^ 0x04c11db7 : crc << 1) >>> 0;
  }
  new DataView(bytes.buffer).setUint32(22, crc, true);
  return bytes;
}
const validOgg = () => oggPage(new Uint8Array([...Buffer.from('OpusHead'), ...new Uint8Array(11)]));

test('valida calendário, rejeita datas impossíveis e remove repetições', () => {
  assert.deepEqual(core.parseDates('2026-11-18,2026-11-18'), ['2026-11-18']);
  for (const date of ['2026-02-30', '2026-13-01', 'abc', '2026-11-18 lixo']) assert.throws(() => core.parseDates(date));
});

test('coleta não significa prontidão e falha fechada com texto ausente ou áudio não validado', () => {
  const day = { conversations: [{ messages: [{ type: 'chat', text: '' }] }] };
  assert.equal(core.summarizeCollection(day).collected, false);
  day.conversations[0].messages[0].text = 'Teste';
  assert.equal(core.summarizeCollection(day).collected, true);
  assert.equal(core.summarizeCollection(day).summaryReady, false);
  day.conversations[0].messages.push({ type: 'ptt', audio: { status: 'recovered' } });
  assert.equal(core.summarizeCollection(day).collected, false);
});

test('erro de reprodução invalida a coleta e atualiza contadores sem duplicar a falha', () => {
  const message = { type: 'ptt', audio: { status: 'recovered', validation: 'decoded', source: 'local-cache' } };
  const day = { conversations: [{ messages: [message] }], audioRecovery: { recoveredTotal: 1, recoveredLocalCache: 1, failedCount: 0 } };
  assert.equal(core.summarizeCollection(day).collected, true);
  core.markAudioPlaybackFailed(day, message);
  core.markAudioPlaybackFailed(day, message);
  assert.equal(day.collection.collected, false);
  assert.equal(day.audioRecovery.recoveredTotal, 0);
  assert.equal(day.audioRecovery.failedCount, 1);
});

test('Ogg rejeita lixo, truncamento e corrupção, sem exigir EOS em áudios WhatsApp', () => {
  const bytes = validOgg();
  assert.equal(media.assertOggOpus(bytes), 1);
  assert.throws(() => media.assertOggOpus(new Uint8Array([1, 2, 3])));
  assert.throws(() => media.assertOggOpus(bytes.slice(0, -1)));
  const corrupt = bytes.slice(); corrupt[corrupt.length - 1] ^= 1;
  assert.throws(() => media.assertOggOpus(corrupt), /Checksum/);
  const gap = oggPage(new Uint8Array([0]), 2, 0);
  const combined = new Uint8Array(bytes.length + gap.length); combined.set(bytes); combined.set(gap, bytes.length);
  assert.throws(() => media.assertOggOpus(combined), /Sequência/);
});

test('validação de mídia exige decoder real disponível e restringe URLs e tipos', async () => {
  await assert.rejects(media.validatedDataUrl(validOgg()), /Decodificador/);
  for (const url of ['https://example.com/a.ogg', 'javascript:alert(1)', 'data:text/html;base64,AAAA', 'data:audio/ogg;base64,abc', 'data:audio/ogg;base64,']) assert.equal(media.isLocalAudioDataUrl(url), false);
  assert.equal(media.isLocalAudioDataUrl('data:audio/ogg;base64,T2dnUw=='), true);
  assert.equal(media.whatsappMediaUrl(null, 'https://example.com/audio'), null);
  assert.equal(media.whatsappMediaUrl(null, 'https://mmg.whatsapp.net.evil.test/a'), null);
  assert.equal(media.whatsappMediaUrl('/v/file'), 'https://mmg.whatsapp.net/v/file');
});

test('validador aguarda decodificação e rejeita duração incompleta e falha do decoder', async () => {
  let decodedCalls = 0;
  let fail = false;
  const sandbox = { Uint8Array, ArrayBuffer, DataView, Map, setTimeout, clearTimeout, btoa, OfflineAudioContext: class {
    async decodeAudioData() { decodedCalls++; if (fail) throw new Error('codec inválido'); return { duration: 10, length: 480000 }; }
  } };
  vm.runInNewContext(read('lib/poc-media.js'), sandbox);
  const validator = sandbox.MonadaWaPocMedia;
  assert.match(await validator.validatedDataUrl(validOgg(), 'audio/ogg', 10), /^data:audio\/ogg;base64,/);
  assert.equal(decodedCalls, 1);
  await assert.rejects(validator.validatedDataUrl(validOgg(), 'audio/ogg', 30), /Duração/);
  fail = true;
  await assert.rejects(validator.validatedDataUrl(validOgg()), /codec inválido/);
});

test('descriptografia autentica MAC antes de aceitar mídia e rejeita adulteração', async () => {
  const key = new Uint8Array(32).fill(7);
  const baseKey = await webcrypto.subtle.importKey('raw', key, 'HKDF', false, ['deriveBits']);
  const expanded = new Uint8Array(await webcrypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: new TextEncoder().encode('WhatsApp Audio Keys') }, baseKey, 896));
  const iv = expanded.slice(0, 16);
  const aes = await webcrypto.subtle.importKey('raw', expanded.slice(16, 48), 'AES-CBC', false, ['encrypt']);
  const plain = validOgg();
  const ciphertext = new Uint8Array(await webcrypto.subtle.encrypt({ name: 'AES-CBC', iv }, aes, plain));
  const signed = new Uint8Array(16 + ciphertext.length); signed.set(iv); signed.set(ciphertext, 16);
  const hmac = await webcrypto.subtle.importKey('raw', expanded.slice(48, 80), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await webcrypto.subtle.sign('HMAC', hmac, signed));
  const encrypted = new Uint8Array(ciphertext.length + 10); encrypted.set(ciphertext); encrypted.set(mac.slice(0, 10), ciphertext.length);
  assert.deepEqual(await media.decryptAudio(encrypted.buffer, key), plain);
  encrypted[encrypted.length - 1] ^= 1;
  await assert.rejects(media.decryptAudio(encrypted.buffer, key), /Autenticação/);
});

async function collect(raw, badCache = false, extraOptions = {}) {
  const db = { objectStoreNames: ['message', 'chat', 'contact'], close() {}, transaction(name, mode) {
    assert.equal(mode, 'readonly');
    return { objectStore() { return { getAll() { const req = {}; queueMicrotask(() => { req.result = name === 'message' ? [raw] : []; req.onsuccess(); }); return req; } }; } };
  } };
  const sandbox = { window: {}, location: { origin: 'https://web.whatsapp.com' }, console: { info() {}, table() {} }, Intl, Date, Uint8Array, ArrayBuffer, Blob,
    indexedDB: { open() { const req = {}; queueMicrotask(() => { req.result = db; req.onsuccess(); }); return req; }, async databases() { return []; } },
    caches: { async keys() { return badCache ? ['test'] : []; }, async open() { return { async keys() { return [{ url: 'https://web.whatsapp.com/sampleHash' }]; }, async match() { return { ok: true, async arrayBuffer() { return new Uint8Array([1, 2, 3]).buffer; } }; } }; } }
  };
  sandbox.window.MonadaWaPocCore = core; sandbox.window.MonadaWaPocMedia = media;
  vm.runInNewContext(read('devtools-collector.js'), sandbox);
  return sandbox.window.__MONADA_WA_POC__.run({ dates: ['2026-11-18'], autoDownloadJson: false, extensionVersion: '0.1.9', ...extraOptions });
}

test('integração com transcrição desligada não lê cache nem recupera arquivos de áudio', async () => {
  const report = await collect({ ...base, type: 'ptt', filehash: 'sampleHash' }, true, { collectAudio: false, allowExplicitMediaDownload: true });
  assert.equal(report.dependenciesUsed.includes('browser:cache-storage'), false);
  assert.equal(report.days[0].audioRecovery.recoveredTotal, 0);
  assert.equal(report.days[0].audioRecovery.totalAudiosFoundLocally, 1);
});

test('coletor real usa núcleo compartilhado e não valida texto vazio nem cache de três bytes', async () => {
  const textReport = await collect(base);
  assert.equal(textReport.days[0].collection.collected, false);
  assert.equal(textReport.days[0].audioRecovery.wouldBeReadyUnderBlockingRule, false);
  assert.equal(textReport.extensionVersion, '0.1.9');
  const audioReport = await collect({ ...base, type: 'ptt', filehash: 'sampleHash' }, true);
  const audio = audioReport.days[0].conversations[0].messages[0].audio;
  assert.notEqual(audio.status, 'recovered');
  assert.equal(audioReport.days[0].collection.collected, false);
});

test('comparação recusa equivalência de versões/opções diferentes e não oculta perda de texto já editado', () => {
  const message = { id: 'm1', type: 'chat', text: 'Original', isEdited: true };
  const report = { schemaVersion: 2, extensionVersion: '0.1.9', collectionOptions: { useMainWorld: true, allowExplicitMediaDownload: true }, targetDates: ['2026-11-18'], days: [{ date: '2026-11-18', conversations: [{ messages: [message] }] }] };
  const copy = structuredClone(report);
  assert.equal(core.compareRounds(report, copy).configurationCompatible, true);
  copy.extensionVersion = '0.1.8';
  assert.equal(core.compareRounds(report, copy).perDate[0].consistentMessages, false);
  copy.extensionVersion = '0.1.9'; copy.days[0].conversations[0].messages[0].text = '';
  assert.equal(core.compareRounds(report, copy).perDate[0].collectionInconsistencies.length, 1);
  assert.equal(core.compareRounds(report, { ...copy, extensionVersion: undefined }).configurationCompatible, false);
});

test('ponte MAIN real hidrata textos e não aceita mídia inválida retornada pelo download nativo', async () => {
  const item = { id: base.id, body: 'Texto de teste', type: 'ptt', filehash: 'hash', async downloadMedia() { return new Uint8Array([1, 2, 3]); } };
  const collection = { get() { return null; }, async getMessagesById() { return [item]; } };
  const sandbox = { window: { MonadaWaPocMedia: media, require(name) { return name === 'WAWebMsgCollection' ? { MsgCollection: collection } : null; } }, Uint8Array, ArrayBuffer, Blob, AbortSignal, setTimeout, clearTimeout };
  vm.runInNewContext(read('main-world-bridge.js'), sandbox);
  const result = await sandbox.window.__MONADA_WA_POC_MAIN__.resolveViaMainWorld({ messageIds: [base.id], audioIdsNeedingRecovery: [base.id], allowExplicitMediaDownload: true });
  assert.equal(result.textById[base.id].body, 'Texto de teste');
  assert.notEqual(result.audioById[base.id]?.status, 'recovered');
});

test('interface persistente bloqueia coletas simultâneas antes da injeção', async () => {
  const elements = new Map();
  const element = id => { if (!elements.has(id)) elements.set(id, { value: id === 'roundKey' ? 'round1' : '', checked: false, addEventListener(event, fn) { this[event] = fn; } }); return elements.get(id); };
  const pending = [];
  let injections = 0;
  const sandbox = { window: { MonadaWaPocCore: core, MonadaPocStorage: { async loadAllRounds() { return {}; } }, addEventListener() {} },
    document: { getElementById: element, querySelector() { return null; } },
    localStorage: { getItem() { return null; }, setItem() {} },
    navigator: { locks: { request(name, options, fn) { assert.equal(options.ifAvailable, true); const p = fn(null); pending.push(p); return p; } } },
    chrome: { runtime: { getManifest() { return { version: '0.1.9' }; } }, scripting: { executeScript() { injections++; } } }
  };
  vm.runInNewContext(read('popup.js'), sandbox);
  element('collectBtn').click(); await Promise.all(pending);
  assert.equal(injections, 0);
  assert.match(element('statusBox').textContent, /outra aba/);
  assert.match(read('launcher.js'), /collection\.html/);
});

test('orquestração real salva textos e validação de mídia com versão e opções após MAIN', async () => {
  const elements = new Map();
  const element = id => { if (!elements.has(id)) elements.set(id, { value: id === 'roundKey' ? 'round1' : '', checked: id === 'useMainWorld' || id === 'allowDownload', addEventListener(event, fn) { this[event] = fn; } }); return elements.get(id); };
  let finished;
  const done = new Promise(resolve => { finished = resolve; });
  let saved;
  let calls = 0;
  const report = await collect({ ...base, type: 'ptt' });
  const message = report.days[0].conversations[0].messages[0];
  const sandbox = { window: { MonadaWaPocCore: core, MonadaPocStorage: { async loadAllRounds() { return {}; }, async saveRound(key, value) { assert.equal(key, 'round1'); saved = value; } }, addEventListener() {} },
    document: { getElementById: element, querySelector() { return null; } }, localStorage: { getItem() { return null; }, setItem() {} },
    navigator: { locks: { async request(name, options, fn) { try { await fn({}); } finally { finished(); } } } },
    chrome: { runtime: { getManifest() { return { version: '0.1.9' }; } }, tabs: { async query() { return [{ id: 1, url: 'https://web.whatsapp.com/' }]; } }, scripting: { async executeScript(options) {
      calls++;
      if (calls === 1) { assert.deepEqual(Array.from(options.files), ['lib/poc-core.js', 'lib/poc-media.js', 'devtools-collector.js']); return []; }
      if (calls === 2) { assert.equal(options.args[0].extensionVersion, '0.1.9'); assert.equal(options.args[0].useMainWorld, true); return [{ result: report }]; }
      if (calls === 3) { assert.equal(options.world, 'MAIN'); return []; }
      return [{ result: { textById: {}, audioById: { [message.id]: { status: 'recovered', source: 'explicit-whatsapp-download', validation: 'decoded', byteLength: 4, dataUrl: 'data:audio/ogg;base64,T2dnUw==' } }, dependenciesUsed: ['main-world:Msg.downloadMedia'] } }];
    } } }
  };
  vm.runInNewContext(read('popup.js'), sandbox);
  element('collectBtn').click(); await done;
  assert.equal(calls, 4);
  assert.equal(saved.days[0].collection.collected, true);
  assert.equal(saved.days[0].collection.summaryReady, false);
  assert.equal(saved.days[0].conversations[0].messages[0].audio.validation, 'decoded');
  assert.equal(saved.days[0].audioRecovery.wouldBeReadyUnderBlockingRule, false);
});
