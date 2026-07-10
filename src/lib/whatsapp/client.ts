export type ConversationMessage = {
  time: string;
  sender: string;
  text: string;
};

export type ConversationSection = {
  title: string;
  meta?: string;
  messages: ConversationMessage[];
  notes: string[];
};

export type WhatsappChatMessage = {
  id: string;
  sender: string;
  senderName: string;
  text: string;
  fromMe: boolean;
  timestamp: string;
  isForwarded: boolean;
  quotedMessageId: string;
  quotedMessageSender: string;
  quotedMessageSenderJid: string;
  quotedMessageText: string;
};

export type WhatsappConversation = {
  chatKey: string;
  chatJid: string;
  chatAliases?: string[];
  isGroup: boolean;
  displayName: string;
  routingWarning?: string;
  messages: WhatsappChatMessage[];
};

export type GroupedWhatsappResponse = {
  date: string;
  count: number;
  unresolvedConversations?: number;
  conversations: WhatsappConversation[];
};

export function unescapeConversationMarkdown(value: string) {
  return value
    .replace(/\\([\\`*_[\]{}()#+\-.!>])/g, '$1')
    .replace(/`/g, '');
}

export function parseConversationDisplay(text: string) {
  const sections: ConversationSection[] = [];
  let title = '';
  let current: ConversationSection | null = null;

  text.split(/\r?\n/).forEach((rawLine) => {
    const line = rawLine.trim();
    if (!line) return;

    if (line.startsWith('# ')) {
      title = unescapeConversationMarkdown(line.slice(2));
      return;
    }

    if (line.startsWith('## ')) {
      current = {
        title: unescapeConversationMarkdown(line.slice(3)),
        messages: [],
        notes: []
      };
      sections.push(current);
      return;
    }

    const legacyHeader = line.match(/^--- Conversa com: (.+?)(?: \((.*?)\))? ---$/);
    if (legacyHeader) {
      current = {
        title: legacyHeader[1],
        meta: legacyHeader[2],
        messages: [],
        notes: []
      };
      sections.push(current);
      return;
    }

    if (line.startsWith('_Identificador:') && current) {
      current.meta = unescapeConversationMarkdown(line.replace(/^_Identificador:\s*/, '').replace(/_$/, ''));
      return;
    }

    const markdownMessage = line.match(/^- \*\*(.*?)\*\*([^\*]*?)\*\*(.*?)(?::\*\*|\*\*:) (.*)$/);
    if (markdownMessage && current) {
      current.messages.push({
        time: unescapeConversationMarkdown(markdownMessage[1]),
        sender: unescapeConversationMarkdown(markdownMessage[3]),
        text: unescapeConversationMarkdown(markdownMessage[4])
      });
      return;
    }

    const legacyMessage = rawLine.match(/^\s*\[(.*?)\]\s+([^:]+):\s*(.*)$/);
    if (legacyMessage && current) {
      current.messages.push({
        time: legacyMessage[1],
        sender: legacyMessage[2],
        text: legacyMessage[3]
      });
      return;
    }

    if (current) current.notes.push(unescapeConversationMarkdown(line));
  });

  return {
    title,
    sections: sections.filter((section) => {
      const hasContent = section.messages.length > 0 || section.notes.length > 0;
      const hasValidTitle = section.title && section.title.trim() !== '' && section.title !== 'undefined';
      return hasContent && hasValidTitle;
    })
  };
}

export function isEmptyMessagesPayload(responseText: string, format: 'json_grouped' | 'text') {
  if (format === 'text') return responseText.trim().length === 0;
  try {
    const data = JSON.parse(responseText) as Partial<GroupedWhatsappResponse>;
    return !Array.isArray(data.conversations) || data.conversations.length === 0;
  } catch {
    return false;
  }
}

export function isGroupedWhatsappResponse(value: unknown): value is GroupedWhatsappResponse {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<GroupedWhatsappResponse>;
  return Array.isArray(candidate.conversations) && candidate.conversations.every((conversation) => (
    !!conversation &&
    typeof conversation.chatKey === 'string' &&
    typeof conversation.displayName === 'string' &&
    Array.isArray(conversation.messages)
  ));
}

export function conversationSectionsToChats(sections: ConversationSection[]): WhatsappConversation[] {
  return sections.map((section, sectionIndex) => {
    const chatKey = section.meta || section.title;
    return {
      chatKey,
      chatJid: section.meta ? `${section.meta}@s.whatsapp.net` : '',
      isGroup: section.notes.length > 0 || section.title.includes('Grupo') || section.title.includes('+'),
      displayName: section.title,
      messages: section.messages.map((message, messageIndex) => ({
        id: `${chatKey}-${sectionIndex}-${messageIndex}`,
        sender: message.sender,
        senderName: message.sender,
        text: message.text,
        fromMe: ['você', 'voce'].includes(message.sender.toLowerCase()),
        timestamp: message.time,
        isForwarded: false,
        quotedMessageId: '',
        quotedMessageSender: '',
        quotedMessageSenderJid: '',
        quotedMessageText: ''
      }))
    };
  });
}

export function filterWhatsappConversations(conversations: WhatsappConversation[], query: string) {
  const normalizedQuery = query.trim().toLocaleLowerCase('pt-BR');
  if (!normalizedQuery) return conversations;
  return conversations.filter((conversation) => (
    conversation.displayName.toLocaleLowerCase('pt-BR').includes(normalizedQuery) ||
    conversation.chatKey.toLocaleLowerCase('pt-BR').includes(normalizedQuery) ||
    (conversation.chatAliases || []).some(alias => alias.toLocaleLowerCase('pt-BR').includes(normalizedQuery))
  ));
}

export function formatWhatsappMessageTime(timestamp: string) {
  if (!timestamp) return '';
  if (timestamp.includes('T')) {
    const date = new Date(timestamp);
    if (!Number.isFinite(date.getTime())) return '';
    return date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }
  return timestamp.match(/\d{2}:\d{2}/)?.[0] || timestamp;
}
