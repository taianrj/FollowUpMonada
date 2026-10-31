import { currentD1Session, d1Services } from './runtime';
import { readBoundedJson, validateSameOrigin } from './http';
import { getTrustedAppOrigin } from '@/lib/security/app-origin';
import { normalizeManagedUserRole } from '@/lib/security/roles';
import { normalizeEmail } from '../../../whatsapp-service/lib/database/auth';

export async function manageD1User(request: Request, action: 'create' | 'resend') {
  if (!validateSameOrigin(request)) return Response.json({ error: 'Origem nao permitida.' }, { status: 403 });
  try {
    const session = await currentD1Session();
    if (!session) return Response.json({ error: 'Nao autorizado.' }, { status: 401 });
    if (session.actor.role !== 'admin') return Response.json({ error: 'Acesso negado.' }, { status: 403 });
    const input = await readBoundedJson(request, 8192) as Record<string, unknown>;
    const email = normalizeEmail(input.email);
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    const role = input.role === undefined && action === 'resend' ? null : normalizeManagedUserRole(input.role);
    if (name.length > 160 || (action === 'create' && !name) || (input.role !== undefined && !role) || (action === 'create' && !role)) return Response.json({ error: 'Dados de usuario invalidos.' }, { status: 400 });
    const userId = input.userId === undefined ? undefined : String(input.userId);
    if (userId && !/^[0-9a-f-]{36}$/i.test(userId)) return Response.json({ error: 'Identidade invalida.' }, { status: 400 });
    const origin = getTrustedAppOrigin({ requestUrl: request.url, nodeEnv: process.env.NODE_ENV, appUrl: process.env.APP_URL, vercelProductionUrl: process.env.VERCEL_PROJECT_PRODUCTION_URL });
    if (!origin) return Response.json({ error: 'Origem da aplicacao nao configurada.' }, { status: 503 });
    const { auth, execute } = d1Services();
    const existing = (await execute([{ sql: 'SELECT id,email,email_confirmed_at,last_sign_in_at FROM monada_auth_users WHERE email=?', params: [email] }]))[0].results[0];
    if (userId && (!existing || existing.id !== userId)) return Response.json({ error: 'Identidade e e-mail nao correspondem.' }, { status: 400 });
    const type = existing?.email_confirmed_at || existing?.last_sign_in_at ? 'recovery' : 'invite';
    const result = await auth.generateLink({ email, name, type, userId, role: role || 'collaborator' });
    if (role) await execute([{ sql: 'UPDATE profiles SET role=? WHERE id=?', params: [role, result.user.id] }]);
    if (!existing && name) {
      const { randomUUID } = await import('node:crypto');
      await execute([{ sql: 'INSERT INTO collaborators(id,name) VALUES (?,?) ON CONFLICT(name) DO NOTHING', params: [randomUUID(), name] }]);
    }
    const url = new URL('/login', origin);
    url.searchParams.set('mode', 'reset'); url.searchParams.set('type', type); url.searchParams.set('token_hash', result.token);
    return Response.json({ success: true, link: url.toString(), isNewUser: result.isNewUser, user: result.user }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return Response.json({ error: 'Nao foi possivel preparar o acesso do usuario.' }, { status: 400 });
  }
}
