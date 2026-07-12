import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const componentSource = readFileSync(
  new URL('./WhatsappSummaryClient.tsx', import.meta.url),
  'utf8'
);
const dashboardCss = readFileSync(new URL('./Dashboard.css', import.meta.url), 'utf8');

describe('WhatsappSummaryClient responsive layout', () => {
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
      /@media \(max-width: 768px\)[\s\S]*?\.whatsappSummaryHistoryPanel > \.custom-scroll\s*\{[^}]*flex-direction:\s*row !important;[^}]*overflow-x:\s*auto !important;/
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

  it('switches the mobile chat view through React state instead of reading window width during render', () => {
    expect(componentSource).not.toContain('window.innerWidth');
    expect(componentSource).toContain("selectedChatKey ? 'chatSidebarWithSelection' : ''");
    expect(componentSource).toContain("selectedChatKey ? 'chatAreaWithSelection' : ''");
    expect(dashboardCss).toMatch(
      /\.chatSidebarWithSelection,[\s\S]*?\.chatArea:not\(\.chatAreaWithSelection\)\s*\{\s*display:\s*none !important;/
    );
  });
});
