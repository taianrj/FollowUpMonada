'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  getInitialSelectedChatJids,
  type ChatSelectionRequest,
  type ChatSelectionResult,
} from '@/lib/whatsapp-extension/chat-selection';

interface ChatSelectionModalProps {
  request: ChatSelectionRequest;
  onConfirm: (result: ChatSelectionResult) => void;
  onCancel: () => void;
}

type FilterTab = 'all' | 'unsummarized' | 'groups' | 'direct';

export function ChatSelectionModal({ request, onConfirm, onCancel }: ChatSelectionModalProps) {
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(getInitialSelectedChatJids(request.conversations)),
  );
  const [search, setSearch] = useState('');
  const [filterTab, setFilterTab] = useState<FilterTab>('all');
  const hasSummarizedAny = useMemo(
    () => request.conversations.some((c) => c.alreadySummarized),
    [request.conversations],
  );
  const [mode, setMode] = useState<'merge' | 'replace'>(
    request.hasExistingSummary ? 'merge' : 'replace',
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onCancel]);

  const filteredConversations = useMemo(() => {
    const query = search.trim().toLocaleLowerCase('pt-BR');
    return request.conversations.filter((conv) => {
      if (filterTab === 'unsummarized' && conv.alreadySummarized) return false;
      if (filterTab === 'groups' && !conv.isGroup) return false;
      if (filterTab === 'direct' && conv.isGroup) return false;
      if (query && !conv.chatName.toLocaleLowerCase('pt-BR').includes(query)) return false;
      return true;
    });
  }, [request.conversations, search, filterTab]);

  const toggleChat = (chatJid: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(chatJid)) next.delete(chatJid);
      else next.add(chatJid);
      return next;
    });
  };

  const selectAll = () => {
    setSelected(new Set(request.conversations.map((c) => c.chatJid)));
  };

  const selectUnsummarized = () => {
    setSelected(new Set(request.conversations.filter((c) => !c.alreadySummarized).map((c) => c.chatJid)));
  };

  const clearSelection = () => {
    setSelected(new Set());
  };

  const formattedDate = request.date.split('-').reverse().join('/');
  const selectedCount = selected.size;
  const totalCount = request.conversations.length;

  return (
    <div className="pendingReviewBackdrop" role="presentation" onClick={onCancel}>
      <div
        className="pendingReviewDialog chatSelectionDialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="chat-selection-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="pendingReviewHeader">
          <div className="pendingReviewTitleGroup">
            <span className="pendingReviewIcon" aria-hidden="true">💬</span>
            <div>
              <h3 id="chat-selection-title" className="pendingReviewTitle">
                Selecionar conversas para resumir
              </h3>
              <p className="pendingReviewSubtitle">
                Data {formattedDate} • Ordenadas das mais recentes para as mais antigas
              </p>
            </div>
          </div>
          <button
            type="button"
            className="pendingReviewCloseBtn"
            onClick={onCancel}
            aria-label="Fechar seleção de conversas"
          >
            ✕
          </button>
        </div>

        <div className="pendingReviewBody chatSelectionBody">
          {request.hasExistingSummary && (
            <div className="chatSelectionModeBar" role="radiogroup" aria-label="Como salvar no resumo desta data">
              <button
                type="button"
                role="radio"
                aria-checked={mode === 'merge'}
                className={`chatSelectionModeBtn ${mode === 'merge' ? 'is-active' : ''}`}
                onClick={() => setMode('merge')}
              >
                + Adicionar ao resumo do dia
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={mode === 'replace'}
                className={`chatSelectionModeBtn ${mode === 'replace' ? 'is-active' : ''}`}
                onClick={() => setMode('replace')}
              >
                Substituir resumo inteiro do dia
              </button>
            </div>
          )}

          <div className="chatSelectionControls">
            <input
              type="search"
              className="chatSelectionSearch"
              placeholder="Buscar conversa ou grupo…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Buscar conversa ou grupo"
            />
            <div className="chatSelectionFilterTabs" role="tablist" aria-label="Filtrar conversas">
              <button
                type="button"
                role="tab"
                aria-selected={filterTab === 'all'}
                className={`chatSelectionTab ${filterTab === 'all' ? 'is-active' : ''}`}
                onClick={() => setFilterTab('all')}
              >
                Todas ({totalCount})
              </button>
              {hasSummarizedAny && (
                <button
                  type="button"
                  role="tab"
                  aria-selected={filterTab === 'unsummarized'}
                  className={`chatSelectionTab ${filterTab === 'unsummarized' ? 'is-active' : ''}`}
                  onClick={() => setFilterTab('unsummarized')}
                >
                  Não resumidas ({request.conversations.filter((c) => !c.alreadySummarized).length})
                </button>
              )}
              <button
                type="button"
                role="tab"
                aria-selected={filterTab === 'groups'}
                className={`chatSelectionTab ${filterTab === 'groups' ? 'is-active' : ''}`}
                onClick={() => setFilterTab('groups')}
              >
                Grupos
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={filterTab === 'direct'}
                className={`chatSelectionTab ${filterTab === 'direct' ? 'is-active' : ''}`}
                onClick={() => setFilterTab('direct')}
              >
                Individuais
              </button>
            </div>
          </div>

          <div className="chatSelectionBulkBar">
            <span className="chatSelectionCount">
              {selectedCount} de {totalCount} selecionada(s)
            </span>
            <div className="chatSelectionBulkActions">
              <button type="button" className="chatSelectionLinkBtn" onClick={selectAll}>
                Selecionar todas
              </button>
              {hasSummarizedAny && (
                <button type="button" className="chatSelectionLinkBtn" onClick={selectUnsummarized}>
                  Só não resumidas
                </button>
              )}
              <button type="button" className="chatSelectionLinkBtn" onClick={clearSelection}>
                Limpar
              </button>
            </div>
          </div>

          {filteredConversations.length === 0 ? (
            <div className="chatSelectionEmpty">
              Nenhuma conversa encontrada com este filtro.
            </div>
          ) : (
            <ul className="chatSelectionList">
              {filteredConversations.map((conv) => {
                const isChecked = selected.has(conv.chatJid);
                return (
                  <li key={conv.chatJid}>
                    <label className={`chatSelectionItem ${isChecked ? 'is-selected' : ''}`}>
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => toggleChat(conv.chatJid)}
                        className="chatSelectionCheckbox"
                      />
                      <div className="chatSelectionItemMain">
                        <div className="chatSelectionItemTop">
                          <span className="chatSelectionItemName">{conv.chatName}</span>
                          <span className="chatSelectionItemTime">{conv.lastTimeLabel}</span>
                        </div>
                        <div className="chatSelectionItemMeta">
                          <span>
                            {conv.messageCount === 1 ? '1 msg' : `${conv.messageCount} msgs`}
                            {conv.audioCount > 0 ? ` • ${conv.audioCount} áudio(s)` : ''}
                          </span>
                          <div className="chatSelectionBadges">
                            {conv.isGroup && <span className="chatSelectionPill is-group">Grupo</span>}
                            {conv.alreadySummarized && (
                              <span className="chatSelectionPill is-done">✓ Já resumida</span>
                            )}
                          </div>
                        </div>
                      </div>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="pendingReviewFooter">
          <span className="pendingReviewFooterNote">
            Apenas os áudios das conversas selecionadas serão baixados e transcritos.
          </span>
          <div className="pendingReviewFooterActions">
            <button
              type="button"
              className="btn btnSecondary pendingReviewFooterBtn"
              onClick={onCancel}
            >
              Cancelar
            </button>
            <button
              type="button"
              className="btn btnPrimary pendingReviewFooterBtn pendingReviewConfirmBtn"
              disabled={selectedCount === 0}
              onClick={() => onConfirm({ selectedChatJids: Array.from(selected), mode: request.hasExistingSummary ? mode : 'replace' })}
            >
              {request.hasExistingSummary && mode === 'merge'
                ? `Adicionar ao resumo (${selectedCount})`
                : `Gerar resumo (${selectedCount})`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
