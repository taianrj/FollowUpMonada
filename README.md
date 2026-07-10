# FollowUp Mônada — Gerenciador Inteligente de Demandas

O **FollowUp Mônada** é um ecossistema corporativo de alta performance desenvolvido para a gestão inteligente de demandas, controle de prazos e acompanhamento de colaborações de equipes. O sistema conta com inteligência artificial para extração semântica de demandas a partir de mensagens de chat e um microsserviço integrado com o WhatsApp Web (via protocolo Baileys) para coleta em tempo real de briefings.

---

## 🌐 Ambientes e Links do Projeto

O ecossistema está implantado e integrado na nuvem nos seguintes endereços:

* **Frontend (Aplicação Web)**: [Vercel](https://vercel.com) — [https://followupmonada.vercel.app/](https://followupmonada.vercel.app/)
* **Banco de Dados & Auth**: [Supabase](https://supabase.com) — [https://seu-projeto.supabase.co](https://seu-projeto.supabase.co)
* **Microsserviço de WhatsApp**: Fly.io, aplicação `monada-whatsapp-service`, região `gru`, com volume persistente montado em `/app/data`.

---

## 🛠️ Tecnologias Utilizadas

### Core & Frontend
- **Framework**: [Next.js (App Router)](https://nextjs.org/) + React 19 + TypeScript
- **Estilização**: Vanilla CSS (Premium Dark Slate Theme)
- **Segurança**: Row Level Security (RLS) nativa no Supabase

### Microsserviço de Integração (WhatsApp)
- **Motor de Conexão**: `baileys@7.0.0-rc13` (Multi-device API do WhatsApp Web, com aliases PN/LID)
- **Servidor HTTP**: Node.js + Express
- **Persistência**: arquivos JSON no volume do Fly.io + Supabase (tabelas relacionais e blobs de contingência)

### Inteligência Artificial
- **Extração Semântica**: API do Gemini (`gemini-2.5-flash`) e Groq API (`llama-3.3-70b-versatile`) como provedor de fallback.

---

## 🤖 Guia Técnico para IAs Agênticas e Desenvolvedores

### 1. Arquitetura de Comunicação e Segurança

O frontend Next.js não acessa o microsserviço de WhatsApp diretamente no cliente. Ele utiliza uma rota de proxy dinâmico para blindagem de chaves e controle de sessão:
* **Rota Proxy**: `/api/whatsapp-service/[...path]`, mapeada para `WHATSAPP_SERVICE_URL`/`NEXT_PUBLIC_WHATSAPP_SERVICE_URL` e protegida por autenticação administrativa.
* **Segurança de Serviço**: Toda chamada do proxy para o microsserviço anexa o header `x-service-token` (segredo `WHATSAPP_SERVICE_SECRET` do `.env.local`) e `x-api-key` (UUID do usuário Supabase logado). O microsserviço rejeita conexões que não possuam ambos os cabeçalhos.

### 2. Endpoints do Microsserviço de WhatsApp (Permitidos no Proxy)

* `GET /status`: Retorna o status de conexão (`connected`, `connecting`, `qrcode`, `disconnected`), contagem de contatos e mensagens da sessão atual, além de diagnósticos em tempo real do último lote de mensagens recebido do WhatsApp.
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
NEXT_PUBLIC_SUPABASE_URL=https://seu-projeto.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=sua_chave_anonima_supabase
SUPABASE_SERVICE_ROLE_KEY=sua_service_role_key_supabase
GEMINI_API_KEY=sua_gemini_api_key
GROQ_API_KEY=sua_groq_api_key
NEXT_PUBLIC_WHATSAPP_SERVICE_URL=http://localhost:8080
WHATSAPP_SERVICE_SECRET=gere_um_segredo_longo_e_exclusivo
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
* `supabase_whatsapp_persistence.sql` — Tabelas de armazenamento de contatos, mensagens e sessões/blobs do WhatsApp.
* `supabase_security_isolation.sql` — Políticas de segurança RLS (Row Level Security) aplicadas a perfis e acessos corporativos.

Após atualizar o microsserviço, execute novamente `supabase_whatsapp_persistence.sql` para adicionar `chat_aliases`, os diagnósticos de roteamento e a chave canônica por `message_id`.
