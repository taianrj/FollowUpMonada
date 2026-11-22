# Privacidade da integração WhatsApp Web — rascunho para publicação

Completar identificação do responsável, suporte, hospedagem e provedores reais
antes de publicar. Este texto não substitui a política final acessível aos usuários.

A extensão é independente e não é produzida, aprovada ou patrocinada pelo WhatsApp.
Sua finalidade é consultar conversas das datas escolhidas no Mônada, transcrever
áudios e gerar resumos/sugestões de demandas. Não envia mensagens pelo WhatsApp.

São tratados nomes/identificadores de contatos, grupos, canais e conta, textos,
horários, autoria e referências de mensagens. Áudios só são recuperados/enviados
com transcrição habilitada. Imagens não são analisadas e Status/Stories são excluídos.
A leitura usa o histórico disponível no navegador, que pode estar incompleto.

Conversas, opções, transcrições e filas são armazenadas em IndexedDB da extensão,
separadas por usuário, origem do Mônada e conta de WhatsApp. Conversas/transcrições
ficam por até 30 dias da coleta; áudios pendentes por até 7 dias do envio local.
Áudios com transcrição bem-sucedida são apagados. A manutenção ocorre quando o
Chrome pode executar a extensão; períodos com navegador fechado podem atrasá-la.

Quando solicitado pelo usuário, áudios e mensagens necessários passam pelo servidor
autenticado do Mônada e pelos provedores de IA configurados: Groq prioritariamente
para transcrição, Gemini como fallback e para resumos. Sem chave Groq, a transcrição
pode usar OpenAI quando configurada ou Gemini. A implementação não persiste essas entradas no servidor/banco.
As práticas de retenção do provedor devem ser informadas na política final. Chaves de
IA permanecem somente no servidor. Não há venda de dados ou uso publicitário.

O Mônada guarda o resultado final: resumo, sugestões de demandas e metadados de
ressalvas. Novos resumos não contêm uma cópia integral das mensagens/transcrições
em raw_text. O resultado ainda contém informações derivadas das conversas. Dados
históricos já salvos por versões anteriores não são apagados automaticamente.

O usuário pode confirmar a exclusão dos dados locais no Mônada. Isso preserva os
resumos salvos, o histórico original do WhatsApp e arquivos exportados separadamente.
Remover a extensão ou o perfil do Chrome elimina a cópia local. Outro computador
não recebe automaticamente as conversas/transcrições, mas acessa resumos de produção.

A extensão executa código somente no WhatsApp Web e nos hosts configurados do
Mônada. Não lê histórico geral de navegação. Permissão de execução no Mônada é usada
para confirmar a sessão real e chamar endpoints fixos autenticados; alarmes retomam
a fila e executam a limpeza local. O armazenamento fica sujeito à proteção da conta
do sistema operacional e às quotas do navegador. Não há sincronização via Chrome Sync.

Somente administradores ativos podem iniciar o fluxo. O servidor aplica autenticação,
isolamento de usuário e proteção de origem. A extensão só responde a origens
explicitamente permitidas no pacote. Antes da submissão, completar canais de pedidos
de acesso/exclusão e manter formulários da loja coerentes com esta política.
