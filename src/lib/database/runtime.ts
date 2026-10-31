import { cookies } from 'next/headers';
import { databaseProvider } from '../../../whatsapp-service/lib/database/config';
import { createD1Transport } from '../../../whatsapp-service/lib/database/transport';
import { createD1Database } from '../../../whatsapp-service/lib/database/d1';
import { createAuthService, cookieName } from '../../../whatsapp-service/lib/database/auth';

export { databaseProvider };

export function d1Services() {
  const execute = createD1Transport();
  return { execute, auth: createAuthService({ execute }) };
}

export async function currentD1Session(allowRecovery = false) {
  const { auth } = d1Services();
  const jar = await cookies();
  return auth.session(jar.get(cookieName)?.value, { allowRecovery });
}

export async function d1ServerClient() {
  const { execute, auth } = d1Services();
  const jar = await cookies();
  const token = jar.get(cookieName)?.value;
  const current = await auth.session(token);
  const db = createD1Database({ execute, actor: current?.actor });
  return {
    ...db,
    auth: {
      getUser: async () => ({ data: { user: current?.user || null }, error: null }),
      signOut: async () => { await auth.signOut(token); return { error: null }; },
      exchangeCodeForSession: async () => ({ error: { message: 'Use o link de acesso do provedor atual.' } })
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (name !== 'match_active_task_embeddings' || !current) return { data: null, error: { message: 'Funcao nao permitida.' } };
      return semanticMatches(db, args);
    }
  };
}

async function semanticMatches(db: ReturnType<typeof createD1Database>, args: Record<string, unknown>) {
  try {
    const vector: unknown = typeof args.query_embedding === 'string' ? JSON.parse(args.query_embedding) : args.query_embedding;
    if (!Array.isArray(vector) || vector.length !== 768 || vector.some(n => typeof n !== 'number' || !Number.isFinite(n))) throw new Error();
    if (typeof args.match_client_id !== 'string' || typeof args.match_embedding_model !== 'string') throw new Error();
    const { cosineSimilarity } = await import('@/lib/ai/embeddings');
    const threshold = typeof args.match_threshold === 'number' && Number.isFinite(args.match_threshold) ? Math.max(-1, Math.min(1, args.match_threshold)) : 0.9;
    const count = typeof args.match_count === 'number' && Number.isInteger(args.match_count) ? Math.max(1, Math.min(50, args.match_count)) : 5;
    // Paginate rather than silently comparing just the first provider page.
    const matches: { id: string; description: string; similarity: number }[] = [];
    for (let offset = 0; ; offset += 200) {
      const result = await db.from('tasks').select('id,description,description_embedding').eq('client_id', args.match_client_id).eq('is_archived', false).eq('description_embedding_model', args.match_embedding_model).order('id').range(offset, offset + 199);
      if (result.error) return result;
      const rows = result.data as { id: string; description: string; description_embedding: string | null }[];
      for (const row of rows) {
        if (!row.description_embedding) continue;
        const stored = JSON.parse(row.description_embedding);
        if (!Array.isArray(stored) || stored.length !== 768 || stored.some(n => typeof n !== 'number' || !Number.isFinite(n))) continue;
        const similarity = cosineSimilarity(vector, stored);
        if (similarity >= threshold) matches.push({ id: row.id, description: row.description, similarity });
      }
      if (rows.length < 200) break;
    }
    return { data: matches.sort((a, b) => b.similarity - a.similarity || a.id.localeCompare(b.id)).slice(0, count), error: null };
  } catch {
    return { data: null, error: { message: 'Parametros de busca semantica invalidos.' } };
  }
}
