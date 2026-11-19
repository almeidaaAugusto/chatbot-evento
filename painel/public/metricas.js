'use strict';

// Página de métricas: busca /api/metricas para o período escolhido e desenha
// os cartões, as barras (SVG) e a tabela de dúvidas. Não há atualização automática.

const $ = (seletor) => document.querySelector(seletor);
const NS_SVG = 'http://www.w3.org/2000/svg';

// Dimensões fixas dos gráficos verticais; o SVG escala com width="100%".
const LARGURA = 640;
const ALTURA = 220;
const BASE = 186; // linha de base das barras; abaixo fica o eixo de rótulos
const TOPO = 10;

// Nomes amigáveis; qualquer valor fora daqui aparece como veio do servidor.
const ORIGENS = new Map([
  ['menu', 'Menu ou regras'],
  ['regras', 'Menu ou regras'],
  ['ia', 'IA'],
  ['fallback', 'Não entendeu (orientação)'],
  ['humano', 'Atendimento humano']
]);
const MOTIVOS_FALHA = new Map([
  ['sem_resposta', 'A IA não tinha a informação'],
  ['tempo_esgotado', 'A IA demorou demais'],
  ['erro_429', 'Cota da API esgotou'],
  ['erro_401', 'Chave da IA recusada'],
  ['erro_de_rede', 'Falha de conexão'],
  ['limite_por_contato', 'Limite por contato'],
  ['limite_do_dia', 'Limite do dia']
]);

let intervalo = { de: '', ate: '' }; // datas AAAA-MM-DD do período em uso
let buscaAtual = 0; // evita que uma resposta antiga sobrescreva a nova

function criar(tag, classe, texto) {
  const el = document.createElement(tag);
  if (classe) el.className = classe;
  if (texto !== undefined && texto !== null) el.textContent = texto;
  return el;
}

function svgEl(tag, atributos, texto) {
  const el = document.createElementNS(NS_SVG, tag);
  for (const [nome, valor] of Object.entries(atributos || {})) el.setAttribute(nome, String(valor));
  if (texto !== undefined && texto !== null) el.textContent = texto;
  return el;
}

async function api(rota) {
  let res;
  try {
    res = await fetch(rota, { headers: { Accept: 'application/json' } });
  } catch { throw new Error('Não foi possível conectar ao painel. Confira a internet e tente de novo.'); }
  if (res.status === 401) { location.href = '/login'; throw new Error('Sessão expirada. Entre novamente.'); }
  let dados = {};
  try { dados = await res.json(); } catch { dados = {}; }
  if (!res.ok) {
    const erro = new Error(dados.erro || 'O painel não respondeu (HTTP ' + res.status + ').');
    erro.status = res.status;
    erro.dados = dados;
    throw erro;
  }
  return dados;
}

function mostrarAviso(mensagem) {
  const caixa = $('#aviso');
  caixa.textContent = mensagem;
  caixa.hidden = !mensagem;
}

function marcarAtualizacao(ok) {
  const el = $('#atualizado');
  el.classList.toggle('falhou', !ok);
  el.textContent = ok ? 'Atualizado às ' + new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : 'Sem atualizar';
}

function numero(valor) {
  const n = Number(valor);
  return Number.isFinite(n) ? n : 0;
}

function textoOu(valor, reserva) {
  return String(valor || '').trim() || reserva;
}

function formatar(n) {
  return n.toLocaleString('pt-BR');
}

function definir(id, texto) {
  $('#' + id).textContent = texto;
}

// Datas no fuso local (toISOString usaria UTC e pularia um dia à noite no Brasil).
function formatarDataLocal(data) {
  const mes = String(data.getMonth() + 1).padStart(2, '0');
  const dia = String(data.getDate()).padStart(2, '0');
  return data.getFullYear() + '-' + mes + '-' + dia;
}

// Período de N dias terminando hoje, contando o próprio dia de hoje.
function intervaloDias(dias) {
  const ate = new Date();
  const de = new Date();
  de.setDate(de.getDate() - (dias - 1));
  return { de: formatarDataLocal(de), ate: formatarDataLocal(ate) };
}

function rotuloDia(iso) {
  const partes = String(iso || '').split('-');
  return partes.length === 3 ? partes[2] + '/' + partes[1] : String(iso || '');
}

// Cada cartão de gráfico tem uma área (data-area) e um aviso de vazio (.vazio).
function areaDe(id) { return $('#' + id + ' [data-area]'); }
function vazioDe(id) { return $('#' + id + ' .vazio'); }

function exibirGrafico(id, temDados) {
  const area = areaDe(id);
  area.hidden = !temDados;
  vazioDe(id).hidden = temDados;
  if (!temDados) area.replaceChildren();
}

// ---------- totais ----------

function desenharTotais(t) {
  const recebidas = numero(t.recebidas);
  const respondidas = numero(t.respondidas);
  definir('total-recebidas', formatar(recebidas));
  definir('total-contatos', formatar(numero(t.contatos)));
  definir('total-respondidas', formatar(respondidas));
  definir('total-sem-resposta', formatar(numero(t.naoRespondidas)));
  definir('taxa-respondidas', recebidas > 0
    ? Math.round((respondidas / recebidas) * 100) + '% das mensagens recebidas'
    : 'Sem mensagens no período');
}

// ---------- barras horizontais ----------

function desenharBarras(id, itens) {
  const validos = itens.filter((i) => i.valor > 0).sort((a, b) => b.valor - a.valor);
  exibirGrafico(id, validos.length > 0);
  if (!validos.length) return;
  const max = validos[0].valor;
  areaDe(id).replaceChildren(...validos.map((item) => {
    const svg = svgEl('svg', { class: 'barra-svg', height: 14, preserveAspectRatio: 'none', viewBox: '0 0 100 14', 'aria-hidden': 'true' });
    const rect = svgEl('rect', { class: 'barra-recebidas', x: 0, y: 0, width: (item.valor / max) * 100, height: 14 });
    rect.append(svgEl('title', {}, item.rotulo + ': ' + formatar(item.valor)));
    svg.append(rect);
    const trilho = criar('div', 'barra-trilho');
    trilho.append(svg);
    const linha = criar('div', 'barra-linha');
    linha.append(criar('span', 'barra-rotulo', item.rotulo), trilho, criar('span', 'barra-valor', formatar(item.valor)));
    return linha;
  }));
}

// ---------- barras verticais ----------

function barraVertical(x, valor, max, largura, classe, titulo) {
  const altura = (valor / max) * (BASE - TOPO);
  const rect = svgEl('rect', { class: classe, x, y: BASE - altura, width: largura, height: altura });
  rect.append(svgEl('title', {}, titulo));
  return rect;
}

function desenharDias(porDia) {
  const dias = porDia
    .map((d) => ({ dia: String(d.dia || ''), recebidas: numero(d.recebidas), respondidas: numero(d.respondidas) }))
    .sort((a, b) => (a.dia < b.dia ? -1 : a.dia > b.dia ? 1 : 0));
  const temDados = dias.some((d) => d.recebidas > 0 || d.respondidas > 0);
  exibirGrafico('grafico-dias', temDados);
  if (!temDados) return;

  const max = Math.max(...dias.map((d) => Math.max(d.recebidas, d.respondidas)));
  const passo = LARGURA / dias.length;
  const barra = Math.min(passo * 0.38, 22);
  const rotuloACada = Math.ceil(dias.length / 7); // poucos rótulos para caber no celular
  const svg = svgEl('svg', { class: 'grafico-svg', width: '100%', viewBox: '0 0 ' + LARGURA + ' ' + ALTURA, role: 'img', 'aria-label': 'Mensagens recebidas e respondidas por dia' });
  dias.forEach((d, i) => {
    const x = i * passo + (passo - barra * 2) / 2;
    const rotulo = rotuloDia(d.dia);
    svg.append(barraVertical(x, d.recebidas, max, barra, 'barra-recebidas', rotulo + ': ' + formatar(d.recebidas) + ' recebidas'));
    svg.append(barraVertical(x + barra, d.respondidas, max, barra, 'barra-respondidas', rotulo + ': ' + formatar(d.respondidas) + ' respondidas'));
    if (i % rotuloACada === 0) svg.append(svgEl('text', { class: 'eixo-texto', x: i * passo + passo / 2, y: ALTURA - 8, 'text-anchor': 'middle' }, rotulo));
  });
  areaDe('grafico-dias').replaceChildren(svg);
}

function desenharHora(porHora) {
  const horas = new Array(24).fill(0);
  for (const item of porHora) {
    const h = Number(item.hora);
    if (Number.isInteger(h) && h >= 0 && h <= 23) horas[h] += numero(item.total);
  }
  const temDados = horas.some((t) => t > 0);
  exibirGrafico('grafico-hora', temDados);
  const pico = $('#pico-hora');
  pico.hidden = !temDados;
  if (!temDados) return;

  const max = Math.max(...horas);
  const indicePico = horas.indexOf(max);
  pico.textContent = 'Pico: ' + indicePico + 'h (' + formatar(max) + ' ' + (max === 1 ? 'mensagem' : 'mensagens') + ')';

  const passo = LARGURA / 24;
  const barra = passo * 0.7;
  const svg = svgEl('svg', { class: 'grafico-svg', width: '100%', viewBox: '0 0 ' + LARGURA + ' ' + ALTURA, role: 'img', 'aria-label': 'Mensagens recebidas por hora do dia' });
  horas.forEach((total, h) => {
    const x = h * passo + (passo - barra) / 2;
    const classe = h === indicePico ? 'barra-pico' : 'barra-recebidas';
    svg.append(barraVertical(x, total, max, barra, classe, h + 'h: ' + formatar(total) + ' ' + (total === 1 ? 'mensagem' : 'mensagens')));
    if (h % 3 === 0) svg.append(svgEl('text', { class: 'eixo-texto', x: h * passo + passo / 2, y: ALTURA - 8, 'text-anchor': 'middle' }, h + 'h'));
  });
  areaDe('grafico-hora').replaceChildren(svg);
}

// ---------- IA ----------

function desenharIa(ia) {
  const consultas = numero(ia.consultas);
  definir('ia-consultas', formatar(consultas));
  definir('ia-respostas', formatar(numero(ia.respostas)));

  const falhas = (ia.falhas || [])
    .map((f) => ({ rotulo: MOTIVOS_FALHA.get(f.motivo) || textoOu(f.motivo, 'Motivo não informado'), valor: numero(f.total) }))
    .filter((f) => f.valor > 0)
    .sort((a, b) => b.valor - a.valor);
  const lista = $('#ia-falhas');
  lista.replaceChildren(...falhas.map((f) => criar('li', '', f.rotulo + ': ' + formatar(f.valor))));
  lista.hidden = falhas.length === 0;
  $('#ia-falhas-titulo').hidden = falhas.length === 0;

  const vazio = consultas === 0 && falhas.length === 0;
  $('#ia-totais').hidden = vazio;
  vazioDe('bloco-ia').hidden = !vazio;
}

// ---------- dúvidas ----------

function desenharDuvidas(lista) {
  const itens = lista
    .map((d) => ({ texto: textoOu(d.texto, '(sem texto)'), total: numero(d.total) }))
    .filter((i) => i.total > 0)
    .sort((a, b) => b.total - a.total);
  $('#duvidas-corpo').replaceChildren(...itens.map((item) => {
    const linha = criar('tr');
    linha.append(criar('td', '', item.texto), criar('td', '', formatar(item.total)));
    return linha;
  }));
  $('#duvidas .tabela-duvidas').hidden = itens.length === 0;
  vazioDe('duvidas').hidden = itens.length > 0;
}

function desenharTudo(dados) {
  desenharTotais(dados.totais || {});
  desenharDias(dados.porDia || []);
  desenharBarras('grafico-origem', (dados.porOrigem || []).map((i) => ({
    rotulo: ORIGENS.get(i.origem) || textoOu(i.origem, 'Não informada'),
    valor: numero(i.total)
  })));
  desenharBarras('grafico-intencao', (dados.porIntencao || []).map((i) => ({
    rotulo: textoOu(i.intencao, 'Sem intenção'),
    valor: numero(i.total)
  })));
  const ia = dados.ia || {};
  desenharBarras('grafico-modelo', (ia.porModelo || []).map((i) => ({
    rotulo: textoOu(i.modelo, 'Modelo não informado'),
    valor: numero(i.total)
  })));
  desenharIa(ia);
  desenharHora(dados.porHora || []);
  desenharDuvidas(dados.duvidas || []);
}

// ---------- carregamento ----------

async function carregar() {
  const busca = ++buscaAtual;
  const atualizado = $('#atualizado');
  atualizado.classList.remove('falhou');
  atualizado.textContent = 'Carregando…';
  try {
    const dados = await api('/api/metricas?de=' + encodeURIComponent(intervalo.de) + '&ate=' + encodeURIComponent(intervalo.ate));
    if (busca !== buscaAtual) return;
    mostrarAviso('');
    $('#conteudo').hidden = false;
    desenharTudo(dados);
    marcarAtualizacao(true);
  } catch (erro) {
    if (busca !== buscaAtual) return;
    if (erro.dados && erro.dados.bancoIndisponivel) {
      mostrarAviso('Métricas indisponíveis: banco de dados fora do ar');
      $('#conteudo').hidden = true;
    } else {
      mostrarAviso(erro.message);
    }
    marcarAtualizacao(false);
  }
}

// ---------- período ----------

function escolherPeriodo(valor) {
  for (const botao of document.querySelectorAll('.periodo .chips button')) {
    botao.setAttribute('aria-pressed', String(botao.dataset.dias === valor));
  }
  const datas = $('#periodo-datas');
  datas.hidden = valor !== 'personalizado';
  if (valor === 'personalizado') {
    // Mostra as datas atuais para ajustar; a busca só começa em "Aplicar".
    if (!$('#data-de').value) $('#data-de').value = intervalo.de;
    if (!$('#data-ate').value) $('#data-ate').value = intervalo.ate;
    return;
  }
  intervalo = intervaloDias(Number(valor));
  carregar();
}

function aplicarDatas() {
  const de = $('#data-de').value;
  const ate = $('#data-ate').value;
  if (!de || !ate || de > ate) {
    mostrarAviso('Escolha as duas datas, com a data inicial antes da final.');
    return;
  }
  intervalo = { de, ate };
  carregar();
}

// ---------- Sair e aba Usuários ----------

// Uma única consulta a /api/sessao, compartilhada pelo botão Sair e pela aba Usuários.
async function lerSessao() {
  try {
    const r = await fetch('/api/sessao', { headers: { Accept: 'application/json' } });
    if (r.status === 401) { location.href = '/login'; return null; }
    return await r.json();
  } catch { return null; }
}

const sessaoPronta = lerSessao();

async function prepararSair() {
  const s = await sessaoPronta;
  if (!s || !s.loginObrigatorio) return;
  const botao = $('#botao-sair');
  botao.hidden = false;
  botao.addEventListener('click', async () => {
    botao.disabled = true;
    try { await fetch('/api/logout', { method: 'POST' }); } catch { /* segue para o login mesmo assim */ }
    location.href = '/login';
  });
}

async function prepararAbaUsuarios() {
  const s = await sessaoPronta;
  if (!s) return;
  const semPapel = s.papel === null || s.papel === undefined;
  if (s.papel === 'admin' || (semPapel && s.loginObrigatorio === false)) $('#aba-usuarios').hidden = false;
}

// ---------- inicialização ----------

prepararSair();
prepararAbaUsuarios();
for (const botao of document.querySelectorAll('.periodo .chips button')) {
  botao.addEventListener('click', () => escolherPeriodo(botao.dataset.dias));
}
$('#aplicar-datas').addEventListener('click', aplicarDatas);
escolherPeriodo('30');
