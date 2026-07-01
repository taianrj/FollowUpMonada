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

    const { text, date, saveToDb, userId } = await request.json();

    if (!text || !text.trim()) {
      return NextResponse.json({ error: 'Texto das mensagens não fornecido' }, { status: 400 });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey || apiKey === 'your-gemini-api-key') {
      return NextResponse.json({ 
        error: 'Chave de API do Gemini não configurada no servidor (.env.local).' 
      }, { status: 500 });
    }

    // 1. Busca os clientes cadastrados no banco para que a IA faça o mapeamento
    const { data: dbClients } = await supabase
      .from('clients')
      .select('id, name')
      .order('name', { ascending: true });

    // 2. Busca os status para que a IA possa sugerir demandas com status válidos
    const { data: dbStatuses } = await supabase
      .from('statuses')
      .select('id, name')
      .order('created_at', { ascending: true });

    const clientListPrompt = dbClients && dbClients.length > 0
      ? dbClients.map(c => `     * ID: "${c.id}" - Nome: "${c.name}"`).join('\n')
      : 'Nenhum cadastrado';

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

    // Inicializa a IA do Gemini
    const genAI = new GoogleGenerativeAI(apiKey);
    
    // Prompt especializado para resumo de conversas e separação por cliente
    const prompt = `
Você é um analista de operações e assistente de IA sênior encarregado de ler o histórico de mensagens de WhatsApp do dia e gerar um resumo executivo de fim de dia estruturado, separando-o por cliente.

Texto de Entrada (Mensagens de WhatsApp do dia):
"""
${text}
"""

Instruções importantes de negócio:
1. Agrupe as conversas e tópicos discutidos por cliente/empresa.
2. Identifique quais clientes cadastrados no sistema estão participando ou sendo mencionados na conversa.
   Aqui está a lista de Clientes Cadastrados no sistema (use o client_id correspondente se for o mesmo cliente. Se for um cliente novo não listado, retorne client_id como null e crie um client_name amigável e profissional):
${clientListPrompt}
   - Se o cliente citado nas mensagens for graficamente ou foneticamente muito próximo de um cliente da lista (ex: "Acme" e na lista tem "Acme Corp"), faça a associação e use o ID e nome corretos da lista.

3. Para cada cliente identificado nas conversas do dia, retorne:
   - client_name: Nome do cliente (da lista ou um novo nome simplificado se não cadastrado).
   - client_id: O UUID correspondente do cliente (da lista cadastrada) ou null se for um cliente novo.
   - general_summary: Um parágrafo coeso, bem escrito e profissional em português do Brasil resumindo o teor geral das interações com esse cliente no dia (ex: o que foi discutido, dúvidas do cliente, feedback recebido, etc.).
   - key_points: Uma lista de strings com os pontos mais importantes, decisões acordadas, ou avisos dados durante a conversa deste cliente no dia (seja conciso e direto).
   - suggested_tasks: Uma lista de tarefas específicas/demandas pendentes que foram solicitadas ou identificadas como necessárias a partir das conversas do dia.
     Para cada tarefa sugerida, retorne:
     * description: A descrição clara, curta e objetiva da tarefa (ex: "Enviar relatório financeiro retificado" ou "Criar layout da tela de login").
     * responsibles: Uma lista contendo nomes de possíveis colaboradores responsáveis por executar a tarefa se forem citados na conversa (caso contrário, retorne uma lista vazia []).
     * status: Deve ser estritamente uma destas chaves exatas de status (letras minúsculas):
${statusListPrompt}
       Caso não esteja claro, use "${validStatusIds[0]}" por padrão.
     * observations: Observações adicionais sobre prazos acordados na conversa, notas técnicas ou contexto relevante para esta tarefa específica.

4. SEPARAÇÃO PRECISA: Não misture conversas de clientes diferentes. Se um bloco de conversa for geral ou não for possível identificar nenhum cliente específico, agrupe-o sob um cliente fictício chamado "Geral / Sem Cliente Específico" com client_id = null.

Retorne estritamente um JSON no formato especificado abaixo, sem textos adicionais, blocos markdown de código ou explicações:
{
  "summaries": [
    {
      "client_name": "Nome do Cliente",
      "client_id": "uuid_ou_null",
      "general_summary": "Resumo geral das conversas de hoje com este cliente...",
      "key_points": [
        "Ponto chave 1 acordado...",
        "Ponto chave 2 sobre entrega..."
      ],
      "suggested_tasks": [
        {
          "description": "Descrição curta da tarefa",
          "responsibles": ["Nome do Responsável se citado"],
          "status": "status_id",
          "observations": "Observação de prazo ou contexto"
        }
      ]
    }
  ]
}
`;

    let responseText = '';
    let successProvider = 'gemini';

    try {
      // Tenta usar o Gemini 2.5 Flash com resposta estruturada JSON
      const model = genAI.getGenerativeModel({ 
        model: 'gemini-2.5-flash',
        generationConfig: {
          responseMimeType: 'application/json',
        }
      });

      const response = await model.generateContent(prompt);
      responseText = response.response.text();
      
      if (!responseText) {
        throw new Error('O modelo do Gemini não retornou nenhuma resposta.');
      }
    } catch (geminiError: any) {
      console.warn('Falha na API do Gemini para resumo. Tentando provedor de fallback Groq...', geminiError);

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
        throw new Error(`A API do Gemini falhou (${geminiError.message || geminiError}) e a chave de backup da Groq não está configurada.`);
      }
    }

    const parsedData = JSON.parse(responseText);

    // Se solicitado, salva o resumo no banco de dados do Supabase
    if (saveToDb) {
      const dbDate = date ? new Date(date).toISOString().split('T')[0] : new Date().toISOString().split('T')[0];
      
      const { data: insertedSummary, error: dbErr } = await supabase
        .from('whatsapp_summaries')
        .insert({
          summary_date: dbDate,
          raw_text: text,
          summary_data: parsedData,
          created_by: userId || user.id
        })
        .select()
        .single();

      if (dbErr) {
        console.error('Erro ao salvar resumo de WhatsApp no banco de dados:', dbErr);
        // Não falha a requisição se der erro de banco (ex: tabela não criada ainda), 
        // apenas retornamos o JSON e avisamos que não salvou no banco.
        return NextResponse.json({
          success: true,
          savedInDb: false,
          dbError: dbErr.message,
          provider: successProvider,
          data: parsedData
        });
      }

      return NextResponse.json({
        success: true,
        savedInDb: true,
        summaryId: insertedSummary.id,
        provider: successProvider,
        data: parsedData
      });
    }

    return NextResponse.json({ 
      success: true, 
      savedInDb: false,
      provider: successProvider,
      data: parsedData 
    });

  } catch (error: any) {
    console.error('Erro na rota whatsapp-summary:', error);
    return NextResponse.json({ 
      error: error.message || 'Erro interno ao processar resumo do WhatsApp com IA.' 
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
      temperature: 0.2
    })
  });

  if (!response.ok) {
    const errData = await response.json();
    throw new Error(errData.error?.message || response.statusText);
  }

  const data = await response.json();
  return data.choices[0]?.message?.content || '';
}
