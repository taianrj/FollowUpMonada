# FollowUp Mônada — Gerenciador Inteligente de Demandas

O **FollowUp Mônada** é um ecossistema corporativo de alta performance desenvolvido para a gestão inteligente de demandas, controle de prazos e acompanhamento de colaborações de equipes. O sistema conta com inteligência artificial para extração semântica de demandas a partir de mensagens de chat e um microsserviço integrado com o WhatsApp Web (via protocolo Baileys) para coleta em tempo real de briefings.

---

## 🌐 Ambientes do Projeto

O frontend pode ser publicado na Vercel, com Supabase para banco/autenticação e um
microsserviço Node.js atrás de proxy HTTPS para a integração com WhatsApp. Endereços,
identificadores de projeto e dados de infraestrutura devem ser mantidos nas variáveis
de ambiente e nos secrets do provedor, não na documentação pública.

---

## 🛠️ Tecnologias Utilizadas

### Core & Frontend
- **Framework**: [Next.js (App Router)](https://nextjs.org/) + React 19 + TypeScript
- **Estilização**: Vanilla CSS (Premium Dark Slate Theme)
- **Segurança**: Row Level Security (RLS) nativa no Supabase

### Microsserviço de Integração (WhatsApp)
- **Motor de Conexão**: `baileys@7.0.0-rc13` (Multi-device API do WhatsApp Web, com aliases PN/LID)
- **Servidor HTTP**: Node.js + Express
- **Persistência**: arquivos JSON persistentes na VM Oracle + Supabase (tabelas relacionais e blobs de contingência)
- **Auth state do Baileys 7**: `useMultiFileAuthState` com suporte a `lid-mapping`, `device-list` e `tctoken`; o snapshot remoto é consolidado em um único bundle `gzip-base64` para não gerar uma chamada por chave.
- **Conclusão do histórico**: somente o evento oficial `messaging-history.status` de `RECENT` com confirmação explícita de 100%, seguido do processamento do lote final, pode marcar a sincronização como concluída. Pausas inferidas permanecem visíveis como `stalled`.
- **Mídia protobuf**: filas persistentes de áudio/imagem usam `BufferJSON` para preservar `Buffer`/`Uint8Array` exigidos pelo Baileys 7.

### Inteligência Artificial
- **Extração de demandas**: Gemini 3.5 Flash-Lite (`gemini-3.5-flash-lite`), com raciocínio mínimo para reduzir latência e custo.
- **Resumo de WhatsApp**: Gemini 3.7 Flash (`gemini-3.7-flash`), com nível de raciocínio médio para interpretação contextual.
- **Saídas estruturadas**: JSON Schema dinâmico (incluindo os status cadastrados) e validação server-side comum ao Gemini e à Groq.
- **Deduplicação semântica**: Gemini Embedding 2 (`gemini-embedding-2`) com vetores de 768 dimensões e comparação cosseno via `pgvector`.
- **SDK**: `@google/genai`. A Groq (`llama-3.3-70b-versatile`) permanece como fallback quando o Gemini falha ou devolve uma resposta inválida.

---

## ☁️ Produção

O microsserviço de WhatsApp pode ser executado em uma VM com Docker e reinício automático.

* **Aplicação**: contêiner `followup-whatsapp`, escutando internamente em `127.0.0.1:8080`.
* **Proxy público**: proxy reverso HTTPS com renovação automática de certificado.
* **Portas expostas**: somente `80` e `443` para o Caddy; a porta `8080` do microsserviço não é pública. O SSH permanece protegido por chave.
* **Dados locais**: persistidos em volume dedicado, montado como `/app/data` no contêiner.
* **Recuperação de sessão**: as credenciais do Baileys também são restauradas do Supabase. Por isso, uma reinstalação/reinicialização normalmente não exige novo QR Code, desde que a sessão não tenha sido desconectada.

### Operação e verificação

Na VM, os comandos abaixo ajudam a verificar o estado da implantação:

```bash
sudo docker ps
sudo docker logs --tail 100 followup-whatsapp
```

O endpoint público de saúde não exige autenticação e pode ser consultado com:

```bash
curl -fsS https://seu-dominio.example/healthz
```

Na Vercel, prefira `WHATSAPP_SERVICE_URL` para que o endereço upstream permaneça server-side.

### Deploy Automático (CI/CD via GitHub Actions)

O deploy do microsserviço de WhatsApp é realizado automaticamente a cada push na branch `main` através do workflow configurado em [.github/workflows/deploy.yml](file:///.github/workflows/deploy.yml).

Para que o deploy funcione corretamente, as seguintes **Secrets** precisam ser cadastradas nas configurações do seu repositório no GitHub (*Settings > Secrets and variables > Actions*):

1. **`SSH_HOST`**: domínio ou IP do servidor.
2. **`SSH_USER`**: usuário restrito de implantação.
3. **`SSH_KEY`**: O conteúdo textual da chave privada correspondente que você utiliza para acessar a VM.

Proteja o ambiente `production` com aprovação obrigatória e mantenha a branch `main`
protegida. As Actions do workflow são fixadas por SHA imutável e possuem apenas
permissão de leitura do conteúdo.

---

## 🤖 Guia Técnico para IAs Agênticas e Desenvolvedores

### 1. Arquitetura de Comunicação e Segurança

O frontend Next.js não acessa o microsserviço de WhatsApp diretamente no cliente. Ele utiliza uma rota de proxy dinâmico para blindagem de chaves e controle de sessão:
* **Rota Proxy**: `/api/whatsapp-service/[...path]`, mapeada para `WHATSAPP_SERVICE_URL`/`NEXT_PUBLIC_WHATSAPP_SERVICE_URL` e protegida por autenticação administrativa.
* **Segurança de Serviço**: o proxy assina cada chamada com HMAC-SHA256 usando `WHATSAPP_SERVICE_SECRET`, incluindo identidade, método, caminho, query, timestamp, nonce e hash do corpo. O segredo não trafega, credenciais em query string são rejeitadas e nonces não podem ser reutilizados.

### 2. Endpoints do Microsserviço de WhatsApp (Permitidos no Proxy)

* `GET /status`: Retorna o status de conexão (`connected`, `connecting`, `qrcode`, `disconnected`), o status do histórico (`pending`, `syncing`, `stalled`, `completed`), contagens e os sinais oficiais/progresso do Baileys usados para concluir a sincronização.
* `GET /qr-code`: Retorna a imagem do QR Code em formato Base64 para pareamento quando o status é `qrcode`.
* `GET /messages?date=YYYY-MM-DD&format=json_grouped`: Carrega e agrupa mensagens da data selecionada, organizadas em conversas individuais para exibição ou consumo da IA. Suporta formatos `json_grouped`, `text` e `markdown`.
* `POST /settings`: Atualiza as preferências do usuário (ex: transcrever áudio automaticamente, interpretar imagens).
* `POST /maintenance/resync?mode=soft|force-history`: Aciona a sincronização do histórico do celular.
* `POST /logout`: Desconecta a conta do WhatsApp do usuário e limpa fisicamente todos os dados de credenciais, contatos e mensagens associados ao UUID.

### 3. Modelo de Persistência Híbrido de Mensagens

Para otimização de rede e contingência a falhas de banco de dados, o microsserviço usa um algoritmo híbrido ao salvar mensagens recebidas do WhatsApp:
1. **Tabela Relacional**: Tenta salvar na tabela `whatsapp_messages` do Supabase via REST API.
2. **Fallback por Blobs**: Se a tabela relacional falhar (ex: migração ausente ou timeout), o microsserviço comprime o lote de mensagens do dia em um JSON compactado e salva como um único registro de blob na tabela `whatsapp_sessions` sob o ID `${userId}:messages:${dateStr}`.
3. **Persistência Local**: Salva uma cópia na pasta `/data/messages/${userId}/messages-${dateStr}.json` no contêiner local para respostas rápidas de leitura.
4. **Autorrecuperação**: tabelas ausentes deixam de ser consultadas por cinco minutos e são testadas novamente depois; uma migração aplicada deixa de exigir reinício do serviço.

Mensagens são deduplicadas pelo ID estável do WhatsApp. PN (`@s.whatsapp.net`) e LID (`@lid`) são preservados em `chat_aliases`/`participant_aliases`. Se o protocolo devolver apenas identidades do próprio dono para uma mensagem recebida, a conversa é colocada como **não identificada** até uma ressincronização corrigir a rota, em vez de ser atribuída ao próprio usuário.

### 4. Conectividade Permanente e Boot

* **Reconexão Automática**: No boot do microsserviço (`app.listen`), a função `autoReconnectAllUsers()` busca todas as chaves na tabela `whatsapp_sessions` do Supabase, ignora blobs temporários (filtrando IDs que contêm `:`) e restabelece a conexão do socket de cada usuário cadastrado em segundo plano.
* **Recuperação de Histórico (`force-history`)**: Limpa localmente e no Supabase o array de marcadores `creds.processedHistoryMessages` no `creds.json`, deleta arquivos de versão do `app-state-sync` e reinicia o socket com `syncFullHistory: true` e `sock.resyncAppState()`. Isso faz com que o Baileys aceite processar pacotes antigos enviados pelo celular.

---

## 🚀 Como Executar o Projeto Localmente

### Passo 1: Instalar dependências
```bash
npm install
```

### Passo 2: Configurar variáveis no `.env.local`
Crie o arquivo na raiz do projeto e configure as seguintes variáveis:
```env
APP_URL=http://localhost:3000
NEXT_PUBLIC_SUPABASE_URL=https://seu-projeto.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=sua_chave_anonima_supabase
SUPABASE_SERVICE_ROLE_KEY=sua_service_role_key_supabase
GEMINI_API_KEY=sua_gemini_api_key
GROQ_API_KEY=sua_groq_api_key
WHATSAPP_SERVICE_URL=http://localhost:8080
WHATSAPP_SERVICE_SECRET=gere_um_segredo_aleatorio_com_no_minimo_32_caracteres
```

### Passo 3: Rodar o Frontend Next.js
```bash
npm run dev
```
Acesse a aplicação em `http://localhost:3000`.

### Passo 4: Rodar o Microsserviço de WhatsApp (Opcional para testar localmente)
```bash
cd whatsapp-service
npm install
npm start
```
O serviço iniciará escutando na porta `8080`.

### Passo 5: Executar todos os testes do WhatsApp
```bash
npm test
```

O comando executa os testes Vitest da interface/proxy e a suíte nativa do microsserviço. Para executar separadamente, use `npm run test:web` ou `npm run test:whatsapp-service`.

---

## 🗄️ Estrutura do Banco de Dados (Supabase)

Para o correto funcionamento do ecossistema, o banco de dados do Supabase conta com a estrutura descrita nos arquivos:
* `supabase_schema.sql` — Tabelas de perfis, clientes, colaboradores, tarefas e histórico de auditoria (Kanban).
* `supabase_ai_embeddings.sql` — Migração aditiva de `pgvector`, embeddings das descrições, busca por similaridade e auditoria de provedor/modelo dos resumos.
* `supabase_whatsapp_persistence.sql` — Tabelas de armazenamento de contatos, mensagens e sessões/blobs do WhatsApp.
* `supabase_security_isolation.sql` — Políticas de segurança RLS (Row Level Security) aplicadas a perfis e acessos corporativos.
* `supabase_auth_hardening.sql` — Migração aditiva que impede autoelevação de papel e remove leitura client-side de credenciais do WhatsApp.

Após atualizar o microsserviço, execute novamente `supabase_whatsapp_persistence.sql` para adicionar `chat_aliases`, os diagnósticos de roteamento e a chave canônica por `message_id`.

Para ambientes existentes, aplique também `supabase_auth_hardening.sql`. Novos usuários
sempre entram como `collaborator`; o primeiro administrador deve ser promovido por uma
operação controlada no SQL Editor ou por ferramenta server-side com service role.

### Migração da integração de IA

Execute `supabase_ai_embeddings.sql` uma vez no SQL Editor do Supabase. A migration é
aditiva: habilita a extensão `vector`, adiciona o embedding à tabela `tasks`, cria a
função `match_active_task_embeddings` com `security invoker` (portanto preservando RLS)
e registra o provedor/modelo em `whatsapp_summaries`.

As demandas criadas pela extração de IA recebem embedding imediatamente. Demandas
anteriores ou editadas manualmente ficam com embedding nulo e são preenchidas de forma
incremental, em lotes limitados e apenas para o cliente que está sendo verificado. A
lista completa de demandas ativas não é mais enviada ao prompt.

O limiar inicial de similaridade é `0.90`. Ele é propositalmente conservador e deve ser
calibrado com exemplos reais de duplicatas e falsos positivos antes de ser reduzido.
