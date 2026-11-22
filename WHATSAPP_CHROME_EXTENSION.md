# Integração WhatsApp pelo Chrome — versão 0.3.0

## Arquitetura atual

`WHATSAPP_INTEGRATION_MODE=baileys` é o padrão, preserva a implementação antiga e
não muda automaticamente por desconexão. `chrome_extension` usa o fluxo abaixo,
sem depender do processo `whatsapp-service`, Worker, Durable Objects ou R2.
`DATABASE_PROVIDER` continua selecionando autenticação, cadastros e resumos finais.

1. O Mônada inicia coleta na extensão. A conta é identificada explicitamente e
   confirmada; PN/LID não são inferidos de contatos, nomes ou conversas.
2. A cópia temporária da coleta e a fila validada ficam em IndexedDB da extensão.
   Lotes, hashes, deduplicação, `fromMe` e confirmação de histórico parcial usam
   o motor compartilhado `workers/whatsapp-extension/engine.mjs`, empacotado no Chrome.
3. A extensão coordena tentativas e chama o Mônada pela aba autenticada para IA.
   Cada áudio passa em memória pelo servidor; sua transcrição volta à extensão.
   O servidor não mantém filas, uploads ou conversas desse novo fluxo.
4. A extensão envia as mensagens/transcrições necessárias para gerar o resumo.
   O servidor revalida dados, data, autoria, permissões, pendências e substituição.
5. Somente o resultado final é salvo: resumo, sugestões de demandas e metadados.
   `raw_text` fica vazio, sem cópia integral das mensagens/transcrições. O resultado
   contém informações derivadas das conversas; não equivale à ausência desses
   dados no resumo. Provedores externos de IA recebem o conteúdo durante a geração.

`POST /api/whatsapp-extension` aceita `transcribe`, `summarize`, `summaryExists` e
leitura histórica legada `history`. Operações antigas de upload/fila/configuração
retornam 410 com orientação para atualizar. O callback antigo de processamento
mantém autenticação por segredo e, após autenticar, retorna 410. Ele não inicia IA.
As variáveis `WHATSAPP_EXTENSION_WORKER_URL`/`SECRET` não são necessárias no fluxo
atual. Os arquivos do Worker e o antigo adaptador SQLite foram preservados como
código legado/testes, sem deploy ou migração automática.

## Teste local e atualização

Requisitos: Node.js 24, dependências e `.env.local` de login/banco/IA existentes.
Transcrever e gerar de verdade pode consumir créditos da IA, como antes.

Para quem já configurou o modo extensão:

```powershell
Set-Location 'C:\Users\taian\Documents\antigravity\FollowUpMonada'
npm.cmd run extension:package
npm.cmd run dev -- --port 3000
```

Pare o servidor anterior com Ctrl+C antes de iniciar novamente. Em
`chrome://extensions`, atualize/recarregue a extensão integrada e confirme a
versão **0.3.0**. O ID/chave pública foi preservado. Autorize as novas permissões
para o Mônada e alarmes, se o Chrome solicitar; não é necessário remover a extensão.
Abra WhatsApp Web e Mônada, atualize a página do Mônada e use **Verificar novamente**.

Em uma primeira instalação, use `npm.cmd run extension:setup`, depois carregue
`chrome-extension/dist` sem compactação em modo desenvolvedor. O setup altera
somente campos locais necessários e não imprime o conteúdo de `.env.local`.
Não o execute para trocar uma configuração de produção.

No modo de desenvolvimento, novos resumos finais ficam somente em
`.extension-data/summaries/`, em SQLite por usuário, ignorado pelo Git. O servidor
não grava novas conversas ou transcrições ali. Login e cadastros ainda usam o banco
configurado. Criação de clientes/demandas e exclusão de resumos nesta tela continuam
bloqueadas no teste local. As demais telas não mudam.

Dados antigos de teste em `.extension-data/`, exports da PoC e registros remotos
existentes não são excluídos nem migrados automaticamente. O novo fluxo não retoma
as filas antigas do servidor. **Consultar Conversas** usa a extensão, sem recorrer
ao histórico remoto do Baileys. Resumos existentes continuam acessíveis pela tela.

## Provedores de transcrição

A transcrição prioriza **Groq / `whisper-large-v3-turbo`**, com idioma `pt` explícito.
A documentação atual da Groq apresenta Turbo como a opção mais rápida entre seus
modelos de transcrição multilíngue disponíveis. Foi mantido por atender português;
a velocidade real também depende do arquivo, rede e limites da conta.
Fonte: [Groq Speech to Text](https://console.groq.com/docs/speech-to-text).

Configuração somente no servidor:

- `GROQ_API_KEY`: prioridade quando presente, mesmo com chave Gemini/OpenAI.
- `GROQ_AUDIO_MODEL`: modelo Groq opcional; na ausência, usa
  `AUDIO_TRANSCRIPTION_MODEL` quando definido ou `whisper-large-v3-turbo`.
- `AUDIO_TRANSCRIPTION_LANGUAGE`: idioma opcional em código curto minúsculo;
  padrão `pt`. Não usar `pt-BR` nesse parâmetro.
- Se a chamada principal falhar (inclusive timeout, JSON inválido ou texto vazio),
  usa Gemini com `GEMINI_API_KEY` e `GEMINI_AUDIO_MODEL` ou `gemini-2.5-flash`.
- Sem chave Groq, usa OpenAI se `OPENAI_API_KEY` existir, com `OPENAI_AUDIO_MODEL`,
  `AUDIO_TRANSCRIPTION_MODEL` ou `whisper-1`. A falha também pode usar Gemini.
- Se somente Gemini estiver configurado, usa Gemini diretamente. Sem provedor,
  o áudio fica com falha/pendência; não é tratado como transcrição concluída.

A prioridade Groq é somente para áudio. A geração de resumos usa Gemini Hydrogen.
A configuração não é recebida do navegador. As chamadas usam destinos fixos HTTPS,
sem seguir redirects nem propagar erros/corpos dos provedores ao usuário. Os arquivos
passam em memória; transcrições continuam na extensão. A integração não importa o
processo `whatsapp-service`. O fluxo Baileys existente não foi alterado.

Não é necessário atualizar a extensão por esta mudança: reinicie o servidor local.
Testes sem rede real cobrem prioridade, multipart/idioma/modelo, fallback, ausência
de chaves, validação e erros seguros. Nenhum áudio real foi enviado para verificar
os provedores, e nenhuma chave foi copiada ou alterada.

## Geração de resumo com Hydrogen

Os fluxos de resumo (extensão e API usada pelo Baileys) compartilham
`src/lib/ai/whatsapp-summary.ts`. O modelo é explicitamente `gemini-4-hydrogen`,
com `ThinkingLevel.LOW` e JSON Schema/validação server-side preservados. Não usa
`gemini-flash-latest`, lista dinâmica, fallback de modelo ou provedor alternativo.
O identificador foi escolhido explicitamente; futuros lançamentos não mudam o
modelo automaticamente. A transcrição Groq/Gemini não foi alterada por esta escolha.

Uma chamada ao SDK oficial `@google/genai` habilita `httpOptions.retryOptions: {}`.
Na versão instalada, isso usa até 5 tentativas totais (incluindo a primeira), espera
exponencial com jitter e os status 408/429/500/502/503/504. A aplicação não implementa
um segundo loop. Erros definitivos e JSON inválido não iniciam outra geração.
Cada tentativa tem timeout de 60 segundos, e o sinal da operação limita o conjunto
a 180 segundos; essa interrupção pode ocorrer antes de esgotar todas as tentativas.

A versão informada pela resposta é registrada em `ai_model` quando disponível;
sem essa informação, registra o ID solicitado. Autenticação, isolamento, confirmação
de pendências/substituição e preservação do resumo anterior continuam em vigor.
O utilitário antigo de múltiplos modelos permanece para compatibilidade e cobertura
legada, mas não é chamado pelos fluxos atuais de geração de resumos.

O uso gratuito depende do projeto da chave estar no Free tier e de suas cotas.
Escolher Hydrogen não altera faturamento, não contrata plano nem garante latência.
Fontes oficiais: [Hydrogen](https://aistudio.google.com/docs/models/gemini-4-hydrogen)
e [faturamento](https://aistudio.google.com/docs/billing). Não houve deploy.

Regressões exercitam o SDK real com HTTP simulado (503 com recuperação, esgotamento
das 5 tentativas e 400 sem repetição), além de configuração, validação, erros seguros,
auditoria e preservação do resumo anterior. Não é necessário atualizar a extensão;
reinicie o servidor local para usar o novo gerador.

## Operação pelo Mônada

- **Consultar Conversas** mostra a importação local da data. Se vazia, faz uma
  prévia do WhatsApp Web sem baixar áudio, iniciar IA ou gerar resumo.
- **Gerar Resumo** coleta todas as conversas disponíveis da data, incluindo grupos
  e canais `@newsletter`, excluindo Status/Stories e controles internos. A cobertura
  é limitada ao histórico local do WhatsApp; não prova completude no celular.
- A transcrição é opcional e a escolha fica na extensão. Desligada, não recupera
  arquivos. Para ativar em uma importação feita sem áudio, colete novamente.
  Mudar a opção de uma coleta interrompida exige confirmar o reinício do rascunho.
- Texto ilegível, autoria ambígua, duplicações e integridade incompleta não podem
  ser ignorados. Imagens não são interpretadas e não bloqueiam a geração.
- Áudio sem transcrição e sinais de histórico parcial exigem confirmação; as
  ressalvas ficam no resumo. O servidor recalcula pendências a partir das mensagens,
  não aceita contadores de prontidão como autoridade.
- Substituição exige confirmação. Conversas só são publicadas na extensão após
  validação dos lotes. O resumo anterior é preservado até salvar o novo com sucesso.
- Arquivos idênticos da mesma conta reutilizam transcrição, inclusive na mesma
  importação. Hashes de contas/usuários diferentes não compartilham o cache.
- Fechar Chrome, desligar o computador, encerrar a sessão ou fechar a aba do Mônada
  pausa o trabalho. Mantenha uma aba autenticada do Mônada aberta para IA. Ao voltar,
  selecione a data e use **Gerar Resumo** para acompanhar/retomar. Alarmes do Chrome
  podem atrasar, especialmente após suspensão. A fila permanece em disco. Uma
  rodada processa trabalho imediato por até cerca de 20 segundos (mais a chamada
  em andamento), evitando esperar um alarme de 30 segundos para cada áudio.
- **Reiniciar coleta interrompida** remove apenas o rascunho de envio ainda não
  publicado. **Dados neste computador > Apagar conversas deste computador** exige
  confirmação e apaga conversas/transcrições/áudios/opções deste usuário e origem;
  preserva resumos salvos e o histórico original do WhatsApp.

## Retenção, espaço e limites

- Conversas, transcrições e cópia local do resultado: 30 dias da coleta. A limpeza
  ocorre nas execuções de manutenção da extensão, enquanto o Chrome puder executar.
- Áudios pendentes/falhos: até 7 dias do envio local; sucesso elimina os arquivos,
  preservando a transcrição até a retenção da conversa. Expiração não vira sucesso.
- Coleta temporária: até 200 MiB por operação; cópias abandonadas expiram após 7 dias.
- Armazenamento da fila: até 256 MiB por usuário/origem, incluindo JSON/base64;
  a quota efetiva do navegador também se aplica. Falhas preservam dados publicados.
- Até 10 mil mensagens/data e 8 MiB de registros na fila local, 100 mensagens/lote.
- Recuperação local aceita áudio até 16 MiB; a transcrição pelo endpoint atual é
  limitada a **2 MiB por arquivo**, para caber em requisições da hospedagem sem
  criar armazenamento remoto. Arquivos maiores permanecem pendentes/falhos com
  explicação e podem ser excluídos do resumo mediante confirmação.
- Envio de mensagens/transcrições à IA: até cerca de **2,8 MB/data**; o endpoint
  limita a requisição inteira a 3 MB. Dias maiores exigem evolução de divisão de
  contexto, ainda não implementada. Nenhuma substituição ocorre em caso de excesso.
- Não há reprodução permanente dos áudios. Remover a extensão/perfil do Chrome
  elimina a cópia local; outro computador não terá as conversas/transcrições.
  Os resumos finais de produção permanecem no Mônada.

## Segurança e distribuição

Cada comando local verifica o administrador ativo no servidor pela sessão real
da aba do Mônada. O `userId` recebido é apenas comparado com essa sessão; não é
aceito como autoridade. O namespace é derivado de origem + usuário autenticado,
e as importações preservam a conta de WhatsApp. Comandos internos não são públicos.
A coleta temporária também verifica origem, usuário e aba antes de ler/devolver dados.

A ponte roda no mundo ISOLATED da aba, confere origem e usa destino fixo
`/api/whatsapp-extension`. A origem é permitida explicitamente no pacote, incluindo
porta exata na lista de origens. Host permissions abrangem apenas WhatsApp Web e
os hosts do Mônada; o Chrome usa padrões por host nas permissões. O CSP permite
conexões somente às origens configuradas. O site não recebe chaves de IA ou segredo
do Worker. POSTs exigem sessão e origem/Content-Type corretos. O usuário esperado
é conferido no POST antes da IA e novamente antes de devolver/salvar, para impedir
corridas de troca de login. Erros inesperados não expõem detalhes internos/PII.

Retomadas do mesmo jobId/conteúdo encontram o resultado final já salvo e evitam
nova IA/gravação. Uma interrupção durante uma chamada de IA ainda pode consumir
créditos mesmo sem resposta; idempotência não cancela a execução do provedor.
O armazenamento local pressupõe acesso restrito à conta do sistema operacional.

Para preparar futuramente a origem de produção, sem publicar:

```powershell
npm.cmd run extension:package -- --origin=https://<dominio-da-aplicacao>
```

Conferir ID/chave da loja, permissões e política antes da submissão. Não listado/
privado ainda exige revisão. `chrome-extension/PRIVACY.md` é rascunho. Não houve
publicação, deploy, contratação, migração ou exclusão de dados antigos.

O aviso de gravações do D1 também pode vir do serviço Baileys existente. Trocar o
modo no Mônada não para esse serviço. Esta alteração não muda nem desliga a produção,
nem garante uso zero de Cloudflare: autenticação/cadastros e resumos ainda a utilizam.
Não há mais gravações de novas conversas/transcrições no fluxo da extensão.

## Verificação

```powershell
npm.cmd test
npm.cmd run build
npm.cmd run extension:package
git diff --check
```

Regressões cobrem: autenticação/origem/troca de sessão; validação das mensagens e
consentimento no servidor; geração sem raw_text; idempotência; filas locais e
cache de transcrição; pausa e reinício de worker; leituras durante IA; bloqueio de
escritas concorrentes; isolamento por usuário/origem; retenção/exclusão; persistência
local somente dos resumos; protocolo da extensão e manutenção do fluxo Baileys.

APIs internas do WhatsApp continuam sujeitas a mudança. Testes automatizados não
substituem o teste real de coleta/transcrição no Chrome. Revisão responsiva considera
320, 375, 768 e 1024 px, quebra de texto, controles alcançáveis e estados do modal.
Uma verificação isolada com Chrome real confirmou CRUD, listagem, isolamento de
namespaces e limpeza de operações no IndexedDB, usando dados sintéticos.
QA visual autenticado e a geração real com IA ficam para o teste local do usuário.


### Comparação local de modelos Gemini

No modo extensão, o painel Consultar Conversas oferece **Exportar para comparar IAs**: exporta a data inteira da conta autenticada, sem respeitar a busca visual, com textos, autoria, transcrições disponíveis e cadastros de clientes/status. Não inclui arquivos de áudio, chaves de mídia ou credenciais. O JSON contém dados pessoais; mantenha-o privado. A leitura usa o canal autenticado existente e não gera/substitui resumos. O rodapé quebra em coluna em telas pequenas e mantém controles de toque de 44px.

O utilitário independente em [tools/summary-comparison](tools/summary-comparison/README.md) compara Hydrogen e Gemini 3.8 Flash com a mesma entrada compacta e ressalvas, sem mudar o modelo do Mônada. Há chamada do dia inteiro, repetição por modelo e exportação completa, sem truncamento silencioso. Testes Python usam dados sintéticos e não chamam APIs. Confira o guia do utilitário para uso, privacidade e limitações.


### Resumos com entrada compacta

No fluxo ativo `chrome_extension`, o resumo usa a projeção `compact-v1`, compartilhada com o teste da Área de Trabalho. Mantém `gemini-4-hydrogen`, raciocínio LOW e retries oficiais. Somente a análise omite canais `@newsletter` e mídias vazias; legendas e transcrições habilitadas continuam incluídas. Agrupa por conversa com horários, preserva autoria e compacta comunicados idênticos por referências quando a identidade é inequívoca, sem apagar entregas/contexto. Consultar Conversas e o histórico salvo não são filtrados por esta política.

Clientes são representados por índices numéricos no prompt/schema e reconvertidos para UUIDs no servidor, com validação estrita e mapa derivado apenas do cadastro do usuário autenticado. Registros/respostas de aplicação mantêm `client_id`. A versão e contagens são registradas nos metadados; resumos antigos não são migrados ou substituídos automaticamente. Substituição permanece explícita; sem texto útil não há chamada à IA. Não há mudança de esquema de banco ou deploy. O fluxo Baileys e o processador legado de extensão não foram alterados.

O comparador lê o preparador comum e exporta os contadores de otimização. Medição offline do conjunto fornecido reduziu o prompt em aproximadamente 59% em caracteres; tokens, preço e qualidade exigem nova geração real. Nenhuma garantia de redução de 80–90% ou preço final. Veja [o guia do teste](tools/summary-comparison/README.md) para critérios e limites. Validação inclui regressões Vitest, testes Python/ponte, build, ESLint e suíte raiz após a última alteração.


### Integração confirmada no Mônada local

O caminho ativo é `POST /api/whatsapp-extension` (ação `summarize`) → `generateExtensionSummary` em `src/lib/whatsapp-extension/stateless.ts` → `prepareWhatsappSummaryInput` → `generateWhatsappSummary` → SDK oficial do Gemini. A referência de produção permanece `gemini-4-hydrogen` com LOW. A comparação 3.8 Flash existe somente no utilitário de teste. O ambiente local já está selecionado como `WHATSAPP_INTEGRATION_MODE=chrome_extension`; não é necessário mudar chave, provedor de banco ou reinstalar a extensão para esta preparação de resumo no backend.

O teste de integração `stateless-generation.test.ts` percorre esse caminho com o SDK real e transporte HTTP simulado. Verifica Hydrogen e LOW no corpo/pedido, índices sem UUID no payload, exclusão seletiva de canais/placeholder, manutenção de legenda e transcrição e salvamento do UUID correto para o ator autenticado, sem raw_text. Índice não cadastrado falha sem gravação nem troca de modelo. Os testes não consomem créditos ou modificam produção.

Para validar no Mônada local, recarregue a página, selecione uma data importada e use Gerar Resumo. Para data com resumo salvo, confirme explicitamente a substituição. A versão compact-v1 impede reutilizar silenciosamente um resumo da política anterior; não há regeneração automática. Consultar Conversas continua exibindo a importação original. Para conferir a projeção aplicada, consulte `summary_data.collection_metadata.summaryInputVersion` e os contadores `summaryInput`, sem armazenar o prompt/texto. Os ganhos reais de tokens observados no programa não são garantia de preço ou latência por dia.

A integração está no código local; publicar esse comportamento no site hospedado exige um deploy separado, que não é feito automaticamente por esta validação.
