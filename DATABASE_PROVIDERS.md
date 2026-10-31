# Provedores de banco do FollowUp Monada

## Estado da migração

O padrão continua sendo Supabase. A implementação D1 deve ser ativada somente
depois de criar o banco Cloudflare, copiar os dados e verificar o resultado.
Nenhum comando desta implementação publica o site ou altera a infraestrutura
Oracle automaticamente.

## Configuração no servidor

Defina a mesma variável na aplicação Next.js e no serviço WhatsApp:

```text
DATABASE_PROVIDER=supabase
```

Valores implementados: `supabase` e `d1`. Valor ausente mantém o comportamento
Supabase; valor desconhecido falha, sem selecionar outro banco silenciosamente.
A variável não usa `NEXT_PUBLIC_`: a aplicação consulta somente o nome público
do provedor, nunca credenciais, para selecionar o cliente correspondente.

Para D1, configure também:

```text
CLOUDFLARE_ACCOUNT_ID=<identificador da conta>
CLOUDFLARE_D1_DATABASE_ID=<identificador do banco>
CLOUDFLARE_D1_API_TOKEN=<token restrito ao banco da aplicação>
APP_URL=https://<domínio da aplicação>
```

O token é exclusivo do servidor e precisa das permissões de consulta/escrita D1.
Use a menor abrangência disponível na conta. Não coloque esses valores no chat,
no Git, em URLs ou em variáveis `NEXT_PUBLIC_`.

## Autenticação e recursos

- D1 usa identidades e hashes bcrypt próprios; não consulta Supabase Auth.
- A migração preserva IDs e hashes de senha, sem precisar conhecer as senhas.
- As sessões web são locais ao provedor. A troca exige novo login.
- Cookies de sessão são HttpOnly, SameSite=Lax e Secure em produção. O banco
  armazena apenas SHA-256 dos tokens aleatórios, com expiração.
- Convites e recuperação usam tokens de uso único. Sessão de recuperação não
  concede acesso aos dados da aplicação antes da troca da senha.
- A recuperação por e-mail no D1 pode usar `RESEND_API_KEY` e `AUTH_EMAIL_FROM`.
  Sem envio configurado, o administrador continua podendo gerar um link pela
  tela de administração; a interface informa que o envio está indisponível.
- As políticas de acesso são verificadas no servidor. Credenciais WhatsApp e
  arquivos de auditoria privados não são acessíveis pelo gateway do navegador.
- A busca semântica D1 preserva embeddings e compara vetores no servidor,
  paginando as tarefas do cliente e respeitando modelo e limiar existentes.
- Mensagens, contatos, estado Baileys e filas continuam com persistência local
  e remota. Snapshots grandes são divididos em partes verificadas por hash.
- As tabelas de negócio permanecem relacionais no D1, com índices, restrições,
  chaves estrangeiras e invalidação de embeddings quando a descrição muda.

## Preparação da transferência

As ferramentas rodam com Node.js 24 (o mesmo utilizado no CI). O serviço
WhatsApp continua compatível com seu runtime Node 20.

Para exportar dados e hashes de senha sem exibi-los, configure uma conexão
PostgreSQL ao Supabase em `SUPABASE_DB_URL`. A conexão remota exige TLS com
validação de certificado. Se necessário, configure `SUPABASE_DB_CA_FILE` com
o caminho do certificado CA oficial. Não desative a validação TLS.

As ferramentas leem `.env.local`, sem imprimir seu conteúdo. Não é necessário
alterar `DATABASE_PROVIDER` para inspecionar ou copiar um banco.

```sh
npm run db:manage -- inspect --from=supabase
npm run db:manage -- init
npm run db:manage -- init --apply
npm run db:manage -- copy --from=supabase --to=d1
```

`inspect` imprime somente contagens, tamanhos e hashes. `init` sem `--apply`
simula a operação. A inicialização aplicada cria somente estruturas aditivas.
`copy` sem `--apply` compara os bancos sem gravar dados.

## Cópia e ativação

1. Coloque a aplicação e o WhatsApp em manutenção, impedindo gravações nos dois
   serviços durante toda a cópia e conferência.
2. Execute a cópia explicitamente:

   ```sh
   npm run db:manage -- copy --from=supabase --to=d1 --apply --maintenance-confirmed
   npm run db:manage -- verify --from=supabase --to=d1
   ```

3. Somente depois da conferência, altere `DATABASE_PROVIDER=d1` na aplicação e
   no serviço WhatsApp. Reinicie/republique ambos com a configuração nova.
4. Verifique login, permissões, cadastros, demandas, histórico, resumos,
   conexão WhatsApp e leitura das mensagens antes de liberar as gravações.

Antes de gravar, a ferramenta cria backups criptografados AES-256-GCM, com
compressão e autenticação, em `.migration-data/`. A chave fica em
`.migration-data/backup.key`, criada uma única vez. A pasta inteira é ignorada
pelo Git. Proteja a pasta com permissões do sistema e guarde uma cópia da chave
em local separado; sem ela não há recuperação dos backups.

A exportação usa uma transação PostgreSQL consistente e somente de leitura.
Tabelas ou colunas desconhecidas, hashes incompatíveis, identidades OAuth, MFA,
contas bloqueadas/excluídas no Auth ou objetos no Supabase Storage interrompem a
migração para evitar perdas silenciosas e redução das proteções de acesso.
O projeto atual não usa objetos no Storage; arquivos futuros precisam de um
plano separado antes de sair do Supabase.

## Voltar para Supabase

**Mudar apenas a variável não transfere dados.** Depois de gravar no D1, o
Supabase pode estar desatualizado. Reative-o, coloque ambos os serviços em
manutenção e execute primeiro a comparação e a transferência no sentido inverso:

```sh
npm run db:manage -- copy --from=d1 --to=supabase
npm run db:manage -- copy --from=d1 --to=supabase --apply --maintenance-confirmed
```

Somente após a verificação configure `DATABASE_PROVIDER=supabase` nos dois
serviços e reinicie ambos. O estado das sessões web não é transferido.

Se o destino tiver registros que foram excluídos na origem, a ferramenta
interrompe a cópia aplicada: não apaga registros automaticamente. Revise as
contagens `remove` do plano. Para confirmar essas exclusões no destino, acrescente
`--reconcile-deletions`. Os backups criptografados dos dois lados são obrigatórios
e são criados antes de qualquer exclusão. Uma cópia parcial ou uma divergência
nunca autoriza a ativação do destino.

Na volta ao Supabase, o importador preserva os timestamps das tarefas desabilitando
somente o trigger conhecido `update_tasks_updated_at` dentro da transação e
restaurando seu estado antes do commit. As restrições de integridade continuam
ativas. Os vetores são reaplicados do mesmo snapshot depois da importação das
descrições. Metadados de auditoria de Supabase Auth podem mudar; a conferência
exige os mesmos IDs, e-mails, hashes e estado de confirmação, além da igualdade
de todas as tabelas da aplicação.

Um backup criptografado também pode servir de origem:

```sh
npm run db:manage -- restore --file=.migration-data/<backup>.monada --to=d1
```

Sem `--apply`, a restauração apenas compara. Use o destino correto e preserve
o banco atual até validar integralmente o resultado.

## Outros bancos no futuro

Uma nova chave de provedor precisa de um adaptador implementado e testado.
Ela não converte SQL ou permissões automaticamente. Os contratos reutilizáveis
ficam em `whatsapp-service/lib/database/`: catálogo de tabelas, descritores de
consulta, transporte, autenticação, persistência e snapshots de transferência.
O gateway não aceita SQL arbitrário ou credenciais do navegador.

## Verificação de desenvolvimento

```sh
npm test
npm run build
node --check whatsapp-service/server.js
git diff --check
```

Os testes de provedores usam SQLite real, sem conexão a dados de produção.
Também devem cobrir falhas de transporte, isolamento de usuários, autenticação,
CSRF, snapshots grandes, cópia e retorno dos dados antes de ativar D1.
