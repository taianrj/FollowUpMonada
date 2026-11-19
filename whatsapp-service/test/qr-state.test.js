'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildQrCodeResponse } = require('../lib/qr-state');

test('retorna connected quando a instância já está conectada', () => {
  assert.deepEqual(
    buildQrCodeResponse({ connectionStatus: 'connected', lastDisconnectCode: 401 }),
    { status: 'connected' }
  );
});

test('retorna qrcode com imagem quando o QR está disponível', () => {
  assert.deepEqual(
    buildQrCodeResponse(
      { connectionStatus: 'qrcode' },
      { qrCodeImage: 'data:image/png;base64,abc' }
    ),
    { status: 'qrcode', qrCode: 'data:image/png;base64,abc' }
  );
});

test('exige recuperação explícita quando a sessão foi encerrada com loggedOut (401)', () => {
  const result = buildQrCodeResponse({
    connectionStatus: 'disconnected',
    lastDisconnectCode: 401,
    lastDisconnectError: 'Connection Failure'
  });

  assert.equal(result.status, 'pairing_reset_required');
  assert.equal(result.reason, 'logged_out');
  assert.equal(result.disconnectCode, 401);
  assert.equal(result.detail, 'Connection Failure');
  assert.match(result.message, /preservados/i);
});

test('retorna disconnected com diagnóstico quando a instância parou sem loggedOut', () => {
  const result = buildQrCodeResponse({
    connectionStatus: 'disconnected',
    lastDisconnectCode: 428,
    lastDisconnectError: 'Connection Closed'
  });

  assert.equal(result.status, 'disconnected');
  assert.equal(result.reason, 'disconnected');
  assert.equal(result.disconnectCode, 428);
  assert.equal(result.detail, 'Connection Closed');
});

test('retorna waiting com diagnóstico opcional enquanto conecta sem QR', () => {
  assert.deepEqual(
    buildQrCodeResponse({
      connectionStatus: 'connecting',
      lastDisconnectCode: 515,
      lastDisconnectError: 'Stream Errored'
    }),
    {
      status: 'waiting',
      disconnectCode: 515,
      detail: 'Stream Errored'
    }
  );
});

test('novo pareamento pula restauracao remota de credenciais antigas no server.js', () => {
  const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(serverSource, /async function connectUserWhatsApp\(userId, \{ freshPairing = false \} = \{\}\)/);
  assert.match(serverSource, /if \(freshPairing\) \{\s*fs\.rmSync\(userAuthDir/);
  assert.match(serverSource, /connectUserWhatsApp\(cleanUserId, \{ freshPairing: resetCredentials \}\)/);
});
