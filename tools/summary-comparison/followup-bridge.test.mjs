import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createObservedFetch, comparisonModelRequest } from './followup-bridge.mjs';

test('comparison changes only the model in the isolated request and rejects unapproved models', () => {
  const args = { model: 'gemini-4-hydrogen', contents: 'synthetic', config: { thinkingConfig: { thinkingLevel: 'LOW' }, httpOptions: { retryOptions: {} } } };
  const flash = comparisonModelRequest(args, 'gemini-4-hydrogen', 'gemini-3.8-flash');
  assert.equal(flash.model, 'gemini-3.8-flash');
  assert.equal(flash.config, args.config); assert.equal(flash.contents, args.contents);
  assert.equal(args.model, 'gemini-4-hydrogen');
  assert.equal(comparisonModelRequest(args, 'gemini-4-hydrogen').model, 'gemini-4-hydrogen');
  assert.throws(() => comparisonModelRequest(args, 'gemini-4-hydrogen', 'gemini-2.5-flash'));
  assert.throws(() => comparisonModelRequest(args, 'changed-source', 'gemini-3.8-flash'));
});

test('HTTP observation preserves requests/responses and exposes only safe metadata', async () => {
  const requests = [], events = [];
  const response = new Response('{}', { status: 503, headers: { 'retry-after': '4', 'secret-header': 'private' } });
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/test:generateContent?key=private';
  const options = { body: 'private-conversation', headers: { authorization: 'private-key' } };
  const fetch = createObservedFetch(async (actualUrl, actualOptions) => {
    assert.equal(actualUrl, url); assert.equal(actualOptions, options); return response;
  }, requests, event => events.push(event));
  assert.equal(await fetch(url, options), response);
  assert.equal(await fetch(url, options), response);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].status, 503);
  assert.equal(requests[0].retryAfterSeconds, 4);
  assert.equal(events.filter(e => e.type === 'http_start').length, 2);
  assert.ok(!JSON.stringify({ requests, events }).includes('private'));
});

test('observation preserves error identity and does not retry or observe unrelated hosts', async () => {
  const requests = [], events = [], failure = new Error('private');
  let calls = 0;
  const fetch = createObservedFetch(async () => { calls++; throw failure; }, requests, event => events.push(event));
  await assert.rejects(fetch('https://generativelanguage.googleapis.com/test'), error => error === failure);
  assert.equal(calls, 1);
  assert.equal(requests[0].networkFailure, true);
  assert.ok(!JSON.stringify(events).includes('private'));
  await assert.rejects(fetch('https://example.com/test'), error => error === failure);
  assert.equal(requests.length, 1);
});
