'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('./lib/poc-core');

test('calcula datas encerradas padrão em America/Sao_Paulo sem incluir o dia atual', () => {
  const fixedNow = Date.parse('2026-11-19T15:00:00Z'); // 12:00 em São Paulo
  assert.deepEqual(core.defaultClosedDates(fixedNow), [
    '2026-11-18',
    '2026-11-17',
    '2026-11-12',
    '2026-11-04'
  ]);
});

test('normaliza mensagens do IndexedDB, ignora status@broadcast e nunca exporta chaves de mídia', () => {
  const result = core.normalizeIndexedDbSnapshot({
    targetDates: ['2026-11-18'],
    rawChats: [
      { id: '5511999990000@c.us', name: 'Cliente Alfa' },
      { id: '1203630001@g.us', name: 'Grupo Projeto' }
    ],
    rawContacts: [
      { id: '5511888880000@c.us', name: 'Maria' }
    ],
    rawMessages: [
      {
        id: 'status_1',
        from: 'status@broadcast',
        to: '5511000000000@c.us',
        t: Math.floor(Date.parse('2026-11-18T13:00:00Z') / 1000),
        type: 'chat',
        body: 'Story que não deve aparecer'
      },
      {
        id: 'true_5511999990000@c.us_MSG1',
        fromMe: true,
        to: '5511999990000@c.us',
        t: Math.floor(Date.parse('2026-11-18T14:00:00Z') / 1000),
        type: 'chat',
        body: 'Bom dia! Segue o retorno.'
      },
      {
        id: 'true_5511999990000@c.us_EDIT_EVENT',
        fromMe: true,
        to: '5511999990000@c.us',
        t: Math.floor(Date.parse('2026-11-18T14:01:00Z') / 1000),
        type: 'message_edit_encrypted',
        body: ''
      },
      {
        id: 'false_1203630001@g.us_AUDIO1',
        fromMe: false,
        from: '1203630001@g.us',
        author: '5511888880000@c.us',
        t: Math.floor(Date.parse('2026-11-18T15:30:00Z') / 1000),
        type: 'ptt',
        duration: 18,
        mimetype: 'audio/ogg; codecs=opus',
        mediaKey: 'SEGREDO_NAO_EXPORTAR',
        directPath: '/v/t62.7117-24/secreto',
        encFilehash: 'HASH_NAO_EXPORTAR'
      }
    ],
    audioResultsByMessageId: new Map([
      [
        'false_1203630001@g.us_AUDIO1',
        {
          status: 'failed',
          source: 'none',
          dependency: 'explicit-whatsapp-cdn-download',
          reason: 'HTTP 410 - mídia expirada',
          byteLength: 0,
          dataUrl: null
        }
      ]
    ])
  });

  assert.equal(result.ignoredStatusCount, 1);
  assert.equal(result.ignoredProtocolEventsCount, 1);
  assert.equal(result.days.length, 1);

  const day = result.days[0];
  assert.equal(day.messageCoverage.conversationCount, 2);
  assert.equal(day.messageCoverage.messageCount, 2);
  assert.equal(day.audioRecovery.totalAudiosFoundLocally, 1);
  assert.equal(day.audioRecovery.failedCount, 1);
  assert.equal(day.audioRecovery.wouldBeReadyUnderBlockingRule, false);
  assert.match(day.audioRecovery.blockingReason, /bloqueado/i);

  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('SEGREDO_NAO_EXPORTAR'), false);
  assert.equal(serialized.includes('/v/t62.7117-24/secreto'), false);
  assert.equal(serialized.includes('HASH_NAO_EXPORTAR'), false);
  assert.equal(serialized.includes('Story que não deve aparecer'), false);
});

test('compara rodadas diferenciando mudança real (mensagem apagada/editada) de inconsistência de coleta', () => {
  const baseDay = {
    date: '2026-11-18',
    messageCoverage: { messageCount: 2, duplicateIdsDetected: [] },
    audioRecovery: { totalAudiosFoundLocally: 1, recoveredTotal: 1 },
    conversations: [
      {
        chatJid: '5511@c.us',
        chatName: 'Cliente',
        messages: [
          {
            id: 'm1',
            chatJid: '5511@c.us',
            chatName: 'Cliente',
            time: '10:00:00',
            timestampMs: 1000,
            fromMe: false,
            senderName: 'Cliente',
            text: 'Texto original',
            isEdited: false,
            isRevoked: false,
            audio: null
          },
          {
            id: 'm2',
            chatJid: '5511@c.us',
            chatName: 'Cliente',
            time: '10:05:00',
            timestampMs: 2000,
            fromMe: false,
            senderName: 'Cliente',
            text: '[Áudio]',
            isEdited: false,
            isRevoked: false,
            audio: { status: 'recovered', source: 'local-cache' }
          }
        ]
      }
    ]
  };

  const nextDay = {
    date: '2026-11-18',
    messageCoverage: { messageCount: 2, duplicateIdsDetected: [] },
    audioRecovery: { totalAudiosFoundLocally: 1, recoveredTotal: 0 },
    conversations: [
      {
        chatJid: '5511@c.us',
        chatName: 'Cliente',
        messages: [
          {
            id: 'm1',
            chatJid: '5511@c.us',
            chatName: 'Cliente',
            time: '10:00:00',
            timestampMs: 1000,
            fromMe: false,
            senderName: 'Cliente',
            text: '[Mensagem apagada]',
            isEdited: false,
            isRevoked: true,
            audio: null
          },
          {
            id: 'm2',
            chatJid: '5511@c.us',
            chatName: 'Cliente',
            time: '10:05:00',
            timestampMs: 2000,
            fromMe: false,
            senderName: 'Cliente',
            text: '[Áudio]',
            isEdited: false,
            isRevoked: false,
            audio: { status: 'failed', source: 'none' }
          }
        ]
      }
    ]
  };

  const comparison = core.compareRounds(
    { schemaVersion: 2, extensionVersion: '0.1.9', collectionOptions: { useMainWorld: true, allowExplicitMediaDownload: true }, targetDates: ['2026-11-18'], roundLabel: 'Rodada 1', days: [baseDay] },
    { schemaVersion: 2, extensionVersion: '0.1.9', collectionOptions: { useMainWorld: true, allowExplicitMediaDownload: true }, targetDates: ['2026-11-18'], roundLabel: 'Rodada 2', days: [nextDay] }
  );

  assert.equal(comparison.perDate.length, 1);
  const row = comparison.perDate[0];
  assert.equal(row.realMessageChanges.length, 1);
  assert.equal(row.realMessageChanges[0].changeType, 'apagada');
  assert.equal(row.collectionInconsistencies.length, 0);
  assert.equal(row.consistentMessages, true);
  assert.equal(row.audioStatusChanges.length, 1);
});

test('manifesto MV3 usa permissões mínimas e páginas não possuem script inline', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ['activeTab', 'scripting']);
  assert.deepEqual(manifest.host_permissions, [
    'https://web.whatsapp.com/*',
    'https://mmg.whatsapp.net/*'
  ]);

  const popupHtml = fs.readFileSync(path.join(__dirname, 'popup.html'), 'utf8');
  const viewerHtml = fs.readFileSync(path.join(__dirname, 'viewer.html'), 'utf8');
  for (const html of [popupHtml, viewerHtml, fs.readFileSync(path.join(__dirname, 'collection.html'), 'utf8')]) {
    const scripts = Array.from(html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi));
    assert.ok(scripts.length > 0);
    for (const [, attrs, body] of scripts) {
      assert.match(attrs, /\bsrc=["'][^"']+["']/i);
      assert.equal(body.trim(), '');
    }
  }
});
