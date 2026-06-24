import { NextResponse } from 'next/server';
import { createClient as createServerClient } from '@/lib/supabase/server';
import { createClient } from '@supabase/supabase-js';

export async function POST(request: Request) {
  try {
    const supabase = await createServerClient();

    // 1. Verifica se usuário está autenticado
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
    }

    // 2. Valida se o usuário é um Administrador
    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single();

    if (!profile || profile.role !== 'admin') {
      return NextResponse.json({ error: 'Acesso negado. Apenas administradores podem gerenciar convites.' }, { status: 403 });
    }

    const { userId, email, name, role } = await request.json();

    if (!email || !email.trim()) {
      return NextResponse.json({ error: 'E-mail do usuário obrigatório.' }, { status: 400 });
    }

    // 3. Inicializa o cliente Supabase Admin (Service Role)
    const supabaseAdmin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false
        }
      }
    );

    // 4. Verifica se o usuário já confirmou sua conta anteriormente no Auth para decidir o tipo de link a gerar
    let isConfirmed = false;
    let authUser: any = null;

    if (userId) {
      const { data: { user }, error: getUserError } = await supabaseAdmin.auth.admin.getUserById(userId);
      if (!getUserError && user) {
        authUser = user;
        isConfirmed = !!user.email_confirmed_at || !!user.last_sign_in_at;
      }
    }

    // 5. Configura redirecionamento para definição de senha
    const origin = new URL(request.url).origin;
    const redirectTo = `${origin}/login?mode=reset`;

    const type = isConfirmed ? 'recovery' : 'invite';
    let linkData: any = null;
    let linkError: any = null;

    if (type === 'invite') {
      const { data, error } = await supabaseAdmin.auth.admin.generateLink({
        type: 'invite',
        email: email.trim(),
        options: {
          redirectTo,
          data: {
            name: (name || '').trim(),
            role: role || 'collaborator'
          }
        }
      });
      linkData = data;
      linkError = error;
    } else {
      const { data, error } = await supabaseAdmin.auth.admin.generateLink({
        type: 'recovery',
        email: email.trim(),
        options: {
          redirectTo
        }
      });
      linkData = data;
      linkError = error;
    }

    if (linkError) {
      return NextResponse.json({ error: `Erro ao gerar link de ${type}: ` + linkError.message }, { status: 500 });
    }

    const actionLink = linkData?.properties?.action_link;
    if (!actionLink) {
      return NextResponse.json({ error: 'Não foi possível obter o link de acesso.' }, { status: 500 });
    }

    return NextResponse.json({ 
      success: true, 
      link: actionLink, 
      isNewUser: !isConfirmed 
    });
  } catch (error: any) {
    console.error('Erro na API de reenvio de convite:', error);
    return NextResponse.json({ error: error.message || 'Erro interno do servidor.' }, { status: 500 });
  }
}
