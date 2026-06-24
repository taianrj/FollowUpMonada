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

    // 4. Configura redirecionamento para definição de senha no primeiro acesso
    const origin = new URL(request.url).origin;
    const redirectTo = `${origin}/login?mode=reset`;

    // Verificar se existe no profiles primeiro
    const { data: existingProfile } = await supabaseAdmin
      .from('profiles')
      .select('id, email')
      .eq('email', email.trim())
      .maybeSingle();

    let linkData: any = null;
    let isNewUser = true;

    if (existingProfile) {
      isNewUser = false;
      const { data: recoveryData, error: recoveryError } = await supabaseAdmin.auth.admin.generateLink({
        type: 'recovery',
        email: email.trim(),
        options: {
          redirectTo
        }
      });

      if (recoveryError) {
        return NextResponse.json({ error: 'Erro ao gerar link de recuperação para usuário existente: ' + recoveryError.message }, { status: 500 });
      }
      linkData = recoveryData;
    } else {
      const { data: inviteData, error: inviteError } = await supabaseAdmin.auth.admin.generateLink({
        type: 'invite',
        email: email.trim(),
        options: {
          redirectTo,
          data: {
            name: name.trim(),
            role: role
          }
        }
      });

      if (inviteError) {
        // Fallback caso o usuário já esteja cadastrado no Auth do Supabase mas não no profiles
        if (inviteError.message && (
          inviteError.message.includes('already been registered') || 
          inviteError.message.includes('already exists')
        )) {
          isNewUser = false;
          const { data: recoveryData, error: recoveryError } = await supabaseAdmin.auth.admin.generateLink({
            type: 'recovery',
            email: email.trim(),
            options: {
              redirectTo
            }
          });

          if (recoveryError) {
            return NextResponse.json({ error: 'Erro ao gerar link de recuperação (fallback): ' + recoveryError.message }, { status: 500 });
          }
          linkData = recoveryData;
        } else {
          return NextResponse.json({ error: 'Erro ao gerar link de convite: ' + inviteError.message }, { status: 500 });
        }
      } else {
        linkData = inviteData;
      }
    }

    const tokenHash = linkData?.properties?.hashed_token;
    const verificationType = linkData?.properties?.verification_type || (isNewUser ? 'invite' : 'recovery');
    if (!tokenHash) {
      return NextResponse.json({ error: 'Não foi possível obter o token de acesso.' }, { status: 500 });
    }

    const appActionLink = `${origin}/login?mode=reset&token_hash=${tokenHash}&type=${verificationType}`;

    // 5. Adiciona na lista de colaboradores se for um novo usuário e não estiver cadastrado
    if (isNewUser) {
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
    }

    return NextResponse.json({ 
      success: true, 
      link: appActionLink, 
      isNewUser, 
      user: linkData.user 
    });
  } catch (error: any) {
    console.error('Erro na API de criação de usuário:', error);
    return NextResponse.json({ error: error.message || 'Erro interno do servidor.' }, { status: 500 });
  }
}
