'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { __test: service } = require('../server');

const ownerPn = '5521983088576@s.whatsapp.net';
const ownerLid = '191684541415573@lid';

function stored(overrides = {}) {
  return {
    id: 'MSG-1',
    chatJid: '5521972504651@s.whatsapp.net',
    chatAliases: ['5521972504651@s.whatsapp.net'],
    participantJid: '5521972504651@s.whatsapp.net',
    participantAliases: ['5521972504651@s.whatsapp.net'],
    sender: '5521972504651',
    participant: '5521972504651',
    chatName: 'Caio',
    name: 'Caio',
    text: 'Oi',
    fromMe: false,
    routingStatus: 'resolved',
    timestamp: '2026-07-09T11:00:00.000Z',
    ...overrides
  };
}

test('normaliza booleanos persistidos sem transformar "false" em true', () => {
  assert.equal(service.normalizeStoredMessage(stored({ fromMe: 'false' })).fromMe, false);
  assert.equal(service.normalizeStoredMessage(stored({ fromMe: 'true' })).fromMe, true);
  assert.equal(service.normalizeBoolean('1'), true);
  assert.equal(service.normalizeBoolean('no'), false);
});

test('usa uma chave canonica baseada no ID da mensagem', () => {
  assert.equal(service.createDedupeKey(stored()), 'id:MSG-1');
  assert.equal(service.normalizeStoredMessage(stored()).dedupeKey, 'id:MSG-1');
});

test('ressincronizacao substitui rota ambigua pela rota corrigida sem duplicar', () => {
  const broken = stored({
    chatJid: ownerPn,
    chatAliases: [ownerPn, ownerLid],
    participantJid: ownerPn,
    participantAliases: [ownerPn, ownerLid],
    sender: '5521983088576',
    participant: '5521983088576',
    chatName: 'Taian Monsores',
    name: 'Taian Monsores',
    routingStatus: 'ambiguous-self'
  });
  const corrected = stored({
    chatJid: '4915165158984@s.whatsapp.net',
    chatAliases: ['4915165158984@s.whatsapp.net', '203216780316843@lid'],
    participantJid: '4915165158984@s.whatsapp.net',
    participantAliases: ['4915165158984@s.whatsapp.net', '203216780316843@lid'],
    sender: '4915165158984',
    participant: '4915165158984',
    chatName: 'Arthur Vidal',
    name: 'Arthur Vidal',
    text: 'Oi editado',
    routingStatus: 'resolved-alt'
  });

  const merged = service.mergeMessages([broken], [corrected]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].chatJid, '4915165158984@s.whatsapp.net');
  assert.equal(merged[0].chatName, 'Arthur Vidal');
  assert.equal(merged[0].text, 'Oi editado');
});

test('nao mistura duas pessoas diferentes que possuem o mesmo nome', () => {
  const conversations = service.buildMessageConversations([
    stored({ id: 'A', chatJid: '111@s.whatsapp.net', chatAliases: ['111@s.whatsapp.net'], sender: '111', chatName: 'Arthur' }),
    stored({ id: 'B', chatJid: '222@s.whatsapp.net', chatAliases: ['222@s.whatsapp.net'], sender: '222', participantJid: '222@s.whatsapp.net', chatName: 'Arthur' })
  ], {
    '111@s.whatsapp.net': 'Arthur',
    '222@s.whatsapp.net': 'Arthur'
  });

  assert.equal(conversations.length, 2);
  assert.deepEqual(conversations.map(chat => chat.chatKey).sort(), ['111', '222']);
});

test('reune as duas direcoes da conversa quando PN e LID foram persistidos separadamente', () => {
  const conversations = service.buildMessageConversations([
    stored({
      id: 'INCOMING',
      chatJid: '5521988377896@s.whatsapp.net',
      chatAliases: ['5521988377896@s.whatsapp.net'],
      participantJid: '5521988377896@s.whatsapp.net',
      participantAliases: ['5521988377896@s.whatsapp.net'],
      sender: '5521988377896',
      participant: '5521988377896',
      chatName: 'Naldo',
      name: 'Naldo',
      fromMe: false
    }),
    stored({
      id: 'OUTGOING',
      chatJid: '5521988377896@lid',
      chatAliases: ['5521988377896@lid'],
      participantJid: ownerPn,
      participantAliases: [ownerPn, ownerLid],
      sender: '5521988377896',
      participant: '5521983088576',
      chatName: 'Naldo',
      name: 'Taian Monsores',
      fromMe: true
    })
  ], {
    '5521988377896@s.whatsapp.net': 'Naldo',
    '5521988377896@lid': 'Naldo'
  }, ownerPn, ownerLid, 'Taian Monsores');

  assert.equal(conversations.length, 1);
  assert.equal(conversations[0].chatKey, '5521988377896');
  assert.deepEqual(conversations[0].messages.map(message => message.id), ['INCOMING', 'OUTGOING']);
  assert.deepEqual(conversations[0].messages.map(message => message.fromMe), [false, true]);
});

test('reune PN e LID de numeros diferentes usando o mapeamento oficial em cache', () => {
  const peerPn = '4915165158984@s.whatsapp.net';
  const peerLid = '203216780316843@lid';
  const conversations = service.buildMessageConversations([
    stored({ id: 'PN', chatJid: peerPn, chatAliases: [peerPn], sender: '4915165158984' }),
    stored({ id: 'LID', chatJid: peerLid, chatAliases: [peerLid], sender: '203216780316843', fromMe: true })
  ], {
    [peerPn]: 'Arthur Vidal',
    [peerLid]: 'Arthur Vidal'
  }, ownerPn, ownerLid, 'Taian Monsores', {
    [peerPn]: peerLid,
    [peerLid]: peerPn
  });

  assert.equal(conversations.length, 1);
  assert.equal(conversations[0].chatKey, '4915165158984');
  assert.deepEqual(conversations[0].chatAliases.sort(), [peerLid, peerPn].sort());
});

test('nao cria conversa para status legado salvo com alias status@broadcast', () => {
  const conversations = service.buildMessageConversations([
    stored({
      id: 'STATUS-1',
      chatAliases: ['status@broadcast', '5521972504651@s.whatsapp.net'],
      text: '[Imagem] atualização de status'
    }),
    stored({ id: 'DIRECT-1', text: 'mensagem direta legítima' })
  ], {});

  assert.equal(conversations.length, 1);
  assert.deepEqual(conversations[0].messages.map(message => message.id), ['DIRECT-1']);
});

test('quarentena a conversa corrompida de producao em vez de exibi-la como conversa propria', () => {
  const messages = [
    stored({
      id: 'IN-1',
      chatJid: ownerPn,
      chatAliases: [ownerPn, ownerLid],
      sender: '5521983088576',
      participantJid: ownerPn,
      participantAliases: [ownerPn, ownerLid],
      participant: '5521983088576',
      chatName: '5521983088576',
      name: '5521983088576',
      text: 'Bom diia',
      fromMe: false,
      routingStatus: 'legacy'
    }),
    stored({
      id: 'OUT-1',
      chatJid: ownerPn,
      chatAliases: [ownerPn, ownerLid],
      sender: '5521983088576',
      participantJid: ownerPn,
      participantAliases: [ownerPn, ownerLid],
      participant: '5521983088576',
      chatName: '5521983088576',
      name: 'Taian Monsores',
      text: 'bom diaa',
      fromMe: true,
      routingStatus: 'legacy'
    })
  ];

  const [conversation] = service.buildMessageConversations(
    messages,
    { [ownerPn]: 'Taian Monsores', [ownerLid]: 'Taian Monsores' },
    ownerPn,
    ownerLid,
    'Taian Monsores'
  );

  assert.equal(conversation.chatKey, 'nao-identificada');
  assert.equal(conversation.displayName, 'Conversa não identificada');
  assert.match(conversation.routingWarning, /ressincronização profunda/);
  assert.equal(conversation.messages[0].routingStatus, 'ambiguous-self');
});

test('mantem uma conversa legitima consigo mesmo quando nao existe contradicao', () => {
  const [conversation] = service.buildMessageConversations([
    stored({
      chatJid: ownerPn,
      chatAliases: [ownerPn, ownerLid],
      sender: '5521983088576',
      participantJid: ownerPn,
      participantAliases: [ownerPn, ownerLid],
      fromMe: true
    })
  ], {}, ownerPn, ownerLid, 'Taian Monsores');

  assert.equal(conversation.displayName, 'Taian Monsores');
  assert.equal(conversation.routingWarning, '');
});

test('ordena mensagens por horario e usa o ID como desempate', () => {
  const messages = [
    stored({ id: 'B', timestamp: '2026-07-09T12:00:00.000Z' }),
    stored({ id: 'C', timestamp: '2026-07-09T11:00:00.000Z' }),
    stored({ id: 'A', timestamp: '2026-07-09T12:00:00.000Z' })
  ].sort(service.compareMessagesChronologically);
  assert.deepEqual(messages.map(message => message.id), ['C', 'A', 'B']);
});

test('extrai textos de mensagens simples, encapsuladas, midia e interativas', () => {
  assert.equal(service.getMessageText({ message: { conversation: 'Olá' } }), 'Olá');
  assert.equal(service.getMessageText({ message: { ephemeralMessage: { message: { conversation: 'Efêmera' } } } }), 'Efêmera');
  assert.equal(service.getMessageText({
    message: { deviceSentMessage: { destinationJid: '1@s.whatsapp.net', message: { conversation: 'Outro aparelho' } } }
  }), 'Outro aparelho');
  assert.equal(service.getMessageText({ message: { imageMessage: { caption: 'Briefing' } } }), '[Imagem] Briefing');
  assert.equal(service.getMessageText({ message: { audioMessage: { mimetype: 'audio/ogg', seconds: 3 } } }), '[Áudio]');
  assert.equal(service.getMessageText({
    message: { interactiveResponseMessage: { nativeFlowResponseMessage: { paramsJson: '{"display_text":"Aprovado"}' } } }
  }), 'Aprovado');
});

test('extrai metadados de encaminhamento e resposta', () => {
  const metadata = service.getMessageContextMetadata({
    message: {
      extendedTextMessage: {
        text: 'Resposta',
        contextInfo: {
          isForwarded: true,
          forwardingScore: 2,
          stanzaId: 'QUOTED-1',
          participant: '5521972504651@s.whatsapp.net',
          quotedMessage: { conversation: 'Original' }
        }
      }
    }
  }, '120363022443116382@g.us');

  assert.deepEqual(metadata, {
    isForwarded: true,
    quotedMessageId: 'QUOTED-1',
    quotedMessageSender: '5521972504651@s.whatsapp.net',
    quotedMessageText: 'Original'
  });
});

test('preserva a versao mais informativa de texto de midia', () => {
  assert.equal(service.chooseBetterMessageText('[Áudio]', '[Áudio] Transcrição: teste'), '[Áudio] Transcrição: teste');
  assert.equal(service.chooseBetterMessageText('[Imagem]', 'Texto normal'), 'Texto normal');
});

test('interpreta respostas dos provedores de audio e visao', () => {
  assert.equal(service.extractTranscriptionText({ text: ' transcrição ' }), 'transcrição');
  assert.equal(service.extractTranscriptionText({ choices: [{ message: { content: 'groq' } }] }), 'groq');
  assert.equal(service.extractVisionResponseText({ candidates: [{ content: { parts: [{ text: 'imagem' }] } }] }), 'imagem');
  assert.match(service.formatImageInterpretationMessage('[Figurinha]', 'um gato', 'gemini'), /um gato/);
});

test('preserva buffers protobuf da fila de midia no formato BufferJSON do Baileys 7', () => {
  const payload = {
    rawMessage: {
      message: {
        audioMessage: {
          mediaKey: Buffer.from([1, 2, 3, 254]),
          fileSha256: new Uint8Array([9, 8, 7])
        }
      }
    }
  };

  const serialized = service.stringifyMediaState(payload);
  const restored = service.parseMediaState(serialized);
  assert.match(serialized, /"type":"Buffer","data":"/);
  assert.equal(Buffer.isBuffer(restored.rawMessage.message.audioMessage.mediaKey), true);
  assert.equal(Buffer.isBuffer(restored.rawMessage.message.audioMessage.fileSha256), true);
  assert.deepEqual([...restored.rawMessage.message.audioMessage.mediaKey], [1, 2, 3, 254]);
  assert.deepEqual([...restored.rawMessage.message.audioMessage.fileSha256], [9, 8, 7]);
});

test('aplica backoff de fila e distingue erros permanentes', () => {
  assert.equal(service.parseRetryDelayMs('retry after 12.5s'), 12500);
  assert.equal(service.shouldPauseMediaQueueForError('HTTP 429 rate limit'), true);
  assert.equal(service.isPermanentMediaError('media is missing from cache'), true);
  assert.equal(service.isPermanentMediaError('HTTP 503'), false);
  assert.ok(service.retryDelayMsForError('HTTP 503', 2) > 0);
  assert.ok(service.longTermRetryDelayMs(2) >= service.longTermRetryDelayMs(1));
});

test('formata texto e markdown com aviso de roteamento', () => {
  const conversations = [{
    chatKey: 'nao-identificada',
    displayName: 'Conversa não identificada',
    isGroup: false,
    routingWarning: 'Aguardando correção.',
    messages: [service.normalizeStoredMessage(stored())]
  }];
  const instance = { myPushName: 'Taian', myPushNameSource: 'profile', myJid: '5521983088576' };
  assert.match(service.formatMessagesAsText(conversations, {}, instance), /\[AVISO\] Aguardando correção/);
  assert.match(service.formatMessagesAsMarkdown(conversations, {}, instance, '2026-07-09'), /> Aguardando correção/);
});

test('diagnostico sinaliza rotas ambiguas e timestamps invalidos', () => {
  const integrity = service.analyzeMessagesIntegrity([
    stored({
      chatJid: ownerPn,
      participantJid: ownerPn,
      chatAliases: [ownerPn, ownerLid],
      participantAliases: [ownerPn, ownerLid],
      routingStatus: 'ambiguous-self',
      timestamp: 'invalido'
    })
  ], {}, [ownerPn, ownerLid]);
  assert.equal(integrity.ambiguousRoutes, 1);
  assert.equal(integrity.invalidTimestamps, 1);
  assert.equal(integrity.ok, false);
});

test('valida cookies e origens CORS', () => {
  assert.deepEqual(service.parseCookies('a=1; whatsapp_api_key=abc%20123'), {
    a: '1',
    whatsapp_api_key: 'abc 123'
  });
  assert.equal(service.isAllowedCorsOrigin('http://localhost:3000'), true);
  assert.equal(service.isAllowedCorsOrigin('https://evil.example'), false);
});
