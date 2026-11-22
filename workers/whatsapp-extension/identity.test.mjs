import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { inspectOwnWhatsappAccount, accountForTab } from '../../chrome-extension/collector.mjs';

// Exercita o mesmo corpo serializado por executeScript, sem acessar a sessão real.
async function inspect(modules, extra = {}) {
  return vm.runInNewContext(`(${inspectOwnWhatsappAccount.toString()})()`, {
    window: { require(name) { if (!(name in modules)) throw new Error('missing module'); return modules[name]; }, ...extra },
    setTimeout, clearTimeout, Date,
  });
}
test('identifica o dono pelo módulo atual MeUser mesmo quando o antigo não existe', async () => {
  const result = await inspect({ WAWebUserPrefsMeUser: { getMaybeMePnUser() { return { _serialized: '5511000000000@c.us' }; } } });
  assert.equal(result.accountId, '5511000000000@c.us');
  assert.equal(result.diagnostics.source, 'WAWebUserPrefsMeUser.getMaybeMePnUser');
});
test('mantém suporte ao módulo antigo e a getters assíncronos com user/server', async () => {
  const result = await inspect({ WAWebUserPrefs: { async getMaybeMePnUser() { return { user: '5511000000000', server: 's.whatsapp.net' }; } } });
  assert.equal(result.accountId, '5511000000000@s.whatsapp.net');
});
test('uma exceção num getter não impede outro getter e não exporta o erro', async () => {
  const result = await inspect({ WAWebUserPrefsMeUser: { getMaybeMePnUser() { throw new Error('private-token-must-not-appear'); }, getMaybeMeUser() { return '5511000000000@c.us'; } } });
  assert.equal(result.accountId, '5511000000000@c.us');
  assert.equal(result.diagnostics.failedGetters.length, 1);
  assert.equal(JSON.stringify(result).includes('private-token-must-not-appear'), false);
});
test('prefere PN explícito antes de LID e aceita LID explícito quando PN não existe', async () => {
  const modern = { getMaybeMeLidUser() { return '100000000@lid'; } };
  const pn = await inspect({ WAWebUserPrefsMeUser: modern, WAWebUserPrefs: { getMaybeMePnUser() { return '5511000000000@c.us'; } } });
  assert.equal(pn.accountId, '5511000000000@c.us');
  assert.equal((await inspect({ WAWebUserPrefsMeUser: modern })).accountId, '100000000@lid');
});
test('não infere identidade de conversas/contatos e rejeita grupos e formatos inválidos', async () => {
  const result = await inspect({ WAWebUserPrefsMeUser: { getMaybeMePnUser() { return '100000000@g.us'; }, getMaybeMeUser() { return 'Nome da pessoa'; } } }, { Store: { Contacts: [{ id: '5511000000000@c.us' }] } });
  assert.equal(result.accountId, null);
  assert.equal(result.diagnostics.code, 'identity_unavailable');
  assert.equal((await inspect({})).diagnostics.code, 'identity_api_unavailable');
});
test('adapter executa a inspeção no MAIN world e distingue API incompatível de aba carregando', async () => {
  const previous = globalThis.chrome;
  try {
    globalThis.chrome = { scripting: { async executeScript(request) {
      assert.equal(request.world, 'MAIN'); assert.equal(request.target.tabId, 7);
      assert.equal(request.func, inspectOwnWhatsappAccount);
      return [{ result: await inspect({ WAWebUserPrefsMeUser: { getMaybeMePnUser() { return '5511000000000@c.us'; } } }) }];
    } } };
    assert.equal(await accountForTab(7), '5511000000000@c.us');
    globalThis.chrome.scripting.executeScript = async () => [{ result: { accountId: null, diagnostics: { code: 'identity_api_unavailable' } } }];
    await assert.rejects(accountForTab(7), /nesta versão/);
    globalThis.chrome.scripting.executeScript = async () => [{ result: { accountId: null, diagnostics: { code: 'page_loading' } } }];
    await assert.rejects(accountForTab(7), /terminar de carregar/);
  } finally { if (previous === undefined) delete globalThis.chrome; else globalThis.chrome = previous; }
});
