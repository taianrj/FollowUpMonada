import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import { getTrustedAppOrigin } from '@/lib/security/app-origin';
import { normalizeManagedUserRole } from '@/lib/security/roles';
import { createClient as createServerClient } from '@/lib/supabase/server';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  try {
    const supabase = await createServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Nao autorizado' }, { status: 401 });
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('role, is_active')
      .eq('id', user.id)
      .single();
    if (!profile || profile.is_active === false || profile.role !== 'admin') {
      return NextResponse.json({ error: 'Acesso negado' }, { status: 403 });
    }

    const body = await request.json().catch(() => null);
    const userId = typeof body?.userId === 'string' ? body.userId.trim() : '';
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    const role = body?.role === undefined ? null : normalizeManagedUserRole(body.role);
    if (!EMAIL_PATTERN.test(email) || email.length > 320 || (userId && !UUID_PATTERN.test(userId)) || (body?.role !== undefined && !role)) {
      return NextResponse.json({ error: 'Dados de usuario invalidos.' }, { status: 400 });
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !serviceRoleKey) {
      return NextResponse.json({ error: 'Administracao de usuarios nao configurada.' }, { status: 503 });
    }

    const origin = getTrustedAppOrigin({
      requestUrl: request.url,
      nodeEnv: process.env.NODE_ENV,
      appUrl: process.env.APP_URL,
      vercelProductionUrl: process.env.VERCEL_PROJECT_PRODUCTION_URL
    });
    if (!origin) {
      return NextResponse.json({ error: 'Origem da aplicacao nao configurada.' }, { status: 503 });
    }

    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false }
    });

    let authUser = null;
    if (userId) {
      const result = await supabaseAdmin.auth.admin.getUserById(userId);
      if (result.error || !result.data.user) {
        return NextResponse.json({ error: 'Usuario nao encontrado.' }, { status: 404 });
      }
      authUser = result.data.user;
      if (String(authUser.email || '').toLowerCase() !== email) {
        return NextResponse.json({ error: 'Identidade e e-mail nao correspondem.' }, { status: 400 });
      }
    }

    const isConfirmed = !!authUser?.email_confirmed_at || !!authUser?.last_sign_in_at;
    const type = isConfirmed ? 'recovery' : 'invite';
    const redirectTo = new URL('/login?mode=reset', origin).toString();
    const result = isConfirmed
      ? await supabaseAdmin.auth.admin.generateLink({
          type: 'recovery',
          email,
          options: { redirectTo }
        })
      : await supabaseAdmin.auth.admin.generateLink({
          type: 'invite',
          email,
          options: { redirectTo, data: { name } }
        });
    if (result.error) {
      console.error('Erro ao reenviar convite:', result.error);
      return NextResponse.json({ error: 'Nao foi possivel gerar o link de acesso.' }, { status: 502 });
    }

    const linkedUserId = result.data?.user?.id;
    const tokenHash = result.data?.properties?.hashed_token;
    const verificationType = result.data?.properties?.verification_type || type;
    if (!linkedUserId || !tokenHash) {
      return NextResponse.json({ error: 'Nao foi possivel preparar o acesso do usuario.' }, { status: 502 });
    }

    if (role) {
      const { error } = await supabaseAdmin
        .from('profiles')
        .upsert({ id: linkedUserId, email, role }, { onConflict: 'id' });
      if (error) {
        console.error('Erro ao atualizar papel no reenvio:', error);
        return NextResponse.json({ error: 'Nao foi possivel aplicar o papel do usuario.' }, { status: 502 });
      }
    }

    const actionUrl = new URL('/login', origin);
    actionUrl.searchParams.set('mode', 'reset');
    actionUrl.searchParams.set('token_hash', tokenHash);
    actionUrl.searchParams.set('type', verificationType);

    return NextResponse.json({
      success: true,
      link: actionUrl.toString(),
      isNewUser: !isConfirmed
    });
  } catch (error) {
    console.error('Erro na API de reenvio de convite:', error);
    return NextResponse.json({ error: 'Erro interno do servidor.' }, { status: 500 });
  }
}
