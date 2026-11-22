import { describe, expect, it } from 'vitest';
import type { ExtensionMessage } from './contracts';
import { buildSelectableConversations, getInitialSelectedChatJids } from './chat-selection';

const msg = (overrides: Partial<ExtensionMessage> & { id: string; chatJid: string; chatName: string; timestampMs: number }): ExtensionMessage => ({
  senderName: overrides.chatName,
  senderJid: overrides.chatJid,
  fromMe: false,
  type: 'chat',
  text: 'Olá',
  isForwarded: false,
  quotedMessageId: '',
  audio: null,
  ...overrides,
});

describe('chat-selection', () => {
  it('ordena conversas da mais recente para a mais antiga, ignora newsletters e marca já resumidas', () => {
    const messages: ExtensionMessage[] = [
      msg({ id: '1', chatJid: '111@c.us', chatName: 'Antiga', timestampMs: Date.parse('2026-11-12T12:00:00Z') }),
      msg({ id: '2', chatJid: '222@g.us', chatName: 'Grupo Recente', timestampMs: Date.parse('2026-11-12T21:30:00Z'), type: 'ptt', audio: { status: 'not_requested', transcription: null, hash: null, chunks: 0, byteLength: 0, mimetype: 'audio/ogg', expiresAt: null, attempts: 0 } }),
      msg({ id: '3', chatJid: '333@c.us', chatName: 'Meio', timestampMs: Date.parse('2026-11-12T16:15:00Z') }),
      msg({ id: '4', chatJid: '999@newsletter', chatName: 'Canal Ofertas', timestampMs: Date.parse('2026-11-12T22:00:00Z') }),
    ];

    const list = buildSelectableConversations(messages, ['111@c.us']);
    expect(list.map((c) => c.chatName)).toEqual(['Grupo Recente', 'Meio', 'Antiga']);
    expect(list[0]).toMatchObject({ isGroup: true, messageCount: 1, audioCount: 1, lastTimeLabel: '18:30', alreadySummarized: false });
    expect(list[2]).toMatchObject({ isGroup: false, alreadySummarized: true });
  });

  it('seleciona todas na primeira vez do dia e apenas não resumidas nas rodadas seguintes', () => {
    const first = buildSelectableConversations([
      msg({ id: '1', chatJid: 'a@c.us', chatName: 'A', timestampMs: Date.parse('2026-11-12T12:00:00Z') }),
      msg({ id: '2', chatJid: 'b@c.us', chatName: 'B', timestampMs: Date.parse('2026-11-12T13:00:00Z') }),
    ]);
    expect(getInitialSelectedChatJids(first)).toEqual(['b@c.us', 'a@c.us']);

    const second = buildSelectableConversations([
      msg({ id: '1', chatJid: 'a@c.us', chatName: 'A', timestampMs: Date.parse('2026-11-12T12:00:00Z') }),
      msg({ id: '2', chatJid: 'b@c.us', chatName: 'B', timestampMs: Date.parse('2026-11-12T13:00:00Z') }),
    ], ['b@c.us']);
    expect(getInitialSelectedChatJids(second)).toEqual(['a@c.us']);
  });
});
