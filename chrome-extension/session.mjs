// Executada no mundo ISOLATED da aba do Mônada, com a sessão autenticada dessa
// aba. Nem userId nem uma URL de destino são aceitos como autoridade do cliente.
export async function requestInMonada(origin, action, body, expectedUser) {
  if (location.origin !== origin) return { ok: false, error: 'Abra o Mônada e entre na sua conta para continuar.' };
  try {
    const configResponse = await fetch('/api/whatsapp-extension', { cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.timeout(10000) });
    if (!configResponse.ok) return { ok: false, error: 'Entre no Mônada como administrador para continuar.' };
    const config = await configResponse.json();
    if (config.mode !== 'chrome_extension' || (expectedUser && config.userId !== expectedUser)) return { ok: false, error: 'Sua sessão mudou. Entre na conta correta para continuar.' };
    if (!action) return { ok: true, ...config };
    if (!['transcribe', 'summarize'].includes(action)) return { ok: false, error: 'Operação não permitida.' };
    const response = await fetch('/api/whatsapp-extension', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, body, expectedUserId: config.userId }), signal: AbortSignal.timeout(240000) });
    const result = await response.json();
    // Descarta também a resposta se houve troca de conta durante a chamada.
    const check = await fetch('/api/whatsapp-extension', { cache: 'no-store', signal: AbortSignal.timeout(10000) });
    if (!check.ok || (await check.json()).userId !== config.userId) return { ok: false, error: 'Sua sessão mudou. Entre na conta correta para continuar.' };
    return response.ok ? { ok: true, result } : { ok: false, error: result.error || 'Falha na IA. Tente novamente.', code: result.code };
  } catch { return { ok: false, error: 'Processamento interrompido. Mantenha o Chrome e o Mônada abertos e tente novamente.' }; }
}
export async function authenticatedTab(tabId, origin, expectedUser, action = null, body = {}) {
  const tab = await chrome.tabs.get(tabId);
  if (new URL(tab.url).origin !== origin) throw new Error('Abra o Mônada para continuar.');
  const response = await chrome.scripting.executeScript({ target: { tabId }, world: 'ISOLATED', func: requestInMonada, args: [origin, action, body, expectedUser || null] });
  const result = response?.[0]?.result;
  if (!result?.ok) { const error = new Error(result?.error || 'Não foi possível confirmar sua sessão no Mônada.'); error.code = result?.code; throw error; }
  return action ? result.result : result;
}
