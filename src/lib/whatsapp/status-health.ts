export interface WhatsappStatusHealth {
  consecutiveFailures: number;
  lastSuccessAt: number | null;
}

export const WHATSAPP_STATUS_FAILURE_THRESHOLD = 3;
export const WHATSAPP_STATUS_FAILURE_GRACE_MS = 45_000;

export function createWhatsappStatusHealth(): WhatsappStatusHealth {
  return { consecutiveFailures: 0, lastSuccessAt: null };
}

export function recordWhatsappStatusSuccess(
  state: WhatsappStatusHealth,
  now = Date.now()
): WhatsappStatusHealth {
  return { ...state, consecutiveFailures: 0, lastSuccessAt: now };
}

export function recordWhatsappStatusFailure(
  state: WhatsappStatusHealth,
  now = Date.now(),
  threshold = WHATSAPP_STATUS_FAILURE_THRESHOLD,
  graceMs = WHATSAPP_STATUS_FAILURE_GRACE_MS
): { state: WhatsappStatusHealth; shouldMarkDisconnected: boolean } {
  const next = {
    ...state,
    consecutiveFailures: state.consecutiveFailures + 1
  };
  const hasRecentSuccess = next.lastSuccessAt !== null && now - next.lastSuccessAt < graceMs;

  return {
    state: next,
    shouldMarkDisconnected: next.consecutiveFailures >= threshold && !hasRecentSuccess
  };
}
