'use strict';

const $ = (seletor) => document.querySelector(seletor);

// Situação do WAHA traduzida; "situacao" alimenta a cor (ok, alerta, erro, neutro).
const SITUACOES = {
  WORKING: { texto: 'Conectado', situacao: 'ok' },
  SCAN_QR_CODE: { texto: 'Aguardando QR Code', situacao: 'alerta' },
  STARTING: { texto: 'Iniciando', situacao: 'alerta' },
  STOPPED: { texto: 'Parado', situacao: 'neutro' },
  FAILED: { texto: 'Falhou', situacao: 'erro' }
};
const SEM_SESSAO = { texto: 'Não iniciado', situacao: 'neutro' };

const cartoes = new Map(); // nome da sessão -> cartão (elementos e estado)
let carregando = false;
let papelEfetivo = 'admin'; // ajustado por /api/sessao; o servidor também confere
const podeEditar = () => papelEfetivo === 'admin' || papelEfetivo === 'editor';
const podeDesconectar = () => papelEfetivo === 'admin';

function criar(tag, classe, texto) {
  const el = document.createElement(tag);
  if (classe) el.className = classe;
  if (texto !== undefined && texto !== null) el.textContent = texto;
  return el;
}

async function api(rota, metodo = 'GET', corpo) {
  let res;
  try {
    res = await fetch(rota, {
      method: metodo,
      headers: corpo === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: corpo === undefined ? undefined : JSON.stringify(corpo)
    });
  } catch { throw new Error('Não foi possível conectar ao painel. Confira a internet e tente de novo.'); }
  if (res.status === 401) { location.href = '/login'; throw new Error('Sessão expirada. Entre novamente.'); }
  let dados = {};
  try { dados = await res.json(); } catch { dados = {}; }
  if (!res.ok) {
    const erro = new Error(dados.erro || 'O painel não respondeu (HTTP ' + res.status + ').');
    erro.status = res.status;
    throw erro;
  }
  return dados;
}

function mostrarAviso(mensagem) {
  const caixa = $('#aviso');
  caixa.textContent = mensagem;
  caixa.hidden = !mensagem;
}

function formatarTelefone(digitos) {
  const d = String(digitos || '').replace(/\D/g, '');
  if (d.length === 13 && d.startsWith('55')) return '+55 (' + d.slice(2, 4) + ') ' + d.slice(4, 9) + '-' + d.slice(9);
  if (d.length === 12 && d.startsWith('55')) return '+55 (' + d.slice(2, 4) + ') ' + d.slice(4, 8) + '-' + d.slice(8);
  return d ? '+' + d : '';
}

function duracao(segundos) {
  const s = Math.max(0, Math.floor(Number(segundos) || 0));
  const dias = Math.floor(s / 86400);
  const horas = Math.floor((s % 86400) / 3600);
  const minutos = Math.floor((s % 3600) / 60);
  if (dias > 0) return dias + ' d ' + horas + ' h';
  if (horas > 0) return horas + ' h ' + minutos + ' min';
  return minutos + ' min';
}

// ---------- servidor ----------

function preencherCard(id, texto, detalhe, situacao) {
  const card = $(id);
  card.dataset.situacao = situacao || '';
  card.querySelector('strong').textContent = texto;
  card.querySelector('small').textContent = detalhe || '';
}

function mostrarServidor(s) {
  preencherCard('#srv-whatsapp', s.whatsapp ? 'No ar' : 'Fora do ar', s.whatsapp ? 'O WAHA está respondendo' : 'O WAHA não respondeu', s.whatsapp ? 'ok' : 'erro');
  preencherCard('#srv-n8n', s.n8n ? 'No ar' : 'Fora do ar', s.n8n ? 'O n8n está respondendo' : 'O n8n não respondeu', s.n8n ? 'ok' : 'erro');
  const m = s.memoria || {};
  const usadaMB = Math.max(0, (m.totalMB || 0) - (m.livreMB || 0));
  const pMem = m.totalMB ? Math.round((usadaMB / m.totalMB) * 100) : 0;
  preencherCard('#srv-memoria', pMem + '% em uso', usadaMB + ' MB de ' + (m.totalMB || 0) + ' MB', pMem >= 90 ? 'erro' : pMem >= 75 ? 'alerta' : 'ok');
  const d = s.disco || {};
  const usadoGB = Math.max(0, (d.totalGB || 0) - (d.livreGB || 0));
  const pDisco = d.totalGB ? Math.round((usadoGB / d.totalGB) * 100) : 0;
  preencherCard('#srv-disco', d.livreGB === undefined ? '–' : d.livreGB + ' GB livres', 'de ' + (d.totalGB || 0) + ' GB', pDisco >= 90 ? 'erro' : pDisco >= 80 ? 'alerta' : 'ok');
  if (typeof s.banco === 'boolean' && s.bancoConfigurado !== false) {
    const atraso = Number(s.atrasoIngestaoSegundos);
    const atrasado = Number.isFinite(atraso) && atraso > 30;
    preencherCard('#srv-banco', s.banco ? 'No ar' : 'Fora do ar',
      s.banco ? (Number.isFinite(atraso) ? (atrasado ? 'Histórico atrasado ' + duracao(atraso) : 'Histórico em dia') : 'Banco respondendo') : 'O histórico não está sendo gravado',
      s.banco ? (atrasado ? 'alerta' : 'ok') : 'erro');
  } else preencherCard('#srv-banco', 'Não usado', 'Conversas só em arquivo', '');
  preencherCard('#srv-ligado', duracao(s.ligadoHa), 'desde a última reinicialização', 'ok');
}

function servidorIndisponivel() {
  for (const id of ['#srv-whatsapp', '#srv-n8n', '#srv-memoria', '#srv-disco', '#srv-banco', '#srv-ligado']) preencherCard(id, '–', 'Sem informação', '');
}

async function carregarServidor() {
  try { mostrarServidor(await api('/api/servidor')); }
  catch { servidorIndisponivel(); }
}

// ---------- números ----------

function criarCartao(nome) {
  const el = criar('article', 'cartao cartao-numero');
  const topo = criar('div', 'numero-topo');
  const identidade = criar('div', 'numero-identidade');
  const titulo = criar('h2', 'numero-titulo');
  const sessao = criar('small', 'numero-sessao');
  identidade.append(titulo, sessao);
  const selo = criar('span', 'selo-status selo-numero');
  topo.append(identidade, selo);
  const telefone = criar('p', 'numero-telefone');
  const msg = criar('p', 'numero-msg', '');
  msg.setAttribute('role', 'status');
  msg.hidden = true;
  const qrCaixa = criar('div', 'qr-caixa');
  qrCaixa.hidden = true;
  const qrImg = criar('img', 'qr-imagem');
  qrImg.alt = 'QR Code para conectar o WhatsApp';
  qrImg.width = 240;
  qrImg.height = 240;
  const qrAjuda = criar('p', 'qr-ajuda', 'No celular: WhatsApp > Aparelhos conectados > Conectar um aparelho, e aponte a câmera para este código.');
  qrCaixa.append(qrImg, qrAjuda);
  const acoes = criar('div', 'numero-acoes');
  const ligar = criar('button', 'botao botao-primario botao-pequeno', 'Ligar');
  const parar = criar('button', 'botao botao-secundario botao-pequeno', 'Parar');
  const desconectar = criar('button', 'botao botao-perigo-suave botao-pequeno', 'Desconectar');
  for (const b of [ligar, parar, desconectar]) b.type = 'button';
  acoes.append(ligar, parar, desconectar);
  el.append(topo, telefone, msg, qrCaixa, acoes);

  const c = { nome, el, titulo, sessao, selo, telefone, msg, qrCaixa, qrImg, ligar, parar, desconectar, status: null, ocupado: false, buscandoQr: false };
  ligar.addEventListener('click', () => executar(c, 'iniciar', 'Ligando…'));
  parar.addEventListener('click', () => executar(c, 'parar', 'Parando…'));
  desconectar.addEventListener('click', () => pedirDesconexao(c));
  return c;
}

function atualizarBotoes(c) {
  const s = c.status;
  c.ligar.hidden = !podeEditar();
  c.parar.hidden = !podeEditar();
  c.desconectar.hidden = !podeDesconectar();
  c.ligar.disabled = c.ocupado || !(s === null || s === 'STOPPED' || s === 'FAILED');
  c.parar.disabled = c.ocupado || !(s === 'WORKING' || s === 'SCAN_QR_CODE' || s === 'STARTING');
  c.desconectar.disabled = c.ocupado || s === null;
}

function mostrarMensagem(c, texto, erro) {
  c.msg.textContent = texto || '';
  c.msg.hidden = !texto;
  c.msg.classList.toggle('erro', Boolean(erro));
}

function desenharCartao(c, n) {
  c.status = n.status || null;
  const info = c.status ? (SITUACOES[c.status] || { texto: c.status, situacao: 'neutro' }) : SEM_SESSAO;
  c.titulo.textContent = n.nomeAmigavel || n.nome;
  c.sessao.textContent = n.nomeAmigavel && n.nomeAmigavel !== n.nome ? 'Sessão: ' + n.nome : '';
  c.sessao.hidden = !c.sessao.textContent;
  c.selo.textContent = info.texto;
  c.selo.dataset.situacao = info.situacao;
  const tel = formatarTelefone(n.telefone);
  const partes = [];
  if (tel) partes.push(tel);
  if (n.nomePerfil) partes.push(n.nomePerfil);
  c.telefone.textContent = partes.length ? partes.join(' · ') : 'Sem número conectado';
  if (c.status !== 'SCAN_QR_CODE') { c.qrCaixa.hidden = true; c.qrImg.removeAttribute('src'); }
  else if (c.qrImg.getAttribute('src')) c.qrCaixa.hidden = false;
  atualizarBotoes(c);
}

async function executar(c, acao, textoOcupado, corpo) {
  c.ocupado = true;
  atualizarBotoes(c);
  mostrarMensagem(c, textoOcupado, false);
  try {
    await api('/api/whatsapp/' + encodeURIComponent(c.nome) + '/' + acao, 'POST', corpo || {});
    mostrarMensagem(c, '', false);
  } catch (erro) {
    mostrarMensagem(c, erro.message, true);
  } finally {
    c.ocupado = false;
    await carregarNumeros();
    atualizarBotoes(c);
    if (c.status === 'SCAN_QR_CODE') atualizarQr(c);
  }
}

function pedirDesconexao(c) {
  const dialogo = $('#confirmar-desconectar');
  $('#texto-desconectar').textContent = 'O número "' + (c.titulo.textContent || c.nome) + '" vai sair do WhatsApp do servidor. Para voltar a usar, será preciso ler um QR Code novo no celular.';
  dialogo.returnValue = 'cancelar';
  dialogo.addEventListener('close', () => {
    if (dialogo.returnValue === 'desconectar') executar(c, 'desconectar', 'Desconectando…', { confirmar: true });
  }, { once: true });
  dialogo.showModal();
}

async function atualizarQr(c) {
  if (c.status !== 'SCAN_QR_CODE' || c.buscandoQr) return;
  c.buscandoQr = true;
  try {
    const qr = await api('/api/whatsapp/' + encodeURIComponent(c.nome) + '/qr');
    const valido = qr && /^image\/(png|jpeg)$/.test(qr.mimetype || '') && /^[A-Za-z0-9+/=]+$/.test(qr.data || '');
    if (valido && c.status === 'SCAN_QR_CODE') {
      c.qrImg.src = 'data:' + qr.mimetype + ';base64,' + qr.data;
      c.qrCaixa.hidden = false;
    }
  } catch { /* o QR some por instantes enquanto o WhatsApp gera outro */ }
  finally { c.buscandoQr = false; }
}

function marcarAtualizacao(ok) {
  const el = $('#atualizado');
  el.classList.toggle('falhou', !ok);
  el.textContent = ok ? 'Atualizado às ' + new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : 'Sem atualizar';
}

async function carregarNumeros() {
  if (carregando) return;
  carregando = true;
  try {
    const { numeros = [] } = await api('/api/whatsapp');
    mostrarAviso('');
    const lista = $('#numeros');
    const nomes = new Set(numeros.map((n) => n.nome));
    for (const [nome, c] of cartoes) if (!nomes.has(nome)) { c.el.remove(); cartoes.delete(nome); }
    for (const n of numeros) {
      let c = cartoes.get(n.nome);
      if (!c) { c = criarCartao(n.nome); cartoes.set(n.nome, c); }
      desenharCartao(c, n);
      lista.append(c.el); // reposiciona na ordem recebida sem recriar
    }
    $('#vazio-numeros').hidden = numeros.length > 0;
    marcarAtualizacao(true);
  } catch (erro) {
    mostrarAviso(erro.message);
    marcarAtualizacao(false);
  } finally {
    carregando = false;
  }
}

async function ciclo() {
  await Promise.all([carregarNumeros(), carregarServidor()]);
  for (const c of cartoes.values()) atualizarQr(c);
}

// ---------- Sair ----------

async function prepararSair() {
  const botao = $('#botao-sair');
  try {
    const r = await fetch('/api/sessao', { headers: { Accept: 'application/json' } });
    const s = await r.json();
    const admin = s.papel === 'admin' || ((s.papel === null || s.papel === undefined) && !s.loginObrigatorio);
    const aba = document.getElementById('aba-usuarios');
    if (aba) aba.hidden = !admin;
    papelEfetivo = admin ? 'admin' : s.papel;
    for (const c of cartoes.values()) atualizarBotoes(c);
    if (!s.loginObrigatorio) return;
    botao.hidden = false;
    botao.addEventListener('click', async () => {
      botao.disabled = true;
      try { await fetch('/api/logout', { method: 'POST' }); } catch { /* segue para o login mesmo assim */ }
      location.href = '/login';
    });
  } catch { /* sem sessão ou painel fora: o botão fica escondido */ }
}

prepararSair();
ciclo();
setInterval(() => { if (!document.hidden) ciclo(); }, 10000);
// O QR Code expira em segundos: renovamos mais depressa que o restante.
setInterval(() => { if (!document.hidden) for (const c of cartoes.values()) atualizarQr(c); }, 5000);
