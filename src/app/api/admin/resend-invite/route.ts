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

    // 4. Se tiver userId, verifica se ele já está confirmado no Auth para evitar reenvio desnecessário
    if (userId) {
      const { data: { user: authUser }, error: getUserError } = await supabaseAdmin.auth.admin.getUserById(userId);
      if (!getUserError && authUser) {
        const isConfirmed = !!authUser.email_confirmed_at || !!authUser.last_sign_in_at;
        if (isConfirmed) {
          return NextResponse.json({ 
            error: 'Este usuário já concluiu o cadastro e confirmou sua conta anteriormente. Caso ele tenha esquecido a senha, oriente-o a usar a opção "Esqueci minha senha" na tela de login.' 
          }, { status: 400 });
        }
      }
    }

    // 5. Configura redirecionamento para definição de senha no primeiro acesso
    const origin = new URL(request.url).origin;
    const redirectTo = `${origin}/auth/callback?next=${encodeURIComponent('/login?mode=reset')}`;

    // 6. Envia o convite por e-mail de novo
    const { data: inviteData, error: inviteError } = await supabaseAdmin.auth.admin.inviteUserByEmail(
      email.trim(),
      {
        redirectTo,
        data: {
          name: (name || '').trim(),
          role: role || 'collaborator'
        }
      }
    );

    if (inviteError) {
      if (inviteError.message && inviteError.message.includes('already been registered')) {
        return NextResponse.json({ 
          error: 'Este usuário já concluiu o cadastro e confirmou sua conta anteriormente. Caso ele tenha esquecido a senha, oriente-o a usar a opção "Esqueci minha senha" na tela de login.' 
        }, { status: 400 });
      }
      return NextResponse.json({ error: 'Erro ao reenviar convite no Supabase Auth: ' + inviteError.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, user: inviteData.user });
  } catch (error: any) {
    console.error('Erro na API de reenvio de convite:', error);
    return NextResponse.json({ error: error.message || 'Erro interno do servidor.' }, { status: 500 });
  }
}
