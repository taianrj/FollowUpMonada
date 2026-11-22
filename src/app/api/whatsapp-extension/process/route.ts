import { NextResponse } from 'next/server';
import { secretMatches } from '../../../../../workers/whatsapp-extension/worker.mjs';

export const runtime = 'nodejs';
export const maxDuration = 300;
export async function POST(request: Request) {
  if (!await secretMatches(request, process.env.WHATSAPP_EXTENSION_WORKER_SECRET)) return NextResponse.json({ error: 'Não autorizado.' }, { status: 401 });
  return NextResponse.json({ error: 'O processamento agora é feito pela extensão.', code: 'EXTENSION_UPDATE_REQUIRED' }, { status: 410 });
}
