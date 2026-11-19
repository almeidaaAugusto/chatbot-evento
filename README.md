# Chatbot de atendimento para eventos (WhatsApp + WAHA + n8n)

Chatbot de atendimento automático por WhatsApp para eventos. O contato manda uma mensagem e o
robô responde com o conteúdo cadastrado (ingressos, valores, data e local, line-up, regras de
entrada etc.). Ele reconhece números do menu, palavras-chave, exemplos de perguntas e pequenos
erros de digitação; quando fica em dúvida, pede esclarecimento; quando não entende, consulta um
assistente de IA.

**Funcionalidades**
- Vários eventos no mesmo número, com escolha por lista ou por palavra-chave.
- Vários números de WhatsApp, cada um com seus eventos.
- Respostas por regras (menu, palavras-chave, perguntas de exemplo, correção de digitação).
- Assistente de IA (Groq) para o que as regras não cobrem, com modelos reserva e conferência de
  links, valores e contatos contra o conteúdo cadastrado.
- Encaminhamento para atendimento humano e proteções contra excesso de mensagens e laços.
- Painel web com HTTPS, login e papéis (admin, editor, leitor): edição do conteúdo, simulador,
  conversas, erros, métricas, histórico de versões da configuração e gestão dos números de WhatsApp.
- Histórico de conversas e métricas em Postgres, com backup diário; o bot nunca depende do banco.
- Deploy em VPS (Oracle Cloud Always Free) administrado por scripts PowerShell.

**Stack:** Docker Compose, WAHA (WhatsApp Web, engine GOWS), n8n, Redis, Postgres, painel em
Node.js, Caddy e Groq. Testes: `node --test tests/*.test.js`.

**Como rodar localmente** (use um número de teste; veja o aviso mais abaixo):
```
powershell -ExecutionPolicy Bypass -File scriptsgerar-env.ps1
copy configchatbot.exemplo.json configchatbot.json
docker compose up -d
```
Detalhes em "Primeira instalação em outro computador". O repositório usa dados de exemplo; os
dados reais (configuração, chaves, endereço do servidor) ficam fora dele.

> **Documentação do projeto:** contexto, arquitetura, decisões, operação e solução de problemas
> estão em [docs/README.md](docs/README.md) e no [CLAUDE.md](CLAUDE.md). Este README é o guia de
> uso.

```
WhatsApp  ->  WAHA  --webhook-->  n8n  (identifica a mensagem, consulta o Redis)
                                   n8n  --(só se não entendeu)-->  API de IA (Groq)
WhatsApp  <-  WAHA  <--API-----  n8n  (envia a resposta)
```

> **Aviso importante.** O WAHA usa o WhatsApp Web de forma **não oficial**. O WhatsApp pode
> restringir ou banir números que usam automação. **Use um número de teste** e não conecte
> o número principal do evento enquanto estiver testando. Para reduzir o risco, o robô só
> responde a quem escreveu primeiro, marca a mensagem como lida e simula digitação antes
> de responder.

## O que roda

| Serviço | Para que serve | Endereço (localhost; na VPS, pelo túnel SSH) |
|---|---|---|
| `waha` (WAHA 2026.10.1, engine GOWS) | Liga o WhatsApp à automação | http://localhost:3000/dashboard |
| `n8n` (2.47.3) | Executa o workflow do chatbot | http://localhost:5678 |
| `redis` (8) | Guarda o estado: mensagens já vistas, limites, contatos em atendimento humano | só na rede interna |
| `postgres` (17) | Guarda o histórico de conversas e eventos, as versões da configuração, os usuários do painel e a página Métricas (seção "Banco de dados") | só na rede interna |
| `backup-banco` | Faz o backup diário do banco (04:00) e mantém os 14 mais recentes | volume `backups_banco` |
| `painel` | Edita o conteúdo, simula conversas e mostra as conversas reais e os erros | http://localhost:8080 (conversas em http://localhost:8080/conversas) |
| `caddy` (2.10, perfil `online`) | HTTPS na frente do painel; só sobe no servidor com `COMPOSE_PROFILES=online` (veja "Painel online") | portas 80 e 443 do servidor |
| `n8n-init`, `preparar-logs` | Rodam uma vez a cada subida e terminam (aparecem como `Exited (0)`) | — |

No PC, as portas são publicadas somente em `127.0.0.1`: nada fica acessível pela rede ou pela internet. Só o `caddy`, ligado no servidor, abre as portas 80 e 443.

## Comandos do dia a dia

> Os comandos desta seção e das seguintes valem para a stack **no computador onde ela roda**.
> Em produção isso é a VPS: no PC use `scripts\vps.ps1 -Script <nome>` (veja "Rodar na VPS" e
> [docs/operacao.md](docs/operacao.md)). **Não suba a stack real no PC**: dois robôs no mesmo
> número respondem em dobro.

Abra um terminal na pasta do projeto (`chatbot-evento`).

| Ação | Comando |
|---|---|
| Iniciar | `docker compose up -d` |
| Parar (os dados ficam guardados) | `docker compose down` |
| Reiniciar | `docker compose restart` |
| Ver a situação dos contêineres | `docker compose ps -a` |
| Ver se o banco está saudável (`postgres` em `healthy`) | `docker compose ps -a` |
| Acompanhar as conversas e os erros | http://localhost:8080/conversas |
| Ver o que o robô fez (sem o texto das mensagens) | `powershell -ExecutionPolicy Bypass -File scripts\ver-logs.ps1` |
| Ver erros | `powershell -ExecutionPolicy Bypass -File scripts\ver-logs.ps1 -Erros` |

Os contêineres têm `restart: unless-stopped`: voltam sozinhos quando o Docker Desktop abre.
Para o robô voltar após reiniciar o computador, deixe o Docker Desktop configurado para
iniciar com o Windows (Settings > General > *Start Docker Desktop when you sign in*).

## Primeira instalação em outro computador

Em uma máquina nova (a VPS usa `scripts\vps.ps1 -Instalar` e `-Enviar`), com o Docker aberto:

```
copy config\chatbot.exemplo.json config\chatbot.json
powershell -ExecutionPolicy Bypass -File scripts\gerar-env.ps1
docker compose up -d
```

Antes de usar, copie o exemplo: `config/chatbot.json` não vem no repositório (é a configuração local, que depois é editada pelo painel). O `scripts\gerar-env.ps1` também copia o exemplo se o arquivo faltar. Na VPS, o `-Enviar` da primeira vez envia o `config/chatbot.json` local ou, na falta, o exemplo.

O `gerar-env.ps1` cria o `.env` com chaves aleatórias. Na primeira subida o serviço
`n8n-init` importa as credenciais e os dois workflows e publica (ativa) o chatbot.

## Rodar na VPS (Oracle)

O robô pode rodar 24 horas numa VM gratuita da Oracle Cloud, sem depender deste computador.
O passo a passo para iniciantes está em [docs/vps-oracle.md](docs/vps-oracle.md). Resumo:

- Crie a VM (Ubuntu 24.04, ARM, 2 OCPU e 12 GB), converta a conta para Pay As You Go e crie um alerta de orçamento.
- `powershell -ExecutionPolicy Bypass -File scripts\vps.ps1 -Configurar -Servidor <IP>` e depois `-Instalar` preparam o servidor (uma vez).
- Pare o robô do PC (`docker compose down`), rode `scripts\vps.ps1 -Enviar` e conecte o WhatsApp com `-Script conectar-whatsapp`.
- Painel, WAHA e n8n ficam acessíveis pelo túnel SSH (`scripts\vps.ps1 -Tunel`). Só o painel pode ser aberto na internet, com HTTPS e login (veja abaixo).

### Painel online (HTTPS e login)

Com o painel online, o celular ou outro PC abre **https://<DOMINIO_DO_PAINEL>** (endereço
gratuito do sslip.io; o certificado é automático). Um serviço `caddy` (perfil `online` do Docker
Compose, ligado só no servidor) recebe as portas 80 e 443 e repassa ao painel. O WAHA e o n8n
continuam fechados. Depois de entrar, a página **WhatsApp** mostra o servidor e permite ligar,
parar, conectar por QR Code e desconectar cada número.

```
powershell -ExecutionPolicy Bypass -File scripts\vps.ps1 -SenhaPainel
powershell -ExecutionPolicy Bypass -File scripts\vps.ps1 -Online -Dominio 203-0-113-10.sslip.io
```

- Antes: libere TCP 80, TCP 443 e UDP 443 na Security List da Oracle e rode `-Enviar`.
- `-SenhaPainel` pede usuário e senha (mínimo 12 caracteres, digitada sem aparecer) e grava só o hash no `.env` do servidor. Rode de novo para trocar a senha.
- `-Online` libera 80/443 no firewall do servidor, grava `PAINEL_DOMINIO`, `COMPOSE_PROFILES=online` e `PAINEL_CONFIAR_PROXY=true` no `.env` do servidor, sobe o Caddy e testa o endereço. Para trocar de domínio, rode de novo com outro `-Dominio`.
- `-OnlineDesligar` para o Caddy e volta ao acesso só por túnel.

Detalhes, cuidados e solução de problemas: [docs/vps-oracle.md](docs/vps-oracle.md), seção 10.

## Conectar o WhatsApp

```
powershell -ExecutionPolicy Bypass -File scripts\conectar-whatsapp.ps1
```

O script inicia a sessão, abre uma página com o QR Code (ela se atualiza sozinha) e espera.
No celular do **número de teste**: WhatsApp > Dispositivos conectados > Conectar dispositivo.
Quando conectar, o robô já está respondendo.

| Ação | Comando |
|---|---|
| Ver se está conectado | `... scripts\conectar-whatsapp.ps1 -Status` |
| Parar de responder sem desfazer o pareamento | `... scripts\conectar-whatsapp.ps1 -Parar` |
| Desfazer o pareamento (trocar de número) | `... scripts\conectar-whatsapp.ps1 -Desconectar` |
| Listar todas as sessões (números) do WAHA | `... scripts\conectar-whatsapp.ps1 -Listar` |

Esses comandos valem para o número padrão (`default`). Para outro número, acrescente
`-Numero <sessão>`, por exemplo `-Numero loja2`. Veja **Vários números**.

Também dá para fazer pelo painel do WAHA (http://localhost:3000/dashboard). O usuário e a
senha estão no `.env` (`WAHA_DASHBOARD_USERNAME` / `WAHA_DASHBOARD_PASSWORD`); se o painel
pedir a chave da API, é o valor de `WAHA_API_KEY`.

## Conteúdo de exemplo

O arquivo `config/chatbot.exemplo.json` traz um evento completo, no formato de vários eventos
(ver a seção **Vários eventos**), para servir de modelo. Os campos do evento ficam em
`eventos[].evento`; os dados da organização (nome, Instagram, e-mail, Linktree) ficam em
`produtora`. Um evento com status `encerrado` não é atendido: o robô responde
`mensagens.sem_eventos` até que algum evento seja ativado.

O menu do exemplo tem 10 opções:

| Nº | Assunto | O que responde |
|---|---|---|
| 1 | Comprar ingresso | Onde comprar e os contatos de venda |
| 2 | Valores e lotes | Lote e valor atuais (campo `evento.ingresso`) e o link para conferir |
| 3 | Data, horário e local | Data, horário de início e término, cidade e local |
| 4 | Line-up e estilos | Atrações e estilos musicais |
| 5 | Documentos e idade | Documento exigido e idade mínima |
| 6 | Proibido levar | Itens proibidos e regras de convivência |
| 7 | Meu ingresso / cancelamento | Onde achar o ingresso e a regra de cancelamento |
| 8 | Grupo oficial | Link do grupo do evento |
| 9 | Fotos | Álbuns de fotos de eventos anteriores |
| 0 | Falar com a equipe | Canais de atendimento humano |

Também há assuntos que o robô reconhece mas que não aparecem no menu (`"mostrar_no_menu": false`).

**Quando houver novidade, troque só o campo do evento** (no painel, seção 01): todas as
respostas e a IA passam a usar o valor novo.

| Novidade | Campo |
|---|---|
| Saiu o endereço/mapa | `local` |
| O lote virou ou mudou o preço | `ingresso` |
| Anunciaram as atrações | `lineup` |
| Novo evento | `nome`, `data`, `horario`, `termino`, links e, se mudar, as respostas das opções |

As informações extras que só a IA usa (e a lista do que ainda **não** foi divulgado, para ela
não inventar) ficam em `ia.conhecimento` (painel, seção 05).

## Vários eventos

Um único número atende vários eventos da produtora. O arquivo continua sendo um só,
`config/chatbot.json`, agora no **formato v2** (`"versao": 2`):

- `produtora`: nome, Instagram, e-mail e Linktree. Os campos ficam disponíveis como
  `{{campo}}` em todos os textos.
- `mensagens`: textos padrão da produtora (`reativado`, `agradecimento`, `sem_eventos`,
  `escolher_evento`). Cada evento pode trocar qualquer um deles.
- `eventos`: a lista de eventos. Cada um tem `id`, `status`, `gatilhos`, `evento` (os campos
  `{{...}}` dele), `mensagens.menu`, `opcoes`, e, se quiser, `fallback` e
  `ia.conhecimento` próprios. A IA recebe o conhecimento da produtora (`ia.conhecimento` da
  raiz) mais o do evento.

Um arquivo sem a chave `eventos` (formato antigo, de um evento só) continua funcionando
como sempre.

**Status do evento**

| Status | O que acontece |
|---|---|
| `rascunho` | O robô não atende; só aparece no simulador do painel |
| `ativo` | O robô atende |
| `encerrado` | Arquivado; o robô não usa |

**O que o contato vê**

- Com **um** evento ativo, o robô atende direto nele.
- Com **mais de um**, o contato recebe a lista (`mensagens.escolher_evento`, com
  `{{eventos}}` no lugar da lista numerada) e digita o número. O robô lembra a escolha por
  24 horas.
- Se a mensagem citar um **gatilho** de um evento (por exemplo "quero ir no requebra"), o
  robô já entra nesse evento. Se citar gatilhos de mais de um, mostra a lista.
- Em qualquer momento o contato digita `eventos`, `trocar evento`, `outro evento` ou
  `mudar evento` para voltar à lista.
- Sem nenhum evento ativo, o robô responde `mensagens.sem_eventos` (ou agradece, se a
  mensagem for um agradecimento).

**Criar, ativar e encerrar**

1. Crie o evento como `rascunho` (no painel, "Novo evento" copia o evento selecionado) e
   teste no simulador, que permite escolher o evento ou incluir rascunhos.
2. Troque o status para `ativo` e salve. Vale a partir da próxima mensagem.
3. Depois do evento, troque para `encerrado`. Os dados ficam guardados.

**Gatilhos**: escolha termos que só aquele evento usa (nome do evento, do artista, da
atração). Eles são comparados sem acento nem maiúsculas, como frase inteira. Dois eventos
`ativo` que podem atender o mesmo número não podem repetir o mesmo gatilho (ver **Vários números**). Evite palavras genéricas ("baile", "ingresso").

**Validação**: erro em evento `ativo` bloqueia o salvamento; erros em `rascunho` ou
`encerrado` viram avisos (prefixados com `eventos[i] (id):`), para que um rascunho
incompleto não impeça de salvar o resto. Sem evento ativo, o arquivo é aceito, com aviso.

**Converter um arquivo antigo**

```
node scripts/migrar-config.js config/chatbot.json --id meu-evento --status ativo --gatilhos "termo 1,termo 2" --produtora "Nome da produtora"
```

Cria o formato v2, guarda o original em `config/chatbot.json.v1.bak` e mostra o resultado
da validação (não grava se houver erros). Instagram, e-mail e Linktree passam para
`produtora`; menu, `nao_entendi`, opções e conhecimento da IA vão para o evento.

## Vários números

Um único WAHA aceita várias sessões. Cada número de WhatsApp é uma sessão, e o **nome da
sessão** identifica o número no robô. O número atual é a sessão `default`.

**Conectar outro número**

```
powershell -ExecutionPolicy Bypass -File scripts\conectar-whatsapp.ps1 -Numero loja2
```

O nome da sessão tem de 1 a 54 caracteres: letras, números, hífen (`-`) e sublinhado (`_`).
A opção `-Numero` vale também para `-Status`, `-Parar` e `-Desconectar`. Para ver todas as
sessões do WAHA, com a situação e o telefone de cada uma, use `-Listar`.

Depois de conectar, cadastre o número para o robô conhecê-lo:

1. Em **Produtora (geral) > "Números de WhatsApp"** (painel), adicione o número com o **mesmo
   nome de sessão** e um nome amigável (por exemplo, "Produtora").
2. Salve. Isso grava o campo `numeros` da raiz de `config/chatbot.json`:

```json
"numeros": [
  { "sessao": "default", "nome": "Produtora" },
  { "sessao": "loja2", "nome": "Loja 2" }
]
```

**Ligar eventos a um número**

No cartão de cada evento, o campo **"Atende nos números"** (`numeros` do evento) lista os
nomes de sessão que atendem aquele evento.

- Evento sem nenhum número marcado é atendido por **todos** os números.
- Exemplo: o número `loja2` atende só o evento A; o número `default` atende só o evento B.

Dentro de cada número, as regras valem separadamente: gatilhos, menu de eventos, evento
lembrado (24 horas) e `mensagens.sem_eventos`. Se um número não tem nenhum evento ativo para
ele, responde só `mensagens.sem_eventos`.

Sem o campo `numeros` na raiz, qualquer sessão atende todos os eventos, como antes.

**Estado e limites**

- O estado da conversa (menu, evento escolhido, etapa do fallback) e a pausa de atendimento
  humano são separados por número: o mesmo contato pode conversar com dois números sem um
  interferir no outro.
- Os limites anti-abuso (taxa por hora e limites da IA) continuam **por contato**, somando as
  mensagens de todos os números.

**Validação**

- Sessão repetida ou inválida: erro.
- Evento com número não cadastrado: erro (vira aviso se o evento for `rascunho` ou `encerrado`).
- Dois eventos com o mesmo gatilho: erro só se os dois puderem ser atendidos no mesmo número.
- Número cadastrado sem nenhum evento ativo: aviso.

**Atendimento e painel**

- `scripts\atendimento.ps1` mostra o número (sessão) de cada contato pausado. Com
  `-Numero <sessão>` mostra só os contatos de um número. Pausas gravadas antes desta mudança
  (sem sessão) continuam válidas.
- No painel, o simulador tem o seletor **Número**, e a página Conversas mostra por qual número
  cada conversa chegou.

> **Aviso de risco.** Cada número conectado pelo WAHA (WhatsApp Web não oficial) corre o mesmo
> risco de bloqueio ou restrição descrito no início deste documento. Teste com números de teste
> primeiro e só depois conecte os números da produtora.

## Editar as mensagens prontas

Abra **http://localhost:8080** com o Docker em execução. O painel permite:

- Editar dados do evento, menu inicial e as três mensagens de fallback.
- Adicionar, remover e editar opções: título, números, palavras-chave, perguntas de exemplo e resposta.
- Gerar o texto do menu a partir dos títulos e números cadastrados.
- Simular uma conversa com o conteúdo em edição, antes de salvar. A simulação não envia nada ao WhatsApp.

Clique em **Salvar** para aplicar o conteúdo à próxima mensagem recebida, sem reiniciar o bot.
O painel valida a configuração, preserva os ajustes avançados e mantém a versão anterior em
`config/chatbot.json.bak`. Se outra janela salvar primeiro, ele pede para recarregar antes
de substituir a edição. No PC (sem `PAINEL_SENHA_HASH`) o painel só abre em localhost e sem
login; no servidor, com domínio configurado, o login é obrigatório (veja "Painel online"). A porta
pode ser alterada com `PAINEL_PORT` no `.env`.

Nas respostas, use `{{local}}`, `{{data}}`, `{{instagram}}` e os outros campos do evento
para reutilizar essas informações.

Tudo o que o robô diz fica em **`config/chatbot.json`**. Edite, salve e pronto: vale a
partir da próxima mensagem, sem reiniciar nada.

| Trecho | O que é |
|---|---|
| `produtora` | (v2) Nome, Instagram, e-mail e Linktree, usados em todos os textos |
| `eventos` | (v2) Lista de eventos: `id`, `status`, `gatilhos`, `evento`, `mensagens.menu`, `opcoes`... |
| `evento` | (formato antigo) Nome, data, horário, local, lote, line-up e links do evento |
| `mensagens.menu` | Menu inicial (enviado em saudações e quando o contato digita `menu`) |
| `mensagens.nao_entendi` | Encaminhamento de compatibilidade quando a terceira etapa do fallback não estiver cadastrada |
| `fallback.mensagens` | Três etapas distintas: orientar, pedir reformulação e indicar atendimento |
| `fallback.mensagem_midia` | Orienta quem enviou áudio ou imagem sem legenda a escrever a dúvida |
| `opcoes` | Uma entrada por opção: título, palavras, perguntas de exemplo e resposta |
| `saudacoes` | Palavras tratadas como saudação (só muda o registro no log; a resposta é o menu) |
| `atendimento_humano` | Duração da pausa e comandos do atendente |
| `protecoes` | Limites de respostas e tempo de "digitando" |
| `ia` | Assistente de IA: ligado ou não, provedor, limites de uso e informações extras |

Regras para escrever:

- Nas respostas, qualquer campo do evento (ou da `produtora`, no formato de vários eventos) entre chaves duplas (`{{local}}`, `{{data}}`, `{{ingresso}}`, `{{grupo}}`...) é trocado pelo valor cadastrado.
- Opções com `"usar_na_ia": false` não são enviadas à IA (hoje: a lista de fotos, para economizar cota); com `"mostrar_no_menu": false` não aparecem na lista de opções do fallback.
- Quebra de linha dentro de um texto se escreve `\n`.
- `palavras_exatas`: a mensagem inteira precisa ser igual (use para números e palavras genéricas).
  `palavras_chave`: termos que identificam o assunto. `perguntas`: exemplos de como as pessoas
  perguntam. Cadastre frases variadas, por exemplo, "quanto tá o ingresso?".
- Seleções explícitas como "opção 2 por favor" têm prioridade. Quando houver mais de um assunto
  plausível, o bot pergunta qual deseja; os números continuam sendo os números do menu.
- Maiúsculas, acentos e pontuação não importam: `PREÇO`, `preco` e `Preço?` são iguais.
- A correção de digitação é conservadora: aceita pequenos erros, sem inventar informações
  fora das respostas cadastradas. O motor de regras não é IA; a IA só entra quando ele não entende.

Sem IA (ou quando ela não ajuda), o fallback guarda a etapa da conversa durante 30 minutos: primeiro mostra os assuntos,
depois pede reformulação e por último indica a equipe. Após a terceira falha, aguarda uma
opção reconhecida para evitar insistir. Qualquer opção válida ou `menu` retoma o atendimento.
Saudações acompanhadas de perguntas desconhecidas seguem o fallback, sem esconder a dúvida.

Depois de editar, confira:

```
powershell -ExecutionPolicy Bypass -File scripts\validar-config.ps1
```

Se o arquivo ficar com erro de sintaxe, o robô para de responder até ser corrigido (o erro
aparece em `ver-logs.ps1 -Erros`).

Para criar uma nova opção, copie um bloco de `opcoes`, dê outro `id` e acrescente a linha
correspondente no texto do menu. Exemplo (responder a agradecimentos sem reenviar o menu):

```json
{
  "id": "agradecimento",
  "palavras_exatas": ["obrigado", "obrigada", "valeu", "ok"],
  "resposta": "Por nada! Se precisar, digite menu."
}
```

## Acompanhar as conversas (painel)

Abra **http://localhost:8080/conversas** (aba **Conversas** no topo do painel). A página se
atualiza sozinha a cada 5 segundos e mostra:

- **WhatsApp**: conectado, parado (com a hora), esperando o QR Code ou fora do ar, e o que fazer.
- **Mensagens de hoje**: quantas chegaram, de quantas pessoas, quantas foram respondidas,
  quantas ficaram sem resposta e quantas respostas não foram entregues.
- **IA de hoje**: consultas usadas da cota do dia e quantas a IA respondeu.
- **Conversas**: lista de contatos (nome do WhatsApp e telefone, quando o WhatsApp informa),
  com busca por nome, número ou texto e filtros *Sem resposta*, *Com IA* e *Com a equipe*.
  Ao abrir um contato, cada mensagem recebida aparece ao lado da resposta enviada, com o
  assunto reconhecido ou a marca *resposta da IA*. Quando o robô não respondeu, aparece o
  motivo (mensagem juntada com a seguinte, 3 orientações já enviadas, limite da IA, contato
  com a equipe, robô desligado...). Mensagens digitadas pela equipe no celular também aparecem.
- **Erros**: falhas do robô (por exemplo, resposta não entregue porque o WhatsApp estava
  desconectado) e da IA (cota esgotada, chave recusada, lentidão), explicadas em português.

Período: hoje, 3 dias ou 7 dias. O botão **Abrir no WhatsApp** abre a conversa com o contato.
Para assumir uma conversa, digite `#humano` nela pelo celular do robô (e `#bot` para devolver).

**Privacidade.** Para esta página, o texto das mensagens, a resposta, o nome e o telefone do
contato ficam gravados **só no servidor onde o robô roda**, no arquivo `conversas-AAAA-MM-DD.log` do volume
`logs`, por **7 dias** (`CONVERSAS_RETENCAO_DIAS` no `.env`, de 1 a 30). O painel apaga os dias
mais antigos a cada hora. O log de atividade (`ver-logs.ps1`) continua sem texto e sem telefone.
Para apagar tudo antes do prazo: `scripts\limpar-dados.ps1 -Logs`.

## Assistente de IA (quando o robô não entende)

Quando o motor de regras não reconhece um texto (por exemplo "tem estacionamento?" ou
"vai ter open bar?"), o robô pode perguntar a uma IA antes de mandar a orientação padrão.

- **Qual IA.** O padrão é a **Groq** (groq.com), que tem plano gratuito com cota diária. Não
  confunda com o **Grok** da xAI (x.ai): a API do Grok é **paga** (sem plano gratuito em
  novembro de 2026). O robô aceita os dois: a chave da Groq começa com `gsk_` e a da xAI com `xai-`.
- **O que a IA sabe.** Só o que está cadastrado: os campos de `evento`, as respostas das
  opções e `ia.conhecimento`. As instruções proíbem inventar endereço, preço, horário, atração,
  link ou contato; quando a informação não existe, ela diz que ainda não foi divulgada e indica
  o Instagram. Se a mensagem não tem relação com o evento, ela devolve um sinal e o robô segue
  com as orientações normais.
- **Conferência automática.** Antes de enviar, o robô confere a resposta: links, @perfis,
  e-mails, telefones e valores em R$ precisam existir no conteúdo cadastrado. Se a IA citar
  algo que não está lá, a resposta é descartada. Respostas longas são cortadas no fim de uma
  frase e ganham o rodapé `ia.rodape`.
- **Limites.** `ia.max_usos_por_contato` (usos por contato) e `ia.max_usos_por_dia` (usos somando
  todos os contatos) aceitam **0 = sem limite**. O contador por contato zera `ia.janela_horas`
  horas (12 por padrão) depois do último uso. Com limite maior que 0, quando ele é atingido o
  contato recebe as orientações normais. A única forma de desligar a IA é `ia.ativa: false`;
  os contadores continuam servindo de estatística. Ajuste no painel (seção 05) ou nesses campos.
  Cada consulta gasta ~2.500 tokens, e a cota da Groq gratuita vale por modelo.
- **Modelos reserva (`ia.modelos_reserva`, opcional, padrão `[]`).** Lista de até 2 modelos,
  sem repetir o principal (`ia.modelo`). Se o principal falhar por cota (429), erro do servidor
  (5xx), tempo esgotado ou falha de rede, o robô tenta as reservas em ordem, com a mesma chave e
  o mesmo endereço. Cada modelo da Groq gratuita tem cota própria, então cada reserva soma
  capacidade. Respostas `[[SEM_RESPOSTA]]`, vazias ou com dado não confirmado **não** tentam
  reserva, nem erros de chave (400, 401, 403).
- **Falhas.** Cada tentativa tem tempo limite de 12 s. Se todos os modelos falharem, o contato
  recebe a orientação normal e o atendimento continua.
- **Privacidade.** A IA recebe **só o texto da mensagem** (nunca o telefone ou o nome do
  contato) e nenhuma conversa anterior. O texto vai para o servidor da Groq, nos EUA.

### Ligar a IA

1. Crie uma conta gratuita em https://console.groq.com e gere uma chave em
   https://console.groq.com/keys (*Create API Key*). Copie a chave (`gsk_...`).
2. Rode e cole a chave quando pedir (ela não aparece na tela):

```
powershell -ExecutionPolicy Bypass -File scripts\configurar-ia.ps1
```

O script grava a chave no `.env`, faz uma pergunta de teste à IA e mostra a resposta. Só
se o teste funcionar ele liga a IA (`ia.ativa`) e atualiza a credencial no n8n, o que deixa
o robô fora do ar por cerca de 1 minuto.

| Ação | Comando |
|---|---|
| Ver se está ligada, provedor e limites | `... scripts\configurar-ia.ps1 -Status` |
| Desligar (a chave continua no `.env`) | `... scripts\configurar-ia.ps1 -Desligar` |
| Testar de novo a chave do `.env` | `... scripts\configurar-ia.ps1 -Testar` |

No log (`ver-logs.ps1`) a coluna da IA mostra o que aconteceu: `respondeu`, `sem_resposta`
(não sabia), `limite_por_contato`, `limite_do_dia`, `tempo_esgotado`, `erro_429` (cota da API),
`erro_401` (chave recusada) ou `link_nao_confirmado`/`preco_nao_confirmado`/`contato_nao_confirmado`
(resposta descartada pela conferência). O simulador do painel também usa a IA de verdade
(e a mesma cota, no máximo 30 consultas por hora) e mostra quando a resposta veio dela.

## Atendimento humano (pelo Instagram)

O atendimento com pessoas é feito **pelo Instagram**, não pelo WhatsApp:

- Quando o contato digita `0` (ou "atendente", "humano", "suporte", "ajuda", "instagram"), o
  robô responde com o Instagram da equipe e o e-mail, e **continua respondendo normalmente** a esse contato.
- Quando o contato escreve algo que o robô **não sabe responder** (e a IA não ajudou), orienta
  em etapas e depois indica o Instagram (`fallback.mensagens`). Saudações
  ("oi", "salve", "bom dia"...) continuam recebendo o menu.

### Opcional: assumir uma conversa pelo próprio WhatsApp

O recurso de pausar o robô para um contato continua disponível, mas nenhuma opção do menu o usa:

- **Pausa automática:** quando alguém da equipe **responde a um contato pelo celular do número
  conectado** (texto, foto ou áudio), o robô para de responder **àquela conversa**; os outros
  contatos continuam com o robô. As respostas do próprio robô não contam. Para desligar:
  `atendimento_humano.pausar_quando_atendente_responder: false`.
- No celular do número conectado, o atendente digita **`#humano`** na conversa: o robô para
  de responder àquele contato. **`#bot`** reativa e avisa o contato.
- Uma opção de `opcoes` com `"transferir_para_humano": true` também pausa o robô para quem a escolher.
- O próprio contato sai da pausa digitando **`menu`** (`atendimento_humano.palavras_para_voltar`; lista vazia `[]` desliga).
- Se ninguém reativar, o robô volta sozinho após 24 horas (`atendimento_humano.horas_pausa`).
- Ver quem está aguardando: `powershell -ExecutionPolicy Bypass -File scripts\atendimento.ps1`
- Reativar pelo computador: `... scripts\atendimento.ps1 reativar 5500000000002` (ou `reativar -Todos`).

O robô **não avisa ninguém da equipe** e não se conecta ao Instagram: ele só informa o perfil ao contato.

## Como o workflow funciona

O workflow `Chatbot Evento - Atendimento WhatsApp` (arquivo `n8n/workflows/chatbot-evento.json`):

1. **Webhook WAHA**: recebe o evento; só aceita com o token secreto no cabeçalho.
2. **Ler/Extrair configuração**: lê `config/chatbot.json`.
3. **Interpretar mensagem**: descarta o que não deve ser respondido (grupos, canais, status,
   mensagens do próprio robô, mensagens antigas) e prepara o texto.
4. **Redis: deduplicar / contato em atendimento?**: ignora mensagem repetida (mesmo ID) e
   contatos em atendimento humano.
   Em seguida **aguarda mensagens em sequência**: só a última de uma sequência do mesmo contato segue adiante.
5. **Redis: ler conversa / Resolver conversa**: interpreta com o motor compartilhado com o painel
   e escolhe a resposta com base no contexto.
   Se não entendeu e a IA está ligada: **Verificar limites da IA**, conta o uso e chama
   **IA: gerar resposta**; **Aplicar resposta da IA** confere a resposta. **Resposta final**
   reúne os três caminhos. Depois aplica os limites por contato.
6. **WAHA: marcar como lida, digitando, aguardar, enviar resposta**.
7. **Redis: guardar conversa**: atualiza o contexto somente após envio bem-sucedido.
8. **Montar linha de log / Gravar no arquivo de log**: registra o resultado (sem texto).
9. **Montar linha da conversa / Gravar no arquivo de conversas**: registra o texto recebido e a
   resposta para a página Conversas. Se o envio falhou, **Propagar falha de envio** marca a
   execução como erro depois de registrar tudo.

Um segundo workflow, `Chatbot Evento - Registro de erros`, grava qualquer falha em `erros-AAAA-MM-DD.log`.

Para ver ou alterar pela tela, abra http://localhost:5678. **No primeiro acesso o n8n pede
para criar a conta de administrador** (e-mail e senha, guardados só no servidor onde o n8n roda); os
workflows já importados aparecem depois do login. O código dos nós fica em `n8n/codigo/`;
se alterá-lo, rode `node n8n/montar-workflows.js` e depois `scripts\reimportar-workflows.ps1`
(a reimportação sobrescreve mudanças feitas pela tela nesses dois workflows).

## Proteções

| Proteção | Como funciona | Onde ajustar |
|---|---|---|
| Laço de mensagens | Mensagens enviadas pelo próprio número nunca são respondidas (as digitadas no celular pausam o robô naquela conversa) | `atendimento_humano.pausar_quando_atendente_responder` |
| Grupos, canais, status | Ignorados no WAHA e novamente no workflow | — |
| Resposta duplicada | Cada ID de mensagem é atendido uma única vez (contador atômico no Redis, guardado 24 h) | — |
| Conversas em aberto | Ao ser ligado, o robô **não responde** ao que foi enviado enquanto estava desligado ou reconectando; só ao que chegar depois | `protecoes.responder_mensagens_recebidas_offline` (`true` volta a responder às pendentes recentes) |
| Mensagens em sequência | Se o contato manda várias mensagens seguidas (ou se várias chegam de uma vez quando o robô é religado), o robô espera 4 segundos e responde **uma vez só**, à última | `protecoes.agrupar_mensagens_segundos` (0 desliga) |
| Contexto simultâneo | Processa uma resposta por vez para o mesmo contato, sem impedir o atendimento dos demais. Reconfere mensagens superadas antes de responder | trava temporária no Redis; expira em até 150 segundos se uma execução falhar antes do envio |
| Resposta repetida | A mesma resposta sai no máximo 3 vezes em 10 minutos para o mesmo contato | `protecoes.max_respostas_iguais`, `janela_respostas_iguais_minutos` |
| Excesso de mensagens | No máximo 40 mensagens atendidas por contato por hora | `protecoes.max_mensagens_por_hora` |
| Mensagens antigas | Ignora o que foi enviado há mais de 2 minutos (segunda trava para as conversas em aberto) | `protecoes.idade_maxima_mensagem_segundos` |
| Falhas | Envio com 2 tentativas; falhas vão para o log de erros | — |

Os dois limites usam janela deslizante: o contador zera depois de um período **sem** novas
mensagens daquele contato.

## Segurança

- Todas as credenciais ficam no `.env` (fora do Git, ver `.gitignore`) e foram geradas aleatoriamente.
- API do WAHA protegida por chave (`X-Api-Key`); o contêiner do WAHA recebe só o hash SHA-512 dela.
- Webhook do n8n protegido por token (`X-Webhook-Token`).
- Painel e Swagger do WAHA com usuário e senha; Redis com senha e sem porta publicada.
- No n8n as chaves ficam em credenciais criptografadas, não dentro do workflow.
- O QR Code não é impresso nos logs (`WAHA_PRINT_QR=False`).
- Para trocar as chaves: edite o `.env` (ou `scripts\gerar-env.ps1 -Forcar`, que troca todas),
  depois `docker compose up -d` e `scripts\reimportar-workflows.ps1 -Credenciais`.
  **Não troque `N8N_ENCRYPTION_KEY` sem reimportar com `-Tudo`**: o n8n deixa de ler as credenciais salvas.
- Não exponha as portas 3000 e 5678 na internet. Só o painel pode ir para a internet, e apenas
  pelo Caddy (HTTPS) com login (veja "Painel online"); como o painel guarda a chave do WAHA
  (`WAHA_API_KEY`), use uma senha forte.

## Dados guardados e como apagar

| Dado | Onde fica | Por quanto tempo |
|---|---|---|
| IDs de mensagens já atendidas | Redis | 24 horas |
| Contadores de limite por contato | Redis | 10 minutos / 1 hora sem mensagens |
| Momento em que o robô foi ligado pela última vez | Redis | Até o próximo liga/desliga |
| Última mensagem de cada contato (para agrupar sequências) | Redis | 2 minutos |
| Contatos em atendimento humano | Redis | Até reativar, no máximo 24 horas |
| Etapa do fallback, últimas intenções, identificador da resposta e opções pendentes (sem texto recebido) | Redis | 30 minutos sem resposta enviada |
| Usos da IA por contato e por dia (só contadores) | Redis | 12 horas sem uso / 2 dias |
| Texto das mensagens que o robô não entendeu (quando a IA está ligada) | Enviado à Groq para gerar a resposta (sem telefone) | Conforme a política da Groq |
| Log de atividade e de erros (contato só pelos 4 últimos dígitos, sem o texto das mensagens) | volume `logs` | 30 dias (`LOG_RETENCAO_DIAS`; a limpeza roda a cada `docker compose up -d`) |
| Conversas para a página Conversas: texto recebido, resposta enviada, nome e telefone do contato | volume `logs` (`conversas-AAAA-MM-DD.log`) | 7 dias (`CONVERSAS_RETENCAO_DIAS`; o painel apaga a cada hora) |
| Execuções do n8n com sucesso | não são gravadas | arquivos temporários somem em até 5 minutos |
| Execuções do n8n com erro (**contêm a mensagem e o número do contato**, para diagnóstico) | banco do n8n | 7 dias |
| Sessão do WhatsApp e dados de conversas que o WAHA guarda para funcionar | volume `waha_sessions` | Até desconectar |
| Mensagens das conversas e eventos do bot (no Postgres, pesquisáveis; telefone como chega) | volume `postgres_data` | 180 dias (`HISTORICO_RETENCAO_DIAS`) |
| Registros e erros do bot (no Postgres) | volume `postgres_data` | 90 dias |
| Versões da configuração (quem e quando salvou; permite restaurar) | volume `postgres_data` | Sem expiração automática |
| Usuários do painel e sessões de login | volume `postgres_data` | Até o admin remover o usuário; sessões enquanto válidas |
| Dumps de backup do banco (`chatbot-AAAAMMDD-HHMM.dump`) | volume `backups_banco` | Os 14 mais recentes (um por dia, às 04:00) |
| Logs dos contêineres | Docker | 3 arquivos de 10 MB por serviço |

Apagar:

```
powershell -ExecutionPolicy Bypass -File scripts\limpar-dados.ps1 -Logs      # logs
powershell -ExecutionPolicy Bypass -File scripts\limpar-dados.ps1 -Estado    # estado do robô no Redis
powershell -ExecutionPolicy Bypass -File scripts\limpar-dados.ps1 -Tudo      # tudo, inclusive o pareamento do WhatsApp
```

## Banco de dados

O serviço `postgres` (PostgreSQL 17) guarda o histórico de conversas e eventos do bot, para
consulta, as versões da configuração (quem e quando salvou, com restauração), os usuários do
painel com papéis (admin, editor e leitor) e os dados da página Métricas. O n8n continua
gravando os arquivos de log, e o painel copia para o banco a cada 5 segundos.

- **Retenção:** mensagens por 180 dias (`HISTORICO_RETENCAO_DIAS`); registros e erros por 90 dias.
  Os arquivos de log seguem com a retenção antiga (`CONVERSAS_RETENCAO_DIAS`, 7 dias).
- **Backup automático:** o serviço `backup-banco` faz um dump todo dia às 04:00 e mantém os 14
  mais recentes no volume `backups_banco`. Na VPS, `scripts\vps.ps1 -Backup` baixa o mais recente.
- **Restauração:** passo a passo em [docs/vps-oracle.md](docs/vps-oracle.md), seção 11.
- **Saúde:** `docker compose ps -a` (o `postgres` deve estar `healthy`) ou
  `docker compose exec postgres pg_isready -U chatbot -d chatbot`.
- **Porta não aberta:** o banco só responde na rede interna do Docker. A porta 5432 nunca deve
  ser publicada.
- **O bot não depende do banco:** se ele cair, o bot segue respondendo e o painel mostra
  "banco indisponível".

## Testes

```
powershell -ExecutionPolicy Bypass -File scripts\testar.ps1
```

Na prática, rode a suíte Docker **na VPS**, num projeto isolado (`chatbot-evento-teste`, sem
portas), copiando a árvore para uma pasta temporária e apagando-a depois; os testes unitários
(`node --test tests/*.test.js`) rodam no PC. Primeiro verifica o motor de interpretação, o painel HTTP e os nós do workflow. Depois
sobe um ambiente **isolado** (n8n e Redis de verdade, WAHA simulado), dispara os casos e
apaga tudo no final. Não usa o WhatsApp nem mexe no ambiente real. Cobre: textos da
especificação, token do webhook, menu, todas as opções e palavras-chave (com acentos,
maiúsculas e pontuação), mensagens que devem ser ignoradas, duplicidade (inclusive entregas
simultâneas), conversas em aberto ao religar, mensagens em sequência, vários contatos ao mesmo tempo, limites, ciclo
completo de atendimento humano, registro de erros, ausência
de dados pessoais nos logs de atividade e de erros, o registro das conversas lido pelo painel
(texto, resposta, nome e telefone no formato real do WAHA GOWS, motivos de silêncio, falha de envio) a escolha entre vários eventos (formato v2, trocando o arquivo de configuração durante o teste) e o assistente de IA com uma API de IA simulada (resposta, sinal de
"sem resposta", limite por contato, erro 500 e 429, lentidão e link inventado). A configuração usada é a cópia congelada em `tests/config/`,
então editar `config/chatbot.json` não quebra os testes.

O que os testes simulados **não** cobrem: a conversa real pelo WhatsApp e a API real da Groq
(o teste dela é feito pelo `configurar-ia.ps1`). Depois de conectar o número de teste, mande
"oi", "2", "0" e uma dúvida fora do menu ("tem estacionamento?") de outro celular e confira as
respostas na página http://localhost:8080/conversas.

## Problemas comuns

| Sintoma | O que verificar |
|---|---|
| Robô não responde | Página http://localhost:8080/conversas: o quadro **WhatsApp** precisa estar *Conectado*, e a conversa mostra o motivo de cada mensagem sem resposta. Depois: `docker compose ps -a` (todos `healthy`?) e `conectar-whatsapp.ps1 -Status` |
| Página Conversas vazia | Ela mostra só o que chegou depois desta atualização do painel. Confira se o WhatsApp está conectado e mande uma mensagem de teste |
| Log mostra `silenciada` | O motivo está na coluna ao lado: contato em atendimento humano, mensagem agrupada com a seguinte, resposta repetida ou limite por hora |
| Log mostra `mensagem_antiga` para mensagens que acabaram de chegar | O relógio do Docker está errado: reinicie o Docker Desktop. Se persistir, aumente `protecoes.idade_maxima_mensagem_segundos` |
| Não respondeu a quem escreveu com o robô desligado | É o esperado (`recebida_com_o_robo_desligado` no log): ele só responde ao que chega depois de ligado. Para mudar, veja `protecoes.responder_mensagens_recebidas_offline` |
| Responde a uns contatos e a outros não | O contato sem resposta pode estar pausado por um atendente (`#humano`): veja `scripts\atendimento.ps1` e reative com `#bot`, com o script, ou peça para ele digitar `menu` |
| A IA nunca responde | `configurar-ia.ps1 -Status` (ligada? chave no `.env`?) e a coluna `ia` do `ver-logs.ps1`. `erro_401`: rode `configurar-ia.ps1` de novo com uma chave válida. `limite_do_dia`/`erro_429`: cota esgotada, volta no dia seguinte |
| A IA respondeu algo errado | Corrija ou complete `ia.conhecimento` (painel, seção 05), principalmente a lista do que ainda não foi divulgado. Se o assunto for frequente, crie uma opção com resposta fixa |
| Erro 422 no log de erros | O WhatsApp não está conectado: rode `conectar-whatsapp.ps1` |
| Parou depois de editar o `chatbot.json` | Rode `validar-config.ps1` |
| Porta 3000 ou 5678 ocupada | Mude `WAHA_PORT` / `N8N_PORT` no `.env` e rode `docker compose up -d` |
| Sessão `FAILED` | O QR Code expirou sem leitura: rode `conectar-whatsapp.ps1` de novo |
| Script do PowerShell bloqueado | Use sempre `powershell -ExecutionPolicy Bypass -File ...` |

## Estrutura do projeto

```
chatbot-evento/
  docker-compose.yml          serviços, rede e volumes
  .env                        credenciais locais (não vai para o Git)
  .env.example                modelo do .env
  config/chatbot.json         TEXTOS, PALAVRAS-CHAVE E LIMITES (edite aqui)
  painel/                     painel local (editor e página Conversas), servidor HTTP, leitura dos
                              registros (registros.js) e configurar-ia.js (usado pelo script)
  painel/Dockerfile           imagem do painel (node:22-alpine)
  lib/                        motor de conversa (conversa.js), vários eventos (eventos.js), assistente de IA (ia.js) e validador
  n8n/
    n8n.env                   configurações não secretas do n8n
    workflows/                workflows exportados (JSON importável)
    codigo/                   código JavaScript dos nós
    montar-workflows.js       gera os JSON a partir de codigo/
    init/                     importação automática e validador da configuração
  scripts/                    scripts de uso (PowerShell) e migrar-config.js (v1 para v2)
  tests/                      testes simulados (WAHA simulado + casos)
  logs/                       recebe os logs exportados (ver-logs.ps1 -Exportar)
```

## Atualizar versões

As imagens estão com versão fixa no `docker-compose.yml` (e no `tests/docker-compose.test.yml`).
Para atualizar: troque as versões nos dois arquivos, rode `scripts\testar.ps1` e, se passar,
`docker compose pull` e `docker compose up -d`. O formato das mensagens do WAHA pode mudar
entre versões e engines; por isso teste antes.

## Limitações conhecidas

- Integração não oficial com o WhatsApp (veja o aviso no início).
- Só mensagens de texto são interpretadas; foto ou áudio sem texto recebem orientação para
  escrever (`fallback.mensagem_midia`, seguindo depois as etapas do fallback).
  Com `protecoes.responder_midia_com_menu: false`, são ignorados. Não há transcrição de áudio.
- Cada número de WhatsApp é uma sessão do WAHA e corre o risco descrito no aviso do início
  (ver **Vários números**). O padrão é um único número (sessão `default`).
- O robô informa o Instagram ao contato, mas não avisa a equipe nem se integra ao Instagram.
- A IA pode errar em fatos escritos por extenso (a conferência automática cobre links,
  contatos e valores em R$, não datas ou nomes). Ela não lembra a conversa anterior, só o
  assunto da última resposta. O conteúdo do evento não se atualiza sozinho a partir do Linktree.
- A pausa automática depende de o WAHA marcar as respostas do robô como enviadas pela API
  (`source: api`); nos logs reais todas as 92 respostas do robô vieram assim.
- Os comandos `#bot` e `#humano` só valem quando digitados **no celular do número conectado**;
  digitados pelo contato são ignorados. Com um número real já foi confirmado que as mensagens
  digitadas nesse celular chegam ao robô (e são ignoradas quando não são comandos). Os dois
  comandos em si foram validados com eventos simulados no formato real do WAHA, ainda não
  digitando-os em um celular.
