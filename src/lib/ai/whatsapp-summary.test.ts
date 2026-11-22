import { ThinkingLevel } from '@google/genai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as gemini from './gemini';
import { generateWhatsappSummary } from './whatsapp-summary';
import { buildWhatsappSummarySchema, parseWhatsappSummaryOutput } from './schemas';

const schema = buildWhatsappSummarySchema(['waiting']);
const options = { geminiApiKey: 'summary-test-key', prompt: 'Dados sintéticos', schema, validate: (value: unknown) => parseWhatsappSummaryOutput(value, ['waiting']) };
const json = JSON.stringify({ summaries: [] });
function mockGeneration(generateContent: ReturnType<typeof vi.fn>) {
  vi.spyOn(gemini, 'getGeminiClient').mockReturnValue({ models: { generateContent } } as unknown as ReturnType<typeof gemini.getGeminiClient>);
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('resumo Hydrogen com retries oficiais', () => {
  it('usa somente Hydrogen, raciocínio baixo e política padrão do SDK, preservando schema e auditoria', async () => {
    const generateContent = vi.fn().mockResolvedValue({ text: json, modelVersion: 'gemini-4-hydrogen' }); mockGeneration(generateContent);
    expect(await generateWhatsappSummary(options)).toMatchObject({ provider: 'gemini', model: 'gemini-4-hydrogen', data: { summaries: [] } });
    expect(generateContent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      model: 'gemini-4-hydrogen', contents: options.prompt,
      config: expect.objectContaining({ responseMimeType: 'application/json', responseJsonSchema: schema, thinkingConfig: { thinkingLevel: ThinkingLevel.LOW }, httpOptions: { retryOptions: {}, timeout: 60000 }, abortSignal: expect.any(AbortSignal) }),
    }));
  });
  it('não adiciona retry ou fallback da aplicação depois que o SDK falha', async () => {
    const generateContent = vi.fn().mockRejectedValue(Object.assign(new Error('private-provider-error'), { status: 503 })); mockGeneration(generateContent);
    const onFailure = vi.fn();
    await expect(generateWhatsappSummary({ ...options, onFailure })).rejects.toMatchObject({ provider: 'gemini', status: 503, category: 'provider_error' });
    expect(generateContent).toHaveBeenCalledOnce(); expect(onFailure).toHaveBeenCalledOnce();
    expect(onFailure.mock.calls[0][0].message).not.toContain('private-provider-error');
  });
  it.each(['invalid-json', '{"summaries":[{"client_id":"invalid"}]}'])('validação continua obrigatória e não dispara nova geração: %s', async text => {
    const generateContent = vi.fn().mockResolvedValue({ text }); mockGeneration(generateContent);
    await expect(generateWhatsappSummary(options)).rejects.toMatchObject({ category: 'invalid_response' });
    expect(generateContent).toHaveBeenCalledOnce();
  });
  it('falha sem chamar o SDK se faltar chave e rejeita resposta vazia', async () => {
    const generateContent = vi.fn().mockResolvedValue({ text: '' }); mockGeneration(generateContent);
    await expect(generateWhatsappSummary({ ...options, geminiApiKey: undefined })).rejects.toMatchObject({ category: 'configuration' });
    expect(generateContent).not.toHaveBeenCalled();
    await expect(generateWhatsappSummary(options)).rejects.toMatchObject({ category: 'empty_response' });
    expect(generateContent).toHaveBeenCalledOnce();
  });
  it('o SDK real repete HTTP 503 no mesmo Hydrogen e encerra após as cinco tentativas padrão', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body)).model).toBeUndefined(); // modelo fica no caminho da API
      expect(String(_url)).toContain('/models/gemini-4-hydrogen:generateContent');
      return Response.json({ error: { code: 503, message: 'Indisponível', status: 'UNAVAILABLE' } }, { status: 503 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = expect(generateWhatsappSummary(options)).rejects.toMatchObject({ status: 503 });
    await vi.advanceTimersByTimeAsync(65000);
    await result;
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });
  it('o SDK real recupera de HTTP 503 sem trocar de modelo e devolve JSON validado', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ error: { code: 503, message: 'Indisponível', status: 'UNAVAILABLE' } }, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ candidates: [{ content: { role: 'model', parts: [{ text: json }] }, finishReason: 'STOP' }], modelVersion: 'gemini-4-hydrogen' }));
    vi.stubGlobal('fetch', fetchMock);
    const result = expect(generateWhatsappSummary(options)).resolves.toMatchObject({ model: 'gemini-4-hydrogen', data: { summaries: [] } });
    await vi.advanceTimersByTimeAsync(2500); await result;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([url]) => String(url).includes('/models/gemini-4-hydrogen:generateContent'))).toBe(true);
  });
  it('o SDK real não repete HTTP 400', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ error: { code: 400, message: 'Requisição inválida', status: 'INVALID_ARGUMENT' } }, { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(generateWhatsappSummary(options)).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
