import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getTrustedAppOrigin, normalizeInternalRedirectPath } from '@/lib/security/app-origin';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  const next = normalizeInternalRedirectPath(searchParams.get('next'));
  const origin = getTrustedAppOrigin({
    requestUrl: request.url,
    nodeEnv: process.env.NODE_ENV,
    appUrl: process.env.APP_URL,
    vercelProductionUrl: process.env.VERCEL_PROJECT_PRODUCTION_URL
  });

  if (!origin) {
    return NextResponse.json({ error: 'Origem da aplicacao nao configurada' }, { status: 503 });
  }

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    
    if (!error) {
      return NextResponse.redirect(new URL(next, origin));
    }
  }

  // Em caso de erro, redireciona de volta para a tela de login
  return NextResponse.redirect(new URL('/login?error=Falha%20na%20autenticacao', origin));
}
