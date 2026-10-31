import { cookies } from 'next/headers';
import { databaseProvider, d1Services } from '@/lib/database/runtime';
import { cookieName } from '../../../../../whatsapp-service/lib/database/auth';
import { readBoundedJson, validateSameOrigin } from '@/lib/database/http';
import { getTrustedAppOrigin } from '@/lib/security/app-origin';

export async function POST(request: Request) {
  if (!validateSameOrigin(request)) return Response.json({ error: { message: 'Origem nao permitida.' } }, { status: 403 });
  try {
    if (databaseProvider() !== 'd1') return Response.json({ error: { message: 'Provedor indisponivel.' } }, { status: 409 });
    const input = await readBoundedJson(request, 8192) as { method?: string; args?: unknown[] };
    if (!input || !Array.isArray(input.args) || input.args.length > 1) throw new Error('Requisicao invalida.');
    const { auth } = d1Services();
    const jar = await cookies();
    const token = jar.get(cookieName)?.value;
    const value = input.args[0];
    const object = value && typeof value === 'object' ? value as Record<string, unknown> : {};
    const setSession = (result: { token: string; maxAge: number }) => jar.set(cookieName, result.token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: result.maxAge });
    const headers = { 'Cache-Control': 'no-store' };
    if (input.method === 'getUser') {
      const session = await auth.session(token, { allowRecovery: true });
      return Response.json({ data: { user: session?.user || null }, error: null }, { headers });
    }
    if (input.method === 'signOut') {
      await auth.signOut(token);
      jar.set(cookieName, '', { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: 0 });
      return Response.json({ data: { user: null }, error: null }, { headers });
    }
    if (input.method === 'signInWithPassword') {
      const result = await auth.authenticate(object.email, object.password);
      await auth.signOut(token);
      setSession(result);
      return Response.json({ data: { user: result.user }, error: null }, { headers });
    }
    if (input.method === 'verifyOtp') {
      const result = await auth.verifyOtp(object.token_hash, object.type);
      await auth.signOut(token);
      setSession(result);
      return Response.json({ data: { user: result.user }, error: null }, { headers });
    }
    if (input.method === 'updateUser') {
      const result = await auth.updatePassword(token, object.password);
      setSession(result);
      return Response.json({ data: { user: result.user }, error: null }, { headers });
    }
    if (input.method === 'resetPasswordForEmail') {
      const origin = getTrustedAppOrigin({ requestUrl: request.url, nodeEnv: process.env.NODE_ENV, appUrl: process.env.APP_URL, vercelProductionUrl: process.env.VERCEL_PROJECT_PRODUCTION_URL });
      const emailKey = process.env.RESEND_API_KEY;
      const from = process.env.AUTH_EMAIL_FROM;
      if (!origin || !emailKey || !from) return Response.json({ error: { message: 'Recuperacao por e-mail indisponivel. Solicite um link ao administrador.' } }, { status: 503, headers });
      await auth.requestRecovery(value, async (link: { user: { email: string }; token: string; type: string }) => {
        const url = new URL('/login', origin);
        url.searchParams.set('mode', 'reset'); url.searchParams.set('token_hash', link.token); url.searchParams.set('type', link.type);
        const result = await fetch('https://api.resend.com/emails', {
          method: 'POST', headers: { Authorization: `Bearer ${emailKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from, to: [link.user.email], subject: 'Recuperar acesso ao FollowUp Monada', text: `Use este link em ate 30 minutos para definir sua senha: ${url.toString()}` }),
          signal: AbortSignal.timeout(10000)
        });
        if (!result.ok) throw new Error('Nao foi possivel enviar o e-mail.');
      });
      return Response.json({ data: {}, error: null }, { headers });
    }
    return Response.json({ error: { message: 'Operacao de autenticacao nao permitida.' } }, { status: 400, headers });
  } catch (error) {
    const safe = ['E-mail ou senha invalidos.', 'E-mail invalido.', 'Muitas tentativas. Aguarde alguns minutos.', 'Link invalido ou expirado.', 'Sessao invalida ou expirada.', 'A senha deve ter pelo menos 10 caracteres e no maximo 72 bytes.'];
    const message = error instanceof Error && safe.includes(error.message) ? error.message : 'Nao foi possivel concluir a autenticacao.';
    return Response.json({ data: { user: null }, error: { message } }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
  }
}
