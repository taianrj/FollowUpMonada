import test from 'node:test';
import assert from 'node:assert/strict';
import { requestInMonada, authenticatedTab } from '../../chrome-extension/session.mjs';
test('ponte autenticada usa destino fixo, recusa mudança de origem e descarta resposta após troca de usuário', async () => {
  const previousFetch = globalThis.fetch, previousLocation = globalThis.location, previousChrome = globalThis.chrome;
  try {
    globalThis.location = { origin: 'http://localhost:3000' };
    let posts = 0, reads = 0;
    globalThis.fetch = async (url, init) => {
      assert.equal(url, '/api/whatsapp-extension');
      if (init?.method === 'POST') { posts++; return Response.json({ text: 'Transcrição sintética' }); }
      reads++; return Response.json({ mode: 'chrome_extension', userId: reads > 1 ? 'other-user' : 'test-user' });
    };
    assert.equal((await requestInMonada('https://untrusted.example', null, {}, 'test-user')).ok, false);
    assert.equal(reads, 0);
    assert.equal((await requestInMonada('http://localhost:3000', 'transcribe', {}, 'test-user')).ok, false);
    assert.equal(posts, 1);
    globalThis.chrome = { tabs: { get: async () => ({ url: 'https://untrusted.example' }) } };
    await assert.rejects(authenticatedTab(1, 'http://localhost:3000'), /Abra o Mônada/);
  } finally { globalThis.fetch = previousFetch; globalThis.location = previousLocation; globalThis.chrome = previousChrome; }
});
