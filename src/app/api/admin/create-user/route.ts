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
      return NextResponse.json({ error: 'Acesso negado. Apenas administradores podem criar usuários.' }, { status: 403 });
    }

    const { email, name, role } = await request.json();

    if (!email || !email.trim() || !name || !name.trim() || !role) {
      return NextResponse.json({ error: 'Campos obrigatórios ausentes.' }, { status: 400 });
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

    // 4. Envia o convite por e-mail
    const origin = new URL(request.url).origin;
    const redirectTo = `${origin}/auth/callback?next=${encodeURIComponent('/login?mode=reset')}`;

    const { data: inviteData, error: inviteError } = await supabaseAdmin.auth.admin.inviteUserByEmail(
      email.trim(),
      {
        redirectTo,
        data: {
          name: name.trim(),
          role: role
        }
      }
    );

    if (inviteError) {
      return NextResponse.json({ error: 'Erro ao convidar usuário no Supabase Auth: ' + inviteError.message }, { status: 500 });
    }

    // 5. Adiciona na lista de colaboradores se não estiver lá
    const { data: existingCollab } = await supabaseAdmin
      .from('collaborators')
      .select('id')
      .eq('name', name.trim())
      .maybeSingle();

    if (!existingCollab) {
      const { error: collabInsertErr } = await supabaseAdmin
        .from('collaborators')
        .insert({ name: name.trim() });
      
      if (collabInsertErr) {
        console.error('Erro ao registrar novo colaborador na lista:', collabInsertErr);
      }
    }

    return NextResponse.json({ success: true, user: inviteData.user });
  } catch (error: any) {
    console.error('Erro na API de criação de usuário:', error);
    return NextResponse.json({ error: error.message || 'Erro interno do servidor.' }, { status: 500 });
  }
}
