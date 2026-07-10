import { describe, expect, it } from 'vitest';
import {
  conversationSectionsToChats,
  filterWhatsappConversations,
  formatWhatsappMessageTime,
  isEmptyMessagesPayload,
  isGroupedWhatsappResponse,
  parseConversationDisplay,
  type WhatsappConversation
} from './client';

describe('cliente de conversas do WhatsApp', () => {
  it('interpreta o Markdown gerado pelo microsserviço', () => {
    const parsed = parseConversationDisplay([
      '# Conversas de 09/07/2026',
      '',
      '## Arthur Vidal',
      '_Identificador: `4915165158984`_',
      '',
      '- **09/07/2026 08:24** · **Arthur Vidal:** Bom dia',
      '- **09/07/2026 08:25** · **Taian:** Tudo bem?'
    ].join('\n'));

    expect(parsed.title).toBe('Conversas de 09/07/2026');
    expect(parsed.sections).toHaveLength(1);
    expect(parsed.sections[0]).toMatchObject({
      title: 'Arthur Vidal',
      meta: '4915165158984',
      messages: [
        { time: '09/07/2026 08:24', sender: 'Arthur Vidal', text: 'Bom dia' },
        { time: '09/07/2026 08:25', sender: 'Taian', text: 'Tudo bem?' }
      ]
    });
  });

  it('mantem compatibilidade com o formato de texto legado e avisos', () => {
    const parsed = parseConversationDisplay([
      '--- Conversa com: Conversa não identificada (nao-identificada) ---',
      '  [AVISO] Aguardando ressincronização',
      '  [09/07/2026 08:24] Remetente não identificado: Bom dia'
    ].join('\n'));

    expect(parsed.sections[0].meta).toBe('nao-identificada');
    expect(parsed.sections[0].notes).toEqual(['[AVISO] Aguardando ressincronização']);
    expect(parsed.sections[0].messages[0].sender).toBe('Remetente não identificado');
  });

  it('descarta seções vazias e títulos inválidos', () => {
    const parsed = parseConversationDisplay('## undefined\n\n## Vazia');
    expect(parsed.sections).toEqual([]);
  });

  it('detecta payloads vazios sem considerar JSON inválido como vazio', () => {
    expect(isEmptyMessagesPayload('   ', 'text')).toBe(true);
    expect(isEmptyMessagesPayload('{"conversations":[]}', 'json_grouped')).toBe(true);
    expect(isEmptyMessagesPayload('{"conversations":[{"chatKey":"1"}]}', 'json_grouped')).toBe(false);
    expect(isEmptyMessagesPayload('indisponível', 'json_grouped')).toBe(false);
  });

  it('valida a estrutura agrupada antes de atualizar a interface', () => {
    expect(isGroupedWhatsappResponse({
      date: '2026-07-09',
      count: 1,
      conversations: [{ chatKey: '1', displayName: 'Arthur', messages: [] }]
    })).toBe(true);
    expect(isGroupedWhatsappResponse({ conversations: [{ displayName: 'Sem chave', messages: [] }] })).toBe(false);
    expect(isGroupedWhatsappResponse({ conversations: 'invalido' })).toBe(false);
  });

  it('converte o fallback e reconhece mensagens próprias com ou sem acento', () => {
    const sections = parseConversationDisplay([
      '--- Conversa com: Arthur (4915) ---',
      '  [08:24] Arthur: Bom dia',
      '  [08:25] Você: Oi'
    ].join('\n')).sections;
    const [chat] = conversationSectionsToChats(sections);
    expect(chat.chatJid).toBe('4915@s.whatsapp.net');
    expect(chat.messages.map(message => message.fromMe)).toEqual([false, true]);
  });

  it('busca por nome, chave e aliases sem alterar a lista original', () => {
    const conversations: WhatsappConversation[] = [
      {
        chatKey: '4915',
        chatJid: '4915@s.whatsapp.net',
        chatAliases: ['203216780316843@lid'],
        isGroup: false,
        displayName: 'Arthur Vidal',
        messages: []
      },
      {
        chatKey: '120363',
        chatJid: '120363@g.us',
        isGroup: true,
        displayName: 'Equipe',
        messages: []
      }
    ];

    expect(filterWhatsappConversations(conversations, 'arthur')).toEqual([conversations[0]]);
    expect(filterWhatsappConversations(conversations, '203216')).toEqual([conversations[0]]);
    expect(filterWhatsappConversations(conversations, '120363')).toEqual([conversations[1]]);
    expect(filterWhatsappConversations(conversations, '')).toBe(conversations);
  });

  it('formata timestamps ISO e legado e rejeita data inválida', () => {
    expect(formatWhatsappMessageTime('2026-07-09T11:24:36.000Z')).toMatch(/^\d{2}:\d{2}$/);
    expect(formatWhatsappMessageTime('[09/07/2026 08:24]')).toBe('08:24');
    expect(formatWhatsappMessageTime('invalidoT')).toBe('');
    expect(formatWhatsappMessageTime('')).toBe('');
  });
});
