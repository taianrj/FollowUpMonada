'use strict';

(() => {
  const rounds = {
    round1: null,
    round2: null,
    round3: null
  };
  let selectedRoundKey = 'round1';
  let selectedDate = '';
  let selectedChatJid = '';

  const el = (tag, attrs = {}, text = '') => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') node.className = v;
      else if (k === 'style') node.setAttribute('style', v);
      else node[k] = v;
    }
    if (text) node.textContent = text;
    return node;
  };

  function clearNode(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function updateRoundStatusText(roundKey, report, sourceHint) {
    const map = {
      round1: 'statusRound1',
      round2: 'statusRound2',
      round3: 'statusRound3'
    };
    const statusNode = document.getElementById(map[roundKey]);
    if (!statusNode) return;
    if (!report) {
      statusNode.textContent = roundKey === 'round1'
        ? 'Nenhum arquivo carregado.'
        : 'Opcional para comparação.';
      return;
    }
    const when = new Date(report.collectedAt || Date.now()).toLocaleString('pt-BR');
    statusNode.textContent = `${sourceHint}: ${report.roundLabel || roundKey} — v${report.extensionVersion || 'não registrada'} (${(report.days || []).length} data(s), ${when})`;
  }

  async function handleFileInput(roundKey, fileInput) {
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      if (!Array.isArray(parsed?.days)) throw new Error('JSON não possui o formato esperado da PoC.');
      rounds[roundKey] = parsed;
      updateRoundStatusText(roundKey, parsed, 'Arquivo carregado');
      if (!rounds[selectedRoundKey]) selectedRoundKey = roundKey;
      renderAll();
    } catch (err) {
      const map = { round1: 'statusRound1', round2: 'statusRound2', round3: 'statusRound3' };
      document.getElementById(map[roundKey]).textContent = `Erro ao ler arquivo: ${err?.message || String(err)}`;
    }
  }

  async function loadStoredExtensionRounds() {
    if (!window.MonadaPocStorage) return;
    try {
      const stored = await window.MonadaPocStorage.loadAllRounds();
      let foundAny = false;
      for (const key of ['round1', 'round2', 'round3']) {
        if (stored[key]) {
          rounds[key] = stored[key];
          updateRoundStatusText(key, stored[key], 'Salvo pela extensão');
          if (!foundAny) {
            selectedRoundKey = key;
            foundAny = true;
          }
        }
      }
      if (foundAny) renderAll();
    } catch {
      // Quando aberto via file:// sem armazenamento prévio, segue normalmente pelo upload manual
    }
  }

  document.getElementById('fileRound1').addEventListener('change', (e) => void handleFileInput('round1', e.target));
  document.getElementById('fileRound2').addEventListener('change', (e) => void handleFileInput('round2', e.target));
  document.getElementById('fileRound3').addEventListener('change', (e) => void handleFileInput('round3', e.target));

  const clearBtn = document.getElementById('clearSavedBtn');
  if (clearBtn) {
    clearBtn.addEventListener('click', async () => {
      try {
        if (window.MonadaPocStorage) {
          await window.MonadaPocStorage.clearAllRounds();
        }
      } catch {
        // Ignora se aberto em contexto sem IndexedDB
      }
      rounds.round1 = null;
      rounds.round2 = null;
      rounds.round3 = null;
      selectedDate = '';
      selectedChatJid = '';
      updateRoundStatusText('round1', null, '');
      updateRoundStatusText('round2', null, '');
      updateRoundStatusText('round3', null, '');
      clearNode(document.getElementById('roundSelect'));
      clearNode(document.getElementById('dateSelect'));
      clearNode(document.getElementById('daySummary'));
      clearNode(document.getElementById('dependenciesBox'));
      clearNode(document.getElementById('chatList'));
      const pane = document.getElementById('messagesPane');
      clearNode(pane);
      pane.appendChild(el('div', { class: 'muted' }, 'Dados locais da PoC limpos. Faça uma nova coleta pela extensão ou carregue um arquivo JSON.'));
      renderComparisonTab();
      renderCellphoneChecklist();
    });
  }

  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const tab = btn.dataset.tab;
      ['conversations', 'comparison', 'cellphone'].forEach((id) => {
        document.getElementById(`tab-${id}`).classList.toggle('hidden', id !== tab);
      });
    });
  });

  const roundSelect = document.getElementById('roundSelect');
  const dateSelect = document.getElementById('dateSelect');
  const chatSearch = document.getElementById('chatSearch');

  roundSelect.addEventListener('change', () => {
    selectedRoundKey = roundSelect.value;
    selectedDate = '';
    selectedChatJid = '';
    renderConversationsTab();
  });
  dateSelect.addEventListener('change', () => {
    selectedDate = dateSelect.value;
    selectedChatJid = '';
    renderConversationsTab();
  });
  chatSearch.addEventListener('input', () => renderConversationsTab());

  function renderAll() {
    renderConversationsTab();
    renderComparisonTab();
    renderCellphoneChecklist();
  }

  function renderConversationsTab() {
    clearNode(roundSelect);
    const availableRounds = Object.entries(rounds).filter(([, data]) => Boolean(data));
    if (availableRounds.length === 0) return;

    if (!rounds[selectedRoundKey]) selectedRoundKey = availableRounds[0][0];
    for (const [key, data] of availableRounds) {
      const opt = el('option', { value: key }, data.roundLabel || key);
      if (key === selectedRoundKey) opt.selected = true;
      roundSelect.appendChild(opt);
    }

    const report = rounds[selectedRoundKey];
    clearNode(dateSelect);
    for (const day of report.days || []) {
      const opt = el('option', { value: day.date }, day.date);
      dateSelect.appendChild(opt);
    }
    if (!selectedDate || !(report.days || []).some((d) => d.date === selectedDate)) {
      selectedDate = report.days?.[0]?.date || '';
    }
    dateSelect.value = selectedDate;

    const day = (report.days || []).find((d) => d.date === selectedDate);
    const daySummary = document.getElementById('daySummary');
    const dependenciesBox = document.getElementById('dependenciesBox');
    const chatList = document.getElementById('chatList');
    const messagesPane = document.getElementById('messagesPane');
    clearNode(daySummary);
    clearNode(dependenciesBox);
    clearNode(chatList);
    clearNode(messagesPane);

    if (!day) {
      messagesPane.appendChild(el('div', { class: 'muted' }, 'Nenhuma data disponível nesta rodada.'));
      return;
    }

    const msgCard = el('div', { class: 'metric-box' });
    msgCard.appendChild(el('h3', {}, `Cobertura de Mensagens (${day.date})`));
    msgCard.appendChild(el('div', {}, `Conversas encontradas localmente: ${day.messageCoverage.conversationCount}`));
    msgCard.appendChild(el('div', {}, `Mensagens encontradas localmente: ${day.messageCoverage.messageCount}`));
    msgCard.appendChild(el('div', {}, `IDs duplicados nesta rodada: ${(day.messageCoverage.duplicateIdsDetected || []).length}`));
    msgCard.appendChild(el('div', {}, `Conversas com sinal de histórico possivelmente parcial: ${(day.messageCoverage.possiblyTruncatedConversations || []).length}`));
    msgCard.appendChild(el('div', { class: 'muted', style: 'margin-top:0.35rem;font-size:0.78rem;' }, `Status/Stories ignorados no total da leitura: ${report.inventory?.ignoredStatusCount ?? 0}`));
    daySummary.appendChild(msgCard);

    const audCard = el('div', { class: 'metric-box' });
    audCard.appendChild(el('h3', {}, `Recuperação de Áudios (${day.date})`));
    audCard.appendChild(el('div', {}, `Áudios encontrados localmente: ${day.audioRecovery.totalAudiosFoundLocally}`));
    audCard.appendChild(el('div', {}, `Recuperados do cache local: ${day.audioRecovery.recoveredLocalCache}`));
    audCard.appendChild(el('div', {}, `Recuperados por download explícito: ${day.audioRecovery.recoveredExplicitDownload}`));
    audCard.appendChild(el('div', {}, `Pendentes: ${day.audioRecovery.pendingCount} | Falhos: ${day.audioRecovery.failedCount}`));
    const collection = window.MonadaWaPocCore.summarizeCollection(day);
    audCard.appendChild(el('div', {}, `Textos ausentes: ${collection.missingTexts} | Áudios sem validação: ${collection.unvalidatedAudios}`));
    const statusWrap = el('div', { style: 'margin-top:0.45rem;' });
    statusWrap.appendChild(
      el(
        'span',
        { class: `badge ${collection.collected ? 'badge-ok' : 'badge-warn'}` },
        collection.collected
          ? 'Coleta validada — transcrição não realizada'
          : 'Coleta pendente ou sem validação'
      )
    );
    audCard.appendChild(statusWrap);
    audCard.appendChild(el('p', { class: 'muted' }, collection.note));
    if (day.audioRecovery.blockingReason) {
      audCard.appendChild(el('div', { class: 'muted', style: 'margin-top:0.35rem;font-size:0.78rem;' }, day.audioRecovery.blockingReason));
    }
    daySummary.appendChild(audCard);

    dependenciesBox.appendChild(el('strong', {}, 'Dependências usadas nesta rodada: '));
    dependenciesBox.appendChild(el('span', {}, (report.dependenciesUsed || []).join(', ') || 'nenhuma registrada'));
    if (Array.isArray(report.limitations) && report.limitations.length > 0) {
      const limTitle = el('div', { style: 'margin-top:0.45rem;color:#fcd34d;font-weight:600;' }, 'Limitações registradas:');
      dependenciesBox.appendChild(limTitle);
      const ul = el('ul', { style: 'margin:0.25rem 0 0 1.2rem;padding:0;' });
      for (const lim of report.limitations) ul.appendChild(el('li', {}, lim));
      dependenciesBox.appendChild(ul);
    }

    const query = chatSearch.value.trim().toLocaleLowerCase('pt-BR');
    const filteredConversations = (day.conversations || []).filter((conv) => {
      if (!query) return true;
      if (String(conv.chatName || '').toLocaleLowerCase('pt-BR').includes(query)) return true;
      return (conv.messages || []).some((m) =>
        String(m.text || '').toLocaleLowerCase('pt-BR').includes(query) ||
        String(m.senderName || '').toLocaleLowerCase('pt-BR').includes(query)
      );
    });

    if (filteredConversations.length === 0) {
      chatList.appendChild(el('div', { class: 'muted', style: 'padding:0.85rem;' }, 'Nenhuma conversa encontrada para o filtro atual.'));
      messagesPane.appendChild(el('div', { class: 'muted' }, 'Selecione uma conversa.'));
      return;
    }

    if (!selectedChatJid || !filteredConversations.some((c) => c.chatJid === selectedChatJid)) {
      selectedChatJid = filteredConversations[0].chatJid;
    }

    for (const conv of filteredConversations) {
      const btn = el('button', {
        type: 'button',
        class: `chat-item${conv.chatJid === selectedChatJid ? ' active' : ''}`
      });
      btn.appendChild(el('div', { class: 'chat-item-title' }, `${conv.chatName}${conv.isGroup ? ' (Grupo)' : ''}`));
      const metaParts = [`${conv.messageCount} msg(s)`];
      if (conv.audioCount > 0) metaParts.push(`${conv.audioCount} áudio(s)`);
      if (conv.possiblyTruncatedOnDate) metaParts.push(`⚠️ histórico local inicia às ${conv.earliestLocalTime}`);
      btn.appendChild(el('div', { class: 'chat-item-meta' }, metaParts.join(' • ')));
      btn.addEventListener('click', () => {
        selectedChatJid = conv.chatJid;
        renderConversationsTab();
      });
      chatList.appendChild(btn);
    }

    const activeConv = filteredConversations.find((c) => c.chatJid === selectedChatJid);
    if (!activeConv) return;

    const headerInfo = el('div', { style: 'padding-bottom:0.5rem;border-bottom:1px solid var(--border);margin-bottom:0.25rem;' });
    headerInfo.appendChild(el('strong', {}, `${activeConv.chatName}${activeConv.isGroup ? ' (Grupo)' : ''}`));
    headerInfo.appendChild(
      el(
        'div',
        { class: 'muted', style: 'font-size:0.78rem;' },
        `Data: ${day.date} • ${activeConv.messageCount} mensagem(ns) • Início do histórico local deste chat: ${activeConv.earliestLocalDate || '?'} ${activeConv.earliestLocalTime || ''}`
      )
    );
    messagesPane.appendChild(headerInfo);

    for (const msg of activeConv.messages || []) {
      const box = el('div', { class: `msg${msg.fromMe === true ? ' from-me' : ''}` });
      const head = el('div', { class: 'msg-head' });
      head.appendChild(el('span', { class: 'msg-sender' }, msg.senderName || 'Desconhecido'));
      if (msg.fromMe === true) head.appendChild(el('span', { class: 'badge badge-me' }, 'Enviada por mim'));
      if (msg.fromMe === null) head.appendChild(el('span', { class: 'badge badge-warn' }, 'fromMe indefinido'));
      head.appendChild(el('span', {}, `${msg.date} ${msg.time}`));
      if (msg.isEdited) head.appendChild(el('span', { class: 'badge badge-warn' }, 'Editada'));
      if (msg.isRevoked) head.appendChild(el('span', { class: 'badge badge-err' }, 'Apagada'));
      if (msg.isForwarded) head.appendChild(el('span', {}, '↪ Encaminhada'));
      box.appendChild(head);

      box.appendChild(el('div', { class: 'msg-text' }, msg.text || '(sem texto)'));

      if (msg.audio) {
        const audioBox = el('div', { class: 'audio-box' });
        const audioTop = el('div', { style: 'display:flex;flex-wrap:wrap;gap:0.4rem;align-items:center;' });
        const statusClass = msg.audio.status === 'recovered'
          ? 'badge-ok'
          : msg.audio.status === 'pending'
            ? 'badge-warn'
            : 'badge-err';
        const statusLabel = msg.audio.status === 'recovered'
          ? `Áudio recuperado (${msg.audio.source})`
          : msg.audio.status === 'pending'
            ? 'Áudio pendente'
            : 'Falha ao recuperar áudio';
        audioTop.appendChild(el('span', { class: `badge ${statusClass}` }, statusLabel));
        audioTop.appendChild(el('span', { class: 'muted' }, `Dependência: ${msg.audio.dependency}`));
        audioBox.appendChild(audioTop);

        if (msg.audio.reason) {
          audioBox.appendChild(el('div', { class: 'muted' }, msg.audio.reason));
        }
        if (msg.audio.status === 'recovered' && window.MonadaWaPocMedia.isLocalAudioDataUrl(msg.audio.dataUrl)) {
          const player = el('audio', { controls: true, preload: 'none', src: msg.audio.dataUrl });
          player.addEventListener('error', () => { window.MonadaWaPocCore.markAudioPlaybackFailed(day, msg); renderAll(); });
          audioBox.appendChild(player);
        }
        box.appendChild(audioBox);
      }

      messagesPane.appendChild(box);
    }
  }

  function renderComparisonBlock(container, comparison) {
    const title = el('h3', { style: 'margin:1rem 0 0.5rem 0;font-size:0.95rem;' }, `${comparison.baselineLabel}  →  ${comparison.candidateLabel}`);
    container.appendChild(title);
    if (comparison.configurationWarning) container.appendChild(el('p', { class: 'badge badge-warn' }, comparison.configurationWarning));

    const wrap = el('div', { class: 'table-wrap' });
    const table = el('table');
    const thead = el('thead');
    const trHead = el('tr');
    ['Data', 'Msgs (Base → Nova)', 'Áudios recup. (Base → Nova)', 'Sumiram', 'Novas', 'Mudanças reais', 'Inconsistências / Duplicados', 'Variação de áudios', 'Status'].forEach((h) => {
      trHead.appendChild(el('th', {}, h));
    });
    thead.appendChild(trHead);
    table.appendChild(thead);

    const tbody = el('tbody');
    for (const row of comparison.perDate) {
      const tr = el('tr');
      tr.appendChild(el('td', {}, row.date));
      tr.appendChild(el('td', {}, `${row.baselineMessageCount} → ${row.candidateMessageCount}`));
      tr.appendChild(el('td', {}, `${row.baselineAudioRecovered}/${row.baselineAudioTotal} → ${row.candidateAudioRecovered}/${row.candidateAudioTotal}`));
      tr.appendChild(el('td', {}, String(row.missingInCandidate.length)));
      tr.appendChild(el('td', {}, String(row.addedInCandidate.length)));
      tr.appendChild(el('td', {}, String(row.realMessageChanges.length)));
      tr.appendChild(el('td', {}, `${row.collectionInconsistencies.length} / ${row.duplicatesInCandidate.length}`));
      tr.appendChild(el('td', {}, String(row.audioStatusChanges.length)));
      const tdStatus = el('td');
      tdStatus.appendChild(
        el(
          'span',
          { class: `badge ${row.consistentMessages ? 'badge-ok' : 'badge-warn'}` },
          row.consistentMessages ? 'Consistente' : 'Divergente'
        )
      );
      tr.appendChild(tdStatus);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    container.appendChild(wrap);
  }

  function renderComparisonTab() {
    const container = document.getElementById('comparisonContent');
    clearNode(container);
    if (!rounds.round1 || (!rounds.round2 && !rounds.round3)) {
      container.textContent = 'Carregue a Rodada 1 e pelo menos a Rodada 2 (pós-reload) ou a Rodada 3 (pós-reinício do Chrome).';
      return;
    }
    if (rounds.round2) {
      renderComparisonBlock(container, window.MonadaWaPocCore.compareRounds(rounds.round1, rounds.round2));
    }
    if (rounds.round3) {
      renderComparisonBlock(container, window.MonadaWaPocCore.compareRounds(rounds.round1, rounds.round3));
    }
  }

  function renderCellphoneChecklist() {
    const container = document.getElementById('cellphoneChecklist');
    clearNode(container);
    if (!rounds.round1) {
      container.textContent = 'Carregue a Rodada 1 para gerar a tabela das datas testadas.';
      return;
    }
    const table = el('table');
    const thead = el('thead');
    const trH = el('tr');
    ['Data', 'Conversas (PoC)', 'Mensagens (PoC)', 'Áudios recup./local', 'Estado da coleta', 'Conferência manual vs. Celular'].forEach((h) => {
      trH.appendChild(el('th', {}, h));
    });
    thead.appendChild(trH);
    table.appendChild(thead);

    const tbody = el('tbody');
    for (const day of rounds.round1.days || []) {
      const tr = el('tr');
      tr.appendChild(el('td', {}, day.date));
      tr.appendChild(el('td', {}, String(day.messageCoverage.conversationCount)));
      tr.appendChild(el('td', {}, String(day.messageCoverage.messageCount)));
      tr.appendChild(el('td', {}, `${day.audioRecovery.recoveredTotal}/${day.audioRecovery.totalAudiosFoundLocally}`));
      tr.appendChild(el('td', {}, window.MonadaWaPocCore.summarizeCollection(day).collected ? 'Coletado; sem transcrição' : 'Pendente / não validado'));
      const tdNote = el('td');
      const input = el('input', {
        type: 'text',
        placeholder: 'Ex.: bateu 100% / faltou chat X / faltou 1 áudio...',
        style: 'width:100%;background:var(--panel-2);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:0.4rem 0.55rem;'
      });
      tdNote.appendChild(input);
      tr.appendChild(tdNote);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    container.appendChild(table);
  }

  void loadStoredExtensionRounds();
})();
