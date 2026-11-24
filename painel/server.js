'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { validarConfig } = require('../lib/configuracao');
const Eventos = require('../lib/eventos');
const IA = require('../lib/ia');
const { criarRegistros, somarDias } = require('./registros');
const { criarAutenticacao } = require('./autenticacao');
const { criarWhatsApp } = require('./whatsapp');
const { criarRepositorioDeUrl } = require('./db/repositorio');
const { criarIngestor } = require('./ingestor');
const { criarServicoUsuarios } = require('./usuarios');

const LIMITE_CORPO = 1024 * 1024;
// O simulador usa a mesma cota gratuita do atendimento real: no máximo isto por hora.
const LIMITE_IA_SIMULADOR = 30;
const SESSAO = /^[a-zA-Z0-9_-]{1,54}$/;
const filas = new Map();
const LIMITE_CORPO_LOGIN = 4 * 1024;
const ROTA_WHATSAPP = /^\/api\/whatsapp\/([^/]+)\/(iniciar|parar|desconectar|qr)$/;
// Rotas liberadas sem sessão (método e caminho exatos). Todo o resto exige login quando ele é obrigatório.
const ROTAS_PUBLICAS = new Set(['GET /api/health', 'POST /api/login', 'GET /api/sessao', 'GET /login', 'GET /login.js', 'GET /style.css']);
const arquivos = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'application/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/conversas', ['conversas.html', 'text/html; charset=utf-8']],
  ['/conversas.js', ['conversas.js', 'application/javascript; charset=utf-8']],
  ['/login', ['login.html', 'text/html; charset=utf-8']],
  ['/login.js', ['login.js', 'application/javascript; charset=utf-8']],
  ['/whatsapp', ['whatsapp.html', 'text/html; charset=utf-8']],
  ['/whatsapp.js', ['whatsapp.js', 'application/javascript; charset=utf-8']],
  ['/metricas', ['metricas.html', 'text/html; charset=utf-8']],
  ['/metricas.js', ['metricas.js', 'application/javascript; charset=utf-8']],
  ['/usuarios', ['usuarios.html', 'text/html; charset=utf-8']],
  ['/usuarios.js', ['usuarios.js', 'application/javascript; charset=utf-8']]
]);
// Conversas antigas são apagadas a cada hora (além de a cada "docker compose up -d").
const INTERVALO_LIMPEZA_MS = 3600 * 1000;
const PAPEL_ADMIN = ['admin'];
const PAPEL_EDITOR = ['admin', 'editor'];
// Quem pode chamar cada rota que muda algo (ou exige mais que leitura). Rota que não está aqui
// só exige estar logado (qualquer papel). Resposta 403 para os demais.
const PAPEIS_POR_ROTA = [
  ['PUT', /^\/api\/config$/, PAPEL_EDITOR],
  ['POST', /^\/api\/config\/versoes\/[^/]+\/restaurar$/, PAPEL_EDITOR],
  ['POST', /^\/api\/whatsapp\/[^/]+\/desconectar$/, PAPEL_ADMIN],
  ['POST', /^\/api\/whatsapp\/[^/]+\/(iniciar|parar)$/, PAPEL_EDITOR],
  ['GET', /^\/api\/whatsapp\/[^/]+\/qr$/, PAPEL_EDITOR],
  [null, /^\/api\/usuarios(\/|$)/, PAPEL_ADMIN]
];
function papeisDaRota(metodo, rota) {
  const regra = PAPEIS_POR_ROTA.find(([m, padrao]) => (m === null || m === metodo) && padrao.test(rota));
  return regra ? regra[2] : null;
}
const HISTORICO_POR_PAGINA = 50;
const MAXIMO_DIAS_METRICAS = 366;
const FORMATO_DIA = /^\d{4}-\d{2}-\d{2}$/;
const INTERVALO_INGESTAO_MS = 5000;
const objeto = valor => valor !== null && typeof valor === 'object' && !Array.isArray(valor);
const revisao = conteudo => crypto.createHash('sha256').update(conteudo).digest('hex');

function erroHttp(status, mensagem, detalhes) {
  const erro = new Error(mensagem);
  erro.status = status;
  erro.detalhes = detalhes;
  return erro;
}

function responder(res, status, dados) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(dados));
}

async function lerConfig(configPath) {
  const conteudo = await fs.readFile(configPath, 'utf8');
  let config;
  try { config = JSON.parse(conteudo.replace(/^\uFEFF/, '')); }
  catch { throw erroHttp(500, 'O arquivo de configuração contém JSON inválido. Corrija o arquivo e recarregue o painel.'); }
  return { config, revisao: revisao(conteudo), avisos: validarConfig(config).avisos, conteudo };
}

async function lerCorpo(req, limite = LIMITE_CORPO) {
  const textoLimite = limite === LIMITE_CORPO ? 'o limite de 1 MB' : 'o limite permitido';
  if (!/^application\/json(?:\s*;|\s*$)/i.test(req.headers['content-type'] || '')) throw erroHttp(415, 'Envie o conteúdo como application/json.');
  if (Number(req.headers['content-length']) > limite) { req.resume(); throw erroHttp(413, 'O conteúdo excede ' + textoLimite + '.'); }
  const partes = [];
  let tamanho = 0;
  for await (const parte of req) {
    tamanho += parte.length;
    if (tamanho > limite) { req.resume(); throw erroHttp(413, 'O conteúdo excede ' + textoLimite + '.'); }
    partes.push(parte);
  }
  try { return JSON.parse(Buffer.concat(partes).toString('utf8')); }
  catch { throw erroHttp(400, 'O conteúdo enviado não é um JSON válido.'); }
}

function conferirOrigem(req, server, host, publicPort, dominio) {
  const cabecalho = req.headers.host;
  let destino;
  try { destino = new URL('http://' + cabecalho); } catch { throw erroHttp(403, 'Acesso permitido somente pelo endereço local do painel.'); }
  // Domínio público (atrás do Caddy): host igual ao domínio, porta 443 ou ausente, origem https.
  if (dominio && cabecalho && [dominio, dominio + ':443'].includes(cabecalho.toLowerCase())) {
    const origemDominio = req.headers.origin;
    if (origemDominio && origemDominio !== 'https://' + dominio) throw erroHttp(403, 'A origem da solicitação não é permitida.');
    if (req.headers['sec-fetch-site'] === 'cross-site') throw erroHttp(403, 'A origem da solicitação não é permitida.');
    return;
  }
  const enderecos = new Set(['localhost', '127.0.0.1', '[::1]']);
  if (host && !['0.0.0.0', '::'].includes(host)) enderecos.add(host === '::1' ? '[::1]' : host.toLowerCase());
  const portas = new Set([server.address()?.port, publicPort].filter(Boolean));
  if (!cabecalho || destino.username || destino.password || destino.pathname !== '/' || destino.search || destino.hash || !enderecos.has(destino.hostname.toLowerCase()) || !portas.has(Number(destino.port || 80))) throw erroHttp(403, 'Acesso permitido somente pelo endereço local do painel.');
  const origem = req.headers.origin;
  if (origem && origem !== destino.origin) throw erroHttp(403, 'A origem da solicitação não é permitida.');
  if (req.headers['sec-fetch-site'] === 'cross-site') throw erroHttp(403, 'A origem da solicitação não é permitida.');
}

async function gravarArquivo(destino, conteudo) {
  const temporario = path.join(path.dirname(destino), '.' + path.basename(destino) + '.' + crypto.randomBytes(12).toString('hex') + '.tmp');
  let arquivo;
  try {
    arquivo = await fs.open(temporario, 'wx', 0o600);
    await arquivo.writeFile(conteudo, 'utf8');
    await arquivo.sync();
    await arquivo.close();
    arquivo = null;
    await fs.rename(temporario, destino);
  } finally {
    if (arquivo) await arquivo.close().catch(() => {});
    await fs.unlink(temporario).catch(() => {});
  }
}

function serializar(configPath, tarefa) {
  const anterior = filas.get(configPath) || Promise.resolve();
  const atual = anterior.catch(() => {}).then(tarefa);
  filas.set(configPath, atual);
  atual.finally(() => { if (filas.get(configPath) === atual) filas.delete(configPath); }).catch(() => {});
  return atual;
}

// Origens que o motor devolve quando reconhece um texto livre (e não um atalho).
const ORIGENS_TEXTO_LIVRE = ['palavra_chave', 'pergunta', 'aproximacao'];
const MEMORIA_PADRAO = 6;
const MAX_HISTORICO_SIMULADOR = 40;
const MAX_TEXTO_HISTORICO = 300;

// Histórico mandado pelo navegador: só turnos válidos, os últimos N e com texto curto.
function historicoDoSimulador(bruto, limite) {
  if (!Array.isArray(bruto) || limite <= 0) return [];
  return bruto
    .filter((item) => objeto(item) && ['contato', 'bot'].includes(item.de) && typeof item.texto === 'string' && item.texto.trim())
    .map((item) => ({ de: item.de, texto: item.texto.trim().slice(0, MAX_TEXTO_HISTORICO) }))
    .slice(-limite);
}

// Valor efetivo da conversa natural: o simulador (quando informado) vence o evento, que vence a raiz.
function conversaNaturalEfetiva(dados, saida, configUsada) {
  if (typeof dados.conversaNatural === 'boolean') return dados.conversaNatural;
  const id = dados.eventoId || saida.estado?.evento;
  const evento = Array.isArray(dados.config?.eventos) ? dados.config.eventos.find((e) => objeto(e) && e.id === id) : null;
  if (typeof evento?.ia?.conversa_natural === 'boolean') return evento.ia.conversa_natural;
  return configUsada?.ia?.conversa_natural === true;
}

function partesDaResposta(lida, maximo) {
  if (Array.isArray(lida.partes) && lida.partes.length) return lida.partes.map(String);
  if (typeof IA.dividirMensagens === 'function') {
    const partes = IA.dividirMensagens(lida.texto, maximo);
    if (Array.isArray(partes) && partes.length) return partes;
  }
  return [lida.texto];
}

// Resolve como o workflow: motor de regras e, se ele não entender, a IA (quando houver
// chave e a IA estiver ligada), respeitando o limite por contato informado pelo navegador.
// Com a conversa natural: atalhos continuam prontos; texto livre reconhecido é reescrito pela IA
// (modo "redigir", com a resposta pronta como reserva) e o não reconhecido usa o modo "responder".
async function simularConversa(dados, { chaveIA, fetchIA, usosRecentes }) {
  const bruta = Eventos.resolver(dados.config, dados.texto, dados.estado || {}, { midia: dados.midia, incluirRascunhos: dados.incluirRascunhos === true, eventoId: dados.eventoId || undefined, sessao: dados.sessao || undefined });
  const { config: configUsada, ...saida } = bruta; // a configuração achatada fica no servidor
  const usos = Number.isInteger(dados.usosIA) && dados.usosIA >= 0 ? dados.usosIA : 0;
  const natural = conversaNaturalEfetiva(dados, saida, configUsada);
  const conf = IA.configuracao(configUsada);
  const opcao = natural && ORIGENS_TEXTO_LIVRE.includes(saida.origem) && !saida.transferir && !saida.silenciar && Array.isArray(configUsada?.opcoes)
    ? configUsada.opcoes.find((o) => o && o.id === saida.intencao) : null;
  const redigir = Boolean(opcao) && !dados.midia && conf.ativa === true && String(dados.texto || '').trim() !== '';
  if (!redigir && !IA.deveConsultar(configUsada, saida, dados.texto)) return { ...saida, usosIA: usos };
  const informar = (resultado, extra = {}) => ({ ...saida, usosIA: usos, ia: { resultado, ...extra, ...(redigir ? { reservaPronta: true } : {}) } });
  if (!chaveIA) return informar('sem_chave');
  if (conf.maxUsosPorContato > 0 && usos >= conf.maxUsosPorContato) return informar('limite_por_contato');
  // Travas sem IA (frente A): mensagem barrada não chama a IA e recebe a resposta pronta.
  if (typeof IA.filtrarEntrada === 'function') {
    const filtro = IA.filtrarEntrada(dados.texto);
    if (filtro && filtro.ok === false) return { ...informar('bloqueada', { trava: 'entrada', motivo: filtro.motivo }), memorizar: false };
  }
  const agora = Date.now();
  while (usosRecentes.length && agora - usosRecentes[0] > 3600 * 1000) usosRecentes.shift();
  if (usosRecentes.length >= LIMITE_IA_SIMULADOR) return informar('limite_do_simulador');
  usosRecentes.push(agora);
  const contexto = {
    chave: chaveIA, fetch: fetchIA, fuso: process.env.TZ,
    ultimaIntencao: typeof dados.estado?.ultimaIntencao === 'string' ? dados.estado.ultimaIntencao : '',
  };
  if (natural) {
    const memoria = Number.isInteger(conf.memoriaMensagens) ? conf.memoriaMensagens : MEMORIA_PADRAO;
    Object.assign(contexto, { modo: redigir ? 'redigir' : 'responder', historico: historicoDoSimulador(dados.historico, memoria) });
    if (redigir) contexto.opcao = opcao;
    if (typeof dados.nomeContato === 'string' && dados.nomeContato.trim()) contexto.nomeContato = dados.nomeContato.trim().split(/\s+/)[0].slice(0, 40);
  }
  const lida = await IA.consultar(configUsada, dados.texto, contexto);
  if (!lida.ok) {
    const trava = typeof lida.trava === 'string' ? { trava: lida.trava } : {};
    return { ...informar(lida.motivo, trava), usosIA: usos + 1, ...(lida.trava ? { memorizar: false } : {}) };
  }
  const partes = natural ? partesDaResposta(lida, conf.maxMensagens || 3) : [lida.texto];
  const resposta = partes.join('\n\n');
  if (redigir) return { ...saida, origem: 'ia_redigida', resposta, partes, usosIA: usos + 1, ia: { resultado: 'respondeu', modo: 'redigir' } };
  const estado = { falhas: 0, ultimaIntencao: 'ia', ultimaResposta: IA.assinatura(lida.texto), pendentes: [], evento: saida.estado?.evento, escolhendoEvento: saida.estado?.escolhendoEvento };
  return { intencao: 'ia', origem: 'ia', resposta, ...(natural ? { partes } : {}), transferir: false, estado, usosIA: usos + 1, ia: { resultado: 'respondeu', ...(natural ? { modo: 'responder' } : {}) } };
}

// Situação do serviço do WhatsApp (WAHA): só a rota pública /ping, sem chave da API.
function verificadorDoWaha(wahaUrl, fetchWaha = globalThis.fetch) {
  let ultimo = { momento: 0, valor: null };
  return async () => {
    if (!wahaUrl) return null;
    if (Date.now() - ultimo.momento < 4000) return ultimo.valor;
    let valor;
    try {
      const resposta = await fetchWaha(String(wahaUrl).replace(/\/+$/, '') + '/ping', { signal: AbortSignal.timeout(2500) });
      valor = resposta.ok;
    } catch {
      valor = false;
    }
    ultimo = { momento: Date.now(), valor };
    return valor;
  };
}

// Situação do n8n: GET /healthz (rota pública do n8n, sem credenciais).
function verificadorN8n(n8nUrl, fetchN8n = globalThis.fetch) {
  return async () => {
    if (!n8nUrl) return false;
    try {
      const resposta = await fetchN8n(String(n8nUrl).replace(/\/+$/, '') + '/healthz', { signal: AbortSignal.timeout(2500) });
      return resposta.ok;
    } catch {
      return false;
    }
  };
}

function criarServidor({ configPath = path.join(__dirname, '../config/chatbot.json'), host = '127.0.0.1', publicPort, chaveIA = process.env.IA_API_KEY, fetchIA, logsDir = process.env.CHATBOT_LOGS, retencaoConversasDias = process.env.CONVERSAS_RETENCAO_DIAS, wahaUrl = process.env.WAHA_URL, fetchWaha, agora, usuario = process.env.PAINEL_USUARIO || 'admin', senhaHash = process.env.PAINEL_SENHA_HASH, dominio = process.env.PAINEL_DOMINIO, confiarProxy = process.env.PAINEL_CONFIAR_PROXY === 'true', wahaChave = process.env.WAHA_API_KEY, n8nUrl = process.env.N8N_URL, fetchN8n, agoraMs, atrasar, databaseUrl = process.env.DATABASE_URL, repositorio, criarPool, historicoRetencaoDias = process.env.HISTORICO_RETENCAO_DIAS, intervaloIngestaoMs = INTERVALO_INGESTAO_MS, intervaloBancoMs = 5000 } = {}) {
  chaveIA = String(chaveIA ?? '').trim();
  // Banco: injetado (testes) ou criado a partir de DATABASE_URL. Sem nenhum dos dois, o painel
  // funciona como antes (arquivos + login do .env). O pool só é criado quando o servidor começa a ouvir.
  const repo = repositorio || (databaseUrl ? criarRepositorioDeUrl(String(databaseUrl), { criarPool, intervaloMs: intervaloBancoMs }) : null);
  const retencaoMensagensDias = Math.min(Math.max(Math.floor(Number(historicoRetencaoDias)) || 180, 1), 3650);
  const retencaoRegistrosDias = 90;
  let bancoPronto = false; // migrações e inicialização concluídas
  const bancoNoAr = () => Boolean(repo) && bancoPronto && repo.disponivel();
  // Lança erro se houver domínio sem hash de senha (o painel não sobe aberto na internet sem login).
  const auth = criarAutenticacao({ usuario, senhaHash, dominio, agora: agoraMs, atrasar, repositorio: repo });
  const servicoUsuarios = repo ? criarServicoUsuarios({ repositorio: repo }) : null;
  const whatsapp = criarWhatsApp({ wahaUrl, chave: String(wahaChave ?? '').trim(), fetch: fetchWaha });
  // IP do cliente: X-Forwarded-For (último valor, o que o Caddy acrescentou) só com PAINEL_CONFIAR_PROXY=true.
  const ipDe = (req) => {
    if (confiarProxy) {
      const ultimo = String(req.headers['x-forwarded-for'] || '').split(',').pop().trim();
      if (ultimo && /^[0-9a-fA-F:.]{2,45}$/.test(ultimo)) return ultimo;
    }
    return req.socket.remoteAddress || 'desconhecido';
  };
  const conexaoSegura = (req) => Boolean(auth.dominio) || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() === 'https';
  const usosRecentes = [];
  const registros = criarRegistros({ pasta: logsDir, retencaoDias: retencaoConversasDias, agora });
  const wahaNoAr = verificadorDoWaha(wahaUrl, fetchWaha);
  const verificarN8n = verificadorN8n(n8nUrl, fetchN8n || fetchWaha);
  // Falhas de leitura dos logs viram uma mensagem própria (e não a do arquivo de configuração).
  const lerRegistros = (tarefa) => tarefa().catch((erro) => {
    if (erro.status) throw erro;
    throw erroHttp(500, 'Não foi possível ler os registros do robô. Confira se o volume de logs está disponível.');
  });
  configPath = path.resolve(configPath);
  const ingestor = repo && registros.disponivel ? criarIngestor({ pasta: logsDir, repositorio: repo, intervaloMs: intervaloIngestaoMs }) : null;

  // Respostas 503 padronizadas para o que depende do banco.
  const exigirBanco = () => {
    if (!bancoNoAr()) {
      const erro = erroHttp(503, 'O banco de dados está indisponível no momento.', { bancoIndisponivel: true });
      throw erro;
    }
  };
  const diaValido = (dia) => {
    if (typeof dia !== 'string' || !FORMATO_DIA.test(dia)) return false;
    const [ano, mes, numero] = dia.split('-').map(Number);
    const data = new Date(Date.UTC(ano, mes - 1, numero));
    return data.getUTCFullYear() === ano && data.getUTCMonth() === mes - 1 && data.getUTCDate() === numero;
  };
  const intervaloDe = (parametros, padraoDias) => {
    let de = parametros.get('de') || '';
    let ate = parametros.get('ate') || '';
    if (padraoDias) {
      if (!ate) ate = registros.hoje();
      if (!de) de = somarDias(ate, -(padraoDias - 1));
    }
    if ((de && !diaValido(de)) || (ate && !diaValido(ate))) throw erroHttp(400, 'Informe as datas no formato AAAA-MM-DD.');
    if (de && ate && de > ate) throw erroHttp(400, 'A data inicial não pode ser maior que a final.');
    if (de && ate && (Date.parse(ate) - Date.parse(de)) / 86400000 >= MAXIMO_DIAS_METRICAS) throw erroHttp(400, 'O período pode ter no máximo ' + MAXIMO_DIAS_METRICAS + ' dias.');
    const [aa, am, ad] = (ate || '1970-01-01').split('-').map(Number);
    const [da, dm, dd] = (de || '1970-01-01').split('-').map(Number);
    return {
      de, ate,
      inicio: de ? new Date(da, dm - 1, dd) : null,
      fim: ate ? new Date(aa, am - 1, ad + 1) : null
    };
  };
  const fusoDoBanco = (() => {
    const candidato = process.env.TZ || 'America/Sao_Paulo';
    try { new Intl.DateTimeFormat('en-US', { timeZone: candidato }); return candidato; } catch { return 'UTC'; }
  })();

  // Grava a configuração (arquivo é a fonte da verdade, como sempre) e depois registra a versão
  // no banco. Falha do banco não desfaz o arquivo: devolve um aviso.
  async function salvarConfig({ config: nova, revisaoEsperada, autor, comentario }) {
    const validacao = validarConfig(nova);
    if (validacao.erros.length) throw erroHttp(422, 'Revise os campos indicados antes de salvar.', validacao);
    const salvo = await serializar(configPath, async () => {
      const anterior = await lerConfig(configPath);
      if (anterior.revisao !== revisaoEsperada) throw erroHttp(409, 'A configuração foi alterada em outra janela. Recarregue os dados antes de salvar novamente.');
      const conteudo = JSON.stringify(nova, null, 2) + '\n';
      await gravarArquivo(configPath + '.bak', anterior.conteudo);
      await gravarArquivo(configPath, conteudo);
      return { config: nova, revisao: revisao(conteudo), avisos: validacao.avisos };
    });
    if (repo) {
      try {
        exigirBanco();
        salvo.versao = await repo.config.inserirVersao({ autor, conteudo: nova, revisao: salvo.revisao, comentario: comentario || null });
      } catch (erro) {
        salvo.avisoVersao = 'A configuração foi salva, mas não foi possível registrar a versão no histórico (banco indisponível).';
        if (!erro.bancoIndisponivel && !erro.status) console.error('Falha ao registrar a versão da configuração: ' + erro.message);
      }
    }
    return salvo;
  }

  // Ao conectar (e a cada reconexão): cria o admin inicial e importa a configuração atual como versão 1.
  async function inicializarBanco() {
    if (auth.obrigatorio) {
      const criado = await servicoUsuarios.garantirAdminInicial({ usuario: auth.usuario, senhaHash });
      if (criado) console.log('Usuário administrador "' + auth.usuario + '" criado no banco a partir de PAINEL_SENHA_HASH.');
    }
    if ((await repo.config.contarVersoes()) === 0) {
      try {
        const { config: atual, conteudo } = await lerConfig(configPath);
        await repo.config.inserirVersao({ autor: 'importação', conteudo: atual, revisao: revisao(conteudo), comentario: null });
      } catch (erro) {
        if (erro.bancoIndisponivel) throw erro;
        console.error('Não foi possível importar a configuração atual como versão 1.');
      }
    }
    bancoPronto = true;
  }

  const limparBanco = async () => {
    if (!bancoNoAr()) return;
    try {
      await auth.limparSessoesDoBanco();
      const r = await repo.retencao.limpar({ mensagensDias: retencaoMensagensDias, registrosDias: retencaoRegistrosDias });
      if (ingestor) await ingestor.esquecerAntigos(30);
      if (r.mensagens || r.registros || r.erros) console.log('Histórico antigo apagado do banco: ' + r.mensagens + ' mensagens, ' + r.registros + ' registros, ' + r.erros + ' erros.');
    } catch (erro) {
      if (!erro.bancoIndisponivel) console.error('Não foi possível limpar o histórico antigo do banco.');
    }
  };
  if (publicPort !== undefined && (!Number.isInteger(Number(publicPort)) || Number(publicPort) < 1 || Number(publicPort) > 65535)) throw new Error('PAINEL_PUBLIC_PORT precisa ser uma porta entre 1 e 65535.');
  publicPort = publicPort === undefined ? undefined : Number(publicPort);
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      conferirOrigem(req, server, host, publicPort, auth.dominio);
      const rota = new URL(req.url, 'http://localhost').pathname;
      const sessao = auth.obrigatorio ? await auth.sessaoDe(req.headers.cookie) : null;
      if (auth.obrigatorio && !sessao && !ROTAS_PUBLICAS.has(req.method + ' ' + rota)) {
        if (rota.startsWith('/api/')) return responder(res, 401, { erro: 'Faça login para continuar.', loginNecessario: true });
        res.writeHead(302, { Location: '/login' });
        return res.end();
      }
      // Sem login obrigatório (uso local) todos podem tudo, exceto gerenciar usuários.
      const papel = sessao ? sessao.papel : (auth.obrigatorio ? null : 'admin');
      if (papel) {
        const permitidos = papeisDaRota(req.method, rota);
        if (permitidos && !permitidos.includes(papel)) throw erroHttp(403, 'Seu perfil não tem permissão para esta ação.');
        if (!auth.obrigatorio && /^\/api\/usuarios(\/|$)/.test(rota)) throw erroHttp(403, 'Ative o login (PAINEL_SENHA_HASH) para gerenciar usuários.');
      }
      if (req.method === 'GET' && rota === '/api/health') return responder(res, 200, { ok: true });
      if (req.method === 'GET' && rota === '/api/sessao') return responder(res, 200, { logado: Boolean(sessao), usuario: sessao ? sessao.usuario : null, papel, loginObrigatorio: auth.obrigatorio });
      if (req.method === 'POST' && rota === '/api/login') {
        if (!auth.obrigatorio) throw erroHttp(400, 'O login não está ativado neste painel.');
        const dados = await lerCorpo(req, LIMITE_CORPO_LOGIN);
        if (!objeto(dados) || typeof dados.usuario !== 'string' || typeof dados.senha !== 'string' || dados.usuario.length > 200 || dados.senha.length > 200) throw erroHttp(400, 'Informe usuário e senha.');
        const resultado = await auth.entrar({ usuario: dados.usuario, senha: dados.senha, ip: ipDe(req) });
        if (resultado.status === 429) {
          res.setHeader('Retry-After', String(resultado.esperarSegundos));
          return responder(res, 429, { erro: 'Muitas tentativas. Tente novamente em ' + Math.ceil(resultado.esperarSegundos / 60) + ' minuto(s).', esperarSegundos: resultado.esperarSegundos });
        }
        if (resultado.status === 503) throw erroHttp(503, 'O banco de dados ficou indisponível durante o login. Tente de novo em instantes.', { bancoIndisponivel: true });
        if (!resultado.ok) throw erroHttp(401, 'Usuário ou senha incorretos.');
        res.setHeader('Set-Cookie', auth.cookie(resultado.token, { seguro: conexaoSegura(req) }));
        return responder(res, 200, { ok: true, usuario: resultado.usuario });
      }
      if (req.method === 'POST' && rota === '/api/logout') {
        await auth.sair(req.headers.cookie);
        res.setHeader('Set-Cookie', auth.cookie('', { seguro: conexaoSegura(req), apagar: true }));
        return responder(res, 200, { ok: true });
      }
      if (req.method === 'GET' && rota === '/api/servidor') {
        const pastaDisco = logsDir || process.cwd();
        const [noAr, n8nNoAr, disco] = await Promise.all([wahaNoAr(), verificarN8n(), fs.statfs(pastaDisco).catch(() => null)]);
        return responder(res, 200, {
          whatsapp: noAr === true,
          n8n: n8nNoAr,
          memoria: { totalMB: Math.round(os.totalmem() / 1048576), livreMB: Math.round(os.freemem() / 1048576) },
          disco: disco ? { totalGB: Math.round(disco.blocks * disco.bsize / 1073741824 * 10) / 10, livreGB: Math.round(disco.bavail * disco.bsize / 1073741824 * 10) / 10 } : null,
          ligadoHa: Math.round(os.uptime()),
          banco: bancoNoAr(),
          bancoConfigurado: Boolean(repo),
          atrasoIngestaoSegundos: ingestor ? ingestor.atrasoSegundos() : null
        });
      }
      if (rota === '/api/whatsapp' && req.method === 'GET') {
        const sessoesWaha = await whatsapp.listar();
        const { config: cfg } = await lerConfig(configPath);
        const cadastrados = Array.isArray(cfg.numeros) ? cfg.numeros : [];
        const lista = cadastrados.filter((n) => objeto(n) && typeof n.sessao === 'string').map((n) => {
          const s = sessoesWaha.find((w) => w.nome === n.sessao);
          return { nome: n.sessao, nomeAmigavel: typeof n.nome === 'string' && n.nome.trim() ? n.nome : n.sessao, status: s ? s.status : null, telefone: s ? s.telefone : '', nomePerfil: s ? s.nomePerfil : '', cadastrado: true, noWaha: Boolean(s) };
        });
        for (const s of sessoesWaha) if (!lista.some((n) => n.nome === s.nome)) lista.push({ nome: s.nome, nomeAmigavel: s.nome, status: s.status, telefone: s.telefone, nomePerfil: s.nomePerfil, cadastrado: false, noWaha: true });
        return responder(res, 200, { numeros: lista });
      }
      const acaoWhatsapp = ROTA_WHATSAPP.exec(rota);
      if (acaoWhatsapp && (acaoWhatsapp[2] === 'qr' ? req.method === 'GET' : req.method === 'POST')) {
        let nome = '';
        try { nome = decodeURIComponent(acaoWhatsapp[1]); } catch {}
        if (!SESSAO.test(nome)) throw erroHttp(400, 'Nome de número inválido.');
        const acao = acaoWhatsapp[2];
        if (acao === 'qr') return responder(res, 200, await whatsapp.qr(nome));
        if (acao === 'iniciar') return responder(res, 200, { ok: true, ...(await whatsapp.iniciar(nome)) });
        if (acao === 'parar') return responder(res, 200, await whatsapp.parar(nome));
        const dados = await lerCorpo(req, LIMITE_CORPO_LOGIN);
        if (!objeto(dados) || dados.confirmar !== true) throw erroHttp(400, 'Confirme a desconexão enviando {"confirmar": true}.');
        return responder(res, 200, await whatsapp.desconectar(nome));
      }
      // Só informa se existe chave e de qual provedor ela parece ser; a chave nunca sai daqui.
      if (req.method === 'GET' && rota === '/api/ia') return responder(res, 200, { chaveConfigurada: Boolean(chaveIA), provedorDaChave: IA.provedorDaChave(chaveIA) || undefined });
      if (req.method === 'GET' && rota === '/api/config') {
        const { conteudo, ...dados } = await lerConfig(configPath);
        return responder(res, 200, dados);
      }
      if (req.method === 'PUT' && rota === '/api/config') {
        const dados = await lerCorpo(req);
        if (!objeto(dados) || typeof dados.revisao !== 'string') throw erroHttp(400, 'Envie a configuração e a revisão carregada pelo painel.');
        if (dados.comentario !== undefined && dados.comentario !== null && (typeof dados.comentario !== 'string' || dados.comentario.length > 300)) throw erroHttp(400, 'O comentário precisa ser um texto de até 300 caracteres.');
        const comentario = typeof dados.comentario === 'string' ? dados.comentario.trim() : '';
        return responder(res, 200, await salvarConfig({ config: dados.config, revisaoEsperada: dados.revisao, autor: sessao ? sessao.usuario : (auth.usuario || 'painel'), comentario }));
      }
      if (req.method === 'GET' && rota === '/api/config/versoes') {
        exigirBanco();
        return responder(res, 200, { versoes: await repo.config.listarVersoes(50) });
      }
      const rotaVersao = /^\/api\/config\/versoes\/(\d{1,9})(\/restaurar)?$/.exec(rota);
      if (rotaVersao && ((req.method === 'GET' && !rotaVersao[2]) || (req.method === 'POST' && rotaVersao[2]))) {
        exigirBanco();
        const id = Number(rotaVersao[1]);
        const versao = await repo.config.versao(id);
        if (!versao) throw erroHttp(404, 'Versão não encontrada.');
        if (!rotaVersao[2]) return responder(res, 200, versao);
        const dados = await lerCorpo(req, LIMITE_CORPO_LOGIN);
        if (!objeto(dados) || typeof dados.revisao !== 'string') throw erroHttp(400, 'Envie a revisão carregada pelo painel.');
        // Mesmo caminho do PUT: valida, confere a revisão, grava o arquivo e cria uma nova versão.
        return responder(res, 200, await salvarConfig({ config: versao.config, revisaoEsperada: dados.revisao, autor: sessao ? sessao.usuario : (auth.usuario || 'painel'), comentario: 'Restaurada da versão ' + id }));
      }
      if (req.method === 'GET' && rota === '/api/historico') {
        exigirBanco();
        const parametros = new URL(req.url, 'http://localhost').searchParams;
        const { inicio, fim } = intervaloDe(parametros, 0);
        const busca = (parametros.get('busca') || '').trim();
        const conversa = (parametros.get('conversa') || '').trim();
        if (busca.length > 200 || conversa.length > 200) throw erroHttp(400, 'Busca ou conversa longa demais.');
        const pagina = parametros.has('pagina') ? Number(parametros.get('pagina')) : 1;
        if (!Number.isSafeInteger(pagina) || pagina < 1 || pagina > 100000) throw erroHttp(400, 'Página inválida.');
        const linhas = await repo.historico.listar({ inicio, fim, busca, conversa, limite: HISTORICO_POR_PAGINA + 1, deslocamento: (pagina - 1) * HISTORICO_POR_PAGINA });
        return responder(res, 200, { itens: linhas.slice(0, HISTORICO_POR_PAGINA), pagina, temMais: linhas.length > HISTORICO_POR_PAGINA });
      }
      const rotaConversa = /^\/api\/historico\/conversa\/([^/]+)$/.exec(rota);
      if (req.method === 'GET' && rotaConversa) {
        exigirBanco();
        let conversa = '';
        try { conversa = decodeURIComponent(rotaConversa[1]); } catch {}
        if (!conversa || conversa.length > 200) throw erroHttp(400, 'Conversa inválida.');
        return responder(res, 200, { itens: await repo.historico.conversa(conversa) });
      }
      if (req.method === 'GET' && rota === '/api/metricas') {
        exigirBanco();
        const { inicio, fim } = intervaloDe(new URL(req.url, 'http://localhost').searchParams, 30);
        return responder(res, 200, await repo.metricas({ inicio, fim, fuso: fusoDoBanco }));
      }
      if (req.method === 'GET' && rota === '/api/usuarios') {
        exigirBanco();
        return responder(res, 200, { usuarios: await servicoUsuarios.listar() });
      }
      if (req.method === 'POST' && rota === '/api/usuarios') {
        exigirBanco();
        const dados = await lerCorpo(req, LIMITE_CORPO_LOGIN);
        if (!objeto(dados)) throw erroHttp(400, 'Envie usuário, papel e senha.');
        return responder(res, 201, await servicoUsuarios.criar({ usuario: dados.usuario, papel: dados.papel, senha: dados.senha }));
      }
      const rotaUsuario = /^\/api\/usuarios\/(\d{1,9})(\/senha)?$/.exec(rota);
      if (rotaUsuario && ((req.method === 'PATCH' && !rotaUsuario[2]) || (req.method === 'POST' && rotaUsuario[2]))) {
        exigirBanco();
        const id = Number(rotaUsuario[1]);
        const dados = await lerCorpo(req, LIMITE_CORPO_LOGIN);
        if (!objeto(dados)) throw erroHttp(400, 'Corpo inválido.');
        if (rotaUsuario[2]) {
          await servicoUsuarios.definirSenha(id, dados.senha);
          return responder(res, 200, { ok: true });
        }
        return responder(res, 200, await servicoUsuarios.atualizar(id, { papel: dados.papel, ativo: dados.ativo }, sessao ? sessao.usuarioId : null));
      }
      if (req.method === 'POST' && rota === '/api/simular') {
        const dados = await lerCorpo(req);
        if (!objeto(dados) || typeof dados.texto !== 'string' || dados.texto.length > 8000 || (dados.estado !== undefined && !objeto(dados.estado)) || (dados.midia !== undefined && typeof dados.midia !== 'boolean' && typeof dados.midia !== 'string') || (dados.usosIA !== undefined && !Number.isInteger(dados.usosIA)) || (dados.eventoId !== undefined && typeof dados.eventoId !== 'string') || (dados.conversaNatural !== undefined && typeof dados.conversaNatural !== 'boolean') || (dados.historico !== undefined && (!Array.isArray(dados.historico) || dados.historico.length > MAX_HISTORICO_SIMULADOR)) || (dados.nomeContato !== undefined && typeof dados.nomeContato !== 'string') || (dados.incluirRascunhos !== undefined && typeof dados.incluirRascunhos !== 'boolean') || (dados.sessao !== undefined && (typeof dados.sessao !== 'string' || !SESSAO.test(dados.sessao)))) throw erroHttp(400, 'Envie um texto de até 8.000 caracteres e um estado de conversa válido.');
        const validacao = validarConfig(dados.config);
        if (validacao.erros.length) throw erroHttp(422, 'Revise a configuração antes de simular.', validacao);
        return responder(res, 200, await simularConversa(dados, { chaveIA, fetchIA, usosRecentes }));
      }
      if (req.method === 'GET' && rota === '/api/situacao') {
        if (!registros.disponivel) return responder(res, 200, { registros: false, retencaoDias: registros.retencao, hoje: registros.hoje() });
        const [dias, whatsapp, noAr] = await lerRegistros(() => Promise.all([registros.diasComConversas(), registros.situacaoDoWhatsApp(), wahaNoAr()]));
        return responder(res, 200, { registros: true, retencaoDias: registros.retencao, hoje: registros.hoje(), dias, whatsapp: { ...(whatsapp || {}), servicoNoAr: noAr ?? undefined } });
      }
      if (req.method === 'GET' && rota === '/api/conversas') {
        const parametros = new URL(req.url, 'http://localhost').searchParams;
        const de = parametros.has('de') ? Number(parametros.get('de')) : 0;
        if (!Number.isSafeInteger(de) || de < 0) throw erroHttp(400, 'Posição de leitura inválida.');
        return responder(res, 200, await lerRegistros(() => registros.conversas(parametros.get('dia') || registros.hoje(), de)));
      }
      if (req.method === 'GET' && rota === '/api/erros') return responder(res, 200, { erros: await lerRegistros(() => registros.erros()) });
      if (req.method === 'GET' && arquivos.has(rota)) {
        const [nome, tipo] = arquivos.get(rota);
        let conteudo;
        try { conteudo = await fs.readFile(path.join(__dirname, 'public', nome)); }
        catch (erro) { if (erro.code === 'ENOENT') return responder(res, 404, { erro: 'Página não encontrada.' }); throw erro; }
        res.writeHead(200, { 'Content-Type': tipo });
        return res.end(conteudo);
      }
      return responder(res, 404, { erro: 'Página não encontrada.' });
    } catch (erro) {
      const status = erro.status || 500;
      if (!erro.status) console.error('Erro inesperado no painel: ' + (erro && erro.message ? String(erro.message).slice(0, 300) : 'sem mensagem'));
      responder(res, status, { erro: status === 500 && !erro.status ? 'Não foi possível concluir a operação. Confira se o arquivo de configuração está acessível.' : erro.message, ...(erro.detalhes || {}) });
    }
  });
  // A consulta à IA pode levar até 30 segundos (tempo_limite_segundos).
  server.requestTimeout = 40000;
  server.headersTimeout = 10000;
  if (registros.disponivel) {
    const limpar = () => registros.limpar().then((removidos) => {
      if (removidos.length) console.log('Conversas antigas apagadas: ' + removidos.join(', '));
    }).catch(() => console.error('Não foi possível apagar as conversas antigas da pasta de registros.'));
    server.once('listening', limpar);
    const temporizador = setInterval(limpar, INTERVALO_LIMPEZA_MS);
    temporizador.unref();
    server.once('close', () => clearInterval(temporizador));
  }
  if (repo) {
    // O banco é opcional: o painel já está de pé. A preparação (migrações, admin inicial, versão 1)
    // roda em segundo plano e se repete sozinha quando o banco aparece ou volta.
    server.once('listening', () => {
      server.bancoPreparado = Promise.resolve(repo.iniciar({ aoConectar: inicializarBanco })).catch(() => {});
      if (ingestor) ingestor.iniciar();
      limparBanco();
    });
    const temporizadorBanco = setInterval(limparBanco, INTERVALO_LIMPEZA_MS);
    temporizadorBanco.unref();
    server.once('close', () => {
      clearInterval(temporizadorBanco);
      if (ingestor) ingestor.parar().catch(() => {});
      Promise.resolve(repo.parar && repo.parar()).catch(() => {});
    });
  }
  server.registros = registros;
  server.repositorio = repo;
  server.ingestor = ingestor;
  return server;
}

if (require.main === module) {
  const host = process.env.PAINEL_HOST || '127.0.0.1';
  const port = Number(process.env.PAINEL_PORT || 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('PAINEL_PORT precisa ser uma porta entre 1 e 65535.');
    process.exitCode = 1;
  } else {
    let server;
    try { server = criarServidor({ configPath: process.env.CHATBOT_CONFIG, host, publicPort: process.env.PAINEL_PUBLIC_PORT }); }
    catch (erro) { console.error('Não foi possível iniciar o painel: ' + erro.message); process.exitCode = 1; }
    if (server) {
      server.on('error', () => { console.error('Não foi possível iniciar o painel. Confira o endereço e se a porta está livre.'); process.exitCode = 1; });
      server.listen(port, host, () => console.log('Painel local disponível em http://127.0.0.1:' + port));
    }
  }
}

module.exports = { criarServidor };
