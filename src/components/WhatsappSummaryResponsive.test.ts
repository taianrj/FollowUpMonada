import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const componentSource = readFileSync(
  new URL('./WhatsappSummaryClient.tsx', import.meta.url),
  'utf8'
);
const dashboardCss = readFileSync(new URL('./Dashboard.css', import.meta.url), 'utf8');
const calendarPanelSource = componentSource.slice(
  componentSource.indexOf('<section className="historyPanel'),
  componentSource.indexOf('{/* Área de Trabalho Principal */}')
);

describe('WhatsappSummaryClient responsive layout', () => {
  it('replaces the saved-summary list with a calendar', () => {
    expect(componentSource).toContain('whatsappSummaryCalendarDay');
    expect(componentSource).toContain("hasSummary ? 'hasSummary' : ''");
    expect(componentSource).not.toContain('>Resumos Salvos</h3>');
    expect(componentSource).not.toContain('whatsappSummaryHistoryItem');
  });

  it('shows the selected date while loading the daily conversations', () => {
    expect(componentSource).toContain(
      "`Carregando conversas do dia ${summaryDate.split('-').reverse().join('/')}...`"
    );
    expect(componentSource).not.toContain('Carregando conversas brutas do servidor...');
  });

  it('uses the calendar as the single source for the selected date', () => {
    expect(componentSource).toContain('handleCalendarDateSelect(day.date)');
    expect(componentSource).toContain('setSummaryDate(date)');
    expect(componentSource).toContain('setActiveSummary(savedSummary)');
    expect(calendarPanelSource).not.toContain('type="date"');
    expect(calendarPanelSource).not.toContain('setSummaryDate(prev');
    expect(calendarPanelSource).toContain('Consultar Conversas');
    expect(calendarPanelSource).toContain('Gerar Resumo');
  });

  it('starts directly with the compact calendar and omits redundant copy', () => {
    expect(calendarPanelSource).not.toContain('whatsappSummaryCalendarTitleRow');
    expect(calendarPanelSource).not.toContain('whatsappSummaryCalendarCount');
    expect(calendarPanelSource).not.toContain('whatsappSummaryCalendarLegend');
    expect(calendarPanelSource).not.toContain('Com resumo');
    expect(calendarPanelSource).not.toContain('Consulte as conversas ou gere o primeiro resumo deste dia.');
    expect(calendarPanelSource).not.toContain('O resumo deste dia está disponível para consulta.');
    expect(dashboardCss).toMatch(/\.whatsappSummaryCalendarDay\s*\{[^}]*min-height:\s*2rem;/s);
  });

  it('places calendar actions in the requested vertical order', () => {
    const generateIndex = calendarPanelSource.indexOf('⚡ Gerar Resumo');
    const conversationsIndex = calendarPanelSource.indexOf('👁️ Consultar Conversas');
    const deleteIndex = calendarPanelSource.indexOf('Excluir Resumo');

    expect(generateIndex).toBeGreaterThan(-1);
    expect(generateIndex).toBeLessThan(conversationsIndex);
    expect(conversationsIndex).toBeLessThan(deleteIndex);
    expect(calendarPanelSource).toContain('className="btn whatsappSummaryCalendarDelete"');
    expect(dashboardCss).toMatch(/\.whatsappSummaryCalendarActions\s*\{[^}]*display:\s*grid;/s);
    expect(componentSource).not.toContain('whatsappSummaryActionBar');
  });

  it('distinguishes saved, selected and current dates visually and accessibly', () => {
    expect(componentSource).toContain('aria-selected={isSelected}');
    expect(componentSource).toContain('resumo salvo. Abrir resumo.');
    expect(componentSource).toContain('Sem resumo');
    expect(dashboardCss).toMatch(/\.whatsappSummaryCalendarDay\.hasSummary\s*\{/);
    expect(dashboardCss).toMatch(/\.whatsappSummaryCalendarDay\.selectedDate\s*\{/);
    expect(dashboardCss).toMatch(/\.whatsappSummaryCalendarDay\.today::after\s*\{/);
  });

  it('formats the result heading with date and weekday', () => {
    expect(componentSource).toContain(
      '`Resumo do Dia - ${activeSummaryDate.numeric} - ${activeSummaryDate.weekday}`'
    );
    expect(componentSource).not.toContain('Resumo Semântico do Dia -');
  });

  it('replaces a stale summary with useful error details after a failed attempt', () => {
    expect(componentSource).toContain('{!isLoading && summaryError && (');
    expect(componentSource).toContain('{!isLoading && !summaryError && activeSummary && (');
    expect(componentSource).toContain('{!isLoading && !summaryError && !activeSummary && (');
    expect(componentSource).not.toContain('O resumo anterior foi ocultado');
    expect(componentSource).toContain('Status HTTP');
    expect(componentSource).toContain('Diagnóstico');
    expect(componentSource).toContain('readSummaryResponseError');
    expect(componentSource).toContain('describeUnexpectedSummaryError');
    expect(componentSource).toContain('role="alert"');
    expect(componentSource).toContain('Ver resumo anterior');
    expect(dashboardCss).toMatch(
      /\.whatsappSummaryResultCard,[\s\S]*?\.whatsappSummaryErrorCard,[\s\S]*?padding:\s*1rem !important;/
    );
  });

  it('asks before replacing a saved summary from the same date', () => {
    expect(componentSource).toContain("result?.code === 'SUMMARY_ALREADY_EXISTS'");
    expect(componentSource).toContain("'Substituir resumo existente?'");
    expect(componentSource).toContain('Deseja substituí-lo pelo novo resumo?');
    expect(componentSource).toContain('replaceExisting');
    expect(componentSource).toContain('summary.summary_date !== targetDate');
  });

  it('keeps the current desktop grid as the base layout', () => {
    expect(dashboardCss).toMatch(
      /\.whatsappSummaryMain\s*\{[^}]*grid-template-columns:\s*320px minmax\(0, 1fr\);[^}]*gap:\s*2rem;[^}]*padding:\s*2\.5rem;/s
    );
  });

  it('collapses the page and its fixed-height panels on tablet and mobile', () => {
    expect(dashboardCss).toMatch(
      /@media \(max-width: 1024px\)[\s\S]*?\.whatsappSummaryMain\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);[^}]*height:\s*auto;/
    );
    expect(dashboardCss).toMatch(
      /@media \(max-width: 768px\)[\s\S]*?\.whatsappSummaryCalendarDay\s*\{[^}]*min-height:\s*2\.1rem;/
    );
    expect(dashboardCss).not.toContain('.whatsappSummaryMobileHistoryPicker');
    expect(dashboardCss).toContain("height: calc(100dvh - 2rem) !important;");
  });

  it('places the page heading before the history on mobile without moving the desktop columns', () => {
    expect(componentSource.indexOf('whatsappSummaryPageHeader')).toBeLessThan(
      componentSource.indexOf('whatsappSummaryHistoryPanel')
    );
    expect(dashboardCss).toMatch(
      /grid-template-areas:\s*'history header'\s*'history workspace';/
    );
    expect(dashboardCss).toMatch(
      /@media \(max-width: 1024px\)[\s\S]*?grid-template-areas:\s*'header'\s*'history'\s*'workspace';/
    );
  });

  it('places the calendar before the result content on mobile', () => {
    expect(dashboardCss).toMatch(
      /\.whatsappSummaryHistoryPanel\s*\{[^}]*order:\s*2;/
    );
  });

  it('switches the mobile chat view through React state instead of reading window width during render', () => {
    expect(componentSource).not.toContain('window.innerWidth');
    expect(componentSource).toContain("selectedChatKey ? 'chatSidebarWithSelection' : ''");
    expect(componentSource).toContain("selectedChatKey ? 'chatAreaWithSelection' : ''");
    expect(dashboardCss).toMatch(
      /\.chatSidebarWithSelection,[\s\S]*?\.chatArea:not\(\.chatAreaWithSelection\)\s*\{\s*display:\s*none !important;/
    );
  });

  it('does not expose the legacy WhatsApp service redirect in the browser', () => {
    expect(componentSource).not.toContain('/api/whatsapp-service/redirect');
    expect(componentSource).not.toContain('Acessar serviço (avançado)');
  });
});
