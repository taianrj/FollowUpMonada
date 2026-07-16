'use strict';

const crypto = require('node:crypto');
const test = require('node:test');
const assert = require('node:assert/strict');

const serviceSecret = 'segredo-de-teste-com-pelo-menos-32-caracteres';
process.env.WHATSAPP_SERVICE_SECRET = serviceSecret;

const { app } = require('../server');

const userId = '00000000-0000-4000-8000-000000000001';
let server;
let baseUrl;

function signedHeaders(pathAndQuery, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const body = options.body || '';
  const timestamp = options.timestamp ?? Date.now();
  const nonce = options.nonce || crypto.randomUUID();
  const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
  const canonicalRequest = [
    'v1',
    String(timestamp),
    nonce,
    userId,
    method,
    pathAndQuery,
    bodyHash
  ].join('\n');
  const signature = crypto.createHmac('sha256', serviceSecret)
    .update(canonicalRequest)
    .digest('hex');

  return {
    'x-api-key': userId,
    'x-service-timestamp': String(timestamp),
    'x-service-nonce': nonce,
    'x-service-body-sha256': bodyHash,
    'x-service-signature': signature,
    ...(options.contentType ? { 'content-type': options.contentType } : {})
  };
}

test.before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

test('healthz responde sem autenticar e sem expor quantidade de sessoes', async () => {
  const response = await fetch(`${baseUrl}/healthz`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.service, 'whatsapp-service');
  assert.equal('activeInstances' in body, false);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('rota protegida rejeita requisicao sem assinatura', async () => {
  const response = await fetch(`${baseUrl}/status`);
  assert.equal(response.status, 401);
});

test('rejeita credenciais legadas em query string ou token bruto em header', async () => {
  const queryResponse = await fetch(
    `${baseUrl}/status?key=${userId}&service_token=${encodeURIComponent(serviceSecret)}`
  );
  assert.equal(queryResponse.status, 401);

  const headerResponse = await fetch(`${baseUrl}/status`, {
    headers: { 'x-api-key': userId, 'x-service-token': serviceSecret }
  });
  assert.equal(headerResponse.status, 401);
});

test('rejeita assinatura vencida, corpo adulterado e replay de nonce', async () => {
  const stale = await fetch(`${baseUrl}/status`, {
    headers: signedHeaders('/status', { timestamp: Date.now() - 61_000 })
  });
  assert.equal(stale.status, 401);

  const signedBody = '{}';
  const tamperedBody = JSON.stringify({ transcribe_audio: true });
  const tampered = await fetch(`${baseUrl}/settings`, {
    method: 'POST',
    headers: signedHeaders('/settings', {
      method: 'POST',
      body: signedBody,
      contentType: 'application/json'
    }),
    body: tamperedBody
  });
  assert.equal(tampered.status, 401);

  const replayPath = '/messages?date=2026-02-30';
  const replayHeaders = signedHeaders(replayPath);
  const first = await fetch(`${baseUrl}${replayPath}`, { headers: replayHeaders });
  assert.equal(first.status, 400);
  const second = await fetch(`${baseUrl}${replayPath}`, { headers: replayHeaders });
  assert.equal(second.status, 401);
});

test('CORS rejeita origem externa e aceita localhost', async () => {
  const denied = await fetch(`${baseUrl}/healthz`, { headers: { Origin: 'https://evil.example' } });
  assert.equal(denied.status, 403);
  const allowed = await fetch(`${baseUrl}/healthz`, { headers: { Origin: 'http://localhost:3000' } });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'http://localhost:3000');
});

test('rotas legadas do navegador e GETs destrutivos permanecem indisponiveis', async () => {
  assert.equal((await fetch(`${baseUrl}/`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/qr`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/logout`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/maintenance/resync`)).status, 404);
});

test('mensagens rejeitam data de calendario invalida antes de acessar dados', async () => {
  const path = '/messages?date=2026-02-30';
  const response = await fetch(`${baseUrl}${path}`, { headers: signedHeaders(path) });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /Data invalida/);
});

test('settings rejeita payload vazio e tipos ambiguos', async () => {
  const emptyBody = '{}';
  const empty = await fetch(`${baseUrl}/settings`, {
    method: 'POST',
    headers: signedHeaders('/settings', {
      method: 'POST',
      body: emptyBody,
      contentType: 'application/json'
    }),
    body: emptyBody
  });
  assert.equal(empty.status, 400);

  const ambiguousBody = JSON.stringify({ transcribe_audio: 'false' });
  const stringBoolean = await fetch(`${baseUrl}/settings`, {
    method: 'POST',
    headers: signedHeaders('/settings', {
      method: 'POST',
      body: ambiguousBody,
      contentType: 'application/json'
    }),
    body: ambiguousBody
  });
  assert.equal(stringBoolean.status, 400);
});
