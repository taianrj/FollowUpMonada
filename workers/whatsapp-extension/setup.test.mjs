import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { updateLocalEnvironment, extensionId } from '../../scripts/setup-whatsapp-extension.mjs';
import { summaryStore } from './summary-store.mjs';

test('preparação local preserva outros valores e não transforma segredos em saída', () => {
  const original = 'GEMINI_API_KEY=private-value\r\nWHATSAPP_INTEGRATION_MODE=baileys\r\nOTHER=value\r\n';
  const updated = updateLocalEnvironment(original, { WHATSAPP_INTEGRATION_MODE: 'chrome_extension', NEXT_PUBLIC_WHATSAPP_EXTENSION_ID: 'a'.repeat(32) });
  assert.ok(updated.includes('GEMINI_API_KEY=private-value\r\n'));
  assert.ok(updated.includes('OTHER=value\r\n'));
  assert.equal(updated.split('WHATSAPP_INTEGRATION_MODE=').length, 2);
  assert.match(updated, /WHATSAPP_INTEGRATION_MODE=chrome_extension/);
});
test('pacote usa ID estável e restringe comunicação aos domínios configurados', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../chrome-extension/manifest.json', import.meta.url), 'utf8'));
  assert.match(extensionId(manifest.key), /^[a-p]{32}$/);
  assert.deepEqual(manifest.host_permissions, ['https://web.whatsapp.com/*', 'http://localhost/*', 'http://127.0.0.1/*']);
  assert.deepEqual(manifest.permissions, ['scripting', 'alarms']);
  assert.ok(manifest.content_security_policy.extension_pages.includes('connect-src http://localhost:3000 http://127.0.0.1:3000'));
  assert.ok(!manifest.externally_connectable.matches.includes('<all_urls>'));
  const background = await readFile(new URL('../../chrome-extension/background.mjs', import.meta.url), 'utf8');
  assert.match(background, /APP_ORIGINS\.includes\(origin\)/);
  assert.match(background, /value\.ownerTab !== tabId/);
});
test('adaptador local usa SQLite persistente por usuário após reiniciar o processo', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'monada-extension-test-'));
  try {
    const modulePath = new URL('./local.mjs', import.meta.url).href;
    const setup = `import {localEngine} from ${JSON.stringify(modulePath)}; const engine=await localEngine('test-user',{transcribe:async()=>'',generate:async()=>({})},${JSON.stringify(directory)}); await engine.call('binding',{accountId:'123@s.whatsapp.net'}); console.log('saved');`;
    const first = spawnSync(process.execPath, ['--input-type=module', '-e', setup], { encoding: 'utf8' }); assert.equal(first.status, 0, first.stderr);
    const check = `import {localEngine} from ${JSON.stringify(modulePath)}; const engine=await localEngine('test-user',{transcribe:async()=>'',generate:async()=>({})},${JSON.stringify(directory)}); const status=await engine.call('status'); console.log(status.binding.accountId);`;
    const second = spawnSync(process.execPath, ['--input-type=module', '-e', check], { encoding: 'utf8' }); assert.equal(second.status, 0, second.stderr); assert.match(second.stdout, /123@s.whatsapp.net/);
  } finally {
    const target = path.resolve(directory), expected = path.resolve(tmpdir()) + path.sep;
    assert.ok(target.startsWith(expected) && path.basename(target).startsWith('monada-extension-test-'));
    await rm(target, { recursive: true, force: true });
  }
});

test('novo armazenamento de teste aceita somente resumo final e isola usuários', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'monada-summaries-test-'));
  try {
    const first = await summaryStore('test-user', directory);
    const summary = { id: 'summary', summary_date: '2026-11-19', created_by: 'test-user', raw_text: '', summary_data: { summaries: [] } };
    assert.throws(() => first.save({ ...summary, raw_text: 'Não persistir' }), /inválido/);
    first.save(summary); first.close();
    const reopened = await summaryStore('test-user', directory);
    assert.deepEqual(reopened.all(), [summary]); reopened.close();
    const other = await summaryStore('other-user', directory);
    assert.deepEqual(other.all(), []);
    assert.throws(() => other.save(summary), /inválido/); other.close();
  } finally {
    assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep));
    assert.ok(path.basename(directory).startsWith('monada-summaries-test-'));
    await rm(directory, { recursive: true, force: true });
  }
});
