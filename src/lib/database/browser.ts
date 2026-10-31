import { createBrowserClient } from '@supabase/ssr';
import { DataQuery } from '../../../whatsapp-service/lib/database/query';
import type { DataRequest, DataResult } from './protocol';

function nativeClient() {
  return createBrowserClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
}
type Client = ReturnType<typeof nativeClient>;
type UserResult = { data: { user?: { id: string; email?: string } | null }; error: { message: string } | null };
const listeners = new Set<(event: string, session: unknown) => void>();

async function api(path: string, value?: unknown) {
  const response = await fetch(`/api/backend/${path}`, {
    method: value === undefined ? 'GET' : 'POST',
    headers: value === undefined ? {} : { 'Content-Type': 'application/json' },
    credentials: 'same-origin', cache: 'no-store',
    body: value === undefined ? undefined : JSON.stringify(value),
    signal: AbortSignal.timeout(20000)
  });
  const body = await response.json();
  if (!response.ok && !body.error) throw new Error('Servico de dados indisponivel.');
  return body;
}

let selected: Promise<{ provider: string; supabase?: Client }> | undefined;
async function selection() {
  selected ||= api('config').then((config) => {
    if (config.provider === 'd1') return { provider: 'd1' };
    if (config.provider !== 'supabase') throw new Error('Provedor de dados invalido.');
    return { provider: 'supabase', supabase: nativeClient() };
  }).catch(error => { selected = undefined; throw error; });
  return selected;
}

async function execute(request: DataRequest): Promise<DataResult> {
  try {
    const { supabase } = await selection();
    if (!supabase) return await api('query', request);
    let query = supabase.from(request.table).select(request.select || '*', { count: request.count, head: request.head });
    if (['insert','upsert','update'].includes(request.operation) && !request.values) throw new Error('Dados ausentes.');
    if (request.operation === 'insert') query = supabase.from(request.table).insert(request.values!) as unknown as typeof query;
    if (request.operation === 'upsert') query = supabase.from(request.table).upsert(request.values!, { onConflict: request.onConflict }) as unknown as typeof query;
    if (request.operation === 'update') query = supabase.from(request.table).update(request.values as Record<string, unknown>) as unknown as typeof query;
    if (request.operation === 'delete') query = supabase.from(request.table).delete() as unknown as typeof query;
    if (request.operation !== 'select' && request.returning) query = query.select(request.select || '*');
    for (const filter of request.filters || []) query = query.filter(filter.field, filter.operator, filter.value);
    for (const order of request.order || []) query = query.order(order.field, { ascending: order.ascending });
    if (request.limit !== undefined) query = query.range(request.offset || 0, (request.offset || 0) + request.limit - 1);
    if (request.cardinality === 'one') return await query.single();
    if (request.cardinality === 'maybe') return await query.maybeSingle();
    return await query;
  } catch {
    return { data: null, error: { message: 'Nao foi possivel acessar os dados. Tente novamente.' } };
  }
}

async function authCall(method: string, args: unknown[]) {
  try {
    const { supabase } = await selection();
    if (supabase) {
      // Method names originate exclusively in this module, not in a URL or user payload.
      const action = supabase.auth[method as keyof typeof supabase.auth] as (...values: unknown[]) => Promise<unknown>;
      return await action.apply(supabase.auth, args);
    }
    const result: UserResult = await api('auth', { method, args: args.slice(0, 1) });
    if (!result.error && result.data?.user) listeners.forEach(listener => listener(method === 'updateUser' ? 'USER_UPDATED' : 'SIGNED_IN', { user: result.data.user }));
    if (!result.error && method === 'signOut') listeners.forEach(listener => listener('SIGNED_OUT', null));
    return result;
  } catch {
    return { data: { user: null }, error: { message: 'Nao foi possivel acessar a autenticacao. Tente novamente.' } };
  }
}

const client = {
  from: (table: string) => new DataQuery(table, execute),
  auth: {
    getUser: () => authCall('getUser', []),
    signOut: () => authCall('signOut', []),
    signInWithPassword: (input: unknown) => authCall('signInWithPassword', [input]),
    resetPasswordForEmail: (...args: unknown[]) => authCall('resetPasswordForEmail', args),
    verifyOtp: (input: unknown) => authCall('verifyOtp', [input]),
    updateUser: (input: unknown) => authCall('updateUser', [input]),
    setSession: (input: unknown) => authCall('setSession', [input]),
    onAuthStateChange(callback: (event: string, session: unknown) => void) {
      listeners.add(callback);
      let unsubscribe: (() => void) | undefined;
      let cancelled = false;
      selection().then(({ supabase }) => {
        if (cancelled || !supabase) return;
        const result = supabase.auth.onAuthStateChange(callback);
        unsubscribe = () => result.data.subscription.unsubscribe();
      }).catch(() => {});
      return { data: { subscription: { unsubscribe() { cancelled = true; listeners.delete(callback); unsubscribe?.(); } } } };
    }
  }
};

export function createDatabaseBrowserClient(): Client {
  return client as unknown as Client;
}
