'use client';

import React, { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Sidebar from './Sidebar';
import { useNotification } from '@/context/NotificationContext';
import { createClient } from '@/lib/supabase/client';
import { Client, Status, Profile, WhatsappSummary, WhatsappClientSummary } from '@/types';
import './Dashboard.css'; // Reutiliza estilos globais de layout e botões

type ConversationMessage = {
  time: string;
  sender: string;
  text: string;
};

type ConversationSection = {
  title: string;
  meta?: string;
  messages: ConversationMessage[];
  notes: string[];
};

function unescapeConversationMarkdown(value: string) {
  return value
    .replace(/\\([\\`*_[\]{}()#+\-.!>])/g, '$1')
    .replace(/`/g, '');
}

function parseConversationDisplay(text: string) {
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

    if (current) {
      current.notes.push(unescapeConversationMarkdown(line));
    }
  });

  const validSections = sections.filter((section) => {
    const hasContent = section.messages.length > 0 || section.notes.length > 0;
    const hasValidTitle = section.title && section.title.trim() !== '' && section.title !== 'undefined';
    return hasContent && hasValidTitle;
  });

  return { title, sections: validSections };
}

function MessageBody({ text }: { text: string }) {
  if (!text.startsWith('[')) return <>{text}</>;

  const closeIndex = text.indexOf(']');
  if (closeIndex <= 0) return <>{text}</>;

  return (
    <>
      <span className="conversationMediaTag">{text.slice(0, closeIndex + 1)}</span>
      {text.slice(closeIndex + 1)}
    </>
  );
}

function ConversationTextViewer({ text }: { text: string }) {
  const cleanText = text.trim();
  const { title, sections } = parseConversationDisplay(cleanText);

  if (!cleanText) {
    return <p className="conversationEmpty">Nenhuma mensagem registrada para esta data.</p>;
  }

  if (sections.length === 0) {
    return <pre className="conversationRawFallback">{text}</pre>;
  }

  return (
    <div className="conversationMarkdownViewer">
      {title && <h4 className="conversationMarkdownTitle">{title}</h4>}
      {sections.map((section, sectionIndex) => (
        <section className="conversationSection" key={`${section.title}-${sectionIndex}`}>
          <div className="conversationSectionHeader">
            <h5>{section.title}</h5>
            {section.meta && <span>{section.meta}</span>}
          </div>
          <div className="conversationMessageList">
            {section.messages.map((message, messageIndex) => (
              <div className="conversationMessageRow" key={`${message.time}-${message.sender}-${messageIndex}`}>
                <span className="conversationMessageTime">{message.time}</span>
                <span className="conversationMessageSender">{message.sender}</span>
                <span className="conversationMessageText">
                  <MessageBody text={message.text} />
                </span>
              </div>
            ))}
            {section.notes.map((note, noteIndex) => (
              <p className="conversationNote" key={`${note}-${noteIndex}`}>{note}</p>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

interface WhatsappSummaryClientProps {
  profile: Profile | null;
  initialClients: Client[];
  initialStatuses: Status[];
  initialSummaries: WhatsappSummary[];
}

export default function WhatsappSummaryClient({
  profile,
  initialClients,
  initialStatuses,
  initialSummaries,
}: WhatsappSummaryClientProps) {
  const router = useRouter();
  const { showToast } = useNotification();
  const supabase = createClient();

  // Estados de navegação e layout
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  // Estados de dados
  const [clients, setClients] = useState<Client[]>(initialClients);
  const [statuses] = useState<Status[]>(initialStatuses);
  const [summaries, setSummaries] = useState<WhatsappSummary[]>(initialSummaries);
  
  // Entrada do usuário
  const [rawText, setRawText] = useState('');
  const [summaryDate, setSummaryDate] = useState('');
  const [saveToDb, setSaveToDb] = useState(true);
  
  // Status de processamento
  const [isLoading, setIsLoading] = useState(false);
  const [loadingStep, setLoadingStep] = useState(0);
  
  // Resumo atualmente exibido na tela
  const [activeSummary, setActiveSummary] = useState<WhatsappSummary | null>(
    initialSummaries.length > 0 ? initialSummaries[0] : null
  );

  // Controle de tarefas já cadastradas na sessão atual para evitar múltiplos cliques
  const [createdTasksKeys, setCreatedTasksKeys] = useState<Record<string, boolean>>({});

  // Elementos de Upload
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  // Estados da integração do WhatsApp
  const [apiUrl, setApiUrl] = useState(process.env.NEXT_PUBLIC_WHATSAPP_SERVICE_URL || 'https://followupmonada.onrender.com');
  const [apiToken, setApiToken] = useState('');
  const [integrationConnected, setIntegrationConnected] = useState(false);
  const [whatsappStatus, setWhatsappStatus] = useState<string>('disconnected');
  
  // Modais de pareamento e visualização de logs
  const [isQrModalOpen, setIsQrModalOpen] = useState(false);
  const [isChoiceModalOpen, setIsChoiceModalOpen] = useState(false);
  const [choiceStep, setChoiceStep] = useState<'options' | 'date'>('options');
  const [autoSummaryEnabled, setAutoSummaryEnabled] = useState(false);
  const [autoSummaryDate, setAutoSummaryDate] = useState('');
  const [transcriptionRunning, setTranscriptionRunning] = useState(false);
  const [transcriptionQueueLength, setTranscriptionQueueLength] = useState(0);
  const [transcriptionCompleted, setTranscriptionCompleted] = useState(0);
  const [transcriptionTotal, setTranscriptionTotal] = useState(0);
  const [waitForTranscriptions, setWaitForTranscriptions] = useState(false);
  const [qrCodeImage, setQrCodeImage] = useState<string | null>(null);
  const [qrStatus, setQrStatus] = useState<string>('waiting'); // 'waiting' | 'qrcode' | 'connected'
  const [isMessagesModalOpen, setIsMessagesModalOpen] = useState(false);
  const [modalMessagesText, setModalMessagesText] = useState<string>('');
  const [chatConversations, setChatConversations] = useState<any[]>([]);
  const [selectedChatKey, setSelectedChatKey] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [isLoadingModalMessages, setIsLoadingModalMessages] = useState(false);
  const [isCheckingStatus, setIsCheckingStatus] = useState(true);
  const [checkAttempts, setCheckAttempts] = useState(0);
  const [connectedUser, setConnectedUser] = useState<{ id: string; name?: string } | null>(null);
  const [whatsappSyncStatus, setWhatsappSyncStatus] = useState<string>('completed'); // 'pending' | 'syncing' | 'completed'
  const [whatsappMessagesCount, setWhatsappMessagesCount] = useState<number>(0);
  const [whatsappContactsCount, setWhatsappContactsCount] = useState<number>(0);

  // Estados para o Modal de Criação de Demanda preenchido
  const [isTaskModalOpen, setIsTaskModalOpen] = useState(false);
  const [modalClientId, setModalClientId] = useState('');
  const [modalDescription, setModalDescription] = useState('');
  const [selectedCollaborators, setSelectedCollaborators] = useState<string[]>([]);
  const [modalStatus, setModalStatus] = useState('');
  const [modalObservations, setModalObservations] = useState('');
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [manualLoading, setManualLoading] = useState(false);
  const [collaborators, setCollaborators] = useState<any[]>([]);
  const [pendingTaskInfo, setPendingTaskInfo] = useState<{
    task: { description: string; responsibles: string[]; status: string; observations: string },
    clientSummary: WhatsappClientSummary,
    taskIndex: number
  } | null>(null);

  const dropdownRef = useRef<HTMLDivElement>(null);
  const hasShownSuccessToastRef = useRef(false);

  const whatsappOwnerName = (profile?.name || profile?.email?.split('@')[0] || '').trim();
  const ownerNameQuery = whatsappOwnerName ? `&ownerName=${encodeURIComponent(whatsappOwnerName)}` : '';
  const whatsappHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(whatsappOwnerName ? { 'x-owner-name': whatsappOwnerName } : {})
  };

  // Efeito para fechar o dropdown customizado de responsáveis ao clicar fora
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, []);

  // Carrega os colaboradores do banco de dados na inicialização
  useEffect(() => {
    const fetchCollaborators = async () => {
      const { data, error } = await supabase
        .from('collaborators')
        .select('*')
        .order('name', { ascending: true });
      if (!error && data) {
        setCollaborators(data);
      }
    };
    fetchCollaborators();
  }, []);

  // Passos de carregamento animados para entreter o usuário enquanto a IA processa
  const loadingSteps = [
    'Analisando conversas do WhatsApp...',
    'Separando mensagens por interlocutor...',
    'Identificando clientes conhecidos no banco...',
    'Agrupando discussões e tópicos chaves...',
    'Extraindo demandas e prazos implícitos...',
    'Formatando relatório executivo final...'
  ];

  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (isLoading) {
      interval = setInterval(() => {
        setLoadingStep((prev) => (prev + 1) % loadingSteps.length);
      }, 3500);
    } else {
      setLoadingStep(0);
    }
    return () => clearInterval(interval);
  }, [isLoading]);

  // Função para carregar exemplo de dados para teste (Wow factor)
  const handleLoadDemoData = () => {
    const today = new Date().toLocaleDateString('pt-BR');
    const demoMessages = `[09:12, ${today}] Cliente Acme Corp: Olá equipe, analisamos o último briefing. Precisamos que o Carlos crie o novo layout para a tela de login do aplicativo, com foco em design escuro e moderno.
[09:15, ${today}] Carlos: Perfeito! Vou iniciar a criação desse layout hoje mesmo.
[10:30, ${today}] Cliente Acme Corp: Outra coisa importante, Carlos. Precisamos que você envie a planilha de conciliação financeira do mês passado retificada até o fim da tarde. O financeiro está cobrando.
[10:32, ${today}] Carlos: Sem problemas, vou retificar e enviar até às 17h.
[11:00, ${today}] João (Loja de Doces): Olá! Qual o status da demanda da nova campanha do Dia dos Namorados? O banner principal precisa de um ajuste nas cores, está muito apagado. Pode colocar o status como 'ajuste' por favor?
[11:05, ${today}] Carlos: Oi João, tudo bem? Sim, eu mudo o status no painel para ajuste e vou corrigir as cores do banner para destacar mais.
[14:15, ${today}] Suporte Interno: Pessoal, lembrando que na sexta-feira às 22h teremos a manutenção programada para o backup semanal do banco de dados. Favor avisar os clientes se necessário.
[16:20, ${today}] Carlos: Excelente, vou agendar o aviso de backup.`;
    
    setRawText(demoMessages);
    showToast('Dados de demonstração carregados com sucesso!', 'info');
  };

  // Trata a leitura do arquivo enviado
  const handleFileRead = (file: File) => {
    if (file.type !== 'text/plain' && !file.name.endsWith('.txt')) {
      showToast('Por favor, envie apenas arquivos de texto (.txt) exportados do WhatsApp.', 'error');
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      if (text) {
        setRawText(text);
        showToast(`Arquivo "${file.name}" carregado com sucesso (${text.length} caracteres).`, 'success');
      }
    };
    reader.onerror = () => {
      showToast('Erro ao ler o arquivo de conversa.', 'error');
    };
    reader.readAsText(file);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  };

  const handleDragLeave = () => {
    setDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFileRead(e.dataTransfer.files[0]);
    }
  };

  // Prepara e abre o modal intermediário de escolha de autogeração ao tentar conectar o celular
  const handleStartConnection = () => {
    setIsChoiceModalOpen(true);
    setChoiceStep('options');
  };

  // Define a data inicial com base no fuso horário local do computador do usuário para evitar hydration mismatches
  useEffect(() => {
    const getLocalDateString = () => {
      const d = new Date();
      const year = d.getFullYear();
      const month = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    };
    setSummaryDate(getLocalDateString());
  }, []);

  // Sincroniza a chave de segurança com o ID do usuário Supabase logado
  useEffect(() => {
    if (profile?.id) {
      setApiToken(profile.id);
      checkConnectionStatus(apiUrl, profile.id);
    }
  }, [profile]);

  // Monitora e checa o status de conexão com o WhatsApp em segundo plano
  useEffect(() => {
    if (!apiToken) return;
    
    checkConnectionStatus(apiUrl, apiToken);
    
    // Polling a cada 3 segundos na fase de inicialização ou sincronização para atualizar rápido, e a cada 15 segundos depois
    const interval = setInterval(() => {
      checkConnectionStatus(apiUrl, apiToken);
    }, (isCheckingStatus || whatsappSyncStatus !== 'completed') ? 3000 : 15000);
    
    return () => clearInterval(interval);
  }, [apiToken, isCheckingStatus, whatsappSyncStatus, apiUrl]);

  // Efeito de gatilho de autogeração de resumo pós-sincronização
  useEffect(() => {
    if (autoSummaryEnabled && autoSummaryDate && whatsappStatus === 'connected' && whatsappSyncStatus === 'completed') {
      // Se configurado para aguardar transcrições, espera até que a fila de áudios chegue a zero
      if (waitForTranscriptions && (transcriptionQueueLength > 0 || transcriptionRunning)) {
        return; // Aguarda o polling de status atualizar e limpar a fila de áudios
      }

      setAutoSummaryEnabled(false);
      setWaitForTranscriptions(false); // Reset para futuros agendamentos
      setSummaryDate(autoSummaryDate);
      
      const dateToGenerate = autoSummaryDate;
      setAutoSummaryDate('');
      
      // Pequeno timeout para aguardar a renderização e o fechamento do modal antes de rodar
      setTimeout(() => {
        handleSyncAndGenerateSummary(dateToGenerate);
      }, 250);
    }
  }, [autoSummaryEnabled, autoSummaryDate, whatsappStatus, whatsappSyncStatus, waitForTranscriptions, transcriptionQueueLength, transcriptionRunning]);

  // Função auxiliar para testar conexão com o WhatsApp
  const checkConnectionStatus = async (url: string, token: string) => {
    const normalizedUrl = url.replace(/\/$/, '');
    try {
      const headers: Record<string, string> = { ...whatsappHeaders };
      headers['x-api-key'] = token;
      
      const response = await fetch(`${normalizedUrl}/status?key=${token}${ownerNameQuery}`, {
        headers: headers
      });
      
      if (response.ok) {
        const data = await response.json();
        setIntegrationConnected(true);
        setWhatsappStatus(data.status);
        setWhatsappSyncStatus(data.syncStatus || 'completed');
        setWhatsappMessagesCount(data.messagesCount || 0);
        setWhatsappContactsCount(data.contactsCount || 0);
        
        if (data.audioTranscription) {
          setTranscriptionRunning(!!data.audioTranscription.running);
          setTranscriptionQueueLength(data.audioTranscription.queueLength || 0);
          setTranscriptionCompleted(data.audioTranscription.completed || 0);
          setTranscriptionTotal(data.audioTranscription.total || 0);
        } else {
          setTranscriptionRunning(false);
          setTranscriptionQueueLength(0);
          setTranscriptionCompleted(0);
          setTranscriptionTotal(0);
        }
        
        // Define os dados do usuário conectado
        if (data.status === 'connected') {
          setConnectedUser(data.user || null);
          setIsCheckingStatus(false);
          setCheckAttempts(0);
        } else if (data.status === 'connecting') {
          // Se o status for conectando, não limpa o usuário para manter a barra verde de conectado no topo sem pulos
          setIsCheckingStatus(false);
          setCheckAttempts(0);
        } else {
          setConnectedUser(null);
          // Se o servidor respondeu, mas não está conectado (ex: qrcode ou disconnected), 
          // significa que o servidor está online e respondendo. Não precisamos continuar checando no spinner.
          setIsCheckingStatus(false);
          setCheckAttempts(0);
        }
      } else {
        handleStatusFailure();
      }
    } catch (e) {
      handleStatusFailure();
    }
  };

  const handleStatusFailure = () => {
    setIntegrationConnected(false);
    setWhatsappStatus('disconnected');
    setConnectedUser(null);
    setWhatsappSyncStatus('completed');
    setWhatsappMessagesCount(0);
    setWhatsappContactsCount(0);
    setTranscriptionRunning(false);
    setTranscriptionQueueLength(0);
    setTranscriptionCompleted(0);
    setTranscriptionTotal(0);
    
    // Tenta carregar até 8 vezes (8 * 3s = 24 segundos) antes de dar timeout do spinner de inicialização
    setCheckAttempts(prev => {
      const next = prev + 1;
      if (next >= 8) {
        setIsCheckingStatus(false);
      }
      return next;
    });
  };

  // Polling para obter o QR Code dinâmico quando o modal está aberto
  useEffect(() => {
    let timer: NodeJS.Timeout;
    
    const pollQr = async () => {
      if (!isQrModalOpen || !apiToken) return;
      
      try {
        const normalizedUrl = apiUrl.replace(/\/$/, '');
        const response = await fetch(`${normalizedUrl}/qr-code?key=${apiToken}${ownerNameQuery}`, {
          headers: whatsappHeaders
        });
        if (response.ok) {
          const data = await response.json();
          setQrStatus(data.status);
          if (data.status === 'qrcode') {
            setQrCodeImage(data.qrCode);
          } else if (data.status === 'connected') {
            if (!hasShownSuccessToastRef.current) {
              hasShownSuccessToastRef.current = true;
              setQrCodeImage(null);
              setIsQrModalOpen(false);
              setIntegrationConnected(true);
              setWhatsappStatus('connected');
              showToast('WhatsApp conectado com sucesso!', 'success');
            }
          } else {
            setQrCodeImage(null);
          }
        }
      } catch (e) {
        console.error('Erro ao buscar status do QR Code:', e);
      }
    };

    if (isQrModalOpen) {
      hasShownSuccessToastRef.current = false;
      pollQr();
      timer = setInterval(pollQr, 3000); // Polling a cada 3 segundos
    } else {
      setQrCodeImage(null);
      setQrStatus('waiting');
    }

    return () => {
      if (timer) clearInterval(timer);
    };
  }, [isQrModalOpen, apiToken, apiUrl]);

  // Função para abrir o modal de conversas coletadas
  const handleOpenMessagesModal = async () => {
    setIsMessagesModalOpen(true);
    setIsLoadingModalMessages(true);
    setModalMessagesText('Carregando conversas brutas do servidor...');
    setChatConversations([]);
    setSelectedChatKey(null);
    setSearchQuery('');

    const normalizedUrl = apiUrl.replace(/\/$/, '');
    try {
      const response = await fetch(`${normalizedUrl}/messages?date=${summaryDate}&format=json_grouped&key=${apiToken}${ownerNameQuery}`, {
        headers: whatsappHeaders
      });
      
      if (response.ok) {
        const contentType = response.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
          const data = await response.json();
          if (data && Array.isArray(data.conversations)) {
            setChatConversations(data.conversations);
            if (data.conversations.length > 0) {
              setSelectedChatKey(data.conversations[0].chatKey);
            }
            setModalMessagesText('');
            return;
          }
        }
        
        // Fallback: Se o backend antigo retornou markdown
        const text = await response.text();
        const trimmedText = text.trim();
        setModalMessagesText(trimmedText ? trimmedText : 'Nenhuma mensagem de clientes registrada para a data selecionada.');
        
        if (trimmedText) {
          const parsed = parseConversationDisplay(trimmedText);
          const conversations = parsed.sections.map((section, idx) => {
            const chatKey = section.meta || section.title;
            return {
              chatKey: chatKey,
              chatJid: section.meta ? `${section.meta}@s.whatsapp.net` : '',
              isGroup: section.notes.length > 0 || section.title.includes('Grupo') || section.title.includes('+'),
              displayName: section.title,
              messages: section.messages.map((m, mIdx) => ({
                id: `${chatKey}-${idx}-${mIdx}`,
                sender: m.sender,
                senderName: m.sender,
                text: m.text,
                fromMe: m.sender.toLowerCase() === 'você' || m.sender.toLowerCase() === 'voce',
                timestamp: m.time
              }))
            };
          });
          setChatConversations(conversations);
          if (conversations.length > 0) {
            setSelectedChatKey(conversations[0].chatKey);
          }
        }
      } else {
        if (response.status === 401) {
          setModalMessagesText('Erro: Chave de segurança inválida ou sessão expirada.');
        } else {
          setModalMessagesText(`Erro ao buscar mensagens do servidor: HTTP ${response.status}`);
        }
      }
    } catch (err: any) {
      setModalMessagesText(`Erro de conexão ao buscar mensagens: ${err.message}`);
    } finally {
      setIsLoadingModalMessages(false);
    }
  };

  // Envia logout para o servidor e zera estados locais
  const handleDisconnect = async () => {
    if (!confirm('Deseja realmente desconectar o seu WhatsApp do servidor?')) return;
    
    const normalizedUrl = apiUrl.replace(/\/$/, '');
    try {
      const response = await fetch(`${normalizedUrl}/logout?key=${apiToken}${ownerNameQuery}`, {
        headers: whatsappHeaders
      });
      if (response.ok) {
        setIntegrationConnected(false);
        setWhatsappStatus('disconnected');
        showToast('WhatsApp desconectado com sucesso!', 'success');
      } else {
        throw new Error('Falha ao desconectar.');
      }
    } catch (err: any) {
      showToast('Erro ao desconectar: ' + err.message, 'error');
    }
  };

  // Busca mensagens e gera o resumo com IA em um único clique
  const handleSyncAndGenerateSummary = async (customDate?: string) => {
    if (!apiToken) {
      showToast('Informe a sua Chave de Segurança nas configurações abaixo para continuar.', 'warning');
      return;
    }

    setIsLoading(true);
    setLoadingStep(0);
    const normalizedUrl = apiUrl.replace(/\/$/, '');
    const targetDate = customDate || summaryDate;
    
    try {
      // Passo 1: Busca mensagens do microsserviço
      const response = await fetch(`${normalizedUrl}/messages?date=${targetDate}&format=text&key=${apiToken}${ownerNameQuery}`, {
        headers: whatsappHeaders
      });
      
      if (!response.ok) {
        if (response.status === 401) {
          throw new Error('Chave de Segurança inválida ou expirada.');
        }
        throw new Error(`Erro ao importar mensagens: HTTP ${response.status}`);
      }
      
      const textMessages = await response.text();
      
      if (textMessages.trim().length === 0) {
        setIsLoading(false);
        showToast(`Nenhuma mensagem de clientes registrada para o dia ${targetDate.split('-').reverse().join('/')}.`, 'warning');
        return;
      }

      setRawText(textMessages);
      setLoadingStep(1); // Passa para o passo de análise da IA
      
      // Passo 2: Executa a geração chamando diretamente a função de processamento estruturada
      await handleGenerateSummary(textMessages, targetDate);
      
    } catch (error: any) {
      setIsLoading(false);
      showToast('Falha no processo: ' + error.message, 'error');
    }
  };

  // Função para tocar um alerta sonoro harmônico e piscar o título da aba caso o usuário esteja em outra aba
  const triggerCompletionAlert = () => {
    // 1. Toca o som de notificação harmônico sutil usando Web Audio API nativa
    try {
      const AudioContext = window.AudioContext || (window as any).webkitAudioContext;
      if (AudioContext) {
        const ctx = new AudioContext();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        
        osc.type = 'sine';
        osc.frequency.setValueAtTime(587.33, ctx.currentTime); // Ré 5 (som suave)
        osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.15); // Lá 5
        
        gain.gain.setValueAtTime(0.12, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.5); // Fade-out em 0.5s
        
        osc.connect(gain);
        gain.connect(ctx.destination);
        
        osc.start();
        osc.stop(ctx.currentTime + 0.5);
      }
    } catch (e) {
      console.error('Falha ao reproduzir áudio de notificação:', e);
    }

    // 2. Se a página estiver em segundo plano (outra aba ou minimizada), pisca o título da aba
    if (document.hidden) {
      const originalTitle = document.title;
      let isAlternate = true;
      
      const interval = setInterval(() => {
        document.title = isAlternate ? '✨ Resumo Pronto! ✨' : originalTitle;
        isAlternate = !isAlternate;
      }, 1000);

      // Para de piscar o título assim que o usuário focar ou mudar a visibilidade de volta para a aba
      const stopBlinking = () => {
        clearInterval(interval);
        document.title = originalTitle;
        window.removeEventListener('focus', stopBlinking);
        document.removeEventListener('visibilitychange', stopBlinking);
      };

      window.addEventListener('focus', stopBlinking);
      document.addEventListener('visibilitychange', stopBlinking);
    }
  };

  // Envia as mensagens para processamento na API do Next.js
  const handleGenerateSummary = async (textOverride?: string, dateOverride?: string) => {
    const textToProcess = textOverride || rawText;
    if (!textToProcess.trim()) {
      showToast('Por favor, forneça o texto das mensagens do WhatsApp para processamento.', 'warning');
      return;
    }

    setIsLoading(true);
    setLoadingStep(textOverride ? 1 : 0); // Se for override, já começa no passo de análise da IA
    const targetDate = dateOverride || summaryDate;

    try {
      const response = await fetch('/api/whatsapp-summary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: textToProcess,
          date: targetDate,
          saveToDb,
          userId: profile?.id
        })
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || 'Erro na requisição');
      }

      showToast(
        result.savedInDb 
          ? 'Resumo gerado e salvo no banco de dados!' 
          : 'Resumo gerado com sucesso (não salvo no banco).', 
        'success'
      );

      // Estrutura um objeto de resumo para a UI
      const newSummary: WhatsappSummary = {
        id: result.summaryId || Math.random().toString(),
        summary_date: targetDate,
        raw_text: textToProcess,
        summary_data: result.data,
        created_by: profile?.id || null,
        created_at: new Date().toISOString()
      };

      // Atualiza a lista de resumos se foi salvo no banco
      if (result.savedInDb) {
        setSummaries(prev => [newSummary, ...prev]);
      }

      setActiveSummary(newSummary);
      setCreatedTasksKeys({}); // Reseta o controle de tarefas criadas
      
      // Atualiza os clientes associados para o Kanban
      const clientsResponse = await fetch('/api/clients');
      if (clientsResponse.ok) {
        const updatedClients = await clientsResponse.json();
        setClients(updatedClients);
      }

      // Dispara o som e o alerta visual na aba do navegador
      triggerCompletionAlert();
    } catch (error: any) {
      console.error(error);
      showToast('Erro ao processar resumo: ' + error.message, 'error');
    } finally {
      setIsLoading(false);
      setLoadingStep(0);
    }
  };

  // Prepara e abre o modal de criação de tarefa sugerida com campos pré-preenchidos
  const handleOpenSuggestedTaskModal = async (
    task: { description: string; responsibles: string[]; status: string; observations: string },
    clientSummary: WhatsappClientSummary,
    taskIndex: number
  ) => {
    const taskKey = `${clientSummary.client_name}-${taskIndex}`;
    if (createdTasksKeys[taskKey]) {
      showToast('Esta demanda já foi criada nesta sessão.', 'info');
      return;
    }

    try {
      let finalClientId = clientSummary.client_id;

      // 1. Se o cliente não estiver cadastrado no banco, criamos ele primeiro!
      if (!finalClientId) {
        showToast(`Cadastrando novo cliente "${clientSummary.client_name}"...`, 'info');
        
        const { data: newClient, error: clientErr } = await supabase
          .from('clients')
          .insert({ name: clientSummary.client_name.trim() })
          .select('*')
          .single();

        if (clientErr) {
          throw new Error('Falha ao cadastrar o cliente automaticamente: ' + clientErr.message);
        }

        finalClientId = newClient.id;
        
        // Atualiza a lista de clientes localmente
        const updatedClients = [...clients, newClient].sort((a, b) => a.name.localeCompare(b.name));
        setClients(updatedClients);
        
        // Atualiza também o client_id no resumo ativo
        if (activeSummary) {
          const updatedSummaries = activeSummary.summary_data.summaries.map(s => {
            if (s.client_name === clientSummary.client_name) {
              return { ...s, client_id: newClient.id };
            }
            return s;
          });
          setActiveSummary({
            ...activeSummary,
            summary_data: { summaries: updatedSummaries }
          });
        }
      }

      // 2. Valida o status da tarefa sugerida
      const statusExists = statuses.some(s => s.id === task.status);
      const finalStatus = statusExists ? task.status : (statuses[0]?.id || 'aguardando cliente');

      // 3. Mapeia e filtra os responsáveis sugeridos que batem com os colaboradores existentes no banco
      const mappedResponsibles: string[] = [];
      task.responsibles.forEach(name => {
        const match = collaborators.find(c => c.name.toLowerCase().trim() === name.toLowerCase().trim());
        if (match) {
          mappedResponsibles.push(match.name);
        }
      });

      // 4. Preenche os estados do modal
      setModalClientId(finalClientId || '');
      setModalDescription(task.description.trim());
      setSelectedCollaborators(mappedResponsibles);
      setModalStatus(finalStatus);
      setModalObservations(task.observations?.trim() || '');
      
      // Guarda a tarefa pendente para o sucesso
      setPendingTaskInfo({
        task,
        clientSummary,
        taskIndex
      });

      // Abre o modal
      setIsTaskModalOpen(true);
    } catch (error: any) {
      console.error(error);
      showToast('Erro ao inicializar formulário da demanda: ' + error.message, 'error');
    }
  };

  // Grava de fato a demanda no banco após o usuário revisar/editar no modal
  const handleSaveSuggestedTask = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pendingTaskInfo) return;

    if (!modalClientId) {
      showToast('Por favor, selecione um cliente.', 'warning');
      return;
    }

    if (!modalDescription.trim()) {
      showToast('Por favor, descreva a demanda.', 'warning');
      return;
    }

    setManualLoading(true);
    const { clientSummary, taskIndex } = pendingTaskInfo;
    const taskKey = `${clientSummary.client_name}-${taskIndex}`;

    try {
      // 1. Insere a demanda editada no banco
      const { data: newTask, error: taskErr } = await supabase
        .from('tasks')
        .insert({
          client_id: modalClientId,
          description: modalDescription.trim(),
          responsibles: selectedCollaborators,
          status: modalStatus,
          observations: modalObservations.trim(),
          is_archived: false,
          created_by: profile?.id
        })
        .select('id')
        .single();

      if (taskErr) {
        throw new Error('Erro ao inserir tarefa: ' + taskErr.message);
      }

      // 2. Registra histórico de auditoria
      await supabase.from('task_history').insert({
        task_id: newTask.id,
        changed_by: profile?.id,
        action: 'create',
        created_by_ai: true,
        ai_provider: 'Gemini WhatsApp Extractor (Revisado)'
      });

      // 3. Marca a tarefa como criada na UI
      setCreatedTasksKeys(prev => ({ ...prev, [taskKey]: true }));
      showToast(`Demanda "${modalDescription.trim()}" criada com sucesso!`, 'success');
      
      // Fecha o modal e limpa
      setIsTaskModalOpen(false);
      setPendingTaskInfo(null);
      
      // Dá um refresh nas rotas para atualizar o Kanban principal
      router.refresh();
    } catch (error: any) {
      console.error(error);
      showToast('Erro ao criar demanda: ' + error.message, 'error');
    } finally {
      setManualLoading(false);
    }
  };

  // Deleta um resumo salvo no banco de dados (Apenas Admin)
  const handleDeleteSummary = async (summaryId: string, e: React.MouseEvent) => {
    e.stopPropagation();

    if (profile?.role !== 'admin') {
      showToast('Apenas administradores podem excluir resumos históricos.', 'warning');
      return;
    }

    if (!window.confirm('Tem certeza de que deseja excluir permanentemente este resumo do histórico?')) {
      return;
    }

    try {
      const { error } = await supabase
        .from('whatsapp_summaries')
        .delete()
        .eq('id', summaryId);

      if (error) {
        throw error;
      }

      showToast('Resumo excluído com sucesso.', 'success');
      
      const remainingSummaries = summaries.filter(s => s.id !== summaryId);
      setSummaries(remainingSummaries);

      if (activeSummary?.id === summaryId) {
        setActiveSummary(remainingSummaries.length > 0 ? remainingSummaries[0] : null);
      }
    } catch (error: any) {
      console.error(error);
      showToast('Erro ao deletar resumo: ' + error.message, 'error');
    }
  };

  return (
    <div className="dashboardLayout">
      <Sidebar profile={profile} isOpen={isSidebarOpen} onClose={() => setIsSidebarOpen(false)} />

      <main className="mainContent" style={{ display: 'grid', gridTemplateColumns: '300px minmax(0, 1fr)', gap: '2rem', padding: '2.5rem' }}>
        
        {/* Painel Lateral Secundário - Histórico de Resumos */}
        <section className="historyPanel" style={{
          backgroundColor: 'var(--bg-secondary)',
          borderRadius: 'var(--radius-lg)',
          border: '1px solid var(--border-color)',
          padding: '1.5rem',
          display: 'flex',
          flexDirection: 'column',
          gap: '1.25rem',
          height: 'calc(100vh - 5rem)',
          overflowY: 'auto'
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-color)', paddingBottom: '0.75rem' }}>
            <h3 style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--text-primary)' }}>Histórico Diário</h3>
            <span style={{ fontSize: '0.75rem', backgroundColor: 'var(--border-color)', color: 'var(--text-secondary)', padding: '0.15rem 0.5rem', borderRadius: '9999px', fontWeight: 600 }}>
              {summaries.length} salvos
            </span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', overflowY: 'auto', flex: 1 }} className="custom-scroll">
            {summaries.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '2rem 1rem', color: 'var(--text-muted)', fontSize: '0.9rem' }}>
                Nenhum resumo salvo no banco de dados.
              </div>
            ) : (
              summaries.map((s) => {
                const isSelected = activeSummary?.id === s.id;
                const formattedDate = new Date(s.summary_date + 'T00:00:00').toLocaleDateString('pt-BR', {
                  day: '2-digit',
                  month: 'short',
                  year: 'numeric'
                });

                return (
                  <div
                    key={s.id}
                    onClick={() => {
                      setActiveSummary(s);
                      setCreatedTasksKeys({});
                    }}
                    style={{
                      padding: '1rem',
                      borderRadius: 'var(--radius-md)',
                      backgroundColor: isSelected ? 'var(--bg-card)' : 'rgba(255,255,255,0.02)',
                      border: isSelected ? '1px solid var(--accent-purple)' : '1px solid transparent',
                      cursor: 'pointer',
                      transition: 'all var(--transition-fast)',
                      position: 'relative',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '0.35rem'
                    }}
                    className={`historyItem ${isSelected ? 'activeHistory' : ''}`}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: '0.9rem', fontWeight: 600, color: isSelected ? 'var(--text-primary)' : 'var(--text-secondary)' }}>
                        Resumo do dia
                      </span>
                      {profile?.role === 'admin' && (
                        <button
                          type="button"
                          onClick={(e) => handleDeleteSummary(s.id, e)}
                          style={{
                            background: 'none',
                            border: 'none',
                            color: '#ef4444',
                            cursor: 'pointer',
                            padding: '0.2rem',
                            opacity: 0.6,
                            transition: 'opacity 0.2s',
                          }}
                          className="deleteSummaryBtn"
                          title="Excluir do histórico"
                        >
                          ✕
                        </button>
                      )}
                    </div>
                    <span style={{ fontSize: '0.8rem', color: 'var(--accent-purple)', fontWeight: 500 }}>
                      {formattedDate}
                    </span>
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block' }}>
                      {s.raw_text.substring(0, 45)}...
                    </span>
                  </div>
                );
              })
            )}
          </div>
        </section>

        {/* Área de Trabalho Principal */}
        <section style={{ display: 'flex', flexDirection: 'column', gap: '2rem', height: 'calc(100vh - 5rem)', overflowY: 'auto' }} className="custom-scroll">
          {/* Header Mobile / Desktop */}
          <div className="header" style={{ marginBottom: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
              <button className="hamburgerBtn" onClick={() => setIsSidebarOpen(true)} title="Abrir menu">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="3" y1="12" x2="21" y2="12"></line>
                  <line x1="3" y1="6" x2="21" y2="6"></line>
                  <line x1="3" y1="18" x2="21" y2="18"></line>
                </svg>
              </button>
              <div>
                <h1 className="headerTitle">Resumos Diários do WhatsApp</h1>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginTop: '0.25rem' }}>
                  Processe logs de conversas do dia para obter relatórios semânticos automáticos separados por cliente.
                </p>
              </div>
            </div>
          </div>

          {/* Painel de Status de Sincronização do Celular (Especialmente para Leigos) */}
          {isCheckingStatus ? (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '0.75rem',
              backgroundColor: 'var(--bg-secondary)',
              border: '1px solid var(--border-color)',
              borderRadius: 'var(--radius-lg)',
              padding: '1.25rem 1.5rem',
              boxShadow: 'var(--shadow-sm)',
              animation: 'fadeIn 0.25s ease'
            }}>
              <div className="spinner" style={{ width: '18px', height: '18px', border: '2px solid rgba(168, 85, 247, 0.1)', borderTop: '2px solid var(--accent-purple)', borderRadius: '50%', animation: 'spin 1s linear infinite' }}></div>
              <span style={{ fontSize: '0.88rem', color: 'var(--text-secondary)', fontWeight: 500 }}>
                Verificando conexão com o WhatsApp na nuvem...
              </span>
            </div>
          ) : integrationConnected && (whatsappStatus === 'connected' || (whatsappStatus === 'connecting' && connectedUser)) ? (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              backgroundColor: 'rgba(16, 185, 129, 0.08)',
              border: '1px solid rgba(16, 185, 129, 0.2)',
              borderRadius: 'var(--radius-lg)',
              padding: '0.85rem 1.25rem',
              boxShadow: 'var(--shadow-sm)'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem', fontSize: '0.88rem', fontWeight: 600, color: '#34d399' }}>
                <span className="pulseGreen" style={{ display: 'inline-block', width: '8px', height: '8px', backgroundColor: '#10b981', borderRadius: '50%' }}></span>
                <span>
                  WhatsApp Conectado: <strong style={{ color: '#fff', marginLeft: '0.25rem' }}>{connectedUser ? (connectedUser.name || connectedUser.id.split('@')[0].split(':')[0]) : 'Carregando...'}</strong>
                  {whatsappStatus === 'connecting' && <span style={{ color: '#f59e0b', fontSize: '0.82rem', marginLeft: '0.5rem', fontWeight: 600 }}>(Conectando...)</span>}
                </span>
              </div>
              <button 
                type="button" 
                onClick={handleDisconnect}
                style={{ background: 'none', border: 'none', color: '#f87171', fontSize: '0.82rem', cursor: 'pointer', fontWeight: 600 }}
              >
                🔴 Desconectar Conta
              </button>
            </div>
          ) : null}

          {/* Painel de Progresso de Transcrição de Áudios */}
          {integrationConnected && whatsappStatus === 'connected' && (transcriptionRunning || transcriptionQueueLength > 0) && (
            <div style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '0.6rem',
              backgroundColor: 'rgba(168, 85, 247, 0.08)',
              border: '1px solid rgba(168, 85, 247, 0.2)',
              borderRadius: 'var(--radius-lg)',
              padding: '1rem 1.25rem',
              boxShadow: 'var(--shadow-sm)',
              marginTop: '0.75rem',
              animation: 'fadeIn 0.3s ease-out'
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.85rem', fontWeight: 600, color: '#c084fc' }}>
                  <span className="spinner" style={{ display: 'inline-block', width: '12px', height: '12px', border: '2px solid rgba(192, 132, 252, 0.1)', borderTop: '2px solid #c084fc', borderRadius: '50%', animation: 'spin 1s linear infinite' }}></span>
                  <span>🎙️ Transcrevendo áudios do WhatsApp...</span>
                </div>
                <span style={{ fontSize: '0.82rem', color: '#c084fc', fontWeight: 'bold' }}>
                  {transcriptionCompleted} / {transcriptionTotal} concluídos ({transcriptionQueueLength} na fila)
                </span>
              </div>
              
              <div style={{ width: '100%', height: '4px', backgroundColor: 'rgba(168, 85, 247, 0.15)', borderRadius: '9999px', overflow: 'hidden' }}>
                <div style={{ 
                  width: `${transcriptionTotal > 0 ? (transcriptionCompleted / transcriptionTotal) * 100 : 0}%`, 
                  height: '100%', 
                  backgroundColor: '#c084fc', 
                  transition: 'width 0.4s ease' 
                }}></div>
              </div>
              
              <p style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', margin: 0 }}>
                Você pode gerar o resumo agora, mas áudios que ainda não foram transcritos serão exibidos apenas como tags genéricas nos relatórios.
              </p>
            </div>
          )}

          {integrationConnected && whatsappStatus === 'qrcode' ? (
            <div style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '0.75rem',
              backgroundColor: 'rgba(245, 158, 11, 0.08)',
              border: '1px solid rgba(245, 158, 11, 0.2)',
              borderRadius: 'var(--radius-lg)',
              padding: '1.25rem 1.5rem',
              boxShadow: 'var(--shadow-sm)'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem', fontSize: '0.88rem', fontWeight: 600, color: '#f59e0b' }}>
                <span style={{ display: 'inline-block', width: '8px', height: '8px', backgroundColor: '#f59e0b', borderRadius: '50%' }}></span>
                WhatsApp Desconectado
              </div>
              <p style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', margin: 0 }}>
                Para poder ler as mensagens e gerar os resumos automáticos, é necessário parear o seu celular.
              </p>
              <div>
                <button 
                  type="button"
                  className="btn btnPrimary"
                  onClick={handleStartConnection}
                  style={{
                    fontSize: '0.82rem',
                    padding: '0.5rem 1rem',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '0.5rem',
                    background: 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
                    borderRadius: 'var(--radius-md)',
                    border: 'none',
                    fontWeight: 600,
                    cursor: 'pointer'
                  }}
                >
                  📱 Conectar Celular (Escanear QR Code)
                </button>
              </div>
            </div>
          ) : (
            <div style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '0.75rem',
              backgroundColor: 'rgba(245, 158, 11, 0.08)',
              border: '1px solid rgba(245, 158, 11, 0.2)',
              borderRadius: 'var(--radius-lg)',
              padding: '1.25rem 1.5rem',
              boxShadow: 'var(--shadow-sm)'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem', fontSize: '0.88rem', fontWeight: 600, color: '#f59e0b' }}>
                <span style={{ display: 'inline-block', width: '8px', height: '8px', backgroundColor: '#f59e0b', borderRadius: '50%' }}></span>
                WhatsApp Desconectado
              </div>
              <p style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', margin: 0 }}>
                Para poder ler as mensagens e gerar os resumos automáticos, é necessário parear o seu celular.
              </p>
              <div>
                <button 
                  type="button"
                  className="btn btnPrimary"
                  onClick={handleStartConnection}
                  style={{
                    fontSize: '0.82rem',
                    padding: '0.5rem 1rem',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '0.5rem',
                    background: 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
                    borderRadius: 'var(--radius-md)',
                    border: 'none',
                    fontWeight: 600,
                    cursor: 'pointer'
                  }}
                >
                  📱 Conectar Celular (Escanear QR Code)
                </button>
              </div>
            </div>
          )}

          {/* Card de Configuração de Processamento Simples - Apenas visível se conectado e sincronização concluída */}
          {integrationConnected && whatsappStatus === 'connected' && whatsappSyncStatus === 'completed' && (
            <div style={{
              backgroundColor: 'var(--bg-secondary)',
              borderRadius: 'var(--radius-lg)',
              border: '1px solid var(--border-color)',
              padding: '1.75rem',
              display: 'flex',
              flexDirection: 'column',
              gap: '1.5rem',
              animation: 'fadeIn 0.3s ease-out'
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1.25rem' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                  <h3 style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>Gerar Novo Resumo</h3>
                  <p style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', margin: 0 }}>
                    Importa conversas do WhatsApp do dia selecionado e gera a análise de tarefas de forma automatizada.
                  </p>
                </div>

                {/* Data e Botão de Ação Única */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
                  <input
                    type="date"
                    value={summaryDate}
                    onChange={(e) => setSummaryDate(e.target.value)}
                    style={{
                      backgroundColor: 'var(--bg-primary)',
                      border: '1px solid var(--border-color)',
                      color: 'var(--text-primary)',
                      padding: '0.45rem 0.75rem',
                      borderRadius: 'var(--radius-md)',
                      fontSize: '0.85rem',
                      outline: 'none'
                    }}
                  />

                  <button
                    type="button"
                    className="btn btnSecondary"
                    onClick={handleOpenMessagesModal}
                    disabled={isLoading || !apiToken}
                    style={{
                      padding: '0.55rem 1.35rem',
                      fontSize: '0.85rem',
                      fontWeight: 600,
                      border: '1px solid var(--border-color)',
                      cursor: apiToken ? 'pointer' : 'not-allowed',
                      opacity: apiToken ? 1 : 0.6,
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '0.5rem'
                    }}
                  >
                    👁️ Ver Mensagens
                  </button>

                  <button
                    type="button"
                    className="btn btnPrimary"
                    onClick={() => handleSyncAndGenerateSummary()}
                    disabled={isLoading || !apiToken}
                    style={{
                      padding: '0.55rem 1.35rem',
                      fontSize: '0.85rem',
                      fontWeight: 700,
                      background: 'linear-gradient(135deg, var(--accent-purple) 0%, #4f46e5 100%)',
                      boxShadow: '0 4px 12px rgba(99, 102, 241, 0.25)',
                      cursor: apiToken ? 'pointer' : 'not-allowed',
                      opacity: apiToken ? 1 : 0.6
                    }}
                  >
                    {isLoading ? '⚙️ Processando...' : '⚡ Gerar Resumo'}
                  </button>
                </div>
              </div>

            </div>
          )}

          {/* Card de Sincronização em Andamento - Visível se conectado mas ainda sincronizando histórico ou em fase de conexão */}
          {integrationConnected && (whatsappStatus === 'connecting' || (whatsappStatus === 'connected' && whatsappSyncStatus !== 'completed')) && (
            <div style={{
              backgroundColor: 'var(--bg-secondary)',
              borderRadius: 'var(--radius-lg)',
              border: '1px solid rgba(245, 158, 11, 0.25)',
              padding: '1.75rem',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '1rem',
              textAlign: 'center',
              animation: 'fadeIn 0.3s ease-out',
              boxShadow: 'var(--shadow-sm)'
            }}>
              <div className="spinner" style={{ width: '28px', height: '28px', border: '3px solid rgba(245, 158, 11, 0.1)', borderTop: '3px solid #f59e0b', borderRadius: '50%', animation: 'spin 1s linear infinite' }}></div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                <h3 style={{ fontSize: '1.05rem', fontWeight: 700, color: '#f59e0b', margin: 0 }}>
                  🔄 Sincronizando dados com o celular...
                </h3>
                <p style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', margin: 0, maxWidth: '500px' }}>
                  Por favor, aguarde alguns instantes enquanto importamos o histórico recente de conversas para podermos gerar os resumos com total precisão.
                </p>
                <div style={{ fontSize: '0.82rem', fontWeight: 600, color: 'var(--text-primary)', marginTop: '0.5rem' }}>
                  Mensagens importadas: {whatsappMessagesCount}
                </div>
              </div>
            </div>
          )}

          {/* Estado de Carregamento Premium com Skeleton */}
          {isLoading && (
            <div style={{
              backgroundColor: 'var(--bg-secondary)',
              borderRadius: 'var(--radius-lg)',
              border: '1px solid var(--border-color)',
              padding: '2.5rem',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '1.5rem',
              minHeight: '300px',
              animation: 'fadeIn 0.3s ease-out'
            }}>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <span className="dot" style={{ width: '12px', height: '12px', borderRadius: '50%', backgroundColor: 'var(--accent-purple)', animation: 'bounce 1.4s infinite ease-in-out both' }} />
                <span className="dot" style={{ width: '12px', height: '12px', borderRadius: '50%', backgroundColor: 'var(--accent-blue)', animation: 'bounce 1.4s infinite ease-in-out both 0.2s' }} style-delayed="true" />
                <span className="dot" style={{ width: '12px', height: '12px', borderRadius: '50%', backgroundColor: '#10b981', animation: 'bounce 1.4s infinite ease-in-out both 0.4s' }} />
              </div>
              <div style={{ textAlign: 'center' }}>
                <h4 style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '0.35rem' }}>
                  {loadingSteps[loadingStep]}
                </h4>
                <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                  Aguarde enquanto a inteligência artificial analisa e agrupa os dados por cliente.
                </p>
              </div>
              {/* Skeleton Cards simulando a estrutura que virá */}
              <div style={{ width: '100%', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem', marginTop: '1rem', opacity: 0.25 }}>
                <div style={{ height: '140px', backgroundColor: 'var(--bg-primary)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-color)' }} />
                <div style={{ height: '140px', backgroundColor: 'var(--bg-primary)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-color)' }} />
              </div>
            </div>
          )}

          {/* Exibição do Resumo Ativo */}
          {!isLoading && activeSummary && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', animation: 'fadeIn 0.3s ease-out' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h2 style={{ fontSize: '1.3rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                  Resumo Semântico do Dia - {new Date(activeSummary.summary_date + 'T00:00:00').toLocaleDateString('pt-BR')}
                </h2>
              </div>

              {/* Grid de Clientes no Resumo */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '1.75rem' }}>
                {activeSummary.summary_data.summaries.length === 0 ? (
                  <div style={{ backgroundColor: 'var(--bg-secondary)', borderRadius: 'var(--radius-lg)', border: '1px solid var(--border-color)', padding: '3rem', textAlign: 'center', color: 'var(--text-muted)' }}>
                    Nenhum cliente ou tópico relevante foi identificado nas conversas deste dia.
                  </div>
                ) : (
                  activeSummary.summary_data.summaries.map((clientSummary, cIndex) => {
                    const isClientRegistered = !!clientSummary.client_id;

                    return (
                      <div
                        key={cIndex}
                        style={{
                          backgroundColor: 'var(--bg-secondary)',
                          borderRadius: 'var(--radius-lg)',
                          border: '1px solid var(--border-color)',
                          padding: '1.75rem',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '1.25rem',
                          boxShadow: 'var(--shadow-sm)',
                          transition: 'transform var(--transition-fast)'
                        }}
                      >
                        {/* Nome do Cliente e Tag de Cadastro */}
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-color)', paddingBottom: '0.75rem' }}>
                          <span style={{ fontSize: '1.2rem', fontWeight: 700, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            👤 {clientSummary.client_name}
                          </span>
                          
                          <span
                            className="roleBadge"
                            style={{
                              backgroundColor: isClientRegistered ? 'rgba(16, 185, 129, 0.1)' : 'rgba(245, 158, 11, 0.1)',
                              color: isClientRegistered ? 'var(--status-resolvido)' : 'var(--status-aguardando-cliente)',
                              border: isClientRegistered ? '1px solid rgba(16, 185, 129, 0.2)' : '1px solid rgba(245, 158, 11, 0.2)',
                              fontSize: '0.7rem'
                            }}
                          >
                            {isClientRegistered ? 'Cliente Cadastrado' : 'Novo Cliente (Auto-Criar)'}
                          </span>
                        </div>

                        {/* Corpo do Resumo */}
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
                          
                          {/* Resumo Geral & Pontos Chaves */}
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                            <div>
                              <h4 style={{ fontSize: '0.9rem', color: 'var(--text-muted)', fontWeight: 700, marginBottom: '0.35rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                                Resumo das Conversas
                              </h4>
                              <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                                {clientSummary.general_summary}
                              </p>
                            </div>

                            {clientSummary.key_points && clientSummary.key_points.length > 0 && (
                              <div>
                                <h4 style={{ fontSize: '0.9rem', color: 'var(--text-muted)', fontWeight: 700, marginBottom: '0.5rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                                  Pontos Principais
                                </h4>
                                <ul style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', paddingLeft: '1.25rem', color: 'var(--text-secondary)' }}>
                                  {clientSummary.key_points.map((point, pIndex) => (
                                    <li key={pIndex} style={{ fontSize: '0.85rem', lineHeight: 1.5 }}>
                                      {point}
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            )}
                          </div>

                          {/* Demandas/Tarefas Sugeridas */}
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', borderTop: '1px solid var(--border-color)', paddingTop: '1.25rem' }}>
                            <h4 style={{ fontSize: '0.9rem', color: 'var(--text-muted)', fontWeight: 700, marginBottom: '0.25rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                              Tarefas Sugeridas pela IA
                            </h4>

                            {clientSummary.suggested_tasks && clientSummary.suggested_tasks.length > 0 ? (
                              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                                {clientSummary.suggested_tasks.map((task, tIndex) => {
                                  const taskKey = `${clientSummary.client_name}-${tIndex}`;
                                  const isCreated = !!createdTasksKeys[taskKey];
                                  const currentStatus = statuses.find(s => s.id === task.status);

                                  return (
                                    <div
                                      key={tIndex}
                                      style={{
                                        backgroundColor: 'var(--bg-primary)',
                                        border: '1px solid var(--border-color)',
                                        borderRadius: 'var(--radius-md)',
                                        padding: '0.85rem 1rem',
                                        display: 'flex',
                                        flexDirection: 'column',
                                        gap: '0.5rem',
                                        transition: 'all 0.2s',
                                        position: 'relative'
                                      }}
                                    >
                                      {/* Título e Botão */}
                                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem' }}>
                                        <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-primary)', lineHeight: 1.4 }}>
                                          {task.description}
                                        </span>

                                        <button
                                          type="button"
                                          className={`btn ${isCreated ? 'btnSecondary' : 'btnPrimary'}`}
                                          style={{
                                            padding: '0.25rem 0.5rem',
                                            fontSize: '0.75rem',
                                            flexShrink: 0,
                                            height: '24px',
                                            minWidth: '70px',
                                            justifyContent: 'center',
                                            background: isCreated ? 'rgba(255,255,255,0.05)' : undefined
                                          }}
                                          onClick={() => handleOpenSuggestedTaskModal(task, clientSummary, tIndex)}
                                          disabled={isCreated}
                                        >
                                          {isCreated ? '✓ Criado' : '➕ Criar'}
                                        </button>
                                      </div>

                                      {/* Rodapé da Tarefa */}
                                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.25rem' }}>
                                        {/* Tag Status */}
                                        {currentStatus && (
                                          <span
                                            style={{
                                              fontSize: '0.7rem',
                                              fontWeight: 700,
                                              padding: '0.1rem 0.4rem',
                                              borderRadius: '9999px',
                                              backgroundColor: `rgba(${parseInt(currentStatus.color.slice(1, 3), 16)}, ${parseInt(currentStatus.color.slice(3, 5), 16)}, ${parseInt(currentStatus.color.slice(5, 7), 16)}, 0.1)`,
                                              color: currentStatus.color,
                                              border: `1px solid rgba(${parseInt(currentStatus.color.slice(1, 3), 16)}, ${parseInt(currentStatus.color.slice(3, 5), 16)}, ${parseInt(currentStatus.color.slice(5, 7), 16)}, 0.2)`
                                            }}
                                          >
                                            {currentStatus.name}
                                          </span>
                                        )}

                                        {/* Responsáveis */}
                                        {task.responsibles && task.responsibles.length > 0 && (
                                          <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
                                            👤 {task.responsibles.join(', ')}
                                          </span>
                                        )}

                                        {/* Observações */}
                                        {task.observations && (
                                          <span
                                            style={{ fontSize: '0.7rem', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'normal', maxWidth: '100%' }}
                                            title={task.observations}
                                          >
                                            📝 {task.observations}
                                          </span>
                                        )}
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            ) : (
                              <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)', fontStyle: 'italic', padding: '1rem 0' }}>
                                Nenhuma demanda detectada para este cliente.
                              </div>
                            )}
                          </div>

                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          )}

          {/* View Vazia quando não há Resumo Ativo */}
          {!isLoading && !activeSummary && (
            <div style={{
              backgroundColor: 'var(--bg-secondary)',
              borderRadius: 'var(--radius-lg)',
              border: '1px solid var(--border-color)',
              padding: '4rem 2rem',
              textAlign: 'center',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '1.25rem',
              minHeight: '350px'
            }}>
              <div style={{
                width: '60px',
                height: '60px',
                borderRadius: '50%',
                backgroundColor: 'var(--accent-glow)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--accent-purple)',
                marginBottom: '0.5rem'
              }}>
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path>
                </svg>
              </div>
              <div>
                <h3 style={{ fontSize: '1.15rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '0.35rem' }}>Nenhum Resumo Carregado</h3>
                <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', maxWidth: '400px', margin: '0 auto', lineHeight: 1.5 }}>
                  Coloque as mensagens do dia acima e clique em "Gerar Resumo Semântico", ou selecione um resumo histórico no painel esquerdo para visualizar.
                </p>
              </div>
            </div>
          )}

        </section>

      </main>

      {/* Modal de Escolha Intermediária para Conexão */}
      {isChoiceModalOpen && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(10, 10, 15, 0.85)',
          backdropFilter: 'blur(8px)',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          zIndex: 9999,
          animation: 'fadeIn 0.25s ease'
        }}>
          <div style={{
            backgroundColor: 'var(--bg-secondary)',
            borderRadius: 'var(--radius-lg)',
            border: '1px solid var(--border-color)',
            padding: '2.25rem 2rem',
            width: '420px',
            maxWidth: '92%',
            display: 'flex',
            flexDirection: 'column',
            gap: '1.5rem',
            boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.5), 0 10px 10px -5px rgba(0, 0, 0, 0.4)',
            position: 'relative'
          }}>
            <button
              type="button"
              onClick={() => setIsChoiceModalOpen(false)}
              style={{
                position: 'absolute',
                top: '1rem',
                right: '1rem',
                background: 'none',
                border: 'none',
                color: 'var(--text-muted)',
                fontSize: '1.35rem',
                cursor: 'pointer',
                transition: 'color 0.2s'
              }}
              onMouseOver={(e) => e.currentTarget.style.color = 'var(--text-primary)'}
              onMouseOut={(e) => e.currentTarget.style.color = 'var(--text-muted)'}
              title="Fechar"
            >
              ✕
            </button>

            {choiceStep === 'options' ? (
              <>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', textAlign: 'center' }}>
                  <h3 style={{ fontSize: '1.2rem', fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>
                    Conectar WhatsApp 📱
                  </h3>
                  <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', margin: 0, lineHeight: 1.5 }}>
                    A primeira conexão pode levar alguns minutos para sincronizar as mensagens. O que deseja fazer?
                  </p>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', width: '100%', marginTop: '0.5rem' }}>
                  <button
                    type="button"
                    className="btn btnPrimary"
                    onClick={() => {
                      const d = new Date();
                      const year = d.getFullYear();
                      const month = String(d.getMonth() + 1).padStart(2, '0');
                      const day = String(d.getDate()).padStart(2, '0');
                      setAutoSummaryDate(`${year}-${month}-${day}`);
                      setChoiceStep('date');
                    }}
                    style={{
                      width: '100%',
                      padding: '0.75rem',
                      fontWeight: 600,
                      fontSize: '0.85rem',
                      background: 'linear-gradient(135deg, var(--accent-purple) 0%, #4f46e5 100%)',
                      border: 'none',
                      boxShadow: '0 4px 12px rgba(99, 102, 241, 0.2)'
                    }}
                  >
                    ⚡ Gerar resumo automaticamente após conectar
                  </button>

                  <button
                    type="button"
                    className="btn btnSecondary"
                    onClick={() => {
                      setAutoSummaryEnabled(false);
                      setIsChoiceModalOpen(false);
                      setIsQrModalOpen(true);
                    }}
                    style={{
                      width: '100%',
                      padding: '0.75rem',
                      fontWeight: 600,
                      fontSize: '0.85rem',
                      border: '1px solid var(--border-color)'
                    }}
                  >
                    📱 Apenas conectar
                  </button>
                </div>
              </>
            ) : (
              <>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', textAlign: 'center' }}>
                  <h3 style={{ fontSize: '1.2rem', fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>
                    Agendar Gerador de Resumos 📅
                  </h3>
                  <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', margin: 0, lineHeight: 1.5 }}>
                    Selecione de qual data deseja obter o resumo assim que a sincronização do celular for concluída:
                  </p>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', width: '100%', alignItems: 'center' }}>
                  <input
                    type="date"
                    value={autoSummaryDate}
                    onChange={(e) => setAutoSummaryDate(e.target.value)}
                    style={{
                      backgroundColor: 'var(--bg-primary)',
                      border: '1px solid var(--border-color)',
                      color: 'var(--text-primary)',
                      padding: '0.5rem 0.75rem',
                      borderRadius: 'var(--radius-md)',
                      fontSize: '0.9rem',
                      outline: 'none',
                      width: '100%',
                      maxWidth: '220px',
                      textAlign: 'center'
                    }}
                  />

                  {/* Opção para aguardar transcrições de áudios */}
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.55rem',
                    width: '100%',
                    maxWidth: '280px',
                    justifyContent: 'center',
                    marginTop: '0.25rem',
                    cursor: 'pointer'
                  }} onClick={() => setWaitForTranscriptions(!waitForTranscriptions)}>
                    <input
                      type="checkbox"
                      id="chkWaitForTranscriptions"
                      checked={waitForTranscriptions}
                      onChange={(e) => setWaitForTranscriptions(e.target.checked)}
                      style={{
                        cursor: 'pointer',
                        accentColor: '#10b981',
                        width: '15px',
                        height: '15px'
                      }}
                      onClick={(e) => e.stopPropagation()} // Evita duplo clique ao disparar o onClick da div
                    />
                    <label 
                      htmlFor="chkWaitForTranscriptions"
                      style={{ 
                        fontSize: '0.78rem', 
                        color: 'var(--text-secondary)', 
                        cursor: 'pointer',
                        userSelect: 'none',
                        lineHeight: 1.3
                      }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      Gerar resumo somente após as transcrições dos áudios.
                    </label>
                  </div>

                  <div style={{ display: 'flex', gap: '0.75rem', width: '100%', marginTop: '0.5rem' }}>
                    <button
                      type="button"
                      className="btn btnSecondary"
                      onClick={() => setChoiceStep('options')}
                      style={{
                        flex: 1,
                        padding: '0.65rem',
                        fontWeight: 600,
                        fontSize: '0.85rem',
                        border: '1px solid var(--border-color)'
                      }}
                    >
                      ⬅️ Voltar
                    </button>

                    <button
                      type="button"
                      className="btn btnPrimary"
                      onClick={() => {
                        setAutoSummaryEnabled(true);
                        setIsChoiceModalOpen(false);
                        setIsQrModalOpen(true);
                      }}
                      style={{
                        flex: 2,
                        padding: '0.65rem',
                        fontWeight: 600,
                        fontSize: '0.85rem',
                        background: 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
                        border: 'none',
                        boxShadow: '0 4px 12px rgba(16, 185, 129, 0.2)'
                      }}
                    >
                      Confirmar e Ver QR Code ✅
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Modal de Pareamento via QR Code */}
      {isQrModalOpen && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(10, 10, 15, 0.85)',
          backdropFilter: 'blur(8px)',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          zIndex: 9999,
          animation: 'fadeIn 0.25s ease'
        }}>
          <div style={{
            backgroundColor: 'var(--bg-secondary)',
            borderRadius: 'var(--radius-lg)',
            border: '1px solid var(--border-color)',
            padding: '2.25rem 2rem',
            width: '400px',
            maxWidth: '90%',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            textAlign: 'center',
            gap: '1.25rem',
            boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.5), 0 10px 10px -5px rgba(0, 0, 0, 0.4)',
            position: 'relative'
          }}>
            <button
              type="button"
              onClick={() => setIsQrModalOpen(false)}
              style={{
                position: 'absolute',
                top: '1rem',
                right: '1rem',
                background: 'none',
                border: 'none',
                color: 'var(--text-muted)',
                fontSize: '1.35rem',
                cursor: 'pointer',
                transition: 'color 0.2s'
              }}
              onMouseOver={(e) => e.currentTarget.style.color = 'var(--text-primary)'}
              onMouseOut={(e) => e.currentTarget.style.color = 'var(--text-muted)'}
              title="Fechar"
            >
              ✕
            </button>

            <h3 style={{ fontSize: '1.25rem', fontWeight: 700, color: 'var(--text-primary)', margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              Conectar WhatsApp 📱
            </h3>
            
            <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', margin: 0, lineHeight: 1.5 }}>
              Abra o WhatsApp no seu celular, acesse <strong>Dispositivos Conectados</strong> e escaneie o código abaixo:
            </p>

            <div style={{
              width: '260px',
              height: '260px',
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'center',
              backgroundColor: 'var(--bg-primary)',
              borderRadius: 'var(--radius-md)',
              border: '1px solid var(--border-color)',
              overflow: 'hidden',
              position: 'relative',
              boxShadow: 'inset 0 2px 4px rgba(0,0,0,0.2)'
            }}>
              {qrStatus === 'waiting' && (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.75rem', color: 'var(--text-muted)' }}>
                  <div className="spinner" style={{ width: '32px', height: '32px', border: '3px solid rgba(168, 85, 247, 0.1)', borderTop: '3px solid var(--accent-purple)', borderRadius: '50%', animation: 'spin 1s linear infinite' }}></div>
                  <span style={{ fontSize: '0.8rem', fontWeight: 500 }}>Iniciando conexão...</span>
                </div>
              )}

              {qrStatus === 'qrcode' && qrCodeImage && (
                <img 
                  src={qrCodeImage} 
                  alt="QR Code do WhatsApp" 
                  style={{
                    width: '240px',
                    height: '240px',
                    backgroundColor: 'white',
                    padding: '0.5rem',
                    borderRadius: 'var(--radius-sm)',
                    boxShadow: 'var(--shadow-md)',
                    animation: 'fadeIn 0.3s ease'
                  }}
                />
              )}
            </div>

            <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: 0, display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
              <span>🔄</span> Esta tela atualizará sozinha e fechará assim que parear.
            </p>
          </div>
        </div>
      )}

      {/* Modal de Visualização de Mensagens Coletadas */}
      {isMessagesModalOpen && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(10, 10, 15, 0.85)',
          backdropFilter: 'blur(8px)',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          zIndex: 9999,
          animation: 'fadeIn 0.25s ease'
        }}>
          <div style={{
            backgroundColor: 'var(--bg-secondary)',
            borderRadius: 'var(--radius-lg)',
            border: '1px solid var(--border-color)',
            padding: '2rem',
            width: '900px',
            maxWidth: '96%',
            height: '650px',
            maxHeight: '90vh',
            display: 'flex',
            flexDirection: 'column',
            gap: '1.25rem',
            boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.5), 0 10px 10px -5px rgba(0, 0, 0, 0.4)',
            position: 'relative'
          }}>
            <button
              type="button"
              onClick={() => setIsMessagesModalOpen(false)}
              style={{
                position: 'absolute',
                top: '1rem',
                right: '1rem',
                background: 'none',
                border: 'none',
                color: 'var(--text-muted)',
                fontSize: '1.35rem',
                cursor: 'pointer',
                transition: 'color 0.2s',
                zIndex: 10
              }}
              onMouseOver={(e) => e.currentTarget.style.color = 'var(--text-primary)'}
              onMouseOut={(e) => e.currentTarget.style.color = 'var(--text-muted)'}
              title="Fechar"
            >
              ✕
            </button>

            <div>
              <h3 style={{ fontSize: '1.25rem', fontWeight: 700, color: 'var(--text-primary)', margin: '0 0 0.25rem 0', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                💬 Conversas Coletadas do WhatsApp
              </h3>
              <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)', margin: 0 }}>
                Logs de mensagens importadas para o dia: <strong>{new Date(summaryDate + 'T00:00:00').toLocaleDateString('pt-BR')}</strong>
              </p>
            </div>

            <div style={{
              flex: 1,
              backgroundColor: 'var(--bg-primary)',
              borderRadius: 'var(--radius-md)',
              border: '1px solid var(--border-color)',
              display: 'flex',
              overflow: 'hidden',
              height: '100%',
              minHeight: 0
            }}>
              {isLoadingModalMessages ? (
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', gap: '0.75rem', color: 'var(--text-muted)' }}>
                  <div className="spinner" style={{ width: '32px', height: '32px', border: '3px solid rgba(168, 85, 247, 0.1)', borderTop: '3px solid var(--accent-purple)', borderRadius: '50%', animation: 'spin 1s linear infinite' }}></div>
                  <span style={{ fontSize: '0.85rem' }}>Buscando logs de mensagens...</span>
                </div>
              ) : chatConversations.length === 0 ? (
                <div style={{ flex: 1, display: 'flex', justifyContent: 'center', alignItems: 'center', padding: '2rem', color: 'var(--text-muted)', textAlign: 'center' }}>
                  {modalMessagesText || 'Nenhuma mensagem de clientes registrada para a data selecionada.'}
                </div>
              ) : (
                (() => {
                  const filteredChats = chatConversations.filter(chat => 
                    chat.displayName.toLowerCase().includes(searchQuery.toLowerCase()) ||
                    chat.chatKey.includes(searchQuery)
                  );
                  const activeChat = chatConversations.find(chat => chat.chatKey === selectedChatKey);

                  return (
                    <>
                      {/* Coluna Esquerda: Lista de Conversas */}
                      <div className="chatSidebar" style={{ display: (selectedChatKey && window.innerWidth <= 768) ? 'none' : 'flex' }}>
                        <div className="chatSearchContainer">
                          <input
                            type="text"
                            placeholder="Buscar conversa..."
                            className="chatSearchInput"
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                          />
                        </div>
                        <div className="chatList custom-scroll">
                          {filteredChats.map((chat) => {
                            const isActive = chat.chatKey === selectedChatKey;
                            const initials = chat.displayName
                              .split(' ')
                              .slice(0, 2)
                              .map((n: string) => n[0])
                              .join('')
                              .toUpperCase() || '?';
                            
                            return (
                              <div
                                key={chat.chatKey}
                                className={`chatListItem ${isActive ? 'active' : ''}`}
                                onClick={() => setSelectedChatKey(chat.chatKey)}
                              >
                                <div className="chatAvatar">
                                  {initials}
                                </div>
                                <div className="chatListItemContent">
                                  <div className="chatListItemHeader">
                                    <span className="chatListName" title={chat.displayName}>{chat.displayName}</span>
                                    <span className="chatBadge">{chat.messages.length}</span>
                                  </div>
                                  <span className="chatListMeta">{chat.chatKey}</span>
                                </div>
                              </div>
                            );
                          })}
                          {filteredChats.length === 0 && (
                            <div className="chatListEmpty">Nenhuma conversa encontrada.</div>
                          )}
                        </div>
                      </div>

                      {/* Coluna Direita: Conteúdo do Chat */}
                      <div className="chatArea" style={{ display: (!selectedChatKey && window.innerWidth <= 768) ? 'none' : 'flex' }}>
                        {activeChat ? (
                          <>
                            <div className="chatAreaHeader">
                              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                <button 
                                  className="chatBackButton" 
                                  onClick={() => setSelectedChatKey(null)}
                                  style={{
                                    background: 'none',
                                    border: 'none',
                                    color: 'var(--text-primary)',
                                    fontSize: '1.25rem',
                                    cursor: 'pointer',
                                    padding: '0 0.5rem 0 0',
                                    lineHeight: 1
                                  }}
                                >
                                  ←
                                </button>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem', flex: 1 }}>
                                  <h4 className="chatAreaTitle">{activeChat.displayName}</h4>
                                  <span className="chatAreaSubtitle">{activeChat.chatKey}</span>
                                </div>
                              </div>
                            </div>
                            <div className="chatMessageList custom-scroll">
                              {activeChat.messages.map((message: any) => {
                                const formattedTime = (() => {
                                  if (!message.timestamp) return '';
                                  if (message.timestamp.includes('T')) {
                                    try {
                                      const date = new Date(message.timestamp);
                                      return date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
                                    } catch (e) {
                                      return '';
                                    }
                                  }
                                  const match = message.timestamp.match(/\d{2}:\d{2}/);
                                  return match ? match[0] : message.timestamp;
                                })();

                                return (
                                  <div
                                    key={message.id}
                                    className={`chatMessageRow ${message.fromMe ? 'outgoing' : 'incoming'}`}
                                  >
                                    <div className="chatMessageBubble">
                                      {activeChat.isGroup && !message.fromMe && (
                                        <span className="chatMessageSenderName">
                                          {message.senderName || message.sender}
                                        </span>
                                      )}
                                      <p className="chatMessageText">
                                        <MessageBody text={message.text} />
                                      </p>
                                      <span className="chatMessageTime">{formattedTime}</span>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </>
                        ) : (
                          <div className="chatAreaPlaceholder">
                            <span style={{ fontSize: '2.5rem', marginBottom: '0.5rem' }}>💬</span>
                            <p>Selecione uma conversa para visualizar as mensagens deste dia.</p>
                          </div>
                        )}
                      </div>
                    </>
                  );
                })()
              )}
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', borderTop: '1px solid var(--border-color)', paddingTop: '1rem' }}>
              <button
                type="button"
                className="btn btnSecondary"
                onClick={() => setIsMessagesModalOpen(false)}
                style={{ fontSize: '0.85rem', padding: '0.5rem 1.25rem' }}
              >
                Fechar Painel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal Unificado: Criação ou Edição de Demanda a partir do WhatsApp */}
      {isTaskModalOpen && (
        <div className="modalOverlay" style={{ zIndex: 1100 }}>
          <div className="modalContent" style={{ minWidth: '450px', backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-lg)' }}>
            <div className="modalHeader" style={{ borderBottom: '1px solid var(--border-color)', paddingBottom: '0.85rem' }}>
              <h2 className="modalTitle" style={{ fontSize: '1.2rem', fontWeight: 700 }}>Cadastrar Nova Demanda</h2>
              <button className="modalCloseBtn" onClick={() => setIsTaskModalOpen(false)}>×</button>
            </div>

            <form onSubmit={handleSaveSuggestedTask}>
              <div className="modalBody" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', padding: '1.25rem 0' }}>
                
                {/* Dropdown de Clientes */}
                <div className="formGroup">
                  <label className="formLabel">Cliente da Demanda</label>
                  <select
                    className="formInput"
                    value={modalClientId}
                    onChange={(e) => setModalClientId(e.target.value)}
                    required
                  >
                    <option value="">-- Escolha um Cliente --</option>
                    {clients.map(c => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                </div>

                {/* Descrição da Demanda */}
                <div className="formGroup">
                  <label className="formLabel">Descrição da Demanda</label>
                  <textarea
                    className="formInput"
                    placeholder="O que precisa ser feito?"
                    value={modalDescription}
                    onChange={(e) => setModalDescription(e.target.value)}
                    required
                    style={{ minHeight: '80px' }}
                  />
                </div>

                {/* Seleção Múltipla de Responsáveis Customizada */}
                <div className="formGroup" ref={dropdownRef} style={{ position: 'relative' }}>
                  <label className="formLabel">Responsáveis Encarregados</label>
                  <div 
                    className="multiSelectContainer formInput"
                    onClick={() => setIsDropdownOpen(!isDropdownOpen)}
                    style={{ cursor: 'pointer', display: 'flex', flexWrap: 'wrap', gap: '0.35rem', alignItems: 'center', minHeight: '40px' }}
                  >
                    {selectedCollaborators.map((r, i) => (
                      <span key={i} className="multiSelectTag" style={{ paddingRight: '0.4rem' }}>
                        {r}
                        <button
                          type="button"
                          className="multiSelectRemoveBtn"
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedCollaborators(selectedCollaborators.filter(item => item !== r));
                          }}
                          title="Remover"
                        >
                          ×
                        </button>
                      </span>
                    ))}
                    
                    {selectedCollaborators.length === 0 && (
                      <span style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', userSelect: 'none' }}>
                        Clique para selecionar...
                      </span>
                    )}

                    <span className="multiSelectTrigger">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: 'var(--text-secondary)' }}>
                        <polyline points="6 9 12 15 18 9"></polyline>
                      </svg>
                    </span>
                  </div>

                  {/* Menu Dropdown de Colaboradores */}
                  {isDropdownOpen && (
                    <div className="customDropdownMenu" style={{ position: 'absolute', width: '100%', zIndex: 1200, maxHeight: '200px', overflowY: 'auto' }}>
                      {collaborators.filter(c => !selectedCollaborators.includes(c.name)).length === 0 ? (
                        <div className="disabledItem">
                          {collaborators.length === 0 
                            ? "Nenhum colaborador cadastrado." 
                            : "Todos os colaboradores já selecionados."}
                        </div>
                      ) : (
                        collaborators
                          .filter(c => !selectedCollaborators.includes(c.name))
                          .map(c => (
                            <button
                              type="button"
                              key={c.id}
                              className="customDropdownItem"
                              onClick={(e) => {
                                e.stopPropagation();
                                setSelectedCollaborators([...selectedCollaborators, c.name]);
                                setIsDropdownOpen(false);
                              }}
                            >
                              {c.name}
                            </button>
                          ))
                      )}
                    </div>
                  )}
                </div>

                {/* Dropdown de Status */}
                <div className="formGroup">
                  <label className="formLabel">Status da Demanda</label>
                  <select
                    className="formInput"
                    value={modalStatus}
                    onChange={(e) => setModalStatus(e.target.value)}
                    required
                  >
                    {statuses.map(s => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </select>
                </div>

                {/* Observações Extras */}
                <div className="formGroup">
                  <label className="formLabel">Observações Extras</label>
                  <textarea
                    className="formInput"
                    style={{ minHeight: '60px' }}
                    placeholder="Contexto adicional ou notas"
                    value={modalObservations}
                    onChange={(e) => setModalObservations(e.target.value)}
                  />
                </div>
              </div>

              <div className="modalFooter" style={{ borderTop: '1px solid var(--border-color)', paddingTop: '0.85rem', display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
                <button className="btn btnSecondary" type="button" onClick={() => setIsTaskModalOpen(false)}>
                  Cancelar
                </button>
                <button className="btn btnPrimary" type="submit" disabled={manualLoading}>
                  {manualLoading ? 'Salvando...' : 'Criar Demanda'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Estilos e Animações locais adicionais para Toasts e Spinners */}
      <style jsx global>{`
        /* Estilos do Chat Premium (Duas Colunas) */
        .chatSidebar {
          width: 280px;
          border-right: 1px solid var(--border-color);
          display: flex;
          flex-direction: column;
          background: rgba(15, 23, 42, 0.4);
          height: 100%;
        }
        .chatSearchContainer {
          padding: 0.75rem;
          border-bottom: 1px solid var(--border-color);
        }
        .chatSearchInput {
          width: 100%;
          padding: 0.5rem 0.75rem;
          background: var(--bg-secondary);
          border: 1px solid var(--border-color);
          border-radius: var(--radius-sm);
          color: var(--text-primary);
          font-size: 0.8rem;
          outline: none;
          transition: border-color 0.2s;
        }
        .chatSearchInput:focus {
          border-color: var(--accent-purple);
        }
        .chatList {
          flex: 1;
          overflow-y: auto;
        }
        .chatListItem {
          display: flex;
          align-items: center;
          gap: 0.75rem;
          padding: 0.85rem 0.75rem;
          border-bottom: 1px solid rgba(255, 255, 255, 0.03);
          cursor: pointer;
          transition: background-color 0.2s;
        }
        .chatListItem:hover {
          background-color: rgba(255, 255, 255, 0.03);
        }
        .chatListItem.active {
          background-color: rgba(168, 85, 247, 0.15);
          border-left: 3px solid var(--accent-purple);
        }
        .chatAvatar {
          width: 38px;
          height: 38px;
          border-radius: 50%;
          background: linear-gradient(135deg, #a855f7 0%, #6366f1 100%);
          color: white;
          font-weight: 700;
          font-size: 0.85rem;
          display: flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
          box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
        }
        .chatListItemContent {
          flex: 1;
          min-width: 0;
          display: flex;
          flex-direction: column;
          gap: 0.15rem;
        }
        .chatListItemHeader {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 0.5rem;
        }
        .chatListName {
          font-size: 0.85rem;
          font-weight: 600;
          color: var(--text-primary);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .chatBadge {
          background: var(--accent-purple);
          color: white;
          font-size: 0.7rem;
          font-weight: 700;
          padding: 0.15rem 0.4rem;
          border-radius: 999px;
          min-width: 18px;
          text-align: center;
        }
        .chatListMeta {
          font-size: 0.7rem;
          color: var(--text-muted);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .chatListEmpty {
          padding: 2rem;
          text-align: center;
          color: var(--text-muted);
          font-size: 0.8rem;
        }
        .chatArea {
          flex: 1;
          display: flex;
          flex-direction: column;
          background: rgba(15, 23, 42, 0.15);
          height: 100%;
          min-width: 0;
        }
        .chatAreaHeader {
          padding: 0.85rem 1.25rem;
          border-bottom: 1px solid var(--border-color);
          background: rgba(255, 255, 255, 0.02);
          display: flex;
          flex-direction: column;
          gap: 0.15rem;
        }
        .chatAreaTitle {
          margin: 0;
          font-size: 0.95rem;
          font-weight: 700;
          color: var(--text-primary);
        }
        .chatAreaSubtitle {
          font-size: 0.72rem;
          color: var(--text-muted);
        }
        .chatMessageList {
          flex: 1;
          overflow-y: auto;
          padding: 1.25rem;
          display: flex;
          flex-direction: column;
          gap: 0.85rem;
          background-image: radial-gradient(rgba(255, 255, 255, 0.015) 1px, transparent 0);
          background-size: 16px 16px;
        }
        .chatMessageRow {
          display: flex;
          width: 100%;
        }
        .chatMessageRow.incoming {
          justify-content: flex-start;
        }
        .chatMessageRow.outgoing {
          justify-content: flex-end;
        }
        .chatMessageBubble {
          max-width: 75%;
          padding: 0.65rem 0.85rem;
          border-radius: 12px;
          position: relative;
          box-shadow: 0 2px 5px rgba(0,0,0,0.15);
          display: flex;
          flex-direction: column;
          gap: 0.2rem;
        }
        .incoming .chatMessageBubble {
          background: #1e293b;
          border: 1px solid rgba(255, 255, 255, 0.06);
          color: var(--text-primary);
          border-bottom-left-radius: 2px;
        }
        .outgoing .chatMessageBubble {
          background: linear-gradient(135deg, #7c3aed 0%, #4f46e5 100%);
          color: white;
          border-bottom-right-radius: 2px;
        }
        .chatMessageSenderName {
          font-size: 0.72rem;
          font-weight: 700;
          color: #fbbf24;
          margin-bottom: 0.1rem;
        }
        .chatMessageText {
          margin: 0;
          font-size: 0.82rem;
          line-height: 1.4;
          word-break: break-word;
          white-space: pre-wrap;
        }
        .outgoing .chatMessageText {
          color: #ffffff;
        }
        .chatMessageTime {
          font-size: 0.65rem;
          align-self: flex-end;
          color: rgba(255, 255, 255, 0.45);
          margin-top: 0.15rem;
        }
        .incoming .chatMessageTime {
          color: var(--text-muted);
        }
        .chatAreaPlaceholder {
          flex: 1;
          display: flex;
          flex-direction: column;
          justify-content: center;
          align-items: center;
          color: var(--text-muted);
          font-size: 0.82rem;
          text-align: center;
          padding: 2rem;
        }
        .chatBackButton {
          display: none;
        }
        @media (max-width: 768px) {
          .chatBackButton {
            display: block !important;
          }
        }
        .conversationMarkdownViewer {
          display: flex;
          flex-direction: column;
          gap: 0.85rem;
          width: 100%;
        }
        .conversationMarkdownTitle {
          margin: 0 0 0.25rem 0;
          color: var(--text-primary);
          font-size: 1rem;
          font-weight: 700;
        }
        .conversationSection {
          border: 1px solid var(--border-color);
          border-radius: var(--radius-md);
          background: rgba(15, 23, 42, 0.38);
          overflow: hidden;
        }
        .conversationSectionHeader {
          display: flex;
          flex-direction: column;
          gap: 0.25rem;
          padding: 0.85rem 1rem;
          background: rgba(255, 255, 255, 0.03);
          border-bottom: 1px solid var(--border-color);
        }
        .conversationSectionHeader h5 {
          margin: 0;
          color: var(--text-primary);
          font-size: 0.95rem;
          font-weight: 700;
        }
        .conversationSectionHeader span {
          color: var(--text-muted);
          font-size: 0.74rem;
        }
        .conversationMessageList {
          display: flex;
          flex-direction: column;
        }
        .conversationMessageRow {
          display: grid;
          grid-template-columns: 126px 170px minmax(0, 1fr);
          gap: 0.75rem;
          padding: 0.7rem 1rem;
          border-bottom: 1px solid rgba(148, 163, 184, 0.13);
          align-items: start;
        }
        .conversationMessageRow:last-child {
          border-bottom: 0;
        }
        .conversationMessageTime {
          color: #93c5fd;
          font-size: 0.76rem;
          font-variant-numeric: tabular-nums;
          white-space: nowrap;
        }
        .conversationMessageSender {
          color: #fbbf24;
          font-size: 0.8rem;
          font-weight: 700;
          word-break: break-word;
        }
        .conversationMessageText {
          color: var(--text-secondary);
          font-size: 0.84rem;
          line-height: 1.45;
          word-break: break-word;
        }
        .conversationMediaTag {
          display: inline-flex;
          align-items: center;
          padding: 0.1rem 0.45rem;
          margin-right: 0.25rem;
          border-radius: 999px;
          background: rgba(16, 185, 129, 0.14);
          color: #34d399;
          font-weight: 700;
          white-space: nowrap;
        }
        .conversationNote,
        .conversationEmpty {
          margin: 0;
          color: var(--text-muted);
          font-size: 0.85rem;
        }
        .conversationRawFallback {
          margin: 0;
          font-family: SFMono-Regular, Consolas, "Liberation Mono", Menlo, monospace;
          font-size: 0.82rem;
          color: var(--text-secondary);
          white-space: pre-wrap;
          word-break: break-word;
          line-height: 1.6;
          background: transparent;
          border: 0;
          padding: 0;
        }
        @media (max-width: 720px) {
          .conversationMessageRow {
            grid-template-columns: 1fr;
            gap: 0.25rem;
          }
        }
        .historyItem:hover {
          background-color: rgba(255, 255, 255, 0.05) !important;
        }
        .activeHistory {
          background-color: var(--bg-card) !important;
          box-shadow: var(--shadow-sm);
        }
        .deleteSummaryBtn:hover {
          opacity: 1 !important;
          transform: scale(1.15);
        }
        .custom-scroll::-webkit-scrollbar {
          width: 6px;
        }
        .custom-scroll::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scroll::-webkit-scrollbar-thumb {
          background: var(--border-color);
          border-radius: 3px;
        }
        .custom-scroll::-webkit-scrollbar-thumb:hover {
          background: var(--text-muted);
        }
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
        @keyframes bounce {
          0%, 80%, 100% { transform: scale(0); }
          40% { transform: scale(1.0); }
        }
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}
