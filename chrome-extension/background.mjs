import { localCall, runLocalAlarm, restoreLocalAlarms } from './local-engine.mjs';
import { authenticatedTab } from './session.mjs';
import { operation, saveOperation, deleteOperation, cleanOperations } from './storage.mjs';
import { whatsappTab, accountForTab } from './collector.mjs';
import { APP_ORIGINS } from './origins.mjs';
chrome.runtime.onMessageExternal.addListener((message, sender, respond) => {
  let origin;
  try { origin = new URL(sender.url).origin; } catch { return false; }
  if (!APP_ORIGINS.includes(origin) || !sender.tab?.id) return false;
  void handle(message, sender.tab.id, origin).then(data => respond({ ok: true, ...data })).catch(error => respond({ ok: false, code: error.code, error: error.message || 'Não foi possível concluir a coleta.' }));
  return true;
});
async function handle(message, tabId, origin) {
  if (message?.action === 'local') return { result: await localCall(tabId, origin, message) };
  const session = await authenticatedTab(tabId, origin);
  if (message.userId !== session.userId) throw new Error('Sua sessão mudou. Atualize o Mônada.');
  if (message?.action === 'ping') {
    let accountId = null, instruction = null;
    try { accountId = await accountForTab((await whatsappTab()).id); } catch (error) { instruction = error.message; }
    return { version: chrome.runtime.getManifest().version, accountId, instruction };
  }
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(message?.operationId || '')) throw new Error('Operação inválida.');
  if (message.action === 'start') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(message.date)) throw new Error('Data inválida.');
    const currentTab = await whatsappTab();
    const currentAccount = await accountForTab(currentTab.id);
    if (currentAccount !== message.accountId) throw new Error('A conta do WhatsApp mudou. Confirme a vinculação no Mônada.');
    const existing = await operation(message.operationId);
    if (existing) {
      existing.whatsappTabId = currentTab.id;
      if (existing.userId !== session.userId || existing.origin !== origin || existing.accountId !== message.accountId || existing.date !== message.date) throw new Error('Coleta pertence a outra conta ou data.');
      // O Mônada só obtém este UUID pela API autenticada do proprietário.
      // Retomar em outra aba transfere a leitura para ela; IDs de aba do Chrome
      // podem ser reutilizados após reinício e não servem como identidade durável.
      existing.ownerTab = tabId;
      let runnerOpen = false;
      if (existing.runnerTabId) { try { const runner = await chrome.tabs.get(existing.runnerTabId); runnerOpen = runner.url?.startsWith(chrome.runtime.getURL('runner.html')); } catch { /* reiniciar coleta interrompida */ } }
      if (existing.state !== 'collected' && !runnerOpen) {
        existing.state = 'collecting'; existing.error = null;
        const runner = await chrome.tabs.create({ url: chrome.runtime.getURL('runner.html') + '#' + existing.id, active: false }); existing.runnerTabId = runner.id;
      }
      await saveOperation(existing); return { state: existing.state };
    }
    const tab = await whatsappTab(); const accountId = await accountForTab(tab.id);
    if (accountId !== message.accountId) throw new Error('A conta do WhatsApp mudou. Confirme a vinculação no Mônada.');
    const selectedChatJids = Array.isArray(message.selectedChatJids)
      ? message.selectedChatJids
          .filter(jid => typeof jid === 'string' && /^[^\s/@]+@(c\.us|s\.whatsapp\.net|lid|g\.us|broadcast)$/.test(jid) && jid !== 'status@broadcast')
          .slice(0, 500)
      : null;
    if (Array.isArray(message.selectedChatJids) && !selectedChatJids?.length) throw new Error('Selecione ao menos uma conversa válida.');
    await saveOperation({ id: message.operationId, ownerTab: tabId, userId: session.userId, origin, whatsappTabId: tab.id, accountId, date: message.date, transcribeAudio: message.transcribeAudio === true, selectedChatJids, state: 'collecting', createdAt: Date.now() });
    const runner = await chrome.tabs.create({ url: chrome.runtime.getURL('runner.html') + '#' + message.operationId, active: false });
    const current = await operation(message.operationId); if (current) await saveOperation({ ...current, runnerTabId: runner.id });
    return { state: 'collecting' };
  }
  const value = await operation(message.operationId);
  if (!value || value.userId !== session.userId || value.ownerTab !== tabId || value.origin !== origin) throw new Error('Coleta local não encontrada para esta aba. Recolha a data pelo Mônada.');
  if (message.action === 'status') return { state: value.state, error: value.error };
  if (message.action === 'clear') { await deleteOperation(value.id); return { cleared: true }; }
  if (value.state !== 'collected') throw new Error(value.error || 'A coleta ainda está em andamento.');
  if (message.action === 'metadata') return { ...value.result, messages: value.result.messages.map(m => ({ ...m, audio: m.audio ? { ...m.audio, dataUrl: undefined } : null })) };
  if (message.action === 'audio') {
    const audio = value.result.messages.find(m => m.id === message.messageId)?.audio;
    if (!audio?.dataUrl || audio.status !== 'recovered' || audio.validation !== 'decoded') throw new Error('Áudio indisponível.');
    const base64 = audio.dataUrl.split(',')[1];
    if (!Number.isInteger(message.index) || message.index < 0 || message.index * 131072 >= base64.length) throw new Error('Bloco inválido.');
    return { base64: base64.slice(message.index * 131072, (message.index + 1) * 131072), byteLength: audio.byteLength, mimetype: audio.dataUrl.slice(5, audio.dataUrl.indexOf(';')), chunks: Math.ceil(base64.length / 131072), hash: audio.sha256 };
  }
  throw new Error('Operação não permitida.');
}

chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'maintenance') { void cleanOperations(null, null, true).catch(() => {}); return; } if (alarm.name.startsWith('local:')) void runLocalAlarm(alarm.name.slice(6)).catch(() => {}); });
void restoreLocalAlarms().catch(() => {});

void chrome.alarms.create('maintenance', { periodInMinutes: 1440 });
