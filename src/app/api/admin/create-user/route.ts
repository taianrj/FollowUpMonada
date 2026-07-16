import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import { getTrustedAppOrigin } from '@/lib/security/app-origin';
import { normalizeManagedUserRole } from '@/lib/security/roles';
import { createClient as createServerClient } from '@/lib/supabase/server';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    const role = normalizeManagedUserRole(body?.role);

    if (!EMAIL_PATTERN.test(email) || email.length > 320 || !name || name.length > 160 || !role) {
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
    const redirectTo = new URL('/login?mode=reset', origin).toString();

    const { data: existingProfile, error: profileLookupError } = await supabaseAdmin
      .from('profiles')
      .select('id, email')
      .eq('email', email)
      .maybeSingle();
    if (profileLookupError) {
      console.error('Erro ao consultar perfil para convite:', profileLookupError);
      return NextResponse.json({ error: 'Nao foi possivel consultar o usuario.' }, { status: 502 });
    }

    let linkData;
    let isNewUser = !existingProfile;

    if (existingProfile) {
      const { data, error } = await supabaseAdmin.auth.admin.generateLink({
        type: 'recovery',
        email,
        options: { redirectTo }
      });
      if (error) {
        console.error('Erro ao gerar link de recuperacao:', error);
        return NextResponse.json({ error: 'Nao foi possivel gerar o link de acesso.' }, { status: 502 });
      }
      linkData = data;
    } else {
      const { data, error } = await supabaseAdmin.auth.admin.generateLink({
        type: 'invite',
        email,
        options: { redirectTo, data: { name } }
      });

      if (error && /already (been registered|exists)/i.test(error.message || '')) {
        isNewUser = false;
        const recovery = await supabaseAdmin.auth.admin.generateLink({
          type: 'recovery',
          email,
          options: { redirectTo }
        });
        if (recovery.error) {
          console.error('Erro ao gerar link de recuperacao alternativo:', recovery.error);
          return NextResponse.json({ error: 'Nao foi possivel gerar o link de acesso.' }, { status: 502 });
        }
        linkData = recovery.data;
      } else if (error) {
        console.error('Erro ao gerar link de convite:', error);
        return NextResponse.json({ error: 'Nao foi possivel gerar o convite.' }, { status: 502 });
      } else {
        linkData = data;
      }
    }

    const linkedUserId = linkData?.user?.id;
    const tokenHash = linkData?.properties?.hashed_token;
    const verificationType = linkData?.properties?.verification_type || (isNewUser ? 'invite' : 'recovery');
    if (!linkedUserId || !tokenHash) {
      return NextResponse.json({ error: 'Nao foi possivel preparar o acesso do usuario.' }, { status: 502 });
    }

    // O trigger sempre cria collaborator. Somente esta rota administrativa pode elevar o papel.
    const { error: roleError } = await supabaseAdmin
      .from('profiles')
      .upsert({ id: linkedUserId, email, role }, { onConflict: 'id' });
    if (roleError) {
      console.error('Erro ao aplicar papel administrativo:', roleError);
      return NextResponse.json({ error: 'Nao foi possivel aplicar o papel do usuario.' }, { status: 502 });
    }

    const actionUrl = new URL('/login', origin);
    actionUrl.searchParams.set('mode', 'reset');
    actionUrl.searchParams.set('token_hash', tokenHash);
    actionUrl.searchParams.set('type', verificationType);

    if (isNewUser) {
      const { data: existingCollaborator } = await supabaseAdmin
        .from('collaborators')
        .select('id')
        .eq('name', name)
        .maybeSingle();
      if (!existingCollaborator) {
        const { error } = await supabaseAdmin.from('collaborators').insert({ name });
        if (error) console.error('Erro ao registrar colaborador:', error);
      }
    }

    return NextResponse.json({
      success: true,
      link: actionUrl.toString(),
      isNewUser,
      user: { id: linkedUserId, email }
    });
  } catch (error) {
    console.error('Erro na API de criacao de usuario:', error);
    return NextResponse.json({ error: 'Erro interno do servidor.' }, { status: 500 });
  }
}
