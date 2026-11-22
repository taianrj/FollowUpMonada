export type WhatsappIntegrationMode = 'baileys' | 'chrome_extension';

// Server configuration only. A disconnect must never select another source.
export function getWhatsappIntegrationMode(value = process.env.WHATSAPP_INTEGRATION_MODE): WhatsappIntegrationMode {
  if (value === undefined || value === '') return 'baileys';
  if (value === 'baileys' || value === 'chrome_extension') return value;
  throw new Error('WHATSAPP_INTEGRATION_MODE deve ser baileys ou chrome_extension.');
}
