import type { WhatsappSummary } from '@/types';
export interface ExtensionMessage {
  id: string; chatJid: string; chatName: string; senderName: string; senderJid: string;
  timestampMs: number; fromMe: boolean; type: string; text: string; isForwarded: boolean; quotedMessageId: string;
  audio: null | { status: string; transcription: string | null; hash: string | null; chunks: number; byteLength: number; mimetype: string; expiresAt: number | null; attempts: number; reason?: string };
}
export interface ExtensionJob {
  id: string; date: string; accountId: string; state: string; transcribeAudio: boolean;
  messageCount: number; audioTotal: number; audioTranscribed: number; audioIgnored?: number; partialChats: number; revision: number;
  error: string | null; errorCode?: string | null; summary: { summaryId: string; localSummary?: WhatsappSummary } | null;
  consent: { pendingAudio: number; partialHistory: boolean; revision: number; required: boolean };
  createdAt: number; messages?: ExtensionMessage[];
}
export interface ExtensionStatus { binding: { accountId: string; linkedAt: number } | null; jobs: ExtensionJob[] }
export interface ExtensionController {
  instruction: string | null; progress: string | null; busy: boolean; available: boolean;
  generate(date: string, options?: { existingIncludedChatJids?: string[]; hasExistingSummary?: boolean }): Promise<WhatsappSummary | null>; conversations(date: string): Promise<ExtensionMessage[]>;
  exportDay(date: string): Promise<ExtensionJob>;
  readPendingAudio(jobId: string, messageId: string): Promise<{ base64: string; mimetype: string; byteLength: number }>;
  setAudioIgnored(jobId: string, messageId: string, ignored: boolean): Promise<ExtensionJob>;
  forget(): Promise<void>; retry(): Promise<void>; restart(): Promise<void>; check(): Promise<void>; updateTranscription(enabled: boolean): Promise<void>;
}
