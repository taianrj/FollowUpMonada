'use strict';

const fs = require('node:fs');
const test = require('node:test');
const assert = require('node:assert/strict');
const { app } = require('../server');

const serviceSecret = fs.readFileSync(new URL('../.env', `file://${__filename.replace(/\\/g, '/')}`), 'utf8')
  .split(/\r?\n/)
  .find(line => line.startsWith('WHATSAPP_SERVICE_SECRET='))
  ?.split('=').slice(1).join('=').trim();
const userId = '00000000-0000-4000-8000-000000000001';
let server;
let baseUrl;

test.before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

test('healthz responde sem autenticar e sem criar socket', async () => {
  const response = await fetch(`${baseUrl}/healthz`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.service, 'whatsapp-service');
});

test('rota protegida rejeita requisicao sem chaves', async () => {
  const response = await fetch(`${baseUrl}/status`);
  assert.equal(response.status, 401);
});

test('CORS rejeita origem externa e aceita localhost', async () => {
  const denied = await fetch(`${baseUrl}/healthz`, { headers: { Origin: 'https://evil.example' } });
  assert.equal(denied.status, 403);
  const allowed = await fetch(`${baseUrl}/healthz`, { headers: { Origin: 'http://localhost:3000' } });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'http://localhost:3000');
});

test('logout destrutivo nao aceita GET', async () => {
  const response = await fetch(`${baseUrl}/logout`, {
    headers: { 'x-api-key': userId, 'x-service-token': serviceSecret }
  });
  assert.equal(response.status, 404);
});

test('mensagens rejeitam data de calendario invalida antes de acessar dados', async () => {
  const response = await fetch(`${baseUrl}/messages?date=2026-02-30`, {
    headers: { 'x-api-key': userId, 'x-service-token': serviceSecret }
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /Data invalida/);
});

test('settings rejeita payload vazio e tipos ambiguos', async () => {
  const headers = {
    'content-type': 'application/json',
    'x-api-key': userId,
    'x-service-token': serviceSecret
  };
  const empty = await fetch(`${baseUrl}/settings`, { method: 'POST', headers, body: '{}' });
  assert.equal(empty.status, 400);
  const stringBoolean = await fetch(`${baseUrl}/settings`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ transcribe_audio: 'false' })
  });
  assert.equal(stringBoolean.status, 400);
});
