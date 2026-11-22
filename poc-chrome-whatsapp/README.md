# PoC local do WhatsApp Web — versão 0.1.9

Extensão Chrome Manifest V3 isolada. Lê conversas e recupera áudios das datas
selecionadas para conferência manual com o celular. Não integra nem altera o
FollowUp Mônada, seu serviço WhatsApp ou o banco de produção.

## Instalar ou atualizar

1. Acesse `chrome://extensions`, ative o modo do desenvolvedor e carregue esta
   pasta sem compactação. Se já estiver instalada, clique em **Atualizar (↻)**.
2. Confirme a versão **0.1.9**. Feche as abas antigas do coletor e visualizador.
3. Deixe o WhatsApp Web aberto. No ícone da extensão, clique em **Abrir coleta
   em uma aba**. A versão também aparece no título dessa página.
4. Escolha a rodada e de 1 a 31 datas de calendário válidas. As datas ficam
   salvas para repetir a mesma amostra. Confira as opções de módulos internos
   e download explícito de mídia, e clique em **Coletar agora**.
5. Pode alternar abas durante o processamento. Mantenha a aba de coleta e a do
   WhatsApp abertas até concluir. Coletas simultâneas são recusadas. Fechar a
   aba de coleta, encerrar o Chrome ou recarregar a extensão interrompe o fluxo;
   não existe retomada automática. Um aviso de saída pode ser mostrado pelo Chrome.
6. Abra o visualizador para ler as conversas e reproduzir os áudios. Se marcada,
   a opção de exportação também baixa um JSON local. A rodada escolhida é
   substituída no armazenamento da extensão; os JSONs baixados são preservados.

## Comparar as rodadas

Execute R1, recarregue o WhatsApp e execute R2. Depois feche completamente o
Chrome, reabra o WhatsApp e execute R3. Aguarde a aplicação carregar antes de
cada rodada. Use **a mesma versão, datas e opções** nas três execuções.

Os JSONs novos usam `schemaVersion: 2` e registram `extensionVersion` e
`collectionOptions`. Arquivos antigos continuam visualizáveis, mas não recebem
certificação retroativa de mídia e a comparação avisa que não são equivalentes.
Mudança de texto em mensagem que já estava marcada como editada continua sendo
uma divergência a conferir: o marcador antigo não prova uma nova edição.

## O que significam os indicadores

- **Coleta validada**: há mensagens, os registros de texto têm conteúdo e os
  áudios encontrados localmente foram validados e decodificados pelo navegador.
- **Coleta pendente ou sem validação**: falta texto, mídia ou confirmação do
  decoder, inclusive em exportações antigas.
- **Não significa pronto para resumo**: esta PoC não transcreve áudios, não
  processa imagens e não confirma completude do histórico do celular. Não
  libera resumos no Mônada. `wouldBeReadyUnderBlockingRule` permanece `false`
  como campo legado; use `collection` para interpretar a coleta.

A comparação manual precisa incluir conversas ausentes e conferir início,
meio e fim das conversas. Ausência de sinais de truncamento não prova cobertura.
As contagens são de mensagens e áudios **encontrados localmente**.

## Mídia, dependências e segurança

- Mensagens, chats e contatos: transações `readonly` no `model-storage`.
  A normalização é compartilhada em `lib/poc-core.js`, também usada nos testes.
  Se o banco não existir, a abertura é abortada sem criar uma base vazia.
- Cache: `lru-media-storage-idb` e Cache Storage, sem rede. Cache inválido não é
  contado como recuperação bem-sucedida.
- Textos criptografados em repouso: com autorização na interface, a extensão
  usa módulos internos no MAIN world (`WAWebMsgCollection.getMessagesById` e
  fallbacks de tabela/descriptografia). São dependências não oficiais e mutáveis.
- Áudios fora do cache: somente com download explícito habilitado, usa
  `Msg.downloadMedia`, download manager interno ou CDN `mmg.whatsapp.net`.
  O fallback direto aceita apenas esse host HTTPS e recusa redirecionamentos.
  Métodos nativos podem atualizar caches e não oferecem garantia de cancelamento:
  o timeout da espera não cancela necessariamente o download interno.
- `lib/poc-media.js`: limite de 32 MiB por áudio; Ogg/Opus exige cabeçalho,
  páginas, sequência e CRC válidos. Não exige flag EOS, ausente em parte dos
  áudios válidos do WhatsApp. Exige também decodificação pelo Chrome em até
  20 segundos e rejeita duração significativamente menor que a informada.
  Outros tipos de áudio permitidos dependem da decodificação do navegador.
  Codec indisponível ou áudio inválido mantém a coleta pendente.
- A descriptografia própria HKDF/AES-CBC verifica o MAC antes de aceitar o
  conteúdo. Chaves, caminhos de mídia e credenciais não são exportados como campos.
- O visualizador só atribui URLs `data:audio/...;base64` locais aos players.
  CSP bloqueia conexões externas e mídia remota nas páginas da extensão e no
  visualizador. Os textos são inseridos com `textContent`.
- Não há envio ao Mônada, provedores de IA, mensagens nem cliques/rolagens
  automáticos. MAIN world compartilha o contexto da página; não é uma fronteira
  confiável para futura autorização no servidor.

Os resultados contêm conversas, identificadores e áudios reais, por escolha do
usuário. Ficam no armazenamento local da extensão e nos JSONs exportados.
**Limpar dados locais da PoC** remove as rodadas salvas, mas não apaga Downloads,
outros visualizadores abertos nem o cache do próprio WhatsApp.

## Verificação

Na raiz do repositório:

```sh
npm run test:whatsapp-poc
npm test
npm run build
git diff --check
```

A suíte da PoC foi incluída em `npm test`. Há regressões para o coletor real,
ponte MAIN, orquestração/salvamento, concorrência, datas inválidas, texto vazio,
cache inválido, MAC adulterado, mídia truncada, decoder e comparação de versões.
Testes automatizados não comprovam compatibilidade dos módulos internos da
versão do WhatsApp instalada: repetir as três rodadas no Chrome continua necessário.

As páginas ajustam colunas e controles para larguras de 320, 375, 768 e 1024 px,
preservando a disposição de conversas lado a lado em telas maiores. Tabelas
largas mantêm rolagem horizontal própria.
