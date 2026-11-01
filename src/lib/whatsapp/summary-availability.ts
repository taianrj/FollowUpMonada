import { formatSummaryDate, getSaoPauloDateString } from './summary-date';

export function describeMissingSummaryMessages({
  date,
  retentionDays,
  syncStatus,
  now = new Date(),
}: {
  date: string;
  retentionDays: number | null;
  syncStatus: string;
  now?: Date;
}): string {
  const labels = formatSummaryDate(date);
  if (!labels) return 'Data inválida. Selecione uma data no calendário.';

  const missing = `Não há mensagens de clientes armazenadas para ${labels.numeric}.`;
  if (retentionDays !== null && Number.isInteger(retentionDays) && retentionDays > 0) {
    // O primeiro dia da janela pode estar parcialmente disponível. Só excluir
    // da orientação datas inteiras anteriores ao corte no fuso de negócio.
    const firstDate = getSaoPauloDateString(new Date(now.getTime() - retentionDays * 86_400_000));
    if (date < firstDate) {
      return `${missing} Essa data está fora da janela de coleta configurada de ${retentionDays} dias. Reconectar não amplia essa janela. Resumos já salvos continuam disponíveis no calendário.`;
    }
  }
  if (syncStatus !== 'completed') {
    return `${missing} O WhatsApp ainda não confirmou a conclusão do histórico. Aguarde novos lotes e tente novamente; a consulta não reinicia a conexão.`;
  }
  return `${missing} A conclusão da sincronização não garante que o celular enviou mensagens de todos os dias. A conexão foi preservada; confira a data ou consulte um resumo já salvo.`;
}
