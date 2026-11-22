'use strict';
document.getElementById('openCollection').addEventListener('click', async () => {
  try {
    await chrome.tabs.create({ url: chrome.runtime.getURL('collection.html') });
    window.close();
  } catch { document.getElementById('launcherStatus').textContent = 'Não foi possível abrir a aba de coleta.'; }
});
