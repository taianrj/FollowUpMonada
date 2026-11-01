'use strict';

const { isValidDate } = require('./message-domain');

function isTranscribedAudio(text) {
  return /^\[[aá]udio transcrito(?:\s|\])/i.test(String(text || '').trim());
}

function getDayReadiness({ date, messages = [], connected = false, historyComplete = false,
  importComplete = false, audioConfigured = false, audioEnabled = true, imagesEnabled = false } = {}) {
  if (!isValidDate(date)) throw new Error('Data inválida');
  const audio = messages.filter(message => message.mediaKind === 'audio'
    || /^\[[aá]udio(?:\s|\])/i.test(String(message.text || '').trim()));
  const pendingAudio = audio.filter(message => !isTranscribedAudio(message.text)).length;
  const pendingImages = imagesEnabled ? messages.filter(message =>
    (['image', 'sticker'].includes(message.mediaKind) || /^\[(?:imagem|figurinha)\]/i.test(String(message.text || '')))
    && !/^\[(?:imagem|figurinha) interpretada(?:\s|\])/i.test(String(message.text || ''))).length : 0;
  let state = 'ready';
  let reason = 'Histórico recebido processado e áudios deste dia transcritos. O WhatsApp não garante o envio de todas as conversas.';
  if (!connected) {
    state = 'disconnected'; reason = 'Aguardando a conexão com o WhatsApp.';
  } else if (!historyComplete || !importComplete) {
    state = 'history_pending'; reason = 'Aguardando a confirmação e o processamento dos lotes de histórico. Receber mensagens de um dia não confirma que ele terminou.';
  } else if (!messages.length) {
    state = 'empty'; reason = 'O histórico recebido não contém mensagens para esta data.';
  } else if (pendingAudio) {
    state = audioEnabled && audioConfigured ? 'audio_pending' : 'audio_unavailable';
    reason = state === 'audio_pending'
      ? `Aguardando a transcrição de ${pendingAudio} áudio(s) deste dia, incluindo retentativas ou falhas ainda não resolvidas.`
      : 'Há áudios sem transcrição. Ative a transcrição e configure o provedor para liberar este dia.';
  } else if (pendingImages) {
    state = 'image_pending'; reason = `Aguardando a interpretação de ${pendingImages} imagem(ns) deste dia.`;
  }
  return { date, state, ready: state === 'ready', messages: messages.length,
    audioTotal: audio.length, audioTranscribed: audio.length - pendingAudio, pendingAudio, pendingImages, reason };
}

async function processInBatches(items, processBatch, { batchSize = 250, isCurrent = () => true } = {}) {
  const size = Math.max(1, Math.min(500, Math.floor(batchSize) || 250));
  for (let offset = 0; offset < items.length; offset += size) {
    if (!isCurrent()) throw new Error('Geração de conexão substituída');
    await processBatch(items.slice(offset, offset + size));
    await new Promise(resolve => setImmediate(resolve));
  }
}

module.exports = { getDayReadiness, isTranscribedAudio, processInBatches };
