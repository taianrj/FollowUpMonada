import { databaseProvider } from '../../../../../whatsapp-service/lib/database/config';

export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json({ provider: databaseProvider() }, { headers: { 'Cache-Control': 'no-store' } });
}
