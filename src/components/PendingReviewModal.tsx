'use client';

import { useEffect, useRef, useState } from 'react';
import type { ExtensionJob } from '@/lib/whatsapp-extension/contracts';
import type { PendingReviewData } from '@/lib/whatsapp-extension/pending-review';

interface PendingReviewModalProps {
  review: PendingReviewData;
  onReadAudio: (jobId: string, messageId: string) => Promise<{ base64: string; mimetype: string; byteLength: number }>;
  onToggleIgnoreAudio: (jobId: string, messageId: string, ignored: boolean) => Promise<ExtensionJob>;
  onConfirm: () => void;
  onCancel: () => void;
}

const ALLOWED_AUDIO_MIME = /^audio\/(ogg|opus|mpeg|mp4|aac|wav|webm)$/;

function decodeBase64ToBlobUrl(base64: string, mimetype: string): string {
  const safeMime = ALLOWED_AUDIO_MIME.test(mimetype) ? mimetype : 'audio/ogg';
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const blob = new Blob([bytes], { type: safeMime });
  return URL.createObjectURL(blob);
}

export function PendingReviewModal({ review, onReadAudio, onToggleIgnoreAudio, onConfirm, onCancel }: PendingReviewModalProps) {
  const [audioUrls, setAudioUrls] = useState<Record<string, string>>({});
  const [loadingAudio, setLoadingAudio] = useState<Record<string, boolean>>({});
  const [audioErrors, setAudioErrors] = useState<Record<string, string>>({});
  const [ignoredMap, setIgnoredMap] = useState<Record<string, boolean>>({});
  const [togglingMap, setTogglingMap] = useState<Record<string, boolean>>({});
  const [remainingPendingCount, setRemainingPendingCount] = useState<number>(review.pendingAudioCount);
  const urlsRef = useRef<string[]>([]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onCancel]);

  useEffect(() => {
    const createdUrls = urlsRef.current;
    return () => {
      for (const url of createdUrls) {
        URL.revokeObjectURL(url);
      }
    };
  }, []);

  const handleLoadAudio = async (messageId: string) => {
    if (audioUrls[messageId] || loadingAudio[messageId]) return;
    setLoadingAudio((prev) => ({ ...prev, [messageId]: true }));
    setAudioErrors((prev) => {
      const next = { ...prev };
      delete next[messageId];
      return next;
    });
    try {
      const data = await onReadAudio(review.jobId, messageId);
      const url = decodeBase64ToBlobUrl(data.base64, data.mimetype);
      urlsRef.current.push(url);
      setAudioUrls((prev) => ({ ...prev, [messageId]: url }));
    } catch (err) {
      setAudioErrors((prev) => ({
        ...prev,
        [messageId]: err instanceof Error ? err.message : 'Não foi possível carregar o áudio local.',
      }));
    } finally {
      setLoadingAudio((prev) => ({ ...prev, [messageId]: false }));
    }
  };

  const handleToggleIgnore = async (messageId: string) => {
    if (togglingMap[messageId]) return;
    const nextIgnored = !ignoredMap[messageId];
    setTogglingMap((prev) => ({ ...prev, [messageId]: true }));
    setAudioErrors((prev) => {
      const next = { ...prev };
      delete next[messageId];
      return next;
    });
    try {
      const updated = await onToggleIgnoreAudio(review.jobId, messageId, nextIgnored);
      setIgnoredMap((prev) => ({ ...prev, [messageId]: nextIgnored }));
      setRemainingPendingCount(updated.consent.pendingAudio);
    } catch (err) {
      setAudioErrors((prev) => ({
        ...prev,
        [messageId]: err instanceof Error ? err.message : 'Não foi possível atualizar o áudio.',
      }));
    } finally {
      setTogglingMap((prev) => ({ ...prev, [messageId]: false }));
    }
  };

  const formattedDate = review.date.split('-').reverse().join('/');
  const ignoredCount = Object.values(ignoredMap).filter(Boolean).length;
  const allResolved = remainingPendingCount === 0;

  return (
    <div className="pendingReviewBackdrop" role="presentation" onClick={onCancel}>
      <div
        className="pendingReviewDialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pending-review-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="pendingReviewHeader">
          <div className="pendingReviewTitleGroup">
            <span className="pendingReviewIcon" aria-hidden="true">{allResolved ? '✅' : '⚠️'}</span>
            <div>
              <h3 id="pending-review-title" className="pendingReviewTitle">
                {allResolved ? 'Pendências resolvidas' : 'Gerar resumo com pendências?'}
              </h3>
              <p className="pendingReviewSubtitle">
                Coleta de {formattedDate} • Confira os áudios não transcritos antes de prosseguir
              </p>
            </div>
          </div>
          <button
            type="button"
            className="pendingReviewCloseBtn"
            onClick={onCancel}
            aria-label="Fechar revisão de pendências"
          >
            ✕
          </button>
        </div>

        <div className="pendingReviewBody">
          <section className="pendingReviewSection" aria-label="Áudios não transcritos">
            <div className="pendingReviewSectionHeader">
              <h4 className="pendingReviewSectionTitle">🎙️ Áudios não transcritos</h4>
              <span className={`pendingReviewBadge ${allResolved ? 'is-resolved' : 'is-warning'}`}>
                {allResolved
                  ? `${ignoredCount} ignorado(s) • 0 pendentes`
                  : `${remainingPendingCount} de ${review.audioTotal} áudio(s)`}
              </span>
            </div>
            <p className="pendingReviewHint">
              {allResolved
                ? 'Todos os áudios com falha foram ignorados. O resumo será gerado sem ressalvas.'
                : 'Você pode ouvir o áudio e marcá-lo como ignorado se não precisar dele no resumo (ex.: música ou ruído).'}
            </p>

            {review.pendingAudios.length > 0 && (
              <ul className="pendingReviewList">
                {review.pendingAudios.map((item) => {
                  const isIgnored = Boolean(ignoredMap[item.messageId]);
                  const isToggling = Boolean(togglingMap[item.messageId]);
                  return (
                    <li key={item.messageId} className={`pendingReviewItem ${isIgnored ? 'is-ignored' : ''}`}>
                      <div className="pendingReviewItemTop">
                        <div className="pendingReviewItemMeta">
                          <strong className="pendingReviewItemName">{item.chatName}</strong>
                          <span className="pendingReviewItemSub">
                            {item.senderName} • {item.timeLabel}
                          </span>
                        </div>
                        <span className={`pendingReviewStatusPill ${isIgnored ? 'is-ignored' : `is-${item.status}`}`}>
                          {isIgnored ? 'Ignorado' : item.statusLabel}
                        </span>
                      </div>
                      <p className="pendingReviewItemReason">
                        {isIgnored ? 'Marcado como ignorado; não entrará no resumo e não gerará ressalva.' : item.reason}
                      </p>

                      <div className="pendingReviewAudioBox">
                        {item.canPlay && audioUrls[item.messageId] && (
                          <audio
                            controls
                            autoPlay={!isIgnored}
                            src={audioUrls[item.messageId]}
                            className="pendingReviewAudioPlayer"
                          />
                        )}
                        <div className="pendingReviewItemActions">
                          {item.canPlay && !audioUrls[item.messageId] && (
                            <button
                              type="button"
                              className="btn btnSecondary pendingReviewActionBtn"
                              onClick={() => void handleLoadAudio(item.messageId)}
                              disabled={Boolean(loadingAudio[item.messageId])}
                            >
                              {loadingAudio[item.messageId] ? 'Carregando áudio…' : '▶ Ouvir áudio'}
                            </button>
                          )}
                          <button
                            type="button"
                            className="btn btnSecondary pendingReviewActionBtn"
                            onClick={() => void handleToggleIgnore(item.messageId)}
                            disabled={isToggling}
                          >
                            {isToggling
                              ? 'Salvando…'
                              : isIgnored
                                ? 'Desfazer'
                                : 'Ignorar áudio'}
                          </button>
                        </div>
                        {!item.canPlay && !isIgnored && (
                          <span className="pendingReviewUnavailableNote">
                            Arquivo não está salvo localmente para reprodução.
                          </span>
                        )}
                        {audioErrors[item.messageId] && (
                          <span className="pendingReviewInlineError">{audioErrors[item.messageId]}</span>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>

        <div className="pendingReviewFooter">
          <span className={`pendingReviewFooterNote ${allResolved ? 'is-resolved' : ''}`}>
            {allResolved
              ? 'Todas as pendências foram resolvidas; o resumo será salvo sem ressalvas.'
              : 'A ressalva ficará registrada no resumo salvo.'}
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
              onClick={onConfirm}
            >
              {allResolved ? 'Gerar resumo' : 'Confirmar e gerar resumo'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
