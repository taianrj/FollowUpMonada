export interface WhatsappDayReadiness {
  date: string;
  state: string;
  ready: boolean;
  messages: number;
  audioTotal: number;
  audioTranscribed: number;
  pendingAudio: number;
  pendingImages?: number;
  reason: string;
}

export function isDayReady(readiness: WhatsappDayReadiness | null, date: string): boolean {
  return readiness?.date === date && readiness.state === 'ready' && readiness.ready === true
    && readiness.messages > 0 && readiness.pendingAudio === 0 && !readiness.pendingImages;
}
