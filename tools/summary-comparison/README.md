# Comparação local: Hydrogen e Gemini 3.8 Flash

O programa TesteGeminiHydrogen compara duas abas: Gemini do FollowUp (atualmente gemini-4-hydrogen) e Gemini 3.8 Flash (gemini-3.8-flash). ERNIE, Nemotron, 2.5 Flash e Flash-Lite não participam. Não há chamadas ao OpenRouter, leitura de sua chave nem botão para abrir o teste antigo. Backups e app.py anterior continuam preservados, sem uso na tela atual.

## Como usar

Feche a janela antiga e reabra pelo .bat existente. Confira a data 2026-11-18 e os áudios transcritos. Clique Gerar nos dois modelos. O dia inteiro é enviado sem blocos, em chamadas independentes, com a mesma chave Gemini. Repetir somente este modelo permite nova tentativa de uma aba sem importar novamente nem reiniciar a outra. Sobreposição na mesma aba é bloqueada, inclusive se a outra ainda está rodando. Tentativas anteriores permanecem no relatório.

A chave Gemini é a mesma carregada do ambiente ou .env.local pelo programa original. Vincular faturamento ao mesmo projeto altera as condições/cotas dessas chamadas, sem trocar a chave ou modificar o modelo. Cada execução dos dois modelos consome a cota/cobrança de ambos. O programa não consulta saldo/plano e não confirma que a compra foi ativada; confira isso no AI Studio. O plano pago não garante menor latência. O tempo mostrado inclui rede e eventuais retries.

Exportar avaliação completa grava um JSON com conversas/transcrições/cadastros, prompt/schema exatos, hash, parâmetros, modelo solicitado/retornado, horários, tempos, tokens, motivos de término e todas as tentativas, inclusive falhas. Pode exportar durante a geração (tentativa running); para análise completa, exporte após terminar. Chaves, ambiente, cabeçalhos e stderr não entram no relatório. O arquivo contém dados pessoais; somente a exportação explícita grava esses dados, sem upload automático.

## Fluxo equivalente

A ponte Node tools/summary-comparison/followup-bridge.mjs usa validateSummaryRequest e o preparador compartilhado src/lib/ai/whatsapp-summary-input.ts, também usado pelo fluxo ativo da extensão no Mônada, e chama generateWhatsappSummary do projeto com o SDK oficial instalado. Para a aba 3.8, substitui apenas o campo model do argumento da chamada isolada ao SDK. AI_MODELS, arquivos e configuração do Mônada não são alterados. A ponte permite somente o modelo atual do FollowUp ou gemini-3.8-flash. Usa LOW, temperatura padrão, timeout por tentativa 60s, limite total 180s e retryOptions padrão do SDK. A preparação offline não envia dados. Uma mudança de modelo depois de preparar a entrada é recusada.

Fontes TypeScript são transpilados em memória; não há acesso ao banco, mudança de produção ou persistência de conversas do Mônada. Somente os módulos confiáveis do repositório são transpilados; mensagens/cadastros são dados, nunca executados. É um teste do fluxo atual, não reprodução garantida de um resumo histórico. Respostas podem variar. JSON válido não garante fidelidade.

## Requisitos e privacidade

Python/Tkinter, Node.js e dependências instaladas no projeto em C:/Users/taian/Documents/antigravity/FollowUpMonada. Mover o projeto exige ajustar PROJECT_ROOT. O app.py/launcher continuam compatíveis; backup de comparison.py é preservado. O arquivo open-router-key.txt anterior permanece intacto na pasta, mas não é lido pelo programa.

Ao abrir, carrega a última exportação de 2026-11-18 em Downloads; na ausência, tenta PoC rodada 3, sem transcrições/cadastros atuais. Use --sem-carregar para impedir a carga inicial. Conteúdo incompleto exige confirmação e gera ressalvas no prompt. Sem truncamento silencioso; entrada acima do limite é recusada. A chave é enviada somente ao SDK/API do Google; textos/transcrições são enviados apenas ao clicar Gerar/Repetir. Nenhum resumo/demanda do Mônada é substituído. Fechar não cancela uma chamada já recebida pelo provedor.

## Verificação

python -m unittest discover -s tools/summary-comparison -p 'test_*.py'

Onze testes sintéticos verificam importação/autoria/data, ausência de mídias/chaves, prompt/schema reais preparados offline, rota exclusiva Gemini com rejeição de modelos removidos e roteamento de cada modelo ao mesmo prompt/schema, erros sem vazamento, bloqueio de repetição simultânea e exportação de todas as tentativas sem chaves. Smoke Tk verifica duas abas em diferentes larguras. node --check valida a ponte e npm test é executado após a última alteração. Nenhum teste faz geração real nas APIs.


## Diagnóstico da API e espera

A tela atualiza o tempo decorrido durante a espera e mostra preparação local, espera da resposta integral ou processamento do SDK. O modo continua sem streaming: tokens e resumo só aparecem depois da resposta completa. O programa não presume que haja tokens sendo gerados enquanto espera.

A ponte observa fetch apenas no processo filho e no host generativelanguage.googleapis.com, sem alterar corpo, cabeçalhos, resultado, exceção ou política de retries. Eventos locais JSON registram início/número da chamada, código HTTP, tempo até receber os cabeçalhos e Retry-After numérico quando fornecido; não registram URL, query string, chave, cabeçalhos arbitrários ou corpo. A tela mostra chamadas HTTP realmente observadas, não o número máximo configurado de retries. Um HTTP 200 nos cabeçalhos ainda não significa resumo completo. Rede/timeout sem resposta não recebe um código HTTP inventado.

No resultado há modelo retornado, motivo de término, tokens de entrada/saída/raciocínio/cache/total quando informados. A exportação inclui também responseId validado, versão do SDK, eventos HTTP, tempo de parede por tentativa e categoria/status seguro de falhas. Plano de faturamento, saldo, custo e limites restantes não são fornecidos pela resposta: não são inferidos nem estimados. Confira-os no AI Studio.

A configuração da API permanece 60s por tentativa e 180s totais. O processo local tem guarda de 195s (inclui inicialização/serialização). Timeout local encerra o processo filho e recebe mensagem específica; isso não cancela trabalho já recebido no servidor nem comprova ausência de cobrança. A UI pode exportar mesmo durante a espera; o relatório mostra elapsedWall e state running nesse caso. A telemetria não provoca chamadas adicionais.

Verifique também `node --test tools/summary-comparison/followup-bridge.test.mjs`: três testes sintéticos comprovam seleção isolada de modelo, preservação da resposta/erro, ausência de retries extras, contagem de chamadas e exclusão de dados privados. Testes Python cobrem eventos ao vivo, relógio durante espera, falhas sanitizadas, término do processo no limite local e exportação. O teste não confirma o plano pago nem a velocidade real de uma geração.


## Entrada compacta compact-v1

O teste e o fluxo ativo chrome_extension compartilham a mesma preparação. Mantêm Hydrogen e LOW (que já estava ativo antes desta otimização). Nenhuma API é usada para filtrar mensagens.

A análise omite chatJid terminado em @newsletter e conteúdos vazios/placeholder de mídia. Legendas, transcrições habilitadas e texto útil em tipos desconhecidos são preservados. Consentimentos e ressalvas de áudio/histórico parcial são calculados antes do filtro. As mensagens originais e a consulta continuam completas; somente a projeção enviada à IA muda. Se nada útil restar, nenhuma geração é enviada.

Mensagens são agrupadas pelo ID real da conversa (nomes iguais não juntam chats), com cabeçalho único e horários de São Paulo. A projeção não repete data/JID em cada linha. Comunicados longos exatamente iguais, do mesmo autor identificado em conversas diferentes, podem usar uma definição @R com cada entrega/horário/autor preservados. Não há deduplicação aproximada, por nome de exibição nem remoção de mensagens curtas. Remetentes sem identificação estável ou com aliases diferentes não são presumidos iguais. No conjunto real medido não houve referência que satisfizesse esse critério conservador; a maior economia veio dos canais e da formatação.

Clientes vão à API como [índice,nome], sem UUID. A resposta usa clientIndex inteiro ou null; somente índices do cadastro autenticado são permitidos. O backend converte para o client_id UUID original e reaplica a validação de saída/status antes de salvar. A interface e os registros salvos continuam no formato existente. Não aceita UUID inserido pelo modelo em substituição ao índice nem índice fora da faixa. O de-para permanece local ao pedido e ao usuário.

preparedInput.optimization contém contagens de mensagens originais, incluídas, canais/mídias omitidos, textos compartilhados, referências, conversas e caracteres; clientMap fica no relatório local explícito, não no prompt/schema enviado. inputPolicy identifica compact-v1. O resumo persistido inclui somente os contadores/versão da política (sem textos). A política anterior não é reutilizada silenciosamente na mesma importação: continua exigida a confirmação para substituir resumo existente. A troca de política não dispara geração automática nem altera resumos antigos.

Medição offline sobre a avaliação fornecida: 778 mensagens originais; 90 mensagens newsletter e 35 sem texto útil omitidas; 653 mensagens em 42 conversas incluídas. Prompt passou de aproximadamente 118 mil para 48,5 mil caracteres (cerca de 59% menos). Caracteres JavaScript UTF-16 e Python Unicode podem diferir por emojis. Isso não mede tokens/custo nem garante economia de 80–90%; só uma geração real e o faturamento podem confirmar. O código não aplica preço estimado nem muda modelo, LOW, retries ou permissões.

Cobertura adicional: Vitest testa filtros seletivos, legendas/áudios, autoria, conversas de nomes iguais, referências sem perda de contexto, UUID fora do prompt, índices inválidos e manutenção de status. Testes stateless verificam ausência de chamadas quando só há canais, política versionada e consentimento de substituição. Testes Python usam a mesma entrada compacta. A revisão responsiva mantém o aviso com quebra de linha em 320/375/768/1024px; verificação visual autenticada e nova geração ficam para o usuário.


## Comparação 3.8 Flash

O pedido de teste é guardado por aba com requestedModel distinto e o mesmo inputHash/schema. A resposta registra o modelo real quando fornecido; na ausência, registra o modelo solicitado. O relatório único reúne os dois resultados e todo o histórico. O valor de preparedInput.model identifica a referência do Mônada; para saber qual modelo cada tentativa usou, consulte attempts de cada aba, requestedModel e result.model. As configurações LOW, temperatura padrão, retries oficiais, timeout e entrada compact-v1 são comuns. Não usa versão Lite nem alias latest/fallback.

As chamadas começam em paralelo; contenção de cota e variação de disponibilidade podem afetar tempo. Não é garantia de qualidade ou menor custo. O teste é local; produção segue Hydrogen. Nenhuma geração paga é disparada pela instalação/testes automatizados. O guia oficial atual lista LOW como suportado pelo 3.8 Flash: https://aistudio.google.com/docs/models/gemini-3.8-flash.


## Correção de exibição e recuperação de avaliação

Campos de usage são opcionais na resposta Gemini. A ausência de reasoning (ou input/output/cache/total) é mostrada como não informado, sem assumir zero nem interromper o polling. Zero explicitamente retornado continua mostrado como zero. Essa correção evita que um resultado concluído libere o botão de repetição mas deixe a tela vazia e pare de atualizar a outra aba. Resultados e erros independentes continuam registrados na avaliação.

Antes de fechar uma janela antiga afetada, use Exportar avaliação completa: o resultado pode já estar no JSON mesmo sem ter sido desenhado. Reabra o programa atualizado e clique Abrir avaliação salva (sem usar API). A leitura valida formato/tamanho/data/autoria/resultados e recupera as abas disponíveis sem carregar chaves, chamar Node ou fazer qualquer chamada de IA. Tentativas running no arquivo não são retomadas automaticamente e não são exibidas como concluídas. Só se recupera o que foi efetivamente exportado; uma resposta na fila interna da janela antiga pode não constar do arquivo.

A entrada preparada arquivada é preservada para exportação e auditoria, mas não é reutilizada para uma nova geração: uma repetição prepara a configuração/entrada atuais. O botão fica indisponível enquanto há geração em andamento para impedir mistura de datas/resultados. Dados do relatório são tratados somente como JSON; não há execução de comandos, URLs ou templates vindos do arquivo. A revisão de janela mantém o botão em outra linha para caber na largura mínima.

Regressões sintéticas exercitam duas respostas concluídas sem reasoning, continuidade da atualização de ambas, zero versus contador ausente, leitura offline da avaliação e recuperação sem chamadas à API. Nenhuma geração real foi disparada para diagnosticar ou corrigir o erro.
