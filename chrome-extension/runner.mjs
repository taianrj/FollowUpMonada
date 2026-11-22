import { operation, saveOperation } from './storage.mjs';
import { collectForMonada } from './collector.mjs';
const id = location.hash.slice(1);
const task = await operation(id);
if (task) {
  try {
    await navigator.locks.request('monada-whatsapp-integration-collection', { ifAvailable: true }, async lock => {
      if (!lock) throw new Error('Já há outra coleta em andamento. Aguarde e tente novamente.');
      const result = await collectForMonada(task.whatsappTabId, task);
      for (const message of result.messages) if (message.audio?.dataUrl && message.audio.validation === 'decoded') {
        const bytes = Uint8Array.from(atob(message.audio.dataUrl.split(',')[1]), c => c.charCodeAt(0));
        message.audio.sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(b => b.toString(16).padStart(2, '0')).join('');
      }
      const current = await operation(id);
      if (current) await saveOperation({ ...current, state: 'collected', result });
      document.getElementById('status').textContent = 'Coleta concluída. As conversas serão mantidas neste computador.';
    });
    window.close();
  } catch (error) { const current = await operation(id); if (current) await saveOperation({ ...current, state: 'failed', error: error.message }); document.getElementById('status').textContent = error.message + ' Volte ao Mônada para tentar novamente.'; }
}
