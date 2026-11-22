export type LoadingVisualStepStatus = 'done' | 'active' | 'upcoming';

export interface LoadingVisualStep {
  id: string;
  label: string;
  status: LoadingVisualStepStatus;
}

export function resolveLoadingVisualSteps(options: {
  isChromeIntegration: boolean;
  chromeProgress: string | null;
  loadingStep: number;
}): LoadingVisualStep[] {
  const labels = options.isChromeIntegration
    ? [
        { id: 'collect', label: 'Coleta' },
        { id: 'audio', label: 'Áudios' },
        { id: 'summary', label: 'Resumo' },
      ]
    : [
        { id: 'messages', label: 'Conversas' },
        { id: 'analysis', label: 'Análise IA' },
        { id: 'report', label: 'Relatório' },
      ];

  let activeIndex = 0;

  if (options.isChromeIntegration) {
    const progress = (options.chromeProgress || '').toLocaleLowerCase('pt-BR');
    if (/gerando|salvando o resumo/.test(progress)) {
      activeIndex = 2;
    } else if (/transcrevendo/.test(progress)) {
      activeIndex = 1;
    } else {
      activeIndex = 0;
    }
  } else if (options.loadingStep >= 5) {
    activeIndex = 2;
  } else if (options.loadingStep >= 2) {
    activeIndex = 1;
  }

  return labels.map((step, index) => ({
    ...step,
    status: index < activeIndex ? 'done' : index === activeIndex ? 'active' : 'upcoming',
  }));
}
