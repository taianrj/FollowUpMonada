import { NextResponse } from 'next/server';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { createClient } from '@/lib/supabase/server';

export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    
    // Verifica se o usuário está autenticado
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
    }

    const { text, userId } = await request.json();

    if (!text || !text.trim()) {
      return NextResponse.json({ error: 'Texto não fornecido' }, { status: 400 });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey || apiKey === 'your-gemini-api-key') {
      return NextResponse.json({ 
        error: 'Chave de API do Gemini não configurada no servidor (.env.local).' 
      }, { status: 500 });
    }

    // 1. Busca os dados dinâmicos do Supabase para alimentar o prompt do Gemini
    const { data: dbStatuses } = await supabase
      .from('statuses')
      .select('id, name')
      .order('created_at', { ascending: true });

    const { data: dbCollaborators } = await supabase
      .from('collaborators')
      .select('name')
      .order('name', { ascending: true });

    const { data: dbClients } = await supabase
      .from('clients')
      .select('name')
      .order('name', { ascending: true });

    // Busca as demandas ativas atuais para evitar duplicatas semânticas
    const { data: dbActiveTasks } = await supabase
      .from('tasks')
      .select('description, client_id, clients(name)')
      .eq('is_archived', false);

    // Fallback de status padrão caso o banco de dados esteja vazio
    const validStatusIds = dbStatuses && dbStatuses.length > 0 
      ? dbStatuses.map(s => s.id) 
      : ['aguardando cliente', 'aguardando texto', 'ajuste', 'aguardando aprovação', 'resolvido'];

    const statusListPrompt = dbStatuses && dbStatuses.length > 0
      ? dbStatuses.map(s => `     * "${s.id}" (${s.name})`).join('\n')
      : `     * "aguardando cliente" (Aguardando Cliente)
     * "aguardando texto" (Aguardando Texto)
     * "ajuste" (Ajuste)
     * "aguardando aprovação" (Aguardando Aprovação)
     * "resolvido" (Resolvido)`;

    const collaboratorListPrompt = dbCollaborators && dbCollaborators.length > 0
      ? dbCollaborators.map(c => c.name).join(', ')
      : 'Nenhum cadastrado';

    const clientListPrompt = dbClients && dbClients.length > 0
      ? dbClients.map(c => c.name).join(', ')
      : 'Nenhum cadastrado';

    const activeTasksListPrompt = dbActiveTasks && dbActiveTasks.length > 0
      ? dbActiveTasks.map(t => {
          const clientObj = Array.isArray(t.clients) ? t.clients[0] : (t.clients as any);
          const clientName = clientObj?.name || 'Sem Cliente';
          return `     * Cliente: "${clientName}" - Demanda: "${t.description}"`;
        }).join('\n')
      : '     * Nenhuma demanda ativa cadastrada no momento.';

    // Inicializa a IA do Gemini
    const genAI = new GoogleGenerativeAI(apiKey);
    
    // Prompt de extração estruturada parametrizado dinamicamente
    const prompt = `
Você é um assistente de produtividade encarregado de ler anotações, atas de reuniões, e-mails ou mensagens e extrair tarefas estruturadas de forma limpa.

Texto de Entrada:
"""
${text}
"""

Instruções importantes:
1. Identifique todas as demandas distintas mencionadas no texto.
2. Para cada demanda, extraia:
   - client_name: Nome do cliente ou da empresa a quem a demanda pertence. Tente associar o nome extraído aos clientes já cadastrados no sistema: [ ${clientListPrompt} ]. Se houver semelhança gráfica (ex: se o texto diz 'Acme' e na lista tem 'Acme Corp', use 'Acme Corp'), use o nome da lista. Caso contrário, crie um nome novo simplificado e profissional.
   - description: Uma frase clara, direta e concisa resumindo o que precisa ser feito.
   - responsibles: Uma lista de strings contendo os nomes das pessoas encarregadas daquela demanda. Tente associar os nomes aos colaboradores já cadastrados no sistema: [ ${collaboratorListPrompt} ]. Se o texto citar 'Carlos' e na lista de colaboradores tem 'Carlos Silva', prefira usar 'Carlos Silva'. Se o colaborador citado não estiver cadastrado, retorne o nome dele mesmo assim. Caso não haja responsáveis citados, retorne uma lista vazia [].
   - status: O status atual da demanda deduzido do contexto. Ele DEVE ser estritamente uma destas opções exatas (tudo em letras minúsculas):
${statusListPrompt}
     Se o texto não der pistas claras de status, use "${validStatusIds[0]}" por padrão.
   - observations: Observações adicionais, prazos citados, notas de contexto ou detalhes técnicos que estavam no texto.

3. EVITE DUPLICATAS: Analise a lista de demandas ativas já existentes fornecida abaixo. Se no texto de entrada houver alguma demanda descrita que já exista (seja idêntica ou semanticamente muito semelhante para o mesmo cliente), você NÃO DEVE extraí-la para o JSON para evitar redundâncias no sistema.

Lista de Demandas Ativas já existentes no sistema (NÃO adicione duplicatas semanticamente semelhantes a estas para o mesmo cliente):
${activeTasksListPrompt}

Seu retorno DEVE ser estritamente um objeto JSON válido, sem comentários adicionais no formato:
{
  "tasks": [
    {
      "client_name": "Nome do Cliente",
      "description": "Descrição da demanda",
      "responsibles": ["Responsável 1", "Responsável 2"],
      "status": "status_deduzido",
      "observations": "Observações extras"
    }
  ]
}
`;

    let responseText = '';
    let successProvider = 'gemini';

    try {
      // Utiliza o modelo gemini-2.5-flash configurado para saída JSON estruturada
      const model = genAI.getGenerativeModel({ 
        model: 'gemini-2.5-flash',
        generationConfig: {
          responseMimeType: 'application/json',
        }
      });

      const response = await model.generateContent(prompt);
      responseText = response.response.text();
      
      if (!responseText) {
        throw new Error('O modelo do Gemini não retornou nenhum conteúdo.');
      }
    } catch (geminiError: any) {
      console.warn('Falha na API do Gemini. Tentando provedor de fallback Groq...', geminiError);

      const groqKey = process.env.GROQ_API_KEY;

      if (groqKey && groqKey !== 'your-groq-api-key') {
        successProvider = 'groq';
        try {
          responseText = await tryGroq(groqKey, prompt);
        } catch (groqError: any) {
          console.error('Falha no fallback da Groq:', groqError);
          throw new Error(`A API do Gemini falhou (${geminiError.message}) e o Fallback da Groq também falhou (${groqError.message}).`);
        }
      } else {
        throw new Error(`A API do Gemini falhou (${geminiError.message || geminiError}) e a chave de backup da Groq não está configurada no arquivo .env.local.`);
      }
    }

    const parsedData = JSON.parse(responseText);
    const extractedTasks = parsedData.tasks || [];

    let tasksCreatedCount = 0;

    // Processa a inserção no banco de dados para cada tarefa extraída
    for (const taskItem of extractedTasks) {
      if (!taskItem.client_name || !taskItem.description) {
        continue;
      }

      // 1. Procura o cliente pelo nome (ignora maiúsculas/minúsculas)
      let { data: client, error: clientFindErr } = await supabase
        .from('clients')
        .select('id, name')
        .ilike('name', taskItem.client_name.trim())
        .maybeSingle();

      if (clientFindErr && clientFindErr.code !== 'PGRST116') {
        console.error('Erro ao buscar cliente:', clientFindErr);
        continue;
      }

      // Se o cliente não existir, cadastra-o
      if (!client) {
        const { data: newClient, error: clientInsertErr } = await supabase
          .from('clients')
          .insert({ name: taskItem.client_name.trim() })
          .select('id, name')
          .single();

        if (clientInsertErr) {
          console.error('Erro ao cadastrar novo cliente:', clientInsertErr);
          continue;
        }
        client = newClient;
      }

      // Validação de Duplicatas Semânticas no Backend
      if (client && dbActiveTasks) {
        const clientName = client.name || taskItem.client_name.trim();
        const clientTasks = dbActiveTasks.filter(t => t.client_id === client.id);
        const isDup = clientTasks.some(t => isDuplicateTask(taskItem.description, t.description));
        if (isDup) {
          console.warn(`[Prevenção] Demanda duplicada descartada para o cliente "${clientName}": "${taskItem.description}"`);
          continue;
        }
      }

      // 2. Valida o status extraído pela IA com a lista de status dinâmicos do banco
      let status: string = validStatusIds[0];
      if (taskItem.status && validStatusIds.includes(taskItem.status)) {
        status = taskItem.status;
      }

      // 3. Insere a demanda vinculada ao cliente
      const { data: newDbTask, error: taskInsertErr } = await supabase
        .from('tasks')
        .insert({
          client_id: client.id,
          description: taskItem.description.trim(),
          responsibles: taskItem.responsibles || [],
          status: status,
          observations: taskItem.observations?.trim() || '',
          is_archived: false,
          created_by: userId || user.id
        })
        .select('id')
        .single();

      if (taskInsertErr) {
        console.error('Erro ao inserir tarefa:', taskInsertErr);
      } else if (newDbTask) {
        // Grava histórico de criação via IA
        const { error: historyErr } = await supabase
          .from('task_history')
          .insert({
            task_id: newDbTask.id,
            changed_by: userId || user.id,
            action: 'create',
            created_by_ai: true,
            ai_provider: successProvider === 'gemini' ? 'gemini-2.5-flash' : 'llama-3.3-70b-versatile (Groq)'
          });
        
        if (historyErr) {
          console.error('Erro ao gravar log da IA no histórico:', historyErr);
        }
        
        tasksCreatedCount++;
      }
    }

    return NextResponse.json({ 
      success: true, 
      count: tasksCreatedCount, 
      tasks: extractedTasks 
    });

  } catch (error: any) {
    console.error('Erro na rota parse-tasks:', error);
    return NextResponse.json({ 
      error: error.message || 'Erro interno ao processar texto com IA.' 
    }, { status: 500 });
  }
}

async function tryGroq(apiKey: string, prompt: string): Promise<string> {
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: 0.1
    })
  });

  if (!response.ok) {
    const errData = await response.json();
    throw new Error(errData.error?.message || response.statusText);
  }

  const data = await response.json();
  return data.choices[0]?.message?.content || '';
}

function cleanText(text: string): string[] {
  const normalized = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?"']/g, ' ');
  
  const stopWords = new Set([
    'a', 'o', 'as', 'os', 'de', 'do', 'da', 'dos', 'das', 'em', 'um', 'uma', 'uns', 'umas',
    'para', 'com', 'por', 'sobre', 'que', 'se', 'e', 'ao', 'aos', 'no', 'na', 'nos', 'nas', 'pra'
  ]);

  return normalized
    .split(/\s+/)
    .filter(word => word.length > 2 && !stopWords.has(word));
}

function isDuplicateTask(newDesc: string, existingDesc: string): boolean {
  const words1 = cleanText(newDesc);
  const words2 = cleanText(existingDesc);

  if (words1.length === 0 || words2.length === 0) return false;

  const set1 = new Set(words1);
  const set2 = new Set(words2);

  const intersection = new Set([...set1].filter(x => set2.has(x)));
  const union = new Set([...set1, ...set2]);

  const jaccard = intersection.size / union.size;
  const overlap = intersection.size / Math.min(set1.size, set2.size);

  // Considera duplicada se Jaccard > 0.40 ou se a sobreposição de termos chave for de pelo menos 50%
  return jaccard > 0.40 || overlap >= 0.50;
}
