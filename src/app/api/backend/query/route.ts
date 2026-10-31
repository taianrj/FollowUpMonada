import { currentD1Session, databaseProvider, d1Services } from '@/lib/database/runtime';
import { createD1Database } from '../../../../../whatsapp-service/lib/database/d1';
import { readBoundedJson, validateSameOrigin } from '@/lib/database/http';
import type { DataRequest } from '@/lib/database/protocol';

export async function POST(request: Request) {
  if (!validateSameOrigin(request)) return Response.json({ error: { message: 'Origem nao permitida.' } }, { status: 403 });
  try {
    if (databaseProvider() !== 'd1') return Response.json({ error: { message: 'Provedor indisponivel.' } }, { status: 409 });
    const current = await currentD1Session();
    if (!current) return Response.json({ error: { message: 'Nao autorizado.' } }, { status: 401 });
    const input = await readBoundedJson(request) as DataRequest;
    const { execute } = d1Services();
    const result = await createD1Database({ execute, actor: current.actor }).query(input);
    return Response.json(result, { status: result.error?.code === 'FORBIDDEN' ? 403 : result.error ? 400 : 200, headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return Response.json({ error: { message: 'Servico de dados indisponivel.' } }, { status: 503 });
  }
}
