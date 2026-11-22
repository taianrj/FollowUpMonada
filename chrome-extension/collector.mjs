export async function whatsappTab() {
  const tabs = await chrome.tabs.query({ url: 'https://web.whatsapp.com/*' });
  if (!tabs.length) throw new Error('Abra o WhatsApp Web neste Chrome e conecte sua conta.');
  if (tabs.length > 1) throw new Error('Deixe apenas uma aba do WhatsApp Web aberta para escolher a conta com segurança.');
  return tabs[0];
}
// Esta função precisa ser autocontida: o Chrome serializa seu código para o MAIN
// world. Nunca usa mensagens, participantes, contatos ou nomes para inferir o dono.
export async function inspectOwnWhatsappAccount() {
  const diagnostics = { code: 'page_loading', modules: [], getters: [], failedGetters: [] };
  if (typeof window.require !== 'function') return { accountId: null, diagnostics };
  const modules = [];
  for (const name of ['WAWebUserPrefsMeUser', 'WAWebUserPrefs']) {
    try {
      const exported = window.require(name);
      if (exported && (typeof exported === 'object' || typeof exported === 'function')) {
        diagnostics.modules.push(name);
        modules.push({ name, value: exported });
        if (exported.default && exported.default !== exported) modules.push({ name: name + '.default', value: exported.default });
      }
    } catch { /* Um módulo ausente não impede tentar o outro. */ }
  }
  const normalize = value => {
    const id = typeof value === 'string' ? value : value?._serialized || (value?.user && value?.server ? `${value.user}@${value.server}` : '');
    return typeof id === 'string' && /^\d+(?::\d+)?@(c\.us|s\.whatsapp\.net|lid)$/.test(id) ? id : null;
  };
  const deadline = Date.now() + 5000;
  // Tenta os getters PN em todos os módulos antes de recorrer ao LID. Não trata
  // esses identificadores como intercambiáveis nem altera vínculos persistidos.
  for (const method of ['getMaybeMePnUser', 'getMePnUserOrThrow', 'getMaybeMeUser', 'getMeUser', 'getMeUserOrThrow', 'getMaybeMeLidUser', 'getMeLidUserOrThrow']) {
    for (const module of modules) {
      if (Date.now() >= deadline) break;
      let timer;
      try {
        if (typeof module.value[method] !== 'function') continue;
        const source = `${module.name}.${method}`;
        diagnostics.getters.push(source);
        const value = await Promise.race([
          Promise.resolve().then(() => module.value[method].call(module.value)),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('identity-timeout')), Math.min(1000, deadline - Date.now())); })
        ]);
        const accountId = normalize(value);
        if (accountId) return { accountId, diagnostics: { ...diagnostics, code: 'ready', source } };
      } catch {
        // Registra só o nome do getter, nunca erro, credenciais ou valor retornado.
        diagnostics.failedGetters.push(`${module.name}.${method}`);
      } finally { clearTimeout(timer); }
    }
  }
  diagnostics.code = diagnostics.getters.length ? 'identity_unavailable' : 'identity_api_unavailable';
  return { accountId: null, diagnostics };
}
export async function accountForTab(tabId) {
  const result = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: inspectOwnWhatsappAccount });
  const identity = result?.[0]?.result;
  if (identity?.accountId) return identity.accountId;
  if (identity?.diagnostics?.code === 'page_loading') throw new Error('Aguarde o WhatsApp Web terminar de carregar e clique em Verificar novamente.');
  if (identity?.diagnostics?.code === 'identity_api_unavailable') throw new Error('A extensão não encontrou a identificação da conta nesta versão do WhatsApp Web. Atualize a extensão e clique em Verificar novamente.');
  throw new Error('Não foi possível identificar a conta do WhatsApp Web. Verifique se ela está conectada e clique em Verificar novamente.');
}
export async function collectForMonada(tabId, options) {
  const accountId = await accountForTab(tabId);
  if (accountId !== options.accountId) throw new Error('A conta do WhatsApp mudou. Volte ao Mônada e confirme a vinculação.');
  const selectedSet = Array.isArray(options.selectedChatJids) && options.selectedChatJids.length
    ? new Set(options.selectedChatJids)
    : null;
  await chrome.scripting.executeScript({ target: { tabId }, files: ['poc/lib/poc-core.js', 'poc/lib/poc-media.js', 'poc/devtools-collector.js'] });
  const results = await chrome.scripting.executeScript({ target: { tabId }, func: opts => window.__MONADA_WA_POC__.run(opts), args: [{ dates: [options.date], roundLabel: 'monada', extensionVersion: chrome.runtime.getManifest().version, useMainWorld: true, allowExplicitMediaDownload: selectedSet ? false : options.transcribeAudio, collectAudio: selectedSet ? false : options.transcribeAudio, autoDownloadJson: false }] });
  const report = results?.[0]?.result; if (!report?.days?.[0]) throw new Error('Não foi possível ler as conversas. Tente novamente.');
  const day = report.days[0];
  const allMessages = day.conversations.flatMap(c => c.messages);
  const messages = selectedSet ? allMessages.filter(m => selectedSet.has(m.chatJid)) : allMessages;
  if (!messages.length) throw new Error('Nenhuma mensagem encontrada nas conversas selecionadas para esta data.');
  await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', files: ['poc/lib/poc-media.js', 'poc/main-world-bridge.js'] });
  const hydrated = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: request => window.__MONADA_WA_POC_MAIN__.resolveViaMainWorld(request), args: [{ messageIds: messages.map(m => m.id), audioIdsNeedingRecovery: options.transcribeAudio ? messages.filter(m => m.audio && m.audio.status !== 'recovered').map(m => m.id) : [], allowExplicitMediaDownload: options.transcribeAudio }] });
  const resolved = hydrated?.[0]?.result; if (!resolved) throw new Error('Não foi possível descriptografar as conversas.');
  for (const message of messages) {
    const text = resolved.textById?.[message.id];
    if (text) {
      if (['chat', 'extended_text'].includes(String(message.type).toLowerCase())) message.text = (text.body || text.caption || '').trim();
      else if (text.caption) message.text = `[${message.type}] ${text.caption}`;
      else if (text.filename && message.type === 'document') message.text = `[Documento] ${text.filename}`;
    }
    if (message.audio && resolved.audioById?.[message.id]) Object.assign(message.audio, resolved.audioById[message.id]);
  }
  if (await accountForTab(tabId) !== accountId) throw new Error('A conta do WhatsApp mudou durante a coleta. Tente novamente.');
  if (messages.some(m => ['chat', 'extended_text'].includes(String(m.type).toLowerCase()) && !m.text?.trim())) throw new Error('Alguns textos não puderam ser lidos. Atualize a extensão e tente novamente.');
  if (!messages.length) throw new Error('Nenhuma conversa disponível no WhatsApp Web para esta data.');
  return { date: options.date, accountId, messages, partialChats: 0 };
}
