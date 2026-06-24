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

    const { email, name, role } = await request.json();

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

    // 4. Configura redirecionamento para definição de senha no primeiro acesso
    const origin = new URL(request.url).origin;
    const redirectTo = `${origin}/auth/callback?next=${encodeURIComponent('/login?mode=reset')}`;

    // 5. Envia o convite por e-mail de novo
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
      return NextResponse.json({ error: 'Erro ao reenviar convite no Supabase Auth: ' + inviteError.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, user: inviteData.user });
  } catch (error: any) {
    console.error('Erro na API de reenvio de convite:', error);
    return NextResponse.json({ error: error.message || 'Erro interno do servidor.' }, { status: 500 });
  }
}
