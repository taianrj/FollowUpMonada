type TrustedOriginInput = {
  requestUrl: string;
  nodeEnv: string | undefined;
  appUrl?: string;
  vercelProductionUrl?: string;
};

function parseConfiguredOrigin(value: string | undefined, requireHttps: boolean) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return null;

  try {
    const url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (requireHttps && url.protocol !== 'https:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function getTrustedAppOrigin(input: TrustedOriginInput) {
  if (input.appUrl !== undefined) {
    return parseConfiguredOrigin(input.appUrl, input.nodeEnv === 'production');
  }

  const vercelOrigin = parseConfiguredOrigin(input.vercelProductionUrl, true);
  if (vercelOrigin) return vercelOrigin;

  if (input.nodeEnv === 'production') return null;
  return parseConfiguredOrigin(new URL(input.requestUrl).origin, false);
}

export function normalizeInternalRedirectPath(value: string | null | undefined) {
  const path = String(value || '/');
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) return '/';
  if (/[^\x20-\x7E]/.test(path)) return '/';
  return path;
}
