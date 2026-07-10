export const WHATSAPP_PROXY_METHODS: Readonly<Record<string, ReadonlySet<string>>> = {
  status: new Set(['GET']),
  settings: new Set(['POST']),
  'qr-code': new Set(['GET']),
  messages: new Set(['GET']),
  logout: new Set(['POST']),
  'maintenance/resync': new Set(['POST'])
};

export function getWhatsappProxyAllowedMethods(servicePath: string) {
  return WHATSAPP_PROXY_METHODS[servicePath] || null;
}

export function buildWhatsappUpstreamUrl(options: {
  baseUrl: string;
  servicePath: string;
  incomingUrl: string;
}) {
  const incomingUrl = new URL(options.incomingUrl);
  const targetUrl = new URL(`${options.baseUrl.replace(/\/$/, '')}/${options.servicePath}`);

  incomingUrl.searchParams.forEach((value, key) => {
    if (!['key', 'ownerName', 'owner_name'].includes(key)) {
      targetUrl.searchParams.set(key, value);
    }
  });
  return targetUrl;
}
