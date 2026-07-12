import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const componentSource = readFileSync(
  new URL('./WhatsappSummaryClient.tsx', import.meta.url),
  'utf8'
);
const dashboardCss = readFileSync(new URL('./Dashboard.css', import.meta.url), 'utf8');

describe('WhatsappSummaryClient responsive layout', () => {
  it('identifies the saved summaries section clearly', () => {
    expect(componentSource).toContain('>Resumos Salvos</h3>');
    expect(componentSource).not.toContain('>Histórico Diário</h3>');
  });

  it('keeps the current desktop grid as the base layout', () => {
    expect(dashboardCss).toMatch(
      /\.whatsappSummaryMain\s*\{[^}]*grid-template-columns:\s*300px minmax\(0, 1fr\);[^}]*gap:\s*2rem;[^}]*padding:\s*2\.5rem;/s
    );
  });

  it('collapses the page and its fixed-height panels on tablet and mobile', () => {
    expect(dashboardCss).toMatch(
      /@media \(max-width: 1024px\)[\s\S]*?\.whatsappSummaryMain\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);[^}]*height:\s*auto;/
    );
    expect(dashboardCss).toMatch(
      /@media \(max-width: 768px\)[\s\S]*?\.whatsappSummaryHistoryList\s*\{[^}]*display:\s*none !important;/
    );
    expect(dashboardCss).toMatch(
      /@media \(max-width: 768px\)[\s\S]*?\.whatsappSummaryMobileHistoryPicker\s*\{[^}]*display:\s*flex;/
    );
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

  it('places the compact mobile history after the new-summary action bar', () => {
    expect(componentSource).toContain('whatsappSummaryMobileHistoryPicker');
    expect(componentSource).toContain('Selecionar outro resumo');
    expect(componentSource).toContain('activeSavedSummary');
    expect(dashboardCss).toMatch(
      /\.whatsappSummaryWorkspace > \.whatsappSummaryActionBar\s*\{\s*order:\s*2;/
    );
    expect(dashboardCss).toMatch(
      /\.whatsappSummaryHistoryPanel\s*\{[^}]*order:\s*3;/
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
});
