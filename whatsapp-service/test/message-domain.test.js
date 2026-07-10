'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const domain = require('../lib/message-domain');

test('normaliza JIDs de dispositivos sem misturar servidores', () => {
  assert.equal(domain.cleanJid('5521983088576:89@S.WHATSAPP.NET'), '5521983088576@s.whatsapp.net');
  assert.equal(domain.cleanJid('191684541415573:4@lid'), '191684541415573@lid');
  assert.deepEqual(
    domain.uniqueJids(['1:2@s.whatsapp.net', '1@s.whatsapp.net', '', null]),
    ['1@s.whatsapp.net']
  );
});

test('extrai aliases PN/LID dos campos do Baileys 7', () => {
  const message = {
    key: {
      remoteJid: '217033371341000@lid',
      remoteJidAlt: '5521999999999@s.whatsapp.net',
      participant: '30726296715288@lid',
      participantAlt: '5521988888888@s.whatsapp.net',
      senderPn: '5521977777777@s.whatsapp.net'
    }
  };

  assert.deepEqual(domain.messageChatAliases(message), [
    '217033371341000@lid',
    '5521999999999@s.whatsapp.net'
  ]);
  assert.deepEqual(domain.messageParticipantAliases(message), [
    '30726296715288@lid',
    '5521988888888@s.whatsapp.net',
    '5521977777777@s.whatsapp.net'
  ]);
});

test('identifica status do WhatsApp antes que o participante pareça uma conversa direta', () => {
  const receivedStatus = {
    key: {
      remoteJid: 'status@broadcast',
      participant: '30726296715288@lid',
      participantAlt: '5521988888888@s.whatsapp.net',
      fromMe: false
    }
  };
  const sentStatus = {
    key: {
      remoteJid: 'status@broadcast',
      remoteJidAlt: '5521983088576@s.whatsapp.net',
      fromMe: true
    }
  };

  assert.equal(domain.isStatusBroadcastMessage(receivedStatus), true);
  assert.equal(domain.isStatusBroadcastMessage(sentStatus), true);
  assert.equal(domain.isStatusBroadcastMessage({
    key: { remoteJid: '12345@broadcast', participant: '5521988888888@s.whatsapp.net' }
  }), false);
  assert.equal(domain.isStatusBroadcastMessage({
    key: { remoteJid: '5521988888888@s.whatsapp.net' }
  }), false);

  const route = domain.resolveMessageRoute(receivedStatus);
  assert.equal(route.chatJid, 'status@broadcast');
  assert.equal(route.routingStatus, 'ignored-status');
  assert.equal(route.participantJid, '5521988888888@s.whatsapp.net');
});

test('reconhece status legado salvo como conversa pelo alias broadcast preservado', () => {
  assert.equal(domain.isStoredStatusMessage({
    chatJid: '5521988888888@s.whatsapp.net',
    chatAliases: ['status@broadcast', '5521988888888@s.whatsapp.net'],
    routingStatus: 'resolved'
  }), true);
  assert.equal(domain.isStoredStatusMessage({
    chatJid: '5521988888888@s.whatsapp.net',
    chatAliases: ['30726296715288@lid', '5521988888888@s.whatsapp.net'],
    routingStatus: 'resolved'
  }), false);
});

test('prioriza o interlocutor alternativo quando remoteJid aponta para o dono', () => {
  const route = domain.resolveMessageRoute({
    key: {
      remoteJid: '5521983088576@s.whatsapp.net',
      remoteJidAlt: '4915165158984@s.whatsapp.net',
      fromMe: false
    }
  }, {
    ownerJids: ['5521983088576@s.whatsapp.net', '191684541415573@lid']
  });

  assert.equal(route.chatJid, '4915165158984@s.whatsapp.net');
  assert.equal(route.participantJid, '4915165158984@s.whatsapp.net');
  assert.equal(route.routingStatus, 'resolved-alt');
  assert.equal(route.routingIssue, '');
});

test('mantem as duas identidades de um chat direto e escolhe PN canonico', () => {
  const route = domain.resolveMessageRoute({
    key: {
      remoteJid: '217033371341000@lid',
      remoteJidAlt: '5521999999999@s.whatsapp.net',
      fromMe: false
    }
  }, { ownerJids: ['5521983088576@s.whatsapp.net'] });

  assert.equal(route.chatJid, '5521999999999@s.whatsapp.net');
  assert.deepEqual(route.chatAliases, [
    '217033371341000@lid',
    '5521999999999@s.whatsapp.net'
  ]);
});

test('atribui o dono como participante de mensagem direta enviada', () => {
  const route = domain.resolveMessageRoute({
    key: { remoteJid: '5521972504651@s.whatsapp.net', fromMe: true }
  }, {
    ownerJids: ['5521983088576@s.whatsapp.net', '191684541415573@lid']
  });

  assert.equal(route.chatJid, '5521972504651@s.whatsapp.net');
  assert.equal(route.participantJid, '5521983088576@s.whatsapp.net');
  assert.equal(route.fromMe, true);
});

test('preserva grupo e aliases do participante', () => {
  const route = domain.resolveMessageRoute({
    key: {
      remoteJid: '120363022443116382@g.us',
      participant: '30726296715288@lid',
      participantAlt: '5521988888888@s.whatsapp.net',
      fromMe: false
    }
  }, { ownerJids: ['5521983088576@s.whatsapp.net'] });

  assert.equal(route.chatJid, '120363022443116382@g.us');
  assert.equal(route.participantJid, '5521988888888@s.whatsapp.net');
  assert.equal(route.routingStatus, 'resolved');
});

test('marca como ambigua a assinatura observada em producao', () => {
  const route = domain.resolveMessageRoute({
    key: {
      remoteJid: '5521983088576@s.whatsapp.net',
      participant: '5521983088576@s.whatsapp.net',
      senderLid: '191684541415573@lid',
      fromMe: false
    }
  }, {
    ownerJids: ['5521983088576@s.whatsapp.net', '191684541415573@lid']
  });

  assert.equal(route.routingStatus, 'ambiguous-self');
  assert.equal(route.chatJid, '5521983088576@s.whatsapp.net');
  assert.match(route.routingIssue, /dono da conta/);
  assert.equal(domain.isAmbiguousOwnerMessage({ ...route }, [
    '5521983088576@s.whatsapp.net',
    '191684541415573@lid'
  ]), true);
});

test('deduplica por ID mesmo quando o WhatsApp corrige o chat', () => {
  const first = { id: 'ABC', chatJid: '5521983088576@s.whatsapp.net', routingStatus: 'ambiguous-self' };
  const corrected = { id: 'ABC', chatJid: '4915165158984@s.whatsapp.net', routingStatus: 'resolved-alt' };
  assert.equal(domain.messageIdentityKey(first), domain.messageIdentityKey(corrected));
  assert.equal(domain.preferMessageRoute(first, corrected), corrected);
});

test('nao usa nome de contato como identidade da conversa', () => {
  assert.equal(
    domain.conversationAliasKey({ chatJid: '111@s.whatsapp.net', chatName: 'Arthur' }),
    '111@s.whatsapp.net'
  );
  assert.notEqual(
    domain.conversationAliasKey({ chatJid: '111@s.whatsapp.net', chatName: 'Arthur' }),
    domain.conversationAliasKey({ chatJid: '222@s.whatsapp.net', chatName: 'Arthur' })
  );
});

test('valida datas reais e calcula o dia em Sao Paulo', () => {
  assert.equal(domain.isValidDate('2026-02-28'), true);
  assert.equal(domain.isValidDate('2026-02-30'), false);
  assert.equal(domain.isValidDate('09/07/2026'), false);
  assert.equal(domain.dateInTimeZone('2026-07-10T02:30:00.000Z'), '2026-07-09');
});
