'use strict';

(() => {
  let collectionInProgress = false;
  const extensionVersion = chrome.runtime.getManifest().version;
  document.getElementById('extensionVersion').textContent = 'v' + extensionVersion;
  window.addEventListener('beforeunload', event => { if (collectionInProgress) { event.preventDefault(); event.returnValue = ''; } });
  const DATES_STORAGE_KEY = 'monada-wa-poc-dates-v1';
  const ROUND_LABELS = {
    round1: 'rodada-1-inicial',
    round2: 'rodada-2-pos-reload',
    round3: 'rodada-3-pos-reinicio'
  };

  const roundSelect = document.getElementById('roundKey');
  const datesInput = document.getElementById('datesInput');
  const useMainWorldInput = document.getElementById('useMainWorld');
  const allowDownloadInput = document.getElementById('allowDownload');
  const downloadJsonInput = document.getElementById('downloadJson');
  const collectBtn = document.getElementById('collectBtn');
  const viewerBtn = document.getElementById('viewerBtn');
  const statusBox = document.getElementById('statusBox');

  function triggerJsonDownload(report, filename) {
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  function applyMainWorldResultToReport(report, mainWorldResult) {
    if (!mainWorldResult || typeof mainWorldResult !== 'object') return report;

    const mergedDeps = new Set(Array.isArray(report.dependenciesUsed) ? report.dependenciesUsed : []);
    for (const dep of mainWorldResult.dependenciesUsed || []) mergedDeps.add(dep);
    report.dependenciesUsed = Array.from(mergedDeps);
    report.mainWorldDiagnostics = mainWorldResult.diagnostics || null;

    const textById = mainWorldResult.textById || {};
    const audioById = mainWorldResult.audioById || {};

    for (const day of report.days || []) {
      const allDayMessages = [];
      for (const conv of day.conversations || []) {
        for (const msg of conv.messages || []) {
          const textHit = textById[msg.id];
          if (textHit) {
            const type = String(msg.type || 'chat').toLowerCase();
            if (type === 'chat' || type === 'extended_text') {
              if (textHit.body || textHit.caption) {
                msg.text = (textHit.body || textHit.caption).trim();
              }
            } else if (textHit.caption) {
              const baseLabel = String(msg.text || '').split(' ')[0] || `[${type}]`;
              msg.text = `${baseLabel} ${textHit.caption.trim()}`;
            } else if (type === 'document' && textHit.filename && msg.text === '[Documento]') {
              msg.text = `[Documento] ${textHit.filename}`;
            }
          }

          if (msg.audio && audioById[msg.id]) {
            const audioHit = audioById[msg.id];
            msg.audio.status = audioHit.status;
            msg.audio.source = audioHit.source;
            msg.audio.dependency = audioHit.dependency;
            msg.audio.reason = audioHit.reason;
            msg.audio.byteLength = audioHit.byteLength || 0;
            msg.audio.dataUrl = audioHit.dataUrl || null;
            msg.audio.validation = audioHit.validation || 'unverified';
          }
          allDayMessages.push(msg);
        }
      }

      const audioMessages = allDayMessages.filter((m) => Boolean(m.audio));
      const recoveredLocalCache = audioMessages.filter((m) => m.audio.status === 'recovered' && m.audio.source === 'local-cache').length;
      const recoveredExplicitDownload = audioMessages.filter((m) => m.audio.status === 'recovered' && m.audio.source === 'explicit-whatsapp-download').length;
      const recoveredTotal = audioMessages.filter((m) => m.audio.status === 'recovered').length;
      const pendingCount = audioMessages.filter((m) => m.audio.status === 'pending').length;
      const failedCount = audioMessages.filter((m) => m.audio.status === 'failed').length;
      const blockedByAudio = pendingCount > 0 || failedCount > 0;

      day.audioRecovery = {
        totalAudiosFoundLocally: audioMessages.length,
        recoveredTotal,
        recoveredLocalCache,
        recoveredExplicitDownload,
        pendingCount,
        failedCount,
        wouldBeReadyUnderBlockingRule: false,
        blockingReason: allDayMessages.length === 0
          ? 'Nenhuma mensagem encontrada localmente nesta data.'
          : blockedByAudio
            ? `${pendingCount} pendente(s) e ${failedCount} com falha — dia ficaria bloqueado pela regra atual.`
            : null
      };
      day.collection = window.MonadaWaPocCore.summarizeCollection(day);
    }

    return window.MonadaWaPocCore.sanitizeObjectForExport(report);
  }

  function setStatus(text, variant = '') {
    statusBox.textContent = text;
    statusBox.className = variant ? `status ${variant}` : 'status';
  }

  function parseDatesInput(raw) { return window.MonadaWaPocCore.parseDates(raw); }

  function initDates() {
    const saved = localStorage.getItem(DATES_STORAGE_KEY);
    if (saved && (() => { try { return parseDatesInput(saved).length > 0; } catch { return false; } })()) {
      datesInput.value = saved;
      return;
    }
    const defaults = window.MonadaWaPocCore.defaultClosedDates();
    datesInput.value = defaults.join(', ');
  }

  async function refreshSavedPills() {
    try {
      const saved = await window.MonadaPocStorage.loadAllRounds();
      for (const [key, label] of [['round1', 'R1'], ['round2', 'R2'], ['round3', 'R3']]) {
        const pill = document.querySelector(`.pill[data-round="${key}"]`);
        if (!pill) continue;
        if (saved[key]) {
          pill.classList.add('saved');
          pill.textContent = `${label}: salva`;
        } else {
          pill.classList.remove('saved');
          pill.textContent = `${label}: pendente`;
        }
      }
    } catch {
      // Ignora erro de visualização dos badges
    }
  }

  async function findWhatsAppTab() {
    const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const active = activeTabs[0];
    if (active?.id && typeof active.url === 'string' && active.url.startsWith('https://web.whatsapp.com/')) {
      return active;
    }
    const waTabs = await chrome.tabs.query({ url: 'https://web.whatsapp.com/*' });
    return waTabs[0] || null;
  }

  async function runCollection() {
    try {
      if (!navigator.locks) throw new Error('Este Chrome não oferece bloqueio seguro de coletas.');
      await navigator.locks.request('monada-wa-poc-collection', { ifAvailable: true }, async lock => {
        if (!lock) { setStatus('Já há uma coleta em andamento em outra aba. Aguarde sua conclusão.', 'err'); return; }
        collectionInProgress = true;
        try { await runCollectionLocked(); } finally { collectionInProgress = false; }
      });
    } catch (err) { setStatus(err.message || 'Erro na coleta.', 'err'); }
  }

  async function runCollectionLocked() {
    const dates = parseDatesInput(datesInput.value);
    if (dates.length === 0) {
      setStatus('Informe pelo menos uma data válida no formato YYYY-MM-DD.', 'err');
      return;
    }
    localStorage.setItem(DATES_STORAGE_KEY, dates.join(', '));

    const roundKey = roundSelect.value;
    const roundLabel = ROUND_LABELS[roundKey] || roundKey;
    const useMainWorld = Boolean(useMainWorldInput?.checked);
    const allowExplicitMediaDownload = allowDownloadInput.checked;
    const autoDownloadJson = downloadJsonInput.checked;

    collectBtn.disabled = true;
    setStatus('Localizando aba do WhatsApp Web e lendo IndexedDB...');

    try {
      const tab = await findWhatsAppTab();
      if (!tab?.id) {
        setStatus('Nenhuma aba aberta em https://web.whatsapp.com foi encontrada. Abra o WhatsApp Web primeiro.', 'err');
        return;
      }

      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['lib/poc-core.js', 'lib/poc-media.js', 'devtools-collector.js']
      });

      const executionResults = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: async (opts) => {
          if (!window.__MONADA_WA_POC__ || typeof window.__MONADA_WA_POC__.run !== 'function') {
            throw new Error('Coletor não inicializado na aba do WhatsApp Web.');
          }
          return await window.__MONADA_WA_POC__.run(opts);
        },
        args: [{
          dates,
          extensionVersion,
          useMainWorld,
          roundLabel,
          allowExplicitMediaDownload,
          autoDownloadJson: false
        }]
      });

      let report = executionResults?.[0]?.result;
      if (!report || !Array.isArray(report.days)) {
        throw new Error('A coleta não retornou um relatório válido.');
      }

      if (useMainWorld) {
        setStatus('Lendo textos descriptografados e áudios pendentes via módulos internos (MAIN world)...');
        const messageIds = [];
        const audioIdsNeedingRecovery = [];
        for (const day of report.days) {
          for (const conv of day.conversations || []) {
            for (const msg of conv.messages || []) {
              messageIds.push(msg.id);
              if (msg.audio && msg.audio.status !== 'recovered') {
                audioIdsNeedingRecovery.push(msg.id);
              }
            }
          }
        }

        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          world: 'MAIN',
          files: ['lib/poc-media.js', 'main-world-bridge.js']
        });

        const mainResults = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          world: 'MAIN',
          func: async (req) => {
            if (!window.__MONADA_WA_POC_MAIN__ || typeof window.__MONADA_WA_POC_MAIN__.resolveViaMainWorld !== 'function') {
              throw new Error('Ponte MAIN world não inicializada.');
            }
            return await window.__MONADA_WA_POC_MAIN__.resolveViaMainWorld(req);
          },
          args: [{
            messageIds,
            audioIdsNeedingRecovery,
            allowExplicitMediaDownload
          }]
        });

        report = applyMainWorldResultToReport(report, mainResults?.[0]?.result);
      }

      await window.MonadaPocStorage.saveRound(roundKey, report);
      await refreshSavedPills();

      if (autoDownloadJson) {
        const safeRound = roundLabel.replace(/[^a-zA-Z0-9-_]+/g, '-').toLowerCase();
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        triggerJsonDownload(report, `monada-wa-poc-${safeRound}-${stamp}.json`);
      }

      const lines = [
        `Coleta concluída (${roundLabel})!`,
        `Dependências: ${(report.dependenciesUsed || []).join(', ') || 'nenhuma'}`
      ];
      for (const day of report.days) {
        const audioInfo = `${day.audioRecovery.recoveredTotal}/${day.audioRecovery.totalAudiosFoundLocally} áudios`;
        const readiness = window.MonadaWaPocCore.summarizeCollection(day).collected ? 'Coleta validada; sem transcrição' : 'Coleta pendente';
        lines.push(`• ${day.date}: ${day.messageCoverage.conversationCount} chats, ${day.messageCoverage.messageCount} msgs, ${audioInfo} (${readiness})`);
      }
      lines.push('', 'Clique em "Abrir Visualizador" para ver conversas, ouvir áudios e comparar rodadas.');
      setStatus(lines.join('\n'), 'ok');
    } catch (err) {
      setStatus(`Erro na coleta: ${err?.message || String(err)}`, 'err');
    } finally {
      collectBtn.disabled = false;
    }
  }

  collectBtn.addEventListener('click', () => {
    void runCollection();
  });

  viewerBtn.addEventListener('click', () => {
    const url = chrome.runtime.getURL('viewer.html');
    void chrome.tabs.create({ url });
  });

  initDates();
  void refreshSavedPills();
})();
