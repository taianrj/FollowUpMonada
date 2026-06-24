import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({
    request,
  });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          supabaseResponse = NextResponse.next({
            request,
          });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // Recupera o usuário atual de forma segura do Supabase Auth
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const isLoginPage = request.nextUrl.pathname.startsWith('/login');
  const isAuthApi = request.nextUrl.pathname.startsWith('/api/auth');
  const isAuthCallback = request.nextUrl.pathname.startsWith('/auth/callback');
  const isResetMode = request.nextUrl.searchParams.get('mode') === 'reset';
  const isStaticFile = 
    request.nextUrl.pathname.includes('.') || 
    request.nextUrl.pathname.startsWith('/_next');

  // Ignorar arquivos estáticos (CSS, imagens, js interno do next)
  if (isStaticFile) {
    return supabaseResponse;
  }

  // Se não estiver logado e tentar acessar área logada, redireciona para o login
  if (!user && !isLoginPage && !isAuthApi && !isAuthCallback) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    return NextResponse.redirect(url);
  }

  // Se já estiver logado e tentar acessar a tela de login, redireciona para o dashboard principal (a menos que esteja redefinindo a senha)
  if (user && isLoginPage && !isResetMode) {
    const url = request.nextUrl.clone();
    url.pathname = '/';
    return NextResponse.redirect(url);
  }

  // Validações do usuário logado
  if (user) {
    const { data: profile } = await supabase
      .from('profiles')
      .select('role, is_active')
      .eq('id', user.id)
      .single();

    // Se a conta do usuário foi desativada pelo administrador
    if (profile && profile.is_active === false) {
      await supabase.auth.signOut();
      const url = request.nextUrl.clone();
      url.pathname = '/login';
      url.searchParams.set('error', 'Sua conta foi desativada pelo administrador.');
      return NextResponse.redirect(url);
    }

    // Se for acessar a área de admin, valida se o perfil é administrador
    if (request.nextUrl.pathname.startsWith('/admin')) {
      if (!profile || profile.role !== 'admin') {
        const url = request.nextUrl.clone();
        url.pathname = '/';
        return NextResponse.redirect(url);
      }
    }
  }

  return supabaseResponse;
}
