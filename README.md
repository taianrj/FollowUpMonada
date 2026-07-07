# FollowUp Mônada — Gerenciador Inteligente de Demandas

O **FollowUp Mônada** é um ecossistema corporativo de alta performance desenvolvido para a gestão inteligente de demandas, controle de prazos e acompanhamento de colaborações de equipes. O sistema conta com inteligência artificial para extração semântica de demandas a partir de mensagens de chat e um microsserviço integrado com o WhatsApp Web (via protocolo Baileys) para coleta em tempo real de briefings.

---

## 🌐 Ambientes e Links do Projeto

O ecossistema está implantado e integrado na nuvem nos seguintes endereços:

* **Frontend (Aplicação Web)**: [Vercel](https://vercel.com) — [https://followupmonada.vercel.app/](https://followupmonada.vercel.app/)
* **Banco de Dados & Auth**: [Supabase](https://supabase.com) — [https://seu-projeto.supabase.co](https://seu-projeto.supabase.co)
* **Microsserviço de WhatsApp**: [Render](https://render.com) — [https://followupmonada.onrender.com](https://followupmonada.onrender.com)
* **Keep-Alive (Cron-Job)**: [Cron-job.org](https://cron-job.org/) configurado para pingar `https://followupmonada.onrender.com/healthz` a cada **10 minutos** para contornar a limitação de sleep do Render gratuito e manter o WhatsApp conectado 24/7.

---

## 🛠️ Tecnologias Utilizadas

### Core & Frontend
- **Framework**: [Next.js (App Router)](https://nextjs.org/) + React 19 + TypeScript
- **Estilização**: Vanilla CSS (Premium Dark Slate Theme)
- **Segurança**: Row Level Security (RLS) nativa no Supabase

### Microsserviço de Integração (WhatsApp)
- **Motor de Conexão**: `@whiskeysockets/baileys` (Multi-device API do WhatsApp Web)
- **Servidor HTTP**: Node.js + Express
- **Persistência**: SQLite (Local em container) + Supabase (Remote blobs e tabelas relacionais)

### Inteligência Artificial
- **Extração Semântica**: API do Gemini (`gemini-2.5-flash`) e Groq API (`llama-3.3-70b-versatile`) como provedor de fallback.

---

## 🤖 Guia Técnico para IAs Agênticas e Desenvolvedores

### 1. Arquitetura de Comunicação e Segurança

O frontend Next.js não acessa o microsserviço de WhatsApp diretamente no cliente. Ele utiliza uma rota de proxy dinâmico para blindagem de chaves e controle de sessão:
* **Rota Proxy**: `/api/whatsapp-service/[...path]` mapeada internamente no Next.js para repassar chamadas para `https://followupmonada.onrender.com`.
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
WHATSAPP_SERVICE_SECRET=lO4cSR+2oCRgytcF3stQp7FYagmcds5eMgaqJbSAonE=
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

---

## 🗄️ Estrutura do Banco de Dados (Supabase)

Para o correto funcionamento do ecossistema, o banco de dados do Supabase conta com a estrutura descrita nos arquivos:
* `supabase_schema.sql` — Tabelas de perfis, clientes, colaboradores, tarefas e histórico de auditoria (Kanban).
* `supabase_whatsapp_persistence.sql` — Tabelas de armazenamento de contatos, mensagens e sessões/blobs do WhatsApp.
* `supabase_security_isolation.sql` — Políticas de segurança RLS (Row Level Security) aplicadas a perfis e acessos corporativos.
