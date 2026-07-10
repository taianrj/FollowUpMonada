import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export const revalidate = 0;

export async function GET(request: NextRequest) {
  // 1. Verifica se o usuário está autenticado e se é administrador
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('id, role, is_active')
    .eq('id', user.id)
    .single();

  if (!profile || profile.is_active === false || profile.role !== 'admin') {
    return NextResponse.json({ error: 'Acesso negado' }, { status: 403 });
  }

  // 2. Obtém a URL base do serviço do WhatsApp
  const serviceBaseUrl = (
    process.env.WHATSAPP_SERVICE_URL ||
    process.env.NEXT_PUBLIC_WHATSAPP_SERVICE_URL ||
    ''
  ).trim().replace(/\/$/, '');

  if (!serviceBaseUrl) {
    return NextResponse.json({ error: 'URL do serviço do WhatsApp não configurada' }, { status: 503 });
  }

  // 3. Obtém o segredo do serviço do WhatsApp
  const serviceToken = process.env.WHATSAPP_SERVICE_SECRET || process.env.WHATSAPP_SERVICE_TOKEN;
  if (!serviceToken) {
    return NextResponse.json({ error: 'Token do serviço do WhatsApp não configurado' }, { status: 503 });
  }

  // 4. Monta a URL de redirecionamento contendo key (UUID) e service_token na query string
  const redirectUrl = `${serviceBaseUrl}/?key=${user.id}&service_token=${encodeURIComponent(serviceToken)}`;

  // 5. Redireciona o usuário para o microsserviço
  return NextResponse.redirect(redirectUrl);
}
