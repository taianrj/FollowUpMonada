import type { ExtensionMessage } from './contracts';

export interface SelectableConversation {
  chatJid: string;
  chatName: string;
  isGroup: boolean;
  messageCount: number;
  audioCount: number;
  lastTimestampMs: number;
  lastTimeLabel: string;
  alreadySummarized: boolean;
}

export interface ChatSelectionRequest {
  date: string;
  conversations: SelectableConversation[];
  hasExistingSummary: boolean;
}

export interface ChatSelectionResult {
  selectedChatJids: string[];
  mode: 'merge' | 'replace';
}

function formatSaoPauloTime(timestampMs: number): string {
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) return '--:--';
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    hour: '2-digit',
    minute: '2-digit',
  }).format(timestampMs);
}

export function buildSelectableConversations(
  messages: ExtensionMessage[],
  summarizedChatJids: string[] = [],
): SelectableConversation[] {
  const summarizedSet = new Set(summarizedChatJids.map((jid) => jid.trim()).filter(Boolean));
  const map = new Map<string, SelectableConversation>();

  for (const message of messages) {
    if (!message.chatJid || message.chatJid.toLowerCase().endsWith('@newsletter')) continue;
    let entry = map.get(message.chatJid);
    if (!entry) {
      entry = {
        chatJid: message.chatJid,
        chatName: (message.chatName || message.chatJid).trim(),
        isGroup: message.chatJid.endsWith('@g.us'),
        messageCount: 0,
        audioCount: 0,
        lastTimestampMs: 0,
        lastTimeLabel: '--:--',
        alreadySummarized: summarizedSet.has(message.chatJid),
      };
      map.set(message.chatJid, entry);
    }
    entry.messageCount += 1;
    if (message.audio || ['audio', 'ptt'].includes(String(message.type || '').toLowerCase())) {
      entry.audioCount += 1;
    }
    if (Number.isFinite(message.timestampMs) && message.timestampMs > entry.lastTimestampMs) {
      entry.lastTimestampMs = message.timestampMs;
      entry.lastTimeLabel = formatSaoPauloTime(message.timestampMs);
    }
  }

  return Array.from(map.values()).sort(
    (a, b) => b.lastTimestampMs - a.lastTimestampMs || a.chatName.localeCompare(b.chatName, 'pt-BR'),
  );
}

export function getInitialSelectedChatJids(conversations: SelectableConversation[]): string[] {
  const hasSummarized = conversations.some((c) => c.alreadySummarized);
  if (!hasSummarized) {
    return conversations.map((c) => c.chatJid);
  }
  return conversations.filter((c) => !c.alreadySummarized).map((c) => c.chatJid);
}
