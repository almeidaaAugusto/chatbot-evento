// Testes SIMULADOS do chatbot (não usam o WhatsApp).
// Envia ao webhook do n8n eventos no formato do WAHA e confere:
//  - o que o n8n mandou para o WAHA simulado (tests/mock-waha.js);
//  - o que ficou registrado nos arquivos de log.
// Rode com scripts\testar.ps1 (sobe um ambiente isolado só para isto).

const fs = require('fs');
const path = require('path');
const http = require('http');

const N8N = process.env.N8N_URL || 'http://n8n:5678';
const MOCK = process.env.WAHA_URL || 'http://waha:3000';
const TOKEN = process.env.WEBHOOK_TOKEN || '';
const DIR_LOGS = process.env.DIR_LOGS || '/logs';
const PAINEL = process.env.PAINEL_URL || 'http://painel:8080';
const WEBHOOK = N8N + '/webhook/waha-evento';
const NUMERO_DO_ROBO = '5599000000@c.us';

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config', 'chatbot.json'), 'utf8'));

// Textos exigidos na especificação do projeto (com os marcadores ainda não preenchidos).
const ESPERADO = {
  menu:
    'Olá! Seja bem-vindo ao atendimento oficial do evento!\n\nComo podemos ajudar?\n\n' +
    '1 - Onde encontro meu QR Code?\n2 - Valores dos ingressos\n3 - Local e horário do evento\n' +
    '4 - Comprar ingressos\n5 - Falar com um atendente\n\nDigite o número da opção desejada.',
  qrcode:
    "Para encontrar seu QR Code, acesse a plataforma onde realizou sua compra, entre em 'Meus Ingressos' e selecione o ingresso do evento.\n\n" +
    'Caso não consiga localizar, digite 5 para solicitar atendimento.',
  valores: 'Confira os valores atualizados dos ingressos no link oficial:\n\n[LINK_DOS_INGRESSOS]',
  local: 'Local: [LOCAL_DO_EVENTO]\nData: [DATA_DO_EVENTO]\nHorário: [HORARIO_DO_EVENTO]',
  comprar: 'Você pode garantir seu ingresso pelo link oficial:\n\n[LINK_DE_COMPRA]',
  // Atendimento humano pelo Instagram (pedido posterior à especificação inicial).
  atendente:
    'O atendimento com a nossa equipe é feito pelo Instagram:\n\n[INSTAGRAM_DO_EVENTO]\n\nChame a gente por lá e responderemos assim que possível.',
  agradecimento: 'Por nada! Se precisar de mais alguma coisa, é só escrever.',
  nao_entendi:
    'Não tenho essa informação por aqui. Para falar com a nossa equipe, chame no Instagram:\n\n[INSTAGRAM_DO_EVENTO]\n\n' +
    'Para ver o que consigo responder por aqui, digite menu.',
  // Opção que existe só na configuração dos testes, para exercitar a pausa do robô.
  teste_transferir: 'Pedido de atendimento registrado (opção usada só nos testes).',
  fallback_segundo: 'Pode escrever sua dúvida de outro jeito? Se preferir, digite menu para escolher um assunto.',
  fallback_terceiro: 'Para esclarecer essa dúvida com a nossa equipe, chame no Instagram:\n\n[INSTAGRAM_DO_EVENTO]',
  midia: 'Recebi sua mídia. Escreva sua dúvida em uma mensagem de texto para eu ajudar.',
};

// ---------- infraestrutura ----------

const dormir = (ms) => new Promise((ok) => setTimeout(ok, ms));

let sequencia = 0;
let sequenciaConversa = 0;
const novaConversa = () => '55990' + String(10000 + ++sequenciaConversa) + '@c.us';

function montar({ de, para, texto = '', deMim = false, origem = 'app', evento = 'message.any', idade = 0, midia = false, extra = {} }) {
  sequencia += 1;
  const chave = 'T' + String(sequencia).padStart(7, '0');
  const conversa = deMim ? para : de;
  return {
    chave,
    conversa,
    corpo: {
      id: 'evt_' + chave.toLowerCase(),
      timestamp: Date.now(),
      event: evento,
      session: 'default',
      me: { id: NUMERO_DO_ROBO, pushName: 'Robô de teste' },
      payload: {
        id: deMim + '_' + conversa + '_' + chave,
        timestamp: Math.floor(Date.now() / 1000) - idade,
        from: deMim ? NUMERO_DO_ROBO : de,
        fromMe: deMim,
        source: origem,
        to: deMim ? para : NUMERO_DO_ROBO,
        body: texto,
        hasMedia: midia,
        ack: 1,
        ...extra,
      },
      engine: 'GOWS',
      environment: { tier: 'CORE', version: 'teste' },
    },
  };
}

async function postar(corpo, cabecalhos = { 'X-Webhook-Token': TOKEN }) {
  const resposta = await fetch(WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...cabecalhos },
    body: JSON.stringify(corpo),
  });
  await resposta.text();
  return resposta.status;
}

function lerLog(prefixo) {
  if (!fs.existsSync(DIR_LOGS)) return [];
  const linhas = [];
  for (const arquivo of fs.readdirSync(DIR_LOGS).sort()) {
    if (!arquivo.startsWith(prefixo + '-') || !arquivo.endsWith('.log')) continue;
    for (const linha of fs.readFileSync(path.join(DIR_LOGS, arquivo), 'utf8').split('\n')) {
      if (!linha.trim()) continue;
      try {
        linhas.push(JSON.parse(linha));
      } catch (e) {
        linhas.push({ invalida: linha });
      }
    }
  }
  return linhas;
}

async function aguardar(descricao, obter, limiteMs = 25000) {
  const fim = Date.now() + limiteMs;
  for (;;) {
    const valor = await obter();
    if (valor) return valor;
    if (Date.now() > fim) throw new Error('Tempo esgotado aguardando: ' + descricao);
    await dormir(150);
  }
}

const aguardarLog = (chave, quantidade = 1) =>
  aguardar('registro da mensagem ' + chave + ' no log (' + quantidade + 'x)', () => {
    const achadas = lerLog('chatbot').filter((l) => l.msg === chave);
    return achadas.length >= quantidade ? achadas : null;
  });

const aguardarConversa = (chave) =>
  aguardar('registro da conversa ' + chave, () => lerLog('conversas').find((l) => l.msg === chave));

// O painel só aceita o endereço local: o Host enviado é o mesmo do navegador no computador.
function painel(rota) {
  return new Promise((ok, erro) => {
    const req = http.request(PAINEL + rota, { headers: { Host: 'localhost:8080', Accept: 'application/json' } }, (res) => {
      let texto = '';
      res.setEncoding('utf8');
      res.on('data', (parte) => { texto += parte; });
      res.on('end', () => { let dados; try { dados = JSON.parse(texto); } catch (e) { dados = undefined; } ok({ status: res.statusCode, dados, texto }); });
    });
    req.on('error', erro);
    req.end();
  });
}

async function chamadas() {
  return (await fetch(MOCK + '/__mock/requests')).json();
}
const enviosPara = async (conversa) =>
  (await chamadas()).filter((c) => c.rota === '/api/sendText' && c.corpo && c.corpo.chatId === conversa);

// Pedidos recebidos pela IA simulada. Eles não levam o contato, então cada teste usa uma
// marca única dentro da mensagem para localizar o seu.
async function pedidosIA() {
  return (await fetch(MOCK + '/__mock/ia')).json();
}
const pedidosIACom = async (marca) => (await pedidosIA()).filter((p) => JSON.stringify(p.corpo ?? '').includes(marca));
let sequenciaMarca = 0;
const novaMarca = () => 'zzq' + String(1000 + ++sequenciaMarca);
// A IA simulada devolve "**...**"; o robô converte para o negrito do WhatsApp.
const respostaIA = (marca) => '*Resposta de teste da IA* para o pedido ' + marca + '.';

async function controlarMock(acao, chatId, extra = {}) {
  const resposta = await fetch(MOCK + '/__mock/' + acao, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId, ...extra }),
  });
  await resposta.text();
  igual(resposta.status, 200, 'controle do WAHA simulado: ' + acao);
}

// Envia uma mensagem e espera o workflow terminar de tratá-la.
async function mandar(opcoes) {
  const m = montar(opcoes);
  const status = await postar(m.corpo);
  igual(status, 200, 'o webhook deveria aceitar a mensagem');
  const [linha] = await aguardarLog(m.chave);
  return { ...m, linha };
}

function igual(obtido, esperado, descricao) {
  if (obtido !== esperado) {
    throw new Error(descricao + '\n          esperado: ' + JSON.stringify(esperado) + '\n          obtido:   ' + JSON.stringify(obtido));
  }
}
function verdadeiro(condicao, descricao) {
  if (!condicao) throw new Error(descricao);
}

function conferePrimeiroFallback(texto) {
  verdadeiro(texto.startsWith('Ainda não identifiquei sua dúvida sobre [NOME_DO_EVENTO].'), 'primeiro fallback deve preencher o nome do evento');
  verdadeiro(!texto.includes('{{'), 'os marcadores do primeiro fallback devem ser preenchidos');
  for (const titulo of [
    'Onde encontro meu QR Code?', 'Valores dos ingressos', 'Local e horário do evento',
    'Comprar ingressos', 'Falar com um atendente',
  ]) verdadeiro(texto.includes(titulo), 'primeiro fallback deve orientar sobre a opção: ' + titulo);
  verdadeiro(texto.endsWith('Digite o número da opção desejada.'), 'primeiro fallback deve orientar a escolha pelo número');
}

function confereEsclarecimento(texto) {
  verdadeiro(/(?:^|\n)\s*2\s*[-:.)]\s*Valores dos ingressos/i.test(texto), 'esclarecimento deve oferecer valores com seu número global 2');
  verdadeiro(/(?:^|\n)\s*3\s*[-:.)]\s*Local e horário do evento/i.test(texto), 'esclarecimento deve oferecer local com seu número global 3');
  verdadeiro(!texto.includes('{{'), 'esclarecimento não deve deixar marcadores sem preenchimento');
}

async function confereResposta({ texto, intencao, de = novaConversa(), resposta = intencao === 'nao_entendi' ? conferePrimeiroFallback : ESPERADO[intencao], ...resto }) {
  const antes = (await enviosPara(de)).length;
  const m = await mandar({ de, texto, ...resto });
  igual(m.linha.resultado, 'respondida', '"' + texto + '": resultado no log');
  igual(m.linha.intencao, intencao, '"' + texto + '": intenção identificada');
  const envios = await enviosPara(de);
  igual(envios.length, antes + 1, '"' + texto + '": quantidade de respostas enviadas');
  const envio = envios[envios.length - 1];
  if (typeof resposta === 'function') resposta(envio.corpo.text);
  else igual(envio.corpo.text, resposta, '"' + texto + '": texto da resposta');
  igual(envio.corpo.session, 'default', '"' + texto + '": sessão usada no envio');
  verdadeiro(envio.chaveOk, '"' + texto + '": o envio deveria levar a chave da API correta');
  return m;
}

async function confereSilencio({ resultado, motivo, conversa, ...opcoes }) {
  const antes = (await enviosPara(conversa)).length;
  const m = await mandar(opcoes);
  igual(m.linha.resultado, resultado, 'resultado no log');
  igual(m.linha.motivo, motivo, 'motivo no log');
  igual((await enviosPara(conversa)).length, antes, 'nenhuma resposta deveria ser enviada');
  return m;
}

const resultados = [];
async function teste(nome, funcao) {
  try {
    await funcao();
    resultados.push({ nome, ok: true });
    console.log('  [ OK  ] ' + nome);
  } catch (e) {
    resultados.push({ nome, ok: false });
    console.log('  [FALHA] ' + nome + '\n          ' + e.message);
  }
}
const secao = (titulo) => console.log('\n' + titulo);

// ---------- testes ----------

async function principal() {
  console.log('Testes simulados do chatbot (WAHA simulado, n8n e Redis reais)');

  await aguardar(
    'webhook do n8n ficar ativo',
    async () => {
      try {
        return (await postar({ event: 'teste.pronto', session: 'default' })) === 200;
      } catch (e) {
        return false;
      }
    },
    120000,
  );
  await fetch(MOCK + '/__mock/requests', { method: 'DELETE' });

  secao('Configuração');
  await teste('textos da configuração iguais aos da especificação', async () => {
    const preencher = (t) => t.replace(/\{\{\s*([\w-]+)\s*\}\}/g, (o, k) => cfg.evento[k] ?? o);
    igual(preencher(cfg.mensagens.menu), ESPERADO.menu, 'menu');
    for (const opcao of cfg.opcoes) igual(preencher(opcao.resposta), ESPERADO[opcao.id], 'resposta de ' + opcao.id);
    igual(preencher(cfg.mensagens.nao_entendi), ESPERADO.nao_entendi, 'mensagem para o que o robô não sabe responder');
    const reais = cfg.opcoes.filter((o) => !o.id.startsWith('teste_'));
    igual(reais.length, 5, 'quantidade de opções');
    verdadeiro(reais.every((o) => o.transferir_para_humano !== true), 'nenhuma opção real deve pausar o robô');
    verdadeiro(reais.every((o) => typeof o.titulo === 'string' && Array.isArray(o.perguntas)), 'opções devem ter título e exemplos de perguntas');
    igual(cfg.fallback.mensagens.length, 3, 'três etapas do fallback');
    igual(cfg.fallback.mensagens[1], ESPERADO.fallback_segundo, 'segundo fallback configurado');
    igual(preencher(cfg.fallback.mensagens[2]), ESPERADO.fallback_terceiro, 'terceiro fallback configurado');
    igual(cfg.fallback.mensagem_midia, ESPERADO.midia, 'orientação para mídia configurada');
  });

  secao('Segurança do webhook');
  await teste('recusa chamada sem token (403)', async () => {
    const m = montar({ de: novaConversa(), texto: 'oi' });
    igual(await postar(m.corpo, {}), 403, 'status');
    await dormir(1500);
    igual((await enviosPara(m.conversa)).length, 0, 'nada deveria ser enviado');
  });
  await teste('recusa chamada com token errado (403)', async () => {
    const m = montar({ de: novaConversa(), texto: 'oi' });
    igual(await postar(m.corpo, { 'X-Webhook-Token': 'token-errado' }), 403, 'status');
    await dormir(1500);
    igual((await enviosPara(m.conversa)).length, 0, 'nada deveria ser enviado');
  });

  secao('Menu inicial');
  for (const texto of ['oi', 'Olá', 'MENU', 'Olá, tudo bem?', 'Boa noite!', 'Boa tarde, queria uma informação', 'me manda o menu']) {
    await teste('"' + texto + '" -> menu', () => confereResposta({ texto, intencao: 'menu' }));
  }
  for (const texto of ['xyzzy plugh', 'tenho 2 ingressos', '12', '#bot', 'Vocês fazem reembolso?', 'Olá, vocês fazem reembolso?']) {
    await teste('"' + texto + '" -> primeira orientação sem disparar menu pela saudação', () => confereResposta({ texto, intencao: 'nao_entendi' }));
  }
  await teste('agradecimento recebe uma resposta curta e o atendimento continua', async () => {
    const m = await confereResposta({ texto: 'obrigado', intencao: 'agradecimento' });
    await confereResposta({ de: m.conversa, texto: '2', intencao: 'valores' });
  });
  await teste('ordem das chamadas: visto, digitando, parar de digitar, enviar', async () => {
    const m = await confereResposta({ texto: 'menu', intencao: 'menu' });
    const rotas = (await chamadas()).filter((c) => c.corpo && c.corpo.chatId === m.conversa).map((c) => c.rota);
    igual(rotas.join(' > '), '/api/sendSeen > /api/startTyping > /api/stopTyping > /api/sendText', 'sequência');
  });
  await teste('evento "message" (além de "message.any") também é atendido', () =>
    confereResposta({ texto: 'oi', intencao: 'menu', evento: 'message' }));
  await teste('contato com identificador @lid recebe resposta', () =>
    confereResposta({ texto: 'oi', intencao: 'menu', de: '123456789012345@lid' }));
  await teste('foto/áudio sem texto -> pede uma mensagem escrita sem transcrever', () =>
    confereResposta({ texto: '', midia: true, intencao: 'nao_entendi', resposta: ESPERADO.midia }));
  await teste('mídia com legenda reconhecida -> responde à dúvida escrita', () =>
    confereResposta({ texto: 'qual a data do evento?', midia: true, intencao: 'local' }));

  secao('Opções e palavras-chave (maiúsculas, acentos e pontuação)');
  const casos = [
    ['1', 'qrcode'], ['qr', 'qrcode'], ['QR Code', 'qrcode'], ['ingresso', 'qrcode'], ['Meu ingresso', 'qrcode'],
    ['Onde está o meu ingresso?', 'qrcode'], ['1)', 'qrcode'], ['ingreço', 'qrcode'],
    ['2', 'valores'], ['preço', 'valores'], ['PREÇO', 'valores'], ['preco', 'valores'], ['Qual o valor?', 'valores'],
    ['quanto custa', 'valores'], ['Quanto custa o ingresso?', 'valores'], ['lote', 'valores'],
    ['qual o valor do ingresso', 'valores'], ['opção 2', 'valores'], ['opção 2 por favor', 'valores'], ['quanto ta o ingresso?', 'valores'],
    ['3', 'local'], ['local', 'local'], ['endereço', 'local'], ['ENDERECO', 'local'], ['onde fica', 'local'],
    ['Onde fica o evento?', 'local'], ['horário', 'local'], ['Que horas começa?', 'local'], ['  3  ', 'local'], ['qual a data do evento?', 'local'],
    ['4', 'comprar'], ['comprar', 'comprar'], ['compra', 'comprar'], ['link', 'comprar'],
    ['Quero comprar ingresso', 'comprar'], ['4.', 'comprar'], ['onde compro meu ingresso?', 'comprar'],
  ];
  // Rodam em lotes de 8 contatos diferentes ao mesmo tempo.
  for (let i = 0; i < casos.length; i += 8) {
    await Promise.all(
      casos.slice(i, i + 8).map(([texto, intencao]) => teste('"' + texto + '" -> ' + intencao, () => confereResposta({ texto, intencao }))),
    );
  }

  secao('Esclarecimento e fallback por contato');
  await teste('dois assuntos plausíveis -> esclarece com números globais, e 2 recupera valores', async () => {
    const de = novaConversa();
    await confereResposta({ de, texto: 'quais os valores e o endereço?', intencao: 'esclarecer', resposta: confereEsclarecimento });
    await confereResposta({ de, texto: '2', intencao: 'valores' });
  });
  await teste('três dúvidas desconhecidas -> orientações diferentes; quarta fica em silêncio', async () => {
    const de = novaConversa();
    await confereResposta({ de, texto: 'xyzzy plugh primeira', intencao: 'nao_entendi' });
    await confereResposta({ de, texto: 'xyzzy plugh segunda', intencao: 'nao_entendi', resposta: ESPERADO.fallback_segundo });
    await confereResposta({ de, texto: 'xyzzy plugh terceira', intencao: 'nao_entendi', resposta: ESPERADO.fallback_terceiro });
    const textos = (await enviosPara(de)).map((envio) => envio.corpo.text);
    igual(new Set(textos).size, 3, 'as três orientações devem ser diferentes');
    await confereSilencio({ conversa: de, de, texto: 'xyzzy plugh quarta', resultado: 'silenciada', motivo: 'fallback_esgotado' });
    await confereSilencio({ conversa: de, de, texto: 'xyzzy plugh quinta', resultado: 'silenciada', motivo: 'fallback_esgotado' });
  });
  await teste('opção reconhecida após fallback esgotado reinicia as orientações', async () => {
    const de = novaConversa();
    await confereResposta({ de, texto: 'xyzzy plugh primeira', intencao: 'nao_entendi' });
    await confereResposta({ de, texto: 'xyzzy plugh segunda', intencao: 'nao_entendi', resposta: ESPERADO.fallback_segundo });
    await confereResposta({ de, texto: 'xyzzy plugh terceira', intencao: 'nao_entendi', resposta: ESPERADO.fallback_terceiro });
    await confereSilencio({ conversa: de, de, texto: 'xyzzy plugh quarta', resultado: 'silenciada', motivo: 'fallback_esgotado' });
    await confereResposta({ de, texto: '2', intencao: 'valores' });
    await confereResposta({ de, texto: 'xyzzy plugh depois', intencao: 'nao_entendi' });
  });
  await teste('suporte reinicia falhas e o robô continua atendendo pelo WhatsApp', async () => {
    const de = novaConversa();
    await confereResposta({ de, texto: 'xyzzy plugh primeira', intencao: 'nao_entendi' });
    await confereResposta({ de, texto: 'xyzzy plugh segunda', intencao: 'nao_entendi', resposta: ESPERADO.fallback_segundo });
    await confereResposta({ de, texto: 'suporte', intencao: 'atendente' });
    await confereResposta({ de, texto: 'xyzzy plugh depois', intencao: 'nao_entendi' });
    await confereResposta({ de, texto: '1', intencao: 'qrcode' });
  });
  await teste('o progresso de fallback de um contato não avança o de outro', async () => {
    const a = novaConversa();
    const b = novaConversa();
    await confereResposta({ de: a, texto: 'xyzzy plugh primeira', intencao: 'nao_entendi' });
    await confereResposta({ de: a, texto: 'xyzzy plugh segunda', intencao: 'nao_entendi', resposta: ESPERADO.fallback_segundo });
    await confereResposta({ de: b, texto: 'xyzzy plugh primeira', intencao: 'nao_entendi' });
    await confereResposta({ de: a, texto: 'xyzzy plugh terceira', intencao: 'nao_entendi', resposta: ESPERADO.fallback_terceiro });
    await confereResposta({ de: b, texto: 'xyzzy plugh segunda', intencao: 'nao_entendi', resposta: ESPERADO.fallback_segundo });
  });
  await teste('entrega duplicada de dúvida desconhecida não avança o fallback', async () => {
    const de = novaConversa();
    const primeira = await confereResposta({ de, texto: 'xyzzy plugh primeira', intencao: 'nao_entendi' });
    igual(await postar(primeira.corpo), 200, 'duplicata aceita pelo webhook');
    const linhas = await aguardarLog(primeira.chave, 2);
    igual(linhas.filter((linha) => linha.motivo === 'mensagem_duplicada').length, 1, 'duplicata deve ser barrada antes do motor');
    igual((await enviosPara(de)).length, 1, 'a duplicata não deve enviar outra orientação');
    await confereResposta({ de, texto: 'xyzzy plugh segunda', intencao: 'nao_entendi', resposta: ESPERADO.fallback_segundo });
    await confereResposta({ de, texto: 'xyzzy plugh terceira', intencao: 'nao_entendi', resposta: ESPERADO.fallback_terceiro });
    await confereSilencio({ conversa: de, de, texto: 'xyzzy plugh quarta', resultado: 'silenciada', motivo: 'fallback_esgotado' });
  });
  await teste('dúvidas agrupadas avançam apenas uma etapa do fallback', async () => {
    const de = novaConversa();
    const a = montar({ de, texto: 'xyzzy plugh primeira' });
    const b = montar({ de, texto: 'xyzzy plugh segunda' });
    igual(await postar(a.corpo), 200, 'primeira dúvida aceita');
    await dormir(150);
    igual(await postar(b.corpo), 200, 'segunda dúvida aceita');
    const [la] = await aguardarLog(a.chave);
    const [lb] = await aguardarLog(b.chave);
    igual(la.resultado + '/' + la.motivo, 'silenciada/agrupada_com_mensagem_seguinte', 'primeira dúvida agrupada');
    igual(lb.resultado + '/' + lb.intencao, 'respondida/nao_entendi', 'última dúvida gera a primeira orientação');
    const envios = await enviosPara(de);
    igual(envios.length, 1, 'uma orientação para as dúvidas agrupadas');
    conferePrimeiroFallback(envios[0].corpo.text);
    await confereResposta({ de, texto: 'xyzzy plugh terceira', intencao: 'nao_entendi', resposta: ESPERADO.fallback_segundo });
  });

  secao('Mensagens que devem ser ignoradas');
  await teste('resposta enviada pelo próprio robô (fromMe, via API)', async () => {
    const conversa = novaConversa();
    await confereSilencio({ conversa, deMim: true, para: conversa, origem: 'api', texto: ESPERADO.menu, resultado: 'ignorada', motivo: 'enviada_pelo_robo' });
  });
  await teste('comando vindo da API não vale como comando do atendente', async () => {
    const conversa = novaConversa();
    await confereSilencio({ conversa, deMim: true, para: conversa, origem: 'api', texto: '#bot', resultado: 'ignorada', motivo: 'enviada_pelo_robo' });
  });
  await teste('mensagem de grupo', async () => {
    const conversa = '120363000000000001@g.us';
    await confereSilencio({ conversa, de: conversa, texto: 'oi', extra: { participant: '5599011111@c.us' }, resultado: 'ignorada', motivo: 'grupo' });
  });
  await teste('canal (newsletter)', async () => {
    const conversa = '120363000000000002@newsletter';
    await confereSilencio({ conversa, de: conversa, texto: 'oi', resultado: 'ignorada', motivo: 'canal' });
  });
  await teste('status / lista de transmissão', async () => {
    const conversa = 'status@broadcast';
    await confereSilencio({ conversa, de: conversa, texto: 'oi', resultado: 'ignorada', motivo: 'status_ou_lista_de_transmissao' });
  });
  await teste('mensagem antiga (mais de 2 minutos)', async () => {
    const conversa = novaConversa();
    const m = await confereSilencio({ conversa, de: conversa, texto: 'oi', idade: 3600, resultado: 'ignorada', motivo: 'mensagem_antiga' });
    // O histórico entregue ao reconectar não aparece na tela "Conversas".
    await dormir(1500);
    igual(lerLog('conversas').filter((l) => l.msg === m.chave).length, 0, 'mensagem antiga não entra no registro de conversas');
  });
  await teste('mensagem vazia sem mídia', async () => {
    const conversa = novaConversa();
    await confereSilencio({ conversa, de: conversa, texto: '   ', resultado: 'ignorada', motivo: 'sem_texto' });
  });
  await teste('evento de status da sessão é registrado e não gera resposta', async () => {
    const marca = 'WORKING_TESTE_' + Date.now();
    igual(await postar({ event: 'session.status', session: 'default', payload: { status: marca } }), 200, 'status');
    const linha = await aguardar('registro do status no log', () => lerLog('chatbot').find((l) => l.detalhe === marca));
    igual(linha.resultado, 'ignorada', 'resultado');
    igual(linha.motivo, 'status_da_sessao', 'motivo');
  });
  await teste('outros eventos (ex.: message.ack) são ignorados', async () => {
    const antes = lerLog('chatbot').filter((l) => l.motivo === 'evento_nao_tratado').length;
    igual(await postar({ event: 'message.ack', session: 'default', payload: { id: 'x', ack: 3 } }), 200, 'status');
    await aguardar('registro do evento no log', () => lerLog('chatbot').filter((l) => l.motivo === 'evento_nao_tratado').length > antes);
  });

  secao('Respostas duplicadas e limites');
  await teste('mesma mensagem entregue duas vezes -> uma resposta só', async () => {
    const m = await confereResposta({ texto: '2', intencao: 'valores' });
    igual(await postar(m.corpo), 200, 'reenvio aceito');
    const linhas = await aguardarLog(m.chave, 2);
    igual(linhas[1].resultado + '/' + linhas[1].motivo, 'silenciada/mensagem_duplicada', 'segunda entrega');
    igual((await enviosPara(m.conversa)).length, 1, 'quantidade de respostas');
  });
  await teste('três entregas simultâneas da mesma mensagem -> uma resposta só', async () => {
    const m = montar({ de: novaConversa(), texto: '3' });
    await Promise.all([postar(m.corpo), postar(m.corpo), postar(m.corpo)]);
    const linhas = await aguardarLog(m.chave, 3);
    igual(linhas.filter((l) => l.resultado === 'respondida').length, 1, 'respondidas');
    igual(linhas.filter((l) => l.motivo === 'mensagem_duplicada').length, 2, 'duplicadas');
    igual((await enviosPara(m.conversa)).length, 1, 'quantidade de respostas');
  });
  await teste('mesma resposta repetida: responde ' + cfg.protecoes.max_respostas_iguais + ' vezes e depois silencia', async () => {
    const de = novaConversa();
    const limite = cfg.protecoes.max_respostas_iguais;
    for (let i = 1; i <= limite; i += 1) {
      const m = await mandar({ de, texto: 'oi' });
      igual(m.linha.resultado, 'respondida', 'mensagem ' + i);
    }
    await confereSilencio({ conversa: de, de, texto: 'olá', resultado: 'silenciada', motivo: 'resposta_repetida' });
    igual((await enviosPara(de)).length, limite, 'quantidade de respostas');
    // Outra opção continua sendo atendida.
    const outra = await mandar({ de, texto: '2' });
    igual(outra.linha.resultado, 'respondida', 'opção diferente após o limite');
  });
  await teste('limite por hora (' + cfg.protecoes.max_mensagens_por_hora + ' no ambiente de teste)', async () => {
    const de = novaConversa();
    const limite = cfg.protecoes.max_mensagens_por_hora;
    const rodizio = ['1', '2', '3', '4'];
    for (let i = 0; i < limite; i += 1) {
      const m = await mandar({ de, texto: rodizio[i % rodizio.length] });
      igual(m.linha.resultado, 'respondida', 'mensagem ' + (i + 1));
    }
    await confereSilencio({ conversa: de, de, texto: 'oi', resultado: 'silenciada', motivo: 'limite_de_mensagens_por_hora' });
    igual((await enviosPara(de)).length, limite, 'quantidade de respostas');
  });

  secao('Robô religado: conversas em aberto');
  await teste('mensagens enviadas antes de o robô ligar não são respondidas', async () => {
    // Simula o WhatsApp ficando online agora.
    const marca = 'WORKING';
    const agora = Date.now();
    igual(await postar({ event: 'session.status', session: 'default', timestamp: agora, payload: { status: marca } }), 200, 'status');
    await aguardar('registro do status no log', () => lerLog('chatbot').some((l) => l.detalhe === marca && Date.parse(l.quando) >= agora - 2000));

    // Pendentes de 20, 60 e 100 segundos atrás, de três contatos diferentes.
    for (const idade of [20, 60, 100]) {
      const de = novaConversa();
      await confereSilencio({ conversa: de, de, texto: 'oi', idade, resultado: 'ignorada', motivo: 'recebida_com_o_robo_desligado' });
    }
    // Várias pendentes do mesmo contato, entregues de uma vez.
    const mesmo = novaConversa();
    const pendentes = [45, 40, 35].map((idade) => montar({ de: mesmo, texto: 'oi', idade }));
    await Promise.all(pendentes.map((m) => postar(m.corpo)));
    for (const m of pendentes) {
      const [linha] = await aguardarLog(m.chave);
      igual(linha.resultado + '/' + linha.motivo, 'ignorada/recebida_com_o_robo_desligado', 'pendente do mesmo contato');
    }
    igual((await enviosPara(mesmo)).length, 0, 'nenhuma resposta às pendentes');

    // Comando do atendente digitado antes de ligar também não vale (não envia o aviso de reativação).
    const de = novaConversa();
    const comando = await mandar({ deMim: true, para: de, texto: '#bot', idade: 30 });
    igual(comando.linha.resultado + '/' + comando.linha.motivo, 'ignorada/recebida_com_o_robo_desligado', 'comando pendente');
    igual((await enviosPara(de)).length, 0, 'nenhum aviso enviado');

    // O que chega depois de ligar é respondido normalmente, inclusive para quem tinha pendências.
    await confereResposta({ texto: 'oi', intencao: 'menu' });
    await confereResposta({ de: mesmo, texto: '2', intencao: 'valores' });
  });
  await teste('pendência lida antes de o robô registrar que foi ligado é barrada na segunda conferência', async () => {
    // Garante distância do último evento de status, para a mensagem passar pela primeira conferência.
    await dormir(3500);
    const de = novaConversa();
    const m = montar({ de, texto: 'oi', idade: 3 });
    igual(await postar(m.corpo), 200, 'mensagem aceita');
    // O aviso de "robô ligado" chega logo depois, durante a espera por mensagens em sequência.
    igual(await postar({ event: 'session.status', session: 'default', timestamp: Date.now(), payload: { status: 'WORKING' } }), 200, 'status');
    const [linha] = await aguardarLog(m.chave);
    igual(linha.resultado + '/' + linha.motivo, 'ignorada/recebida_com_o_robo_desligado', 'resultado no log');
    igual((await enviosPara(de)).length, 0, 'nenhuma resposta enviada');
    // Mensagem nova do mesmo contato é respondida.
    await confereResposta({ de, texto: 'oi', intencao: 'menu' });
  });
  await teste('evento de status atrasado não volta o relógio', async () => {
    const antigo = Date.now() - 3600 * 1000;
    igual(await postar({ event: 'session.status', session: 'default', timestamp: antigo, payload: { status: 'STARTING_ATRASADO' } }), 200, 'status');
    await aguardar('registro do status no log', () => lerLog('chatbot').some((l) => l.detalhe === 'STARTING_ATRASADO'));
    const de = novaConversa();
    await confereSilencio({ conversa: de, de, texto: 'oi', idade: 60, resultado: 'ignorada', motivo: 'recebida_com_o_robo_desligado' });
  });

  secao('Mensagens em sequência e vários contatos');
  await teste('envio demorado não sobrescreve o reset de uma opção reconhecida posterior', async () => {
    const de = novaConversa();
    const a = montar({ de, texto: 'xyzzy plugh primeira' });
    const b = montar({ de, texto: '2' });
    await controlarMock('hold', de);
    try {
      igual(await postar(a.corpo), 200, 'primeira dúvida aceita');
      await aguardar('o primeiro envio ficar retido no WAHA simulado', async () => (await enviosPara(de)).length === 1);
      igual(await postar(b.corpo), 200, 'opção posterior aceita');
      await dormir((cfg.protecoes.agrupar_mensagens_segundos + 1.5) * 1000);
      igual((await enviosPara(de)).length, 1, 'a opção deve aguardar a gravação do contexto da primeira resposta');
      await confereResposta({ texto: '3', intencao: 'local' });
    } finally {
      await controlarMock('release', de);
    }
    const [la] = await aguardarLog(a.chave);
    const [lb] = await aguardarLog(b.chave);
    igual(la.resultado + '/' + la.intencao, 'respondida/nao_entendi', 'primeira resposta concluída');
    igual(lb.resultado + '/' + lb.intencao, 'respondida/valores', 'opção posterior concluída');
    const envios = await enviosPara(de);
    igual(envios.length, 2, 'duas respostas, na ordem de atendimento');
    conferePrimeiroFallback(envios[0].corpo.text);
    igual(envios[1].corpo.text, ESPERADO.valores, 'a opção reconhecida é enviada depois da primeira resposta');
    await confereResposta({ de, texto: 'xyzzy plugh depois da opcao', intencao: 'nao_entendi' });
  });
  await teste('mensagem superada durante a espera da conversa não responde nem altera o contexto', async () => {
    const de = novaConversa();
    const a = montar({ de, texto: 'xyzzy plugh primeira' });
    const b = montar({ de, texto: '2' });
    const c = montar({ de, texto: '3' });
    await controlarMock('hold', de);
    try {
      igual(await postar(a.corpo), 200, 'primeira dúvida aceita');
      await aguardar('o envio ficar retido antes das próximas mensagens', async () => (await enviosPara(de)).length === 1);
      igual(await postar(b.corpo), 200, 'segunda mensagem aceita');
      await dormir((cfg.protecoes.agrupar_mensagens_segundos + 1.5) * 1000);
      igual(await postar(c.corpo), 200, 'terceira mensagem aceita');
      await dormir((cfg.protecoes.agrupar_mensagens_segundos + 1.5) * 1000);
    } finally {
      await controlarMock('release', de);
    }
    await aguardarLog(a.chave);
    const [lb] = await aguardarLog(b.chave);
    const [lc] = await aguardarLog(c.chave);
    igual(lb.resultado + '/' + lb.motivo, 'silenciada/agrupada_com_mensagem_seguinte', 'a segunda mensagem foi superada na espera');
    igual(lc.resultado + '/' + lc.intencao, 'respondida/local', 'a mensagem mais recente continua atendida');
    const envios = await enviosPara(de);
    igual(envios.length, 2, 'somente a primeira e a última mensagens recebem resposta');
    igual(envios[1].corpo.text, ESPERADO.local, 'última opção selecionada');
    await confereResposta({ de, texto: 'xyzzy plugh depois da opcao', intencao: 'nao_entendi' });
  });
  await teste('pausa do operador durante a fila impede que um menu anterior reative a conversa', async () => {
    const de = novaConversa();
    const a = montar({ de, texto: 'xyzzy plugh primeira' });
    const b = montar({ de, texto: 'menu' });
    await controlarMock('hold', de);
    try {
      igual(await postar(a.corpo), 200, 'primeira dúvida aceita');
      await aguardar('o envio ficar retido antes da pausa do operador', async () => (await enviosPara(de)).length === 1);
      igual(await postar(b.corpo), 200, 'menu recebido antes da pausa');
      await dormir((cfg.protecoes.agrupar_mensagens_segundos + 1.5) * 1000);
      const pausa = await mandar({ deMim: true, para: de, texto: '#humano' });
      igual(pausa.linha.resultado, 'robo_pausado', 'nova pausa do operador confirmada durante a fila');
    } finally {
      await controlarMock('release', de);
    }
    await aguardarLog(a.chave);
    const [lb] = await aguardarLog(b.chave);
    igual(lb.resultado + '/' + lb.motivo, 'silenciada/em_atendimento_humano', 'menu anterior deve respeitar a pausa posterior');
    igual((await enviosPara(de)).length, 1, 'o menu da fila não pode enviar resposta');
    const reativada = await mandar({ deMim: true, para: de, texto: '#bot' });
    igual(reativada.linha.resultado, 'robo_reativado', 'operador continua podendo reativar');
    await confereResposta({ de, texto: 'xyzzy plugh segunda', intencao: 'nao_entendi', resposta: ESPERADO.fallback_segundo });
    await confereResposta({ de, texto: '2', intencao: 'valores' });
  });
  await teste('3 mensagens seguidas do mesmo contato -> uma resposta só, à última', async () => {
    const de = novaConversa();
    const a = montar({ de, texto: 'oi' });
    const b = montar({ de, texto: 'olá' });
    const c = montar({ de, texto: '2' });
    await postar(a.corpo);
    await dormir(150);
    await postar(b.corpo);
    await dormir(150);
    await postar(c.corpo);
    const [la] = await aguardarLog(a.chave);
    const [lb] = await aguardarLog(b.chave);
    const [lc] = await aguardarLog(c.chave);
    igual(la.resultado + '/' + la.motivo, 'silenciada/agrupada_com_mensagem_seguinte', '1ª mensagem');
    igual(lb.resultado + '/' + lb.motivo, 'silenciada/agrupada_com_mensagem_seguinte', '2ª mensagem');
    igual(lc.resultado + '/' + lc.intencao, 'respondida/valores', '3ª mensagem');
    const envios = await enviosPara(de);
    igual(envios.length, 1, 'quantidade de respostas');
    igual(envios[0].corpo.text, ESPERADO.valores, 'texto da resposta');
  });
  await teste('5 "oi" de uma vez (como ao religar o robô) -> um menu só, e o limite de repetição conta 1', async () => {
    const de = novaConversa();
    const rajada = Array.from({ length: 5 }, () => montar({ de, texto: 'oi' }));
    await Promise.all(rajada.map((m) => postar(m.corpo)));
    const linhas = (await Promise.all(rajada.map((m) => aguardarLog(m.chave)))).map(([l]) => l);
    igual(linhas.filter((l) => l.resultado === 'respondida').length, 1, 'respondidas');
    igual(linhas.filter((l) => l.motivo === 'agrupada_com_mensagem_seguinte').length, 4, 'agrupadas');
    igual((await enviosPara(de)).length, 1, 'menus enviados');
    // As 4 agrupadas não contam como respostas repetidas: ainda cabem mais 2 menus (limite 3).
    igual((await mandar({ de, texto: 'oi' })).linha.resultado, 'respondida', '2º menu');
    igual((await mandar({ de, texto: 'oi' })).linha.resultado, 'respondida', '3º menu');
    await confereSilencio({ conversa: de, de, texto: 'oi', resultado: 'silenciada', motivo: 'resposta_repetida' });
    igual((await enviosPara(de)).length, 3, 'menus enviados no total');
  });
  await teste('12 contatos diferentes escrevendo ao mesmo tempo -> todos recebem a resposta certa', async () => {
    const textos = ['oi', '1', '2', '3', '4', 'menu', 'preço', 'local', 'comprar', 'qr code', 'olá', 'lote'];
    const esperadas = ['menu', 'qrcode', 'valores', 'local', 'comprar', 'menu', 'valores', 'local', 'comprar', 'qrcode', 'menu', 'valores'];
    const mensagens = textos.map((texto) => montar({ de: novaConversa(), texto }));
    await Promise.all(mensagens.map((m) => postar(m.corpo)));
    for (let i = 0; i < mensagens.length; i += 1) {
      const [linha] = await aguardarLog(mensagens[i].chave);
      igual(linha.resultado + '/' + linha.intencao, 'respondida/' + esperadas[i], 'contato ' + (i + 1) + ' ("' + textos[i] + '")');
      const envios = await enviosPara(mensagens[i].conversa);
      igual(envios.length, 1, 'contato ' + (i + 1) + ': quantidade de respostas');
      igual(envios[0].corpo.text, ESPERADO[esperadas[i]], 'contato ' + (i + 1) + ': texto da resposta');
    }
  });
  await teste('contato em atendimento humano não bloqueia os outros contatos', async () => {
    const pausado = novaConversa();
    await confereResposta({ de: pausado, texto: 'transferir teste', intencao: 'teste_transferir' });
    await confereResposta({ texto: 'oi', intencao: 'menu' });
    await confereResposta({ texto: '2', intencao: 'valores' });
    await confereSilencio({ conversa: pausado, de: pausado, texto: '1', resultado: 'silenciada', motivo: 'em_atendimento_humano' });
  });

  secao('Atendimento humano');
  await teste('contato em atendimento digita "menu" -> sai do atendimento e volta ao robô', async () => {
    const de = novaConversa();
    await confereResposta({ de, texto: 'transferir teste', intencao: 'teste_transferir' });
    await confereSilencio({ conversa: de, de, texto: 'oi', resultado: 'silenciada', motivo: 'em_atendimento_humano' });
    const volta = await mandar({ de, texto: 'Menu' });
    igual(volta.linha.resultado + '/' + volta.linha.intencao, 'respondida/menu', 'resposta ao "menu"');
    igual(volta.linha.detalhe, 'contato_voltou_do_atendimento_humano', 'registro da volta');
    const envios = await enviosPara(de);
    igual(envios[envios.length - 1].corpo.text, ESPERADO.menu, 'menu enviado');
    const depois = await mandar({ de, texto: '3' });
    igual(depois.linha.resultado + '/' + depois.linha.intencao, 'respondida/local', 'continua respondendo');
  });
  await teste('equipe responde pelo celular -> robô para naquela conversa; #bot devolve ao robô', async () => {
    const de = novaConversa();
    const outro = novaConversa();
    await confereResposta({ de, texto: 'oi', intencao: 'menu' });

    // Resposta do próprio robô (eco via API) não pausa nada.
    const eco = await mandar({ deMim: true, para: de, origem: 'api', texto: ESPERADO.menu });
    igual(eco.linha.motivo, 'enviada_pelo_robo', 'eco do robô');
    await confereResposta({ de, texto: '2', intencao: 'valores' });

    const equipe = await mandar({ deMim: true, para: de, texto: 'Oi! Aqui é a Kakau, posso te ajudar 😊' });
    igual(equipe.linha.resultado + '/' + equipe.linha.motivo, 'robo_pausado/atendente_respondeu', 'pausa automática');
    for (const texto of ['quero 2 ingressos', '1', 'oi']) {
      await confereSilencio({ conversa: de, de, texto, resultado: 'silenciada', motivo: 'em_atendimento_humano' });
    }
    // Os outros contatos continuam com o robô.
    await confereResposta({ de: outro, texto: 'oi', intencao: 'menu' });

    const reativar = await mandar({ deMim: true, para: de, texto: '#bot' });
    igual(reativar.linha.resultado, 'robo_reativado', '#bot não conta como resposta da equipe');
    const m = await mandar({ de, texto: '3' });
    igual(m.linha.resultado + '/' + m.linha.intencao, 'respondida/local', 'volta a responder');
  });
  await teste('comando antigo do atendente (entregue ao reconectar) é ignorado', async () => {
    const de = novaConversa();
    const antigo = await mandar({ deMim: true, para: de, texto: '#humano', idade: 3600 });
    igual(antigo.linha.resultado + '/' + antigo.linha.motivo, 'ignorada/mensagem_antiga', 'comando antigo');
    await confereResposta({ de, texto: 'oi', intencao: 'menu' });
  });
  for (const texto of ['5', 'atendente', 'humano', 'suporte', 'ajuda', 'Preciso de AJUDA, por favor!', 'qual o instagram de vocês?']) {
    await teste('"' + texto + '" -> encaminha para o Instagram e o robô continua respondendo', async () => {
      const m = await confereResposta({ texto, intencao: 'atendente' });
      if (texto === '5') igual(m.linha.motivo, 'numero', 'motivo no log para uma seleção numérica');
      else verdadeiro(['palavra_chave', 'pergunta', 'aproximacao'].includes(m.linha.motivo), 'motivo no log deve indicar reconhecimento sem pausa no WhatsApp');
      const depois = await mandar({ de: m.conversa, texto: '1' });
      igual(depois.linha.resultado + '/' + depois.linha.intencao, 'respondida/qrcode', 'continua respondendo ao mesmo contato');
    });
  }
  await teste('opção marcada com transferir_para_humano ainda pausa o robô (recurso opcional)', async () => {
    const m = await confereResposta({ texto: 'transferir teste', intencao: 'teste_transferir' });
    igual(m.linha.motivo, 'transferida_para_atendimento_humano', 'motivo no log');
    await confereSilencio({ conversa: m.conversa, de: m.conversa, texto: '1', resultado: 'silenciada', motivo: 'em_atendimento_humano' });
  });
  await teste('pausa no WhatsApp, ciclo completo: pausa -> #bot reativa -> #humano pausa -> #bot reativa', async () => {
    const de = novaConversa();
    await confereResposta({ de, texto: 'transferir teste', intencao: 'teste_transferir' });

    // Enquanto pausado nada é respondido (nem "#bot" digitado pelo cliente).
    for (const texto of ['1', '#bot', 'alguém aí?', '2', '3', '4', 'oi', 'olá', 'ei', 'teste', 'ok']) {
      await confereSilencio({ conversa: de, de, texto, resultado: 'silenciada', motivo: 'em_atendimento_humano' });
    }

    const reativar = await mandar({ deMim: true, para: de, texto: '#bot' });
    igual(reativar.linha.resultado, 'robo_reativado', 'comando #bot');
    let envios = await enviosPara(de);
    igual(envios.length, 2, 'aviso de reativação enviado');
    igual(envios[1].corpo.text, cfg.mensagens.reativado, 'texto do aviso de reativação');

    // As mensagens trocadas durante a pausa não contam no limite por hora.
    let m = await mandar({ de, texto: '1' });
    igual(m.linha.resultado, 'respondida', 'volta a responder após reativar');
    igual((await enviosPara(de))[2].corpo.text, ESPERADO.qrcode, 'resposta após reativar');

    const pausar = await mandar({ deMim: true, para: de, texto: '#Humano' });
    igual(pausar.linha.resultado, 'robo_pausado', 'comando #humano');
    await confereSilencio({ conversa: de, de, texto: '2', resultado: 'silenciada', motivo: 'em_atendimento_humano' });

    const deNovo = await mandar({ deMim: true, para: de, texto: ' #BOT ' });
    igual(deNovo.linha.resultado, 'robo_reativado', 'segundo #bot');
    m = await mandar({ de, texto: '2' });
    igual(m.linha.resultado, 'respondida', 'responde após a segunda reativação');
    envios = await enviosPara(de);
    igual(envios[envios.length - 1].corpo.text, ESPERADO.valores, 'resposta final');
  });

  await teste('formato real do WAHA GOWS (conversa em "from", "to" nulo): #humano e #bot funcionam', async () => {
    // Observado com um número real: nas mensagens do próprio número o WAHA GOWS envia a
    // conversa em "from" e deixa "to" nulo, e os contatos chegam com identificador @lid.
    const de = '987654321098765@lid';
    const doCelular = (texto) => mandar({ deMim: true, para: de, texto, extra: { from: de, to: null } });

    const pausar = await doCelular('#humano');
    igual(pausar.linha.resultado, 'robo_pausado', 'comando #humano');
    await confereSilencio({ conversa: de, de, texto: 'oi', extra: { to: null }, resultado: 'silenciada', motivo: 'em_atendimento_humano' });

    const reativar = await doCelular('#bot');
    igual(reativar.linha.resultado, 'robo_reativado', 'comando #bot');
    const m = await mandar({ de, texto: 'oi', extra: { to: null } });
    igual(m.linha.resultado, 'respondida', 'volta a responder');

    // A resposta do robô volta como evento (fromMe, via API) com a conversa em "from": deve ser ignorada.
    await confereSilencio({ conversa: de, deMim: true, para: de, origem: 'api', texto: ESPERADO.menu, extra: { from: de, to: null }, resultado: 'ignorada', motivo: 'enviada_pelo_robo' });
  });

  secao('Assistente de IA (API simulada)');
  await teste('dúvida fora do menu -> a IA responde, com chave própria e sem dados do contato', async () => {
    const de = novaConversa();
    const marca = novaMarca();
    const m = await confereResposta({ de, texto: 'IA responde ' + marca, intencao: 'ia', resposta: respostaIA(marca) });
    igual(m.linha.motivo, 'ia', 'motivo no log');
    igual(m.linha.ia, 'respondeu', 'resultado da IA no log');
    const pedidos = await pedidosIACom(marca);
    igual(pedidos.length, 1, 'uma única chamada à IA');
    verdadeiro(pedidos[0].chaveOk, 'a chamada deveria levar a chave da IA');
    igual(pedidos[0].corpo.model, 'modelo-de-teste', 'modelo configurado');
    igual(pedidos[0].corpo.messages.length, 2, 'instruções e mensagem do cliente');
    const instrucoes = pedidos[0].corpo.messages[0].content;
    verdadeiro(instrucoes.includes('[[SEM_RESPOSTA]]'), 'as instruções definem o sinal de "sem resposta"');
    verdadeiro(instrucoes.includes('Estacionamento: ainda não divulgado.'), 'o conhecimento extra é enviado');
    verdadeiro(instrucoes.includes('Valores dos ingressos'), 'as respostas cadastradas são enviadas');
    verdadeiro(pedidos[0].corpo.messages[1].content.endsWith('Mensagem do cliente: IA responde ' + marca), 'a mensagem do cliente vai por último');
    verdadeiro(!JSON.stringify(pedidos[0].corpo).includes(de.split('@')[0]), 'o telefone não pode ir para a IA');
    // Uma resposta da IA reinicia a sequência de orientações e o atendimento segue normal.
    await confereResposta({ de, texto: 'xyzzy plugh depois da ia', intencao: 'nao_entendi' });
    await confereResposta({ de, texto: '2', intencao: 'valores' });
  });
  await teste('IA sem resposta para a dúvida -> orientação normal, com o motivo no log', async () => {
    const marca = novaMarca();
    const m = await confereResposta({ texto: 'xyzzy plugh ' + marca, intencao: 'nao_entendi' });
    igual(m.linha.ia, 'sem_resposta', 'resultado da IA no log');
    igual((await pedidosIACom(marca)).length, 1, 'a IA foi consultada uma vez');
  });
  await teste('limite por contato: ' + cfg.ia.max_usos_por_contato + ' usos, depois a IA não é mais chamada (outro contato continua)', async () => {
    const de = novaConversa();
    for (let i = 1; i <= cfg.ia.max_usos_por_contato; i += 1) {
      const marca = novaMarca();
      await confereResposta({ de, texto: 'ia responde ' + marca, intencao: 'ia', resposta: respostaIA(marca) });
    }
    const extra = novaMarca();
    const m = await confereResposta({ de, texto: 'ia responde ' + extra, intencao: 'nao_entendi' });
    igual(m.linha.ia, 'limite_por_contato', 'motivo no log');
    igual((await pedidosIACom(extra)).length, 0, 'nenhuma chamada depois do limite');
    const outro = novaMarca();
    await confereResposta({ texto: 'ia responde ' + outro, intencao: 'ia', resposta: respostaIA(outro) });
  });
  for (const [texto, esperado, descricao] of [
    ['ia erro interno', 'erro_500', 'IA fora do ar (erro 500)'],
    ['ia limite da api', 'erro_429', 'cota da API esgotada (erro 429)'],
    ['ia inventa link', 'link_nao_confirmado', 'resposta da IA com link que não está cadastrado'],
  ]) {
    await teste(descricao + ' -> orientação normal, sem derrubar o atendimento', async () => {
      const antes = lerLog('erros').length;
      const marca = novaMarca();
      const m = await confereResposta({ texto: texto + ' ' + marca, intencao: 'nao_entendi' });
      igual(m.linha.ia, esperado, 'resultado da IA no log');
      igual((await pedidosIACom(marca)).length, 1, 'uma tentativa só, sem repetir');
      igual(lerLog('erros').length, antes, 'não deve virar erro do workflow');
      await confereResposta({ de: m.conversa, texto: '3', intencao: 'local' });
    });
  }
  await teste('IA lenta -> desiste no tempo limite e envia a orientação normal', async () => {
    const marca = novaMarca();
    const inicio = Date.now();
    const m = await confereResposta({ texto: 'ia lenta ' + marca, intencao: 'nao_entendi' });
    igual(m.linha.ia, 'tempo_esgotado', 'resultado da IA no log');
    verdadeiro(Date.now() - inicio < 15000, 'o contato não pode esperar a IA indefinidamente');
  });
  await teste('IA ainda ajuda depois das três orientações, e a sequência recomeça', async () => {
    const de = novaConversa();
    await confereResposta({ de, texto: 'xyzzy plugh primeira', intencao: 'nao_entendi' });
    await confereResposta({ de, texto: 'xyzzy plugh segunda', intencao: 'nao_entendi', resposta: ESPERADO.fallback_segundo });
    await confereResposta({ de, texto: 'xyzzy plugh terceira', intencao: 'nao_entendi', resposta: ESPERADO.fallback_terceiro });
    const marca = novaMarca();
    await confereResposta({ de, texto: 'ia responde ' + marca, intencao: 'ia', resposta: respostaIA(marca) });
    const depois = await confereResposta({ de, texto: 'xyzzy plugh depois', intencao: 'nao_entendi' });
    igual(depois.linha.ia, 'limite_por_contato', 'os usos anteriores contam no limite do contato');
  });
  await teste('opções do menu, saudações, números soltos e mídia não gastam a cota da IA', async () => {
    const antes = (await pedidosIA()).length;
    const de = novaConversa();
    await confereResposta({ de, texto: '2', intencao: 'valores' });
    await confereResposta({ de, texto: 'oi', intencao: 'menu' });
    await confereResposta({ de, texto: '', midia: true, intencao: 'nao_entendi', resposta: ESPERADO.midia });
    await confereResposta({ de, texto: '12', intencao: 'nao_entendi', resposta: ESPERADO.fallback_segundo });
    igual((await pedidosIA()).length, antes, 'nenhuma chamada à IA');
  });

  secao('Conversas no painel (texto recebido e resposta enviada)');
  await teste('mensagem respondida: texto, resposta, assunto e telefone ficam no arquivo de conversas', async () => {
    const de = novaConversa();
    const m = await confereResposta({ de, texto: 'Oi', intencao: 'menu' });
    const r = await aguardarConversa(m.chave);
    igual(r.de, 'contato', 'quem escreveu');
    igual(r.conversa, de, 'conversa');
    igual(r.telefone, de.split('@')[0], 'telefone');
    igual(r.texto, 'Oi', 'texto recebido');
    igual(r.resultado, 'respondida', 'resultado');
    igual(r.intencao, 'menu', 'assunto');
    igual(r.resposta, ESPERADO.menu, 'resposta enviada');
  });
  await teste('formato real do WAHA GOWS (@lid): nome e telefone vêm de _data.Info', async () => {
    const de = '98765432' + String(1000000 + ++sequenciaConversa) + '@lid';
    const m = await mandar({ de, texto: '2', extra: { to: null, _data: { Info: { Chat: de, Sender: de, SenderAlt: '5518991234567@s.whatsapp.net', RecipientAlt: '', PushName: 'Ana Teste' } } } });
    igual(m.linha.resultado, 'respondida', 'resultado no log');
    const r = await aguardarConversa(m.chave);
    igual(r.nome, 'Ana Teste', 'nome do contato');
    igual(r.telefone, '5518991234567', 'telefone vindo de SenderAlt');
    igual(r.resposta, ESPERADO.valores, 'resposta');
  });
  await teste('dúvidas sem resposta, mensagem da equipe e resposta do robô (eco) ficam como devem', async () => {
    const de = novaConversa();
    await confereResposta({ de, texto: 'xyzzy conversa um', intencao: 'nao_entendi' });
    await confereResposta({ de, texto: 'xyzzy conversa dois', intencao: 'nao_entendi', resposta: ESPERADO.fallback_segundo });
    await confereResposta({ de, texto: 'xyzzy conversa tres', intencao: 'nao_entendi', resposta: ESPERADO.fallback_terceiro });
    const quarta = await confereSilencio({ conversa: de, de, texto: 'xyzzy conversa quatro', resultado: 'silenciada', motivo: 'fallback_esgotado' });
    const r = await aguardarConversa(quarta.chave);
    igual(r.resultado, 'silenciada', 'resultado');
    igual(r.motivo, 'fallback_esgotado', 'motivo do silêncio');
    igual(r.resposta, undefined, 'nada foi enviado');
    verdadeiro(typeof r.ia === 'string', 'a tentativa da IA também aparece');

    const equipe = await mandar({ deMim: true, para: de, texto: 'Oi! Aqui é a equipe.' });
    igual(equipe.linha.resultado + '/' + equipe.linha.motivo, 'robo_pausado/atendente_respondeu', 'log de atividade');
    const daEquipe = await aguardarConversa(equipe.chave);
    igual(daEquipe.de, 'atendente', 'mensagem digitada no celular');
    igual(daEquipe.texto, 'Oi! Aqui é a equipe.', 'texto da equipe');

    const eco = await mandar({ deMim: true, para: de, origem: 'api', texto: ESPERADO.fallback_terceiro });
    igual(eco.linha.motivo, 'enviada_pelo_robo', 'eco da resposta do robô');
    await dormir(1500);
    igual(lerLog('conversas').filter((l) => l.msg === eco.chave).length, 0, 'o eco não duplica a resposta na conversa');
  });
  await teste('painel lê as conversas, a situação do WhatsApp e os erros gravados pelo n8n', async () => {
    const de = novaConversa();
    const m = await confereResposta({ de, texto: 'obrigado!', intencao: 'agradecimento' });
    await aguardarConversa(m.chave);
    const situacao = await painel('/api/situacao');
    igual(situacao.status, 200, 'situação');
    igual(situacao.dados.registros, true, 'painel com acesso aos registros');
    verdadeiro(situacao.dados.dias.includes(situacao.dados.hoje), 'dia de hoje entre os dias com conversas');
    igual(situacao.dados.whatsapp.servicoNoAr, true, 'WAHA (simulado) no ar');
    verdadeiro(typeof situacao.dados.whatsapp.status === 'string', 'último status do WhatsApp vem do log de atividade');
    verdadeiro(fs.existsSync(path.join(DIR_LOGS, 'conversas-' + situacao.dados.hoje + '.log')), 'arquivo do dia com a data do fuso do evento');
    let registros = [];
    let de0 = 0;
    for (let i = 0; i < 20; i += 1) {
      const lido = await painel('/api/conversas?dia=' + situacao.dados.hoje + '&de=' + de0);
      igual(lido.status, 200, 'conversas do dia');
      registros = registros.concat(lido.dados.registros);
      de0 = lido.dados.ate;
      if (lido.dados.fim) break;
    }
    const r = registros.find((x) => x.msg === m.chave);
    verdadeiro(r, 'a mensagem aparece pelo painel');
    igual(r.texto, 'obrigado!', 'texto pelo painel');
    igual(r.resposta, ESPERADO.agradecimento, 'resposta pelo painel');
    const pagina = await painel('/conversas');
    igual(pagina.status, 200, 'página de conversas');
  });

  secao('Erros e privacidade');
  await teste('falha de envio libera a conversa e não avança o fallback sem uma resposta entregue', async () => {
    const de = novaConversa();
    const antes = lerLog('erros').length;
    await controlarMock('fail-next', de, { quantidade: 2 });
    const m = montar({ de, texto: 'xyzzy plugh sem entrega' });
    igual(await postar(m.corpo), 200, 'dúvida aceita antes da falha simulada');
    const linhas = await aguardar('falha transitória depois das duas tentativas de envio', () => {
      const todas = lerLog('erros');
      return todas.length > antes ? todas : null;
    });
    igual(linhas[linhas.length - 1].no, 'WAHA: enviar resposta', 'erro propagado deve apontar para o envio');
    igual(lerLog('chatbot').filter(l => l.msg === m.chave && l.resultado === 'respondida').length, 0, 'envio malsucedido não pode ser registrado como respondido');
    const inicio = Date.now();
    await confereResposta({ de, texto: 'xyzzy plugh nova tentativa', intencao: 'nao_entendi' });
    verdadeiro(Date.now() - inicio < 25000, 'a conversa deve ser liberada sem aguardar a expiração da trava');
    await confereResposta({ de, texto: 'xyzzy plugh segunda entregue', intencao: 'nao_entendi', resposta: ESPERADO.fallback_segundo });
  });
  await teste('falha no envio é registrada no log de erros sem dados pessoais', async () => {
    const de = '5599000500@c.us'; // o WAHA simulado devolve erro 500 para esta conversa
    const antes = lerLog('erros').length;
    const m = montar({ de, texto: '2' });
    igual(await postar(m.corpo), 200, 'webhook aceita');
    const linhas = await aguardar('registro no log de erros', () => {
      const todas = lerLog('erros');
      return todas.length > antes ? todas : null;
    }, 40000);
    const linha = linhas[linhas.length - 1];
    igual(linha.no, 'WAHA: enviar resposta', 'nó que falhou');
    verdadeiro(typeof linha.erro === 'string' && linha.erro.length > 0, 'mensagem de erro presente');
    verdadeiro(!JSON.stringify(linha).includes('5599000500'), 'o telefone não pode aparecer no log de erros');
    igual(lerLog('chatbot').filter((l) => l.msg === m.chave && l.resultado === 'respondida').length, 0, 'não pode constar como respondida');
    const conversa = await aguardarConversa(m.chave);
    igual(conversa.resultado, 'falha_no_envio', 'a conversa mostra a resposta como não entregue');
    igual(conversa.resposta, ESPERADO.valores, 'com o texto que deveria ter sido enviado');
    const erros = await painel('/api/erros');
    verdadeiro(erros.dados.erros.some((e) => e.quando === linha.quando && e.no === 'WAHA: enviar resposta'), 'o painel lista o erro');
  });
  await teste('40 eventos simultâneos: todos tratados e nenhuma linha de log perdida', async () => {
    const marca = 'RAJADA_' + Date.now() + '_';
    const total = 40;
    const status = await Promise.all(
      Array.from({ length: total }, (_, i) => postar({ event: 'session.status', session: 'default', payload: { status: marca + i } })),
    );
    igual(status.filter((s) => s === 200).length, total, 'eventos aceitos pelo webhook');
    const contar = () => new Set(lerLog('chatbot').map((l) => l.detalhe).filter((d) => String(d).startsWith(marca))).size;
    await aguardar('as ' + total + ' linhas no log', () => contar() === total, 40000).catch(() => {});
    igual(contar(), total, 'linhas distintas gravadas no log');
  });
  // ---------- vários eventos (configuração v2) ----------
  // O n8n lê o arquivo a cada mensagem: troca o arquivo de configuração dos testes por uma
  // versão v2 (dois eventos ativos) e devolve o original no fim, mesmo se algo falhar.
  secao('Vários eventos (formato v2)');
  const arquivoCfg = path.join(__dirname, 'config', 'chatbot.json');
  const original = fs.readFileSync(arquivoCfg, 'utf8');
  const evento = (id, nome, gatilho, status = 'ativo') => ({
    id, status, gatilhos: [gatilho],
    evento: { nome, data: '20/12', local: 'Local do ' + nome },
    mensagens: { menu: 'Menu do ' + nome + '\n\n{{opcoes}}' },
    opcoes: cfg.opcoes,
  });
  const v2 = (eventos) => ({
    versao: 2,
    produtora: { nome: 'Produtora de Teste', instagram: cfg.evento.instagram },
    mensagens: { reativado: cfg.mensagens.reativado, sem_eventos: 'Sem eventos agora. Veja {{instagram}}' },
    saudacoes: cfg.saudacoes,
    atendimento_humano: cfg.atendimento_humano,
    protecoes: cfg.protecoes,
    fallback: cfg.fallback,
    ia: { ...cfg.ia, ativa: false, conhecimento: undefined },
    eventos,
  });
  const usarConfig = async (novo) => {
    fs.writeFileSync(arquivoCfg, JSON.stringify(novo, null, 2));
    await dormir(500);
  };
  const ultimaResposta = async (conversa) => { const e = await enviosPara(conversa); return e[e.length - 1].corpo.text; };
  try {
    await usarConfig(v2([evento('alfa-teste', 'Evento Alfa', 'alfa'), evento('beta-teste', 'Evento Beta', 'beta')]));
    await teste('v2: contato novo recebe o menu de eventos e escolhe pelo número', async () => {
      const de = novaConversa();
      let m = await mandar({ de, texto: 'oi' });
      igual(m.linha.intencao, 'escolher_evento', 'intenção do menu de eventos');
      const lista = await ultimaResposta(de);
      verdadeiro(lista.includes('1 - Evento Alfa (20/12)') && lista.includes('2 - Evento Beta (20/12)'), 'menu deve listar os dois eventos');
      m = await mandar({ de, texto: '2' });
      igual(m.linha.intencao, 'menu', 'intenção depois da escolha');
      verdadeiro((await ultimaResposta(de)).startsWith('Menu do Evento Beta'), 'deve mostrar o menu do evento escolhido');
      m = await mandar({ de, texto: '3' });
      igual(m.linha.intencao, 'local', 'opção do evento escolhido');
      verdadeiro((await ultimaResposta(de)).includes('Local do Evento Beta'), 'a resposta deve usar os dados do evento escolhido');
    });
    await teste('v2: gatilho escolhe o evento e a escolha é lembrada nas mensagens seguintes', async () => {
      const de = novaConversa();
      let m = await mandar({ de, texto: 'quero saber do alfa' });
      igual(m.linha.intencao, 'menu', 'intenção do menu do evento');
      verdadeiro((await ultimaResposta(de)).startsWith('Menu do Evento Alfa'), 'deve mostrar o menu do evento do gatilho');
      m = await mandar({ de, texto: '3' });
      verdadeiro((await ultimaResposta(de)).includes('Local do Evento Alfa'), 'o evento escolhido deve ser lembrado');
      m = await mandar({ de, texto: 'trocar evento' });
      igual(m.linha.intencao, 'escolher_evento', 'comando de troca de evento');
    });
    await usarConfig(v2([evento('alfa-teste', 'Evento Alfa', 'alfa', 'encerrado'), evento('beta-teste', 'Evento Beta', 'beta', 'rascunho')]));
    await teste('v2: sem evento ativo o robô responde a mensagem da produtora', async () => {
      const de = novaConversa();
      const m = await mandar({ de, texto: 'oi' });
      igual(m.linha.intencao, 'sem_eventos', 'intenção sem eventos');
      igual(await ultimaResposta(de), 'Sem eventos agora. Veja ' + cfg.evento.instagram, 'texto sem_eventos');
    });
  } finally {
    fs.writeFileSync(arquivoCfg, original);
    await dormir(500);
  }

  await teste('logs de atividade e de erros não contêm telefones completos nem o texto das mensagens', async () => {
    let bruto = '';
    for (const arquivo of fs.readdirSync(DIR_LOGS)) {
      // As conversas (com texto, retenção curta) ficam num arquivo à parte, conferido abaixo.
      if (arquivo.endsWith('.log') && !arquivo.startsWith('conversas-')) bruto += fs.readFileSync(path.join(DIR_LOGS, arquivo), 'utf8');
    }
    verdadeiro(bruto.length > 0, 'deveria haver logs');
    verdadeiro(!/5599\d{4,}/.test(bruto), 'telefone completo encontrado nos logs');
    verdadeiro(!/\d{9,}@/.test(bruto), 'identificador de conversa encontrado nos logs');
    for (const trecho of ['xyzzy', 'quanto custa', 'atendente.', 'Meus Ingressos', 'ia responde', 'Resposta de teste da IA', 'zzq1']) {
      verdadeiro(!bruto.includes(trecho), 'texto de mensagem encontrado nos logs: ' + trecho);
    }
    verdadeiro(lerLog('chatbot').every((l) => !l.invalida), 'todas as linhas do log devem ser JSON válido');
  });
  await teste('texto das mensagens fica só no arquivo de conversas, sem linhas inválidas', async () => {
    const conversas = lerLog('conversas');
    verdadeiro(conversas.length > 50, 'deveria haver muitas conversas registradas');
    igual(conversas.filter((l) => l.invalida).length, 0, 'linhas inválidas no arquivo de conversas');
    verdadeiro(conversas.some((l) => String(l.texto).includes('xyzzy')), 'texto recebido registrado');
    verdadeiro(conversas.every((l) => l.de === 'contato' || l.de === 'atendente'), 'só mensagens de contatos e da equipe');
    igual(conversas.filter((l) => /@g\.us|@newsletter|@broadcast/.test(String(l.conversa))).length, 0, 'grupos, canais e status não entram');
  });
  await teste('pedidos à IA levaram a chave própria e nenhum identificador de contato', async () => {
    const todos = await pedidosIA();
    verdadeiro(todos.length > 20, 'deveria haver vários pedidos à IA registrados');
    igual(todos.filter((p) => !p.chaveOk).length, 0, 'pedidos sem a chave da IA');
    const bruto = JSON.stringify(todos.map((p) => p.corpo));
    verdadeiro(!/5599\d{4,}/.test(bruto), 'telefone encontrado em pedido à IA');
    verdadeiro(!/@c\.us|@lid|@s\.whatsapp\.net/.test(bruto), 'identificador de conversa encontrado em pedido à IA');
    verdadeiro(todos.every((p) => p.corpo.messages.length === 2), 'cada pedido leva só as instruções e uma mensagem (sem histórico)');
  });
  await teste('todas as chamadas ao WAHA levaram a chave da API correta', async () => {
    const todas = await chamadas();
    verdadeiro(todas.length > 50, 'deveria haver muitas chamadas registradas');
    igual(todas.filter((c) => !c.chaveOk).length, 0, 'chamadas sem a chave correta');
  });

  // ---------- resumo ----------
  const falhas = resultados.filter((r) => !r.ok);
  console.log('\n' + '-'.repeat(60));
  console.log('Total: ' + resultados.length + '   Passaram: ' + (resultados.length - falhas.length) + '   Falharam: ' + falhas.length);
  if (falhas.length) {
    console.log('Falhas:');
    for (const f of falhas) console.log('  - ' + f.nome);
  }
  console.log('RESULTADO: ' + (falhas.length ? 'FALHOU' : 'TODOS OS TESTES PASSARAM'));
  process.exit(falhas.length ? 1 : 0);
}

principal().catch((e) => {
  console.error('Erro inesperado no executor de testes: ' + (e && e.stack ? e.stack : e));
  process.exit(2);
});
