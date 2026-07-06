import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

const ALLOWED_PATHS = new Set([
  'status',
  'settings',
  'qr-code',
  'messages',
  'logout'
]);

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
  return (
    process.env.WHATSAPP_SERVICE_URL ||
    process.env.NEXT_PUBLIC_WHATSAPP_SERVICE_URL ||
    'https://followupmonada.onrender.com'
  ).replace(/\/$/, '');
}

async function proxyWhatsappRequest(request: NextRequest, context: ProxyContext) {
  const { user, profile, error } = await getCurrentAdmin();
  if (error) return error;

  const { path } = await context.params;
  const servicePath = path.join('/');
  if (!ALLOWED_PATHS.has(servicePath)) {
    return NextResponse.json({ error: 'Endpoint do WhatsApp nao permitido' }, { status: 404 });
  }

  const incomingUrl = new URL(request.url);
  const targetUrl = new URL(`${getWhatsappServiceBaseUrl()}/${servicePath}`);

  incomingUrl.searchParams.forEach((value, key) => {
    if (key !== 'key') {
      targetUrl.searchParams.set(key, value);
    }
  });
  targetUrl.searchParams.set('key', user.id);

  const ownerName = String(profile.name || profile.email?.split('@')[0] || '').trim();
  if (ownerName && !targetUrl.searchParams.has('ownerName')) {
    targetUrl.searchParams.set('ownerName', ownerName);
  }

  const headers = new Headers();
  const contentType = request.headers.get('content-type');
  if (contentType) headers.set('content-type', contentType);
  headers.set('x-api-key', user.id);
  if (ownerName) headers.set('x-owner-name', ownerName);

  const serviceToken = process.env.WHATSAPP_SERVICE_SECRET || process.env.WHATSAPP_SERVICE_TOKEN;
  if (serviceToken) {
    headers.set('x-service-token', serviceToken);
  }

  const upstream = await fetch(targetUrl, {
    method: request.method,
    headers,
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.text(),
    cache: 'no-store'
  });

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
