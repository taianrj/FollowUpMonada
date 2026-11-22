import { describe, expect, it } from 'vitest';
import { getWhatsappIntegrationMode } from './integration-mode';

describe('seletor explícito de integração WhatsApp', () => {
  it('mantém Baileys como padrão e não aceita modos desconhecidos', () => {
    expect(getWhatsappIntegrationMode('')).toBe('baileys');
    expect(getWhatsappIntegrationMode('baileys')).toBe('baileys');
    expect(getWhatsappIntegrationMode('chrome_extension')).toBe('chrome_extension');
    expect(() => getWhatsappIntegrationMode('auto')).toThrow();
    expect(() => getWhatsappIntegrationMode(' chrome_extension ')).toThrow();
  });
});
