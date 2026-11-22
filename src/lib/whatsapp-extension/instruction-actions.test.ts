import { describe, expect, it } from 'vitest';
import { selectChromeInstructionActions } from './instruction-actions';

describe('selectChromeInstructionActions', () => {
  it('mostra apenas ações de instalação/verificação quando falta instalar ou atualizar a extensão', () => {
    expect(
      selectChromeInstructionActions({
        instruction: 'Instale e ative a extensão do Mônada neste Chrome.',
        available: false,
        installUrl: 'https://chromewebstore.google.com/detail/monada',
        jobState: null,
        hasPendingAudio: false,
      }),
    ).toEqual({
      showInstall: true,
      showOpenWhatsapp: false,
      showRecheck: true,
      showRestart: false,
      showRetry: false,
      showInstallHelp: true,
    });
  });

  it('mostra abrir WhatsApp Web e verificar novamente quando falta conectar a aba do WhatsApp', () => {
    expect(
      selectChromeInstructionActions({
        instruction: 'Abra o WhatsApp Web e conecte sua conta.',
        available: false,
        installUrl: 'https://chromewebstore.google.com/detail/monada',
        jobState: null,
        hasPendingAudio: false,
      }),
    ).toEqual({
      showInstall: false,
      showOpenWhatsapp: true,
      showRecheck: true,
      showRestart: false,
      showRetry: false,
      showInstallHelp: false,
    });
  });

  it('mostra reiniciar coleta apenas quando há coleta interrompida em uploading', () => {
    expect(
      selectChromeInstructionActions({
        instruction: 'A coleta foi interrompida.',
        available: true,
        installUrl: null,
        jobState: 'uploading',
        hasPendingAudio: false,
      }),
    ).toEqual({
      showInstall: false,
      showOpenWhatsapp: false,
      showRecheck: false,
      showRestart: true,
      showRetry: false,
      showInstallHelp: false,
    });
  });

  it('mostra tentar novamente transcrições quando há pendência ou falha de áudio', () => {
    expect(
      selectChromeInstructionActions({
        instruction: '2 de 5 áudio(s) não estão transcritos e não entrarão no resumo.',
        available: true,
        installUrl: null,
        jobState: 'awaiting_confirmation',
        hasPendingAudio: true,
      }),
    ).toEqual({
      showInstall: false,
      showOpenWhatsapp: false,
      showRecheck: false,
      showRestart: false,
      showRetry: true,
      showInstallHelp: false,
    });
  });
});
