# Provedores de banco do FollowUp Monada

## Estado da migração

A migração para **Cloudflare D1 foi concluída em 31/10/2026**. A aplicação na
Vercel e o serviço WhatsApp na VM Oracle usam `DATABASE_PROVIDER=d1`.
O Supabase foi preservado para retorno; depois da ativação, ele não recebe as
novas gravações feitas no D1. Não há espelhamento automático entre os bancos.

A cópia foi conferida nos dois sentidos, sem diferenças nas tabelas ou nas
credenciais dos usuários naquele momento. Login com senha existente, demandas,
cadastros, resumos e acesso ao serviço WhatsApp foram verificados em produção.
A conta usada na conferência já aguardava pareamento do celular antes da migração.
O envio automático de recuperação por e-mail ainda depende de configuração.

O fallback do código, quando a variável está ausente, continua sendo Supabase.
Isso é diferente da configuração explícita D1 usada em produção. Os comandos
`db:manage` não mudam esse seletor nem publicam o site ou a infraestrutura Oracle.

## Configuração no servidor

Defina a mesma variável na aplicação Next.js e no serviço WhatsApp:

```text
DATABASE_PROVIDER=d1
```

Valores implementados: `supabase` e `d1`. Valor ausente mantém o comportamento
Supabase; valor desconhecido falha, sem selecionar outro banco silenciosamente.
A variável não usa `NEXT_PUBLIC_`: a aplicação consulta somente o nome público
do provedor, nunca credenciais, para selecionar o cliente correspondente.

Para D1, configure também:

```text
CLOUDFLARE_ACCOUNT_ID=<identificador da conta>
CLOUDFLARE_D1_DATABASE_ID=<identificador do banco>
CLOUDFLARE_D1_API_TOKEN=<token privado com acesso D1 na conta escolhida>
APP_URL=https://<domínio da aplicação>
```

O token é exclusivo do servidor e precisa das permissões de consulta/escrita D1.
Use a menor abrangência disponível na conta. Não coloque esses valores no chat,
no Git, em URLs ou em variáveis `NEXT_PUBLIC_`.
Se o token tiver escopo de conta, seu acesso abrange os bancos D1 dessa conta,
inclusive os criados posteriormente; não o descreva como restrito a um único banco.

Na Vercel, mantenha as credenciais de produção apenas no ambiente Production.
Na VM, use um arquivo privado de ambiente, preservando as demais configurações
e o volume `/app/data`. Funções e logs legados ainda podem conter o nome
“Supabase”; o adaptador de persistência respeita `DATABASE_PROVIDER`.

### Aplicar uma mudança de configuração

- **Vercel:** altere a variável de Production e faça um novo deploy com as
  configurações atualizadas. Salvar a variável não altera um deploy já existente.
- **WhatsApp em Docker:** altere o arquivo passado com `--env-file` e recrie o
  contêiner, mantendo imagem validada, portas, política de reinício e volume.
  `docker restart` reaproveita as variáveis antigas do contêiner; ele não relê
  esse arquivo. O workflow de publicação recria o contêiner com o arquivo da VM.
- **Desenvolvimento:** altere `.env.local` e reinicie os processos locais.
  Recarregue o navegador e faça novo login após a troca de provedor.

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
`SUPABASE_DB_URL` exige a senha PostgreSQL: `SUPABASE_SERVICE_ROLE_KEY` é uma
chave da API e não a substitui. Se a máquina não tiver IPv6, use a URI de
Session pooler disponibilizada em Connect no painel Supabase.

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
   no serviço WhatsApp. Republique a aplicação e recrie o contêiner WhatsApp
   conforme a seção de aplicação da configuração acima.
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
npm run db:manage -- verify --from=d1 --to=supabase
```

Somente após a verificação configure `DATABASE_PROVIDER=supabase` nos dois
serviços, republique o site e recrie o contêiner WhatsApp com o mesmo volume.
Preserve as credenciais Supabase de servidor, além da conexão PostgreSQL usada
pela ferramenta. O estado das sessões web não é transferido: entre novamente e
confira o funcionamento antes de liberar gravações.

A conferência feita na migração comprovou a igualdade dos dados naquele momento;
ela não executou uma reversão de produção. Uma futura volta precisa de nova cópia
e conferência, incluindo qualquer dado criado depois da ativação D1.

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

Sem `--apply`, a restauração apenas compara. A ferramenta atual exige que o
provedor de destino seja diferente do provedor registrado no backup. O comando
acima usa um backup Supabase como origem para D1. Ele não deve ser tratado como
uma restauração no mesmo provedor. Preserve o banco atual até validar o resultado.

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
