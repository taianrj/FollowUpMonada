import { describe, expect, it } from 'vitest';
import { resolveLoadingVisualSteps } from './loading-steps';

describe('resolveLoadingVisualSteps', () => {
  it('acompanha coleta, áudios e resumo no modo extensão Chrome', () => {
    expect(
      resolveLoadingVisualSteps({
        isChromeIntegration: true,
        chromeProgress: 'Salvando áudio no computador 2/23…',
        loadingStep: 0,
      }),
    ).toEqual([
      { id: 'collect', label: 'Coleta', status: 'active' },
      { id: 'audio', label: 'Áudios', status: 'upcoming' },
      { id: 'summary', label: 'Resumo', status: 'upcoming' },
    ]);

    expect(
      resolveLoadingVisualSteps({
        isChromeIntegration: true,
        chromeProgress: 'Transcrevendo áudios: 4/10.',
        loadingStep: 0,
      }),
    ).toEqual([
      { id: 'collect', label: 'Coleta', status: 'done' },
      { id: 'audio', label: 'Áudios', status: 'active' },
      { id: 'summary', label: 'Resumo', status: 'upcoming' },
    ]);

    expect(
      resolveLoadingVisualSteps({
        isChromeIntegration: true,
        chromeProgress: 'Gerando e salvando o resumo…',
        loadingStep: 0,
      }),
    ).toEqual([
      { id: 'collect', label: 'Coleta', status: 'done' },
      { id: 'audio', label: 'Áudios', status: 'done' },
      { id: 'summary', label: 'Resumo', status: 'active' },
    ]);
  });

  it('acompanha conversas, análise e relatório no modo Baileys', () => {
    expect(
      resolveLoadingVisualSteps({
        isChromeIntegration: false,
        chromeProgress: null,
        loadingStep: 3,
      }),
    ).toEqual([
      { id: 'messages', label: 'Conversas', status: 'done' },
      { id: 'analysis', label: 'Análise IA', status: 'active' },
      { id: 'report', label: 'Relatório', status: 'upcoming' },
    ]);
  });
});
