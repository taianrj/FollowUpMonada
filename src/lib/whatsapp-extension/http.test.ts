import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ user: 'admin-user' as string | null, role: 'admin', active: true, transcribe: true, saved: false }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({
  auth: { getUser: async () => ({ data: { user: state.user ? { id: state.user } : null } }) },
  from: (table: string) => ({ select() { return this; }, eq() { return this; },
    single: async () => ({ data: table === 'profiles' ? { id: state.user, role: state.role, is_active: state.active, transcribe_audio: state.transcribe } : null, error: null }),
    maybeSingle: async () => ({ data: state.saved ? { id: 'existing' } : null, error: null }),
  })
}) }));
vi.mock('./stateless', () => ({ generateExtensionSummary: vi.fn(), findExtensionSummary: vi.fn() }));
vi.mock('../../../workers/whatsapp-extension/providers.mjs', () => ({ transcribeAudio: vi.fn() }));
import { generateExtensionSummary, findExtensionSummary } from './stateless';
import { transcribeAudio } from '../../../workers/whatsapp-extension/providers.mjs';
import * as server from './server';
import { InputError } from '../../../workers/whatsapp-extension/domain.mjs';
import { GET, POST } from '@/app/api/whatsapp-extension/route';
import { POST as processJob } from '@/app/api/whatsapp-extension/process/route';
const request = (action: string, body: Record<string, unknown> = {}, origin = 'http://localhost:3000', expectedUserId = 'admin-user') => new Request('http://localhost:3000/api/whatsapp-extension', { method: 'POST', headers: { 'Content-Type': 'application/json', origin }, body: JSON.stringify({ action, body, expectedUserId }) });

describe('API autenticada da extensão', () => {
  beforeEach(() => { state.user = 'admin-user'; state.role = 'admin'; state.active = true; state.saved = false; state.transcribe = true; vi.stubEnv('WHATSAPP_INTEGRATION_MODE', 'chrome_extension'); vi.stubEnv('APP_URL', 'http://localhost:3000'); vi.mocked(findExtensionSummary).mockResolvedValue(null); vi.mocked(transcribeAudio).mockResolvedValue('Texto sintético'); vi.spyOn(server, 'extensionBackend').mockResolvedValue({ accepted: true }); });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
  it('exige login e perfil de administrador ativo inclusive na configuração', async () => {
    state.user = null; expect((await GET()).status).toBe(401);
    state.user = 'user'; state.role = 'collaborator'; expect((await POST(request('status'))).status).toBe(403);
    state.role = 'admin'; state.active = false; expect((await POST(request('status'))).status).toBe(403);
    expect(server.extensionBackend).not.toHaveBeenCalled();
  });
  it('identifica a sessão atual e rejeita corpos malformados sem executar o processamento', async () => {
    const config = await (await GET()).json();
    expect(config.userId).toBe('admin-user');
    expect(config.minimumVersion).toBe('1.0.0');
    const invalid = new Request('http://localhost:3000/api/whatsapp-extension', { method: 'POST', headers: { 'Content-Type': 'application/json', origin: 'http://localhost:3000' }, body: '{' });
    expect((await POST(invalid)).status).toBe(400);
    expect(server.extensionBackend).not.toHaveBeenCalled();
  });
  it('bloqueia CSRF, operações internas e modo desativado', async () => {
    expect((await POST(request('status', {}, 'https://untrusted.example'))).status).toBe(403);
    expect((await POST(request('claim'))).status).toBe(410);
    vi.stubEnv('WHATSAPP_INTEGRATION_MODE', 'baileys'); expect((await POST(request('status'))).status).toBe(409);
    expect(server.extensionBackend).not.toHaveBeenCalled();
  });
  it('não aceita mais uploads, filas, opções ou vínculos no servidor', async () => {
    for (const action of ['create', 'append', 'audio', 'seal', 'generate', 'binding', 'settings', 'retry']) {
      const response = await POST(request(action, { userId: 'forged', date: '2026-11-18' }));
      expect(response.status).toBe(410);
      expect((await response.json()).code).toBe('EXTENSION_UPDATE_REQUIRED');
    }
    expect(server.extensionBackend).not.toHaveBeenCalled();
  });
  it('consulta existência de resumo sem gravar e rejeita datas impossíveis', async () => {
    expect((await POST(request('summaryExists', { date: '2026-02-30' }))).status).toBe(400);
    const response = await POST(request('summaryExists', { date: '2026-11-18', userId: 'forged' }));
    expect(await response.json()).toEqual({ exists: false });
    expect(findExtensionSummary).toHaveBeenCalledWith(expect.objectContaining({ user: { id: 'admin-user' } }), '2026-11-18');
    expect(server.extensionBackend).not.toHaveBeenCalled();
  });
  it('transcreve um áudio em memória sem usar a persistência de importações', async () => {
    const response = await POST(request('transcribe', { base64: 'T2dnUw==', mimetype: 'audio/ogg', userId: 'forged' }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ text: 'Texto sintético' });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(transcribeAudio).toHaveBeenCalledWith(expect.any(Uint8Array), 'audio/ogg', expect.anything());
    expect(server.extensionBackend).not.toHaveBeenCalled();
  });
  it('rejeita áudio inválido, tipo indevido e corpo excessivo antes de chamar a IA', async () => {
    vi.mocked(transcribeAudio).mockClear();
    for (const body of [{ base64: '!!!', mimetype: 'audio/ogg' }, { base64: 'T2dnUw==', mimetype: 'text/html' }]) expect((await POST(request('transcribe', body))).status).toBe(400);
    expect((await POST(request('transcribe', { base64: 'A'.repeat(3000001), mimetype: 'audio/ogg' }))).status).toBe(413);
    expect(transcribeAudio).not.toHaveBeenCalled();
  });
  it('descarta a transcrição se a sessão mudar durante a IA', async () => {
    vi.mocked(transcribeAudio).mockImplementationOnce(async () => { state.user = 'other-user'; return 'Texto sintético'; });
    const response = await POST(request('transcribe', { base64: 'T2dnUw==', mimetype: 'audio/ogg' }));
    expect(response.status).toBe(403);
    expect(JSON.stringify(await response.json())).not.toContain('Texto sintético');
  });
  it('bloqueia troca de login entre a configuração e o POST antes de enviar dados à IA', async () => {
    vi.mocked(transcribeAudio).mockClear(); vi.mocked(generateExtensionSummary).mockClear();
    expect((await POST(request('transcribe', { base64: 'T2dnUw==', mimetype: 'audio/ogg' }, 'http://localhost:3000', 'other-user'))).status).toBe(403);
    expect((await POST(request('summarize', {}, 'http://localhost:3000', 'other-user'))).status).toBe(403);
    expect(transcribeAudio).not.toHaveBeenCalled(); expect(generateExtensionSummary).not.toHaveBeenCalled();
  });
  it('envia a geração ao serviço sem estado com o ator autenticado', async () => {
    vi.mocked(generateExtensionSummary).mockResolvedValueOnce(null);
    expect((await POST(request('summarize', { userId: 'forged' }))).status).toBe(200);
    expect(generateExtensionSummary).toHaveBeenCalledWith(expect.objectContaining({ user: { id: 'admin-user' } }), { userId: 'forged' });
    expect(server.extensionBackend).not.toHaveBeenCalled();
  });
  it('callback não aceita sessão de navegador como autorização de processamento', async () => {
    vi.stubEnv('WHATSAPP_EXTENSION_WORKER_SECRET', 'a'.repeat(32));
    const response = await processJob(new Request('http://localhost:3000/api/whatsapp-extension/process', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }));
    expect(response.status).toBe(401);
  });
  it('mostra erros de validação conhecidos e oculta detalhes de falhas inesperadas', async () => {
    vi.mocked(generateExtensionSummary).mockRejectedValueOnce(new InputError('Conversa inválida.', 400, 'INVALID_INPUT'));
    const invalid = await POST(request('summarize'));
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: 'Conversa inválida.', code: 'INVALID_INPUT' });
    vi.mocked(generateExtensionSummary).mockRejectedValueOnce(new Error('private failure'));
    const unexpected = await POST(request('summarize'));
    expect(unexpected.status).toBe(500);
    expect(JSON.stringify(await unexpected.json())).not.toContain('private failure');
  });
});
