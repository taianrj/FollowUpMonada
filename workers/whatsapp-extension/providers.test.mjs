import test from 'node:test';
import assert from 'node:assert/strict';
import { transcribeAudio } from './providers.mjs';
const audio = new Uint8Array([79, 103, 103, 83]);
const gemini = () => Response.json({ candidates: [{ content: { parts: [{ text: 'Texto de fallback sintético' }] } }] });

test('Groq é prioritária, usa Turbo/português e envia multipart sem chamar Gemini ou OpenAI', async () => {
  const calls = [];
  const text = await transcribeAudio(audio, 'audio/ogg; codecs=opus', { GROQ_API_KEY: 'groq-test-key', GEMINI_API_KEY: 'gemini-test-key', OPENAI_API_KEY: 'openai-test-key' }, async (url, init) => {
    calls.push(url);
    assert.equal(init.headers.Authorization, 'Bearer groq-test-key');
    assert.equal(init.headers['Content-Type'], undefined);
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal(init.body.get('model'), 'whisper-large-v3-turbo');
    assert.equal(init.body.get('language'), 'pt');
    assert.equal(init.body.get('response_format'), 'json');
    const file = init.body.get('file');
    assert.equal(file.name, 'whatsapp-audio.ogg');
    assert.equal(file.type, 'audio/ogg');
    assert.deepEqual(new Uint8Array(await file.arrayBuffer()), audio);
    return Response.json({ text: '  Texto sintético  ' });
  });
  assert.equal(text, 'Texto sintético');
  assert.deepEqual(calls, ['https://api.groq.com/openai/v1/audio/transcriptions']);
});

test('falha HTTP, rede, JSON ou transcrição vazia da Groq usa Gemini sem reenviar a chave Groq', async () => {
  for (const failure of [() => new Response('private-provider-error', { status: 429 }), () => { throw new Error('private-network-error'); }, () => new Response('invalid-json'), () => Response.json({ text: '' })]) {
    const calls = [];
    const text = await transcribeAudio(audio, 'audio/ogg', { GROQ_API_KEY: 'groq-test-key', GEMINI_API_KEY: 'gemini-test-key' }, async (url, init) => {
      calls.push(url);
      if (calls.length === 1) return failure();
      assert.equal(init.headers['x-goog-api-key'], 'gemini-test-key');
      assert.equal(init.headers.Authorization, undefined);
      assert.ok(!url.includes('key='));
      return gemini();
    });
    assert.equal(text, 'Texto de fallback sintético');
    assert.equal(calls.length, 2);
    assert.match(calls[1], /generativelanguage\.googleapis\.com/);
  }
});

test('sem Groq usa OpenAI se configurada, ou Gemini quando é a única chave', async () => {
  const calls = [];
  assert.equal(await transcribeAudio(audio, 'audio/webm', { OPENAI_API_KEY: 'openai-test-key', GEMINI_API_KEY: 'gemini-test-key' }, async (url, init) => {
    calls.push(url); assert.equal(init.body.get('model'), 'whisper-1');
    return Response.json({ text: 'OpenAI sintético' });
  }), 'OpenAI sintético');
  assert.deepEqual(calls, ['https://api.openai.com/v1/audio/transcriptions']);
  assert.equal(await transcribeAudio(audio, 'audio/ogg', { GEMINI_API_KEY: 'gemini-test-key' }, async () => gemini()), 'Texto de fallback sintético');
  await assert.rejects(transcribeAudio(audio, 'audio/ogg', {}), /não configurado/);
});

test('permite configurar modelo/idioma e recusa entradas inválidas antes da rede', async () => {
  await transcribeAudio(audio, 'audio/ogg', { GROQ_API_KEY: 'test', GROQ_AUDIO_MODEL: 'whisper-large-v3', AUDIO_TRANSCRIPTION_LANGUAGE: 'es' }, async (_url, init) => {
    assert.equal(init.body.get('model'), 'whisper-large-v3'); assert.equal(init.body.get('language'), 'es'); return Response.json({ text: 'Texto sintético' });
  });
  const never = async () => { assert.fail('Não deve chamar a rede'); };
  for (const [bytes, mime, env] of [[audio, 'text/html', { GROQ_API_KEY: 'test' }], [new Uint8Array(), 'audio/ogg', {}], [audio, 'audio/ogg', { GROQ_API_KEY: 'test', GROQ_AUDIO_MODEL: '../invalid' }], [audio, 'audio/ogg', { GROQ_API_KEY: 'test', AUDIO_TRANSCRIPTION_LANGUAGE: 'pt-BR' }]]) await assert.rejects(transcribeAudio(bytes, mime, env, never));
});

test('falhas sem fallback não expõem corpo ou mensagens do provedor', async () => {
  await assert.rejects(transcribeAudio(audio, 'audio/ogg', { GROQ_API_KEY: 'private-key' }, async () => { throw new Error('private-key private-transcript'); }), error => {
    assert.doesNotMatch(error.message, /private/); return true;
  });
});
