import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { buildWhatsappUpstreamUrl, getWhatsappProxyAllowedMethods } from '@/lib/whatsapp/proxy';

const UPSTREAM_TIMEOUT_MS = 30_000;

type ProxyContext = {
  params: Promise<{
    path: string[];
  }>;
};

async function getCurrentAdmin() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return { error: NextResponse.json({ error: 'Nao autorizado' }, { status: 401 }) };
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('id, email, name, role, is_active')
    .eq('id', user.id)
    .single();

  if (!profile || profile.is_active === false || profile.role !== 'admin') {
    return { error: NextResponse.json({ error: 'Acesso negado' }, { status: 403 }) };
  }

  return { user, profile };
}

function getWhatsappServiceBaseUrl() {
  const configuredUrl = (
    process.env.WHATSAPP_SERVICE_URL ||
    process.env.NEXT_PUBLIC_WHATSAPP_SERVICE_URL ||
    ''
  ).trim();
  return configuredUrl ? configuredUrl.replace(/\/$/, '') : null;
}

async function proxyWhatsappRequest(request: NextRequest, context: ProxyContext) {
  const { user, profile, error } = await getCurrentAdmin();
  if (error) return error;

  const { path } = await context.params;
  const servicePath = path.join('/');
  const allowedMethods = getWhatsappProxyAllowedMethods(servicePath);
  if (!allowedMethods) {
    return NextResponse.json({ error: 'Endpoint do WhatsApp nao permitido' }, { status: 404 });
  }
  if (!allowedMethods.has(request.method)) {
    return NextResponse.json(
      { error: 'Metodo nao permitido para este endpoint do WhatsApp' },
      { status: 405, headers: { Allow: [...(allowedMethods || [])].join(', ') } }
    );
  }

  const ownerName = String(profile.name || profile.email?.split('@')[0] || '').trim();
  const serviceBaseUrl = getWhatsappServiceBaseUrl();
  if (!serviceBaseUrl) {
    return NextResponse.json({ error: 'URL do servico do WhatsApp nao configurada' }, { status: 503 });
  }
  const targetUrl = buildWhatsappUpstreamUrl({
    baseUrl: serviceBaseUrl,
    servicePath,
    incomingUrl: request.url
  });

  const headers = new Headers();
  const contentType = request.headers.get('content-type');
  if (contentType) headers.set('content-type', contentType);
  headers.set('x-api-key', user.id);
  if (ownerName) headers.set('x-owner-name', ownerName);

  const serviceToken = process.env.WHATSAPP_SERVICE_SECRET || process.env.WHATSAPP_SERVICE_TOKEN;
  if (!serviceToken) {
    return NextResponse.json({ error: 'Integracao do WhatsApp nao configurada' }, { status: 503 });
  }
  headers.set('x-service-token', serviceToken);

  let upstream: Response;
  try {
    upstream = await fetch(targetUrl, {
      method: request.method,
      headers,
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.text(),
      cache: 'no-store',
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
    });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    return NextResponse.json(
      { error: timedOut ? 'O servico do WhatsApp demorou para responder' : 'Servico do WhatsApp indisponivel' },
      { status: timedOut ? 504 : 502 }
    );
  }

  const responseHeaders = new Headers();
  const upstreamContentType = upstream.headers.get('content-type');
  if (upstreamContentType) {
    responseHeaders.set('content-type', upstreamContentType);
  }
  responseHeaders.set('cache-control', 'no-store');

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders
  });
}

export async function GET(request: NextRequest, context: ProxyContext) {
  return proxyWhatsappRequest(request, context);
}

export async function POST(request: NextRequest, context: ProxyContext) {
  return proxyWhatsappRequest(request, context);
}
