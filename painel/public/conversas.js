'use strict';

// Página "Conversas": lê os registros gravados pelo n8n (via painel/server.js) e mostra
// cada mensagem recebida ao lado da resposta enviada. Todo texto vindo do WhatsApp entra
// na página como texto puro (textContent), nunca como HTML.

const $ = (seletor) => document.querySelector(seletor);
const INTERVALO_MS = 5000;

const estado = {
  hoje: null,
  retencao: 7,
  periodo: 1,
  dias: new Map(), // dia -> { ate, registros }
  erros: [],
  whatsapp: null,
  config: null,
  selecionada: null,
  filtro: 'todas',
  busca: '',
  versao: 0,
  desenhada: -1,
  atualizando: false,
};

const motivos = {
  agrupada_com_mensagem_seguinte: 'veio junto com a mensagem seguinte (o robô responde só à última de uma sequência)',
  fallback_esgotado: 'o robô não entendeu e já tinha mandado as 3 orientações. Volta a responder quando a pessoa mandar algo do menu ou depois de 30 minutos sem resposta',
  em_atendimento_humano: 'conversa com a equipe (robô pausado para este contato)',
  limite_de_mensagens_por_hora: 'o contato passou do limite de mensagens por hora',
  resposta_repetida: 'a mesma resposta já tinha sido enviada várias vezes em poucos minutos',
  recebida_com_o_robo_desligado: 'chegou enquanto o robô estava desligado',
  mensagem_antiga: 'mensagem antiga, entregue com atraso pelo WhatsApp',
  sem_texto: 'mensagem sem texto',
  erro_no_whatsapp: 'falha ao enviar pelo WhatsApp',
};

const resultadosIA = {
  respondeu: 'a IA respondeu',
  sem_resposta: 'a IA não tinha essa informação',
  limite_por_contato: 'este contato já tinha usado a IA o máximo de vezes',
  limite_do_dia: 'a cota diária da IA já tinha acabado',
  tempo_esgotado: 'a IA demorou demais para responder',
  erro_de_rede: 'não foi possível conectar à API de IA',
  erro_401: 'a chave da IA foi recusada (rode scripts\\configurar-ia.ps1)',
  erro_403: 'a chave da IA não tem permissão para este modelo',
  erro_429: 'a cota da API de IA esgotou por enquanto',
  resposta_invalida: 'a API de IA devolveu uma resposta inválida',
  vazia: 'a IA devolveu uma resposta vazia',
  resposta_cortada: 'a resposta da IA veio cortada e foi descartada',
  link_nao_confirmado: 'a IA citou um link que não está cadastrado (resposta descartada)',
  contato_nao_confirmado: 'a IA citou um contato que não está cadastrado (resposta descartada)',
  preco_nao_confirmado: 'a IA citou um valor que não está cadastrado (resposta descartada)',
};
const FALHAS_DA_IA = /^(erro_|tempo_esgotado$|resposta_invalida$|vazia$|resposta_cortada$)/;

const situacoesWhatsApp = {
  WORKING: ['Conectado', 'ok', 'O robô está respondendo'],
  STOPPED: ['Parado', 'alerta', 'O robô não responde. Para religar: scripts\\conectar-whatsapp.ps1'],
  SCAN_QR_CODE: ['Esperando o QR Code', 'alerta', 'Rode scripts\\conectar-whatsapp.ps1 e escaneie o código'],
  STARTING: ['Conectando…', 'neutro', 'O WhatsApp está iniciando'],
  FAILED: ['Com falha', 'erro', 'Rode scripts\\conectar-whatsapp.ps1 para reconectar'],
};

// ---------- utilitários ----------

function elemento(tag, classe, texto) {
  const el = document.createElement(tag);
  if (classe) el.className = classe;
  if (texto !== undefined && texto !== null) el.textContent = texto;
  return el;
}

async function api(rota) {
  const resposta = await fetch(rota, { headers: { Accept: 'application/json' } });
  if (resposta.status === 401) { location.href = '/login'; throw new Error('Sessão expirada. Entre novamente.'); }
  let dados = {};
  try { dados = await resposta.json(); } catch { dados = {}; }
  if (!resposta.ok) throw new Error(dados.erro || 'O painel não respondeu (HTTP ' + resposta.status + ').');
  return dados;
}

const plural = (n, um, varios) => n + ' ' + (n === 1 ? um : varios);
const hora = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }); };
const diaDe = (registro) => registro._dia;

function somarDias(dia, quantidade) {
  const [a, m, d] = dia.split('-').map(Number);
  return new Date(Date.UTC(a, m - 1, d + quantidade)).toISOString().slice(0, 10);
}

function nomeDoDia(dia) {
  if (dia === estado.hoje) return 'Hoje';
  if (estado.hoje && dia === somarDias(estado.hoje, -1)) return 'Ontem';
  const [a, m, d] = dia.split('-').map(Number);
  return new Date(a, m - 1, d).toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' });
}

function formatarTelefone(digitos) {
  if (!digitos) return '';
  const m = digitos.match(/^55(\d{2})(\d{4,5})(\d{4})$/);
  return m ? '+55 (' + m[1] + ') ' + m[2] + '-' + m[3] : '+' + digitos;
}

function identificacao(contato) {
  const telefone = formatarTelefone(contato.telefone);
  const final = String(contato.conversa).split('@')[0].slice(-4);
  return {
    nome: contato.nome || telefone || 'Contato …' + final,
    detalhe: [contato.nome ? telefone : '', telefone ? '' : 'número não informado pelo WhatsApp'].filter(Boolean).join(' · '),
  };
}

function assunto(intencao) {
  const fixos = { menu: 'menu', nao_entendi: 'orientação (não entendeu)', esclarecer: 'pediu para escolher o assunto', agradecimento: 'agradecimento', ia: 'resposta da IA' };
  if (!intencao) return '';
  if (fixos[intencao]) return fixos[intencao];
  const opcao = (estado.config?.opcoes || []).find((o) => o.id === intencao);
  return opcao?.titulo || intencao;
}

// Número (sessão do WhatsApp) -> nome cadastrado em config.numeros. Preenchido ao carregar a configuração.
const nomesDosNumeros = new Map();

function mapearNumeros(config) {
  nomesDosNumeros.clear();
  for (const numero of config?.numeros || []) if (numero?.sessao) nomesDosNumeros.set(numero.sessao, numero.nome || '');
}

// Nome cadastrado para o número; sem nome, o próprio número (sessão). Sem sessão, devolve ''.
function nomeDoNumero(sessao) {
  if (!sessao) return '';
  return nomesDosNumeros.get(sessao) || sessao;
}

const explicarIA = (resultado) => resultadosIA[resultado] || (String(resultado).startsWith('erro_') ? 'a API de IA respondeu com erro ' + String(resultado).slice(5) : resultado);

// ---------- dados ----------

function diasDoPeriodo() {
  if (!estado.hoje) return [];
  const dias = [];
  for (let i = estado.periodo - 1; i >= 0; i -= 1) dias.push(somarDias(estado.hoje, -i));
  return dias;
}

async function carregarDia(dia) {
  const atual = estado.dias.get(dia) || { ate: 0, registros: [] };
  for (let voltas = 0; voltas < 50; voltas += 1) {
    const lido = await api('/api/conversas?dia=' + encodeURIComponent(dia) + '&de=' + atual.ate);
    if (lido.reiniciado) atual.registros = [];
    for (const registro of lido.registros) { registro._dia = dia; atual.registros.push(registro); }
    if (lido.registros.length || lido.reiniciado) estado.versao += 1;
    atual.ate = lido.ate;
    if (lido.fim) break;
  }
  estado.dias.set(dia, atual);
}

function registrosDoPeriodo() {
  return diasDoPeriodo().flatMap((dia) => estado.dias.get(dia)?.registros || []);
}

// Chave única de uma conversa: o mesmo contato falando com números (sessões) diferentes gera conversas separadas.
const chaveDe = (sessao, conversa) => (sessao || '') + '|' + conversa;

function agruparContatos(registros) {
  const contatos = new Map();
  for (const r of registros) {
    if (!r.conversa) continue;
    const chave = chaveDe(r.sessao, r.conversa);
    let c = contatos.get(chave);
    if (!c) { c = { chave, sessao: r.sessao || '', conversa: r.conversa, registros: [], nome: '', telefone: '', semResposta: false, equipe: false, ia: false, ultimoRegistro: null }; contatos.set(chave, c); }
    c.registros.push(r);
    if (r.nome) c.nome = r.nome;
    if (r.telefone) c.telefone = r.telefone;
    if (r.ia === 'respondeu') c.ia = true;
    // "Com a equipe": robô pausado para o contato (#humano, opção de atendente) até ser reativado
    // (#bot, "menu" digitado pelo contato ou fim da pausa, quando o robô volta a responder).
    if (r.resultado === 'robo_pausado' || r.motivo === 'em_atendimento_humano' || r.transferida) c.equipe = true;
    else if (r.resultado === 'robo_reativado' || (r.de === 'contato' && r.resultado === 'respondida')) c.equipe = false;
    if (r.de === 'contato') {
      c.semResposta = r.resultado !== 'respondida' && r.motivo !== 'agrupada_com_mensagem_seguinte';
      c.naoEntregue = r.resultado === 'falha_no_envio';
    }
    if (r.de === 'atendente') { c.semResposta = false; c.naoEntregue = false; }
    c.ultimoRegistro = r;
    c.ultimo = r.quando;
  }
  for (const c of contatos.values()) {
    c.buscavel = [c.nome, c.telefone, ...c.registros.flatMap((r) => [r.texto, r.resposta])].filter(Boolean).join(' \n ').toLocaleLowerCase('pt-BR');
  }
  return [...contatos.values()].sort((a, b) => String(b.ultimo).localeCompare(String(a.ultimo)));
}

function filtrar(contatos) {
  const termo = estado.busca.trim().toLocaleLowerCase('pt-BR');
  const digitos = termo.replace(/\D/g, '');
  return contatos.filter((c) => {
    if (estado.filtro === 'sem_resposta' && !c.semResposta) return false;
    if (estado.filtro === 'ia' && !c.ia) return false;
    if (estado.filtro === 'equipe' && !c.equipe) return false;
    if (!termo) return true;
    return c.buscavel.includes(termo) || (digitos.length >= 3 && String(c.telefone).includes(digitos));
  });
}

// ---------- desenho ----------

function previa(registro) {
  if (!registro) return '';
  if (registro.de === 'atendente') return 'Equipe: ' + (registro.texto || '');
  if (registro.resultado === 'respondida' && registro.resposta) return 'Robô: ' + registro.resposta;
  if (registro.resultado === 'falha_no_envio') return 'Não entregue: ' + (registro.texto || '');
  return registro.texto || (registro.midia ? 'Foto, áudio ou arquivo' : '');
}

function desenharContatos(contatos) {
  const lista = $('#contatos');
  const filtrados = filtrar(contatos);
  lista.replaceChildren();
  for (const c of filtrados) {
    const { nome } = identificacao(c);
    const item = elemento('li');
    const botao = elemento('button', 'contato' + (c.chave === estado.selecionada ? ' ativo' : ''));
    botao.type = 'button';
    botao.dataset.chave = c.chave;
    if (c.chave === estado.selecionada) botao.setAttribute('aria-current', 'true');
    const linha1 = elemento('span', 'contato-linha');
    linha1.append(elemento('strong', 'contato-nome', nome));
    if (c.sessao) linha1.append(elemento('small', 'contato-numero', nomeDoNumero(c.sessao)));
    linha1.append(elemento('time', 'contato-hora', (diaDe(c.registros.at(-1)) === estado.hoje ? '' : nomeDoDia(diaDe(c.registros.at(-1))) + ' ') + hora(c.ultimo)));
    const linha2 = elemento('span', 'contato-previa', previa(c.ultimoRegistro).replace(/\s+/g, ' ').slice(0, 120));
    const marcas = elemento('span', 'marcas');
    if (c.naoEntregue) marcas.append(elemento('span', 'marca-estado erro', 'não entregue'));
    else if (c.semResposta) marcas.append(elemento('span', 'marca-estado alerta', 'sem resposta'));
    if (c.equipe) marcas.append(elemento('span', 'marca-estado equipe', 'com a equipe'));
    if (c.ia) marcas.append(elemento('span', 'marca-estado ia', 'IA'));
    botao.append(linha1, linha2);
    if (marcas.childElementCount) botao.append(marcas);
    item.append(botao);
    lista.append(item);
  }
  const vazio = $('#sem-contatos');
  vazio.hidden = filtrados.length > 0;
  vazio.textContent = contatos.length ? 'Nenhuma conversa com esse filtro.' : estado.periodo === 1 ? 'Nenhuma conversa hoje ainda. As mensagens aparecem aqui assim que chegarem.' : 'Nenhuma conversa no período.';
}

function nota(texto, classe = '') {
  return elemento('div', 'nota-conversa' + (classe ? ' ' + classe : ''), texto);
}

function textoDoWhatsApp(texto) {
  const alvo = elemento('span', 'balao-texto');
  const estilos = { '*': 'strong', _: 'em', '~': 's' };
  const padrao = /([*_~])(?=\S)([^\n]*?\S)\1(?![\p{L}\p{N}])/gu;
  let posicao = 0;
  for (const achado of String(texto).matchAll(padrao)) {
    const antes = String(texto)[achado.index - 1];
    if (antes && /[\p{L}\p{N}]/u.test(antes)) continue;
    alvo.append(document.createTextNode(String(texto).slice(posicao, achado.index)), elemento(estilos[achado[1]], '', achado[2]));
    posicao = achado.index + achado[0].length;
  }
  alvo.append(document.createTextNode(String(texto).slice(posicao)));
  return alvo;
}

function balao(classe, texto, rotulo, quando) {
  const b = elemento('div', 'balao ' + classe);
  if (rotulo) b.append(elemento('span', 'balao-rotulo', rotulo));
  b.append(textoDoWhatsApp(texto));
  if (quando) b.append(elemento('time', 'balao-hora', hora(quando)));
  return b;
}

function desenharMensagens(contatos) {
  const area = $('#mensagens');
  const contato = contatos.find((c) => c.chave === estado.selecionada);
  const perto = area.scrollHeight - area.scrollTop - area.clientHeight < 80;
  if (!contato) {
    $('#contato-nome').textContent = 'Escolha uma conversa';
    $('#contato-numero').textContent = contatos.length ? 'As mensagens aparecem aqui' : 'Nenhuma conversa no período';
    $('#contato-avatar').textContent = '✳';
    $('#abrir-whatsapp').hidden = true;
    const inicio = elemento('div', 'inicio-conversa');
    inicio.append(elemento('span', '', '✉'), elemento('p', '', 'Escolha uma conversa na lista.'), elemento('small', '', 'Mensagens do contato à esquerda; respostas do robô e da equipe à direita.'));
    inicio.firstChild.setAttribute('aria-hidden', 'true');
    area.replaceChildren(inicio);
    return;
  }
  const { nome, detalhe } = identificacao(contato);
  $('#contato-nome').textContent = nome;
  const pelo = contato.sessao ? 'pelo número ' + nomeDoNumero(contato.sessao) : '';
  $('#contato-numero').textContent = [detalhe || 'Conversa no WhatsApp', pelo].filter(Boolean).join(' · ');
  $('#contato-avatar').textContent = (nome.match(/[A-Za-zÀ-ÿ0-9]/) || ['✳'])[0].toUpperCase();
  const link = $('#abrir-whatsapp');
  link.hidden = !contato.telefone;
  if (contato.telefone) link.href = 'https://wa.me/' + encodeURIComponent(contato.telefone);

  const itens = [];
  let diaAnterior = '';
  for (const r of contato.registros) {
    if (diaDe(r) !== diaAnterior) { itens.push(elemento('div', 'separador-dia', nomeDoDia(diaDe(r)))); diaAnterior = diaDe(r); }
    if (r.de === 'atendente') {
      itens.push(balao('equipe', r.texto || '(sem texto)', 'Equipe · pelo celular', r.quando));
      if (r.resultado === 'robo_pausado') itens.push(nota(r.motivo === 'atendente_respondeu'
        ? 'Alguém da equipe respondeu pelo celular: o robô parou de responder a este contato. Digite #bot para devolver ao robô.'
        : 'Robô pausado para este contato (#humano). Digite #bot para devolver ao robô.'));
      if (r.resultado === 'robo_reativado') {
        itens.push(nota('Robô reativado para este contato (#bot).'));
        if (r.resposta) itens.push(balao('robo', r.resposta, 'Robô · aviso de reativação', r.quando));
      }
      continue;
    }
    const texto = r.texto || (r.midia ? '📎 Foto, áudio ou arquivo sem texto' : '(mensagem vazia)');
    itens.push(balao('recebida', r.midia && r.texto ? texto + '\n📎 com anexo' : texto, '', r.quando));
    if (r.voltou_do_atendimento) itens.push(nota('O contato saiu do atendimento da equipe e voltou ao robô.'));
    if (r.resultado === 'respondida') {
      const deIA = r.ia === 'respondeu';
      const rotulo = deIA ? 'Robô · resposta da IA' : 'Robô · ' + (assunto(r.intencao) || 'resposta');
      itens.push(balao(deIA ? 'robo de-ia' : 'robo', r.resposta || '(resposta não registrada)', rotulo, r.quando));
      if (r.ia && !deIA) itens.push(nota('IA consultada, mas ' + explicarIA(r.ia) + '. Foi enviada a orientação normal.', FALHAS_DA_IA.test(r.ia) ? 'erro' : ''));
      if (r.transferida) itens.push(nota('Contato encaminhado para a equipe: o robô fica pausado para ele.'));
    } else if (r.resultado === 'falha_no_envio') {
      itens.push(balao('robo falhou', r.resposta || '', 'Não entregue · falha ao enviar pelo WhatsApp', r.quando));
    } else {
      let explicacao = 'Sem resposta: ' + (motivos[r.motivo] || r.motivo || 'motivo não informado') + '.';
      if (r.ia && r.ia !== 'respondeu') explicacao += ' IA: ' + explicarIA(r.ia) + '.';
      itens.push(nota(explicacao, r.motivo === 'agrupada_com_mensagem_seguinte' ? 'discreta' : 'alerta'));
    }
  }
  const mudouDeContato = area.dataset.chave !== contato.chave;
  area.dataset.chave = contato.chave;
  area.replaceChildren(...itens);
  if (mudouDeContato || perto) area.scrollTop = area.scrollHeight;
}

function desenharIndicadores() {
  const hoje = (estado.dias.get(estado.hoje)?.registros || []);
  const recebidas = hoje.filter((r) => r.de === 'contato');
  const respondidas = recebidas.filter((r) => r.resultado === 'respondida').length;
  const semResposta = recebidas.filter((r) => !['respondida', 'falha_no_envio'].includes(r.resultado) && r.motivo !== 'agrupada_com_mensagem_seguinte').length;
  const naoEntregues = recebidas.filter((r) => r.resultado === 'falha_no_envio').length;
  const pessoas = new Set(recebidas.map((r) => chaveDe(r.sessao, r.conversa))).size;
  $('#hoje-recebidas').textContent = String(recebidas.length);
  $('#hoje-detalhe').textContent = [plural(pessoas, 'pessoa', 'pessoas'), plural(respondidas, 'respondida', 'respondidas'), semResposta + ' sem resposta', naoEntregues ? plural(naoEntregues, 'não entregue', 'não entregues') : ''].filter(Boolean).join(' · ');

  const ia = estado.config?.ia || {};
  const consultas = hoje.filter((r) => r.ia && !String(r.ia).startsWith('limite_')).length;
  const respondeu = hoje.filter((r) => r.ia === 'respondeu').length;
  const brutoDiario = ia.max_usos_por_dia;
  const semLimite = brutoDiario !== undefined && brutoDiario !== null && brutoDiario !== '' && Number(brutoDiario) === 0;
  const limite = Number(brutoDiario) > 0 ? Number(brutoDiario) : 80;
  const esgotado = !semLimite && consultas >= limite;
  $('#hoje-ia').textContent = ia.ativa === true ? (semLimite ? consultas + ' · sem limite' : consultas + ' de ' + limite) : 'Desligada';
  $('#ia-detalhe').textContent = ia.ativa === true ? plural(respondeu, 'respondida', 'respondidas') + ' pela IA' + (esgotado ? '. Cota do dia esgotada' : '') : 'Ligue com scripts\\configurar-ia.ps1';
  $('#card-ia').dataset.situacao = ia.ativa === true && esgotado ? 'alerta' : 'neutro';

  const w = estado.whatsapp || {};
  const card = $('#card-whatsapp');
  let titulo; let situacao; let detalhe;
  if (w.servicoNoAr === false) {
    [titulo, situacao, detalhe] = ['Fora do ar', 'erro', 'O serviço do WhatsApp está desligado. Rode: docker compose up -d'];
  } else if (w.status && situacoesWhatsApp[w.status]) {
    [titulo, situacao, detalhe] = situacoesWhatsApp[w.status];
    const quando = new Date(w.quando);
    if (!Number.isNaN(quando.getTime())) detalhe = 'Desde ' + (w.quando.slice(0, 10) === estado.hoje ? 'hoje' : quando.toLocaleDateString('pt-BR')) + ', ' + hora(w.quando) + '. ' + detalhe;
  } else if (w.status) {
    [titulo, situacao, detalhe] = [w.status, 'neutro', 'Desde ' + hora(w.quando)];
  } else {
    [titulo, situacao, detalhe] = ['Sem informação', 'neutro', 'Nenhuma mudança de status registrada ainda'];
  }
  $('#whatsapp-status').textContent = titulo;
  $('#whatsapp-detalhe').textContent = detalhe;
  card.dataset.situacao = situacao;

  const lista = errosParaMostrar();
  const deHoje = lista.filter((e) => String(e.quando).slice(0, 10) === estado.hoje).length;
  $('#total-erros').textContent = String(lista.length);
  $('#erros-detalhe').textContent = deHoje + ' hoje · últimos ' + estado.retencao + ' dias';
  $('#card-erros').dataset.situacao = deHoje ? 'erro' : 'neutro';
}

function explicarErro(e) {
  const tecnico = [e.erro, e.descricao].filter(Boolean).join(' — ');
  if (e.http === 422 || /Session status is not as expected/i.test(tecnico)) return ['O WhatsApp não estava conectado quando o robô tentou responder.', 'Confira a situação do WhatsApp no topo da página. ' + tecnico];
  if (e.no === 'WAHA: enviar resposta') return ['Não foi possível enviar uma resposta pelo WhatsApp.', /^Não foi possível enviar/.test(tecnico) ? 'O robô tentou 2 vezes. A conversa do contato mostra qual resposta não foi entregue.' : tecnico];
  if (/^Redis/.test(e.no || '')) return ['Falha ao acessar a memória do robô (Redis).', tecnico];
  if (/config/i.test(tecnico)) return ['Problema no arquivo de configuração do robô.', tecnico];
  return [e.erro || 'Falha no atendimento automático.', [e.descricao, e.no ? 'Etapa: ' + e.no : ''].filter(Boolean).join(' · ')];
}

function errosParaMostrar() {
  const doRobo = estado.erros.map((e) => ({ ...e, origem: 'robo' }));
  const daIA = [...estado.dias.values()].flatMap((d) => d.registros).filter((r) => r.ia && FALHAS_DA_IA.test(r.ia)).map((r) => ({ quando: r.quando, origem: 'ia', ia: r.ia, sessao: r.sessao, conversa: r.conversa, nome: r.nome, telefone: r.telefone }));
  return [...doRobo, ...daIA].sort((a, b) => String(b.quando).localeCompare(String(a.quando)));
}

function desenharErros() {
  const lista = $('#lista-erros');
  const erros = errosParaMostrar().slice(0, 150);
  lista.replaceChildren();
  for (const e of erros) {
    const item = elemento('li', 'erro-item' + (e.origem === 'ia' ? ' ia' : ''));
    const [titulo, detalhe] = e.origem === 'ia'
      ? ['IA: ' + explicarIA(e.ia) + '.', 'Na conversa com ' + identificacao(e).nome + '. O contato recebeu a orientação normal.']
      : explicarErro(e);
    const quando = new Date(e.quando);
    const data = Number.isNaN(quando.getTime()) ? '' : (String(e.quando).slice(0, 10) === estado.hoje ? 'Hoje' : quando.toLocaleDateString('pt-BR')) + ', ' + hora(e.quando);
    const corpo = elemento('div', 'erro-corpo');
    corpo.append(elemento('strong', '', titulo));
    if (detalhe) corpo.append(elemento('small', '', detalhe));
    item.append(elemento('time', 'erro-quando', data), corpo);
    if (e.origem === 'ia' && e.conversa) {
      const abrir = elemento('button', 'botao-texto', 'Ver conversa');
      abrir.type = 'button';
      abrir.dataset.chave = chaveDe(e.sessao, e.conversa);
      item.append(abrir);
    }
    lista.append(item);
  }
  $('#sem-erros').hidden = erros.length > 0;
}

function desenhar(forcar = false) {
  if (!forcar && estado.desenhada === estado.versao) return;
  estado.desenhada = estado.versao;
  const contatos = agruparContatos(registrosDoPeriodo());
  desenharContatos(contatos);
  desenharMensagens(contatos);
  desenharIndicadores();
  desenharErros();
}

// ---------- histórico do banco ----------
// Quando o banco está no ar, a página mostra o histórico completo (busca, período, paginação).
// Sem banco, continua no modo "ao vivo", lendo os arquivos recentes.

const hist = { ativo: false, disponivel: false, pagina: 0, temMais: false, carregando: false, selecionada: null };

async function apiBanco(rota) {
  let resposta;
  try { resposta = await fetch(rota, { headers: { Accept: 'application/json' } }); }
  catch { const e = new Error('Não foi possível conectar ao painel.'); e.banco = false; throw e; }
  if (resposta.status === 401) { location.href = '/login'; throw new Error('Sessão expirada. Entre novamente.'); }
  let dados = {};
  try { dados = await resposta.json(); } catch { dados = {}; }
  if (!resposta.ok) {
    const e = new Error(dados.erro || 'O painel não respondeu (HTTP ' + resposta.status + ').');
    e.banco = resposta.status === 503 && dados.bancoIndisponivel === true;
    throw e;
  }
  return dados;
}

const dataHora = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
};
const diaLocal = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' });
};

function consultaHistorico(pagina) {
  const p = new URLSearchParams();
  if ($('#h-de').value) p.set('de', $('#h-de').value);
  if ($('#h-ate').value) p.set('ate', $('#h-ate').value);
  if ($('#h-busca').value.trim()) p.set('busca', $('#h-busca').value.trim());
  p.set('pagina', String(pagina));
  return '/api/historico?' + p.toString();
}

function itemDoHistorico(m) {
  const { nome } = identificacao({ nome: m.nome, telefone: m.telefone, conversa: m.conversa || '' });
  const li = elemento('li');
  const botao = elemento('button', 'contato' + (hist.selecionada === m.conversa ? ' ativo' : ''));
  botao.type = 'button';
  botao.dataset.conversa = m.conversa || '';
  botao.dataset.nome = m.nome || '';
  botao.dataset.telefone = m.telefone || '';
  botao.dataset.sessao = m.sessao || '';
  const linha1 = elemento('span', 'contato-linha');
  linha1.append(elemento('strong', 'contato-nome', nome));
  if (m.sessao) linha1.append(elemento('small', 'contato-numero', nomeDoNumero(m.sessao)));
  linha1.append(elemento('time', 'contato-hora', dataHora(m.quando)));
  const linha2 = elemento('span', 'contato-previa', (m.texto || '(sem texto)').replace(/\s+/g, ' ').slice(0, 120));
  botao.append(linha1, linha2);
  if (m.resposta) botao.append(elemento('span', 'contato-previa contato-resposta', 'Robô: ' + String(m.resposta).replace(/\s+/g, ' ').slice(0, 120)));
  const marcas = elemento('span', 'marcas');
  if (m.resultado && m.resultado !== 'respondida') marcas.append(elemento('span', 'marca-estado alerta', 'sem resposta'));
  if (m.ia === 'respondeu') marcas.append(elemento('span', 'marca-estado ia', 'IA'));
  if (marcas.childElementCount) botao.append(marcas);
  li.append(botao);
  return li;
}

async function buscarHistorico(reiniciar) {
  if (hist.carregando) return;
  hist.carregando = true;
  const proxima = reiniciar ? 1 : hist.pagina + 1;
  try {
    const dados = await apiBanco(consultaHistorico(proxima));
    const itens = Array.isArray(dados.itens) ? dados.itens : [];
    const lista = $('#h-lista');
    if (reiniciar) lista.replaceChildren();
    for (const m of itens) lista.append(itemDoHistorico(m));
    hist.pagina = Number(dados.pagina) || proxima;
    hist.temMais = Boolean(dados.temMais);
    $('#h-mais').hidden = !hist.temMais;
    $('#h-vazio').hidden = lista.childElementCount > 0;
    $('#h-aviso').hidden = true;
    hist.disponivel = true;
  } catch (erro) {
    if (!hist.disponivel) throw erro;
    $('#h-aviso').textContent = erro.banco ? 'Histórico indisponível: banco de dados fora do ar. Tente de novo em instantes ou use o modo ao vivo.' : erro.message;
    $('#h-aviso').hidden = false;
  } finally {
    hist.carregando = false;
  }
}

function desenharConversaHistorico(itens, referencia) {
  const area = $('#h-mensagens');
  const { nome, detalhe } = identificacao({ nome: referencia.nome, telefone: referencia.telefone, conversa: referencia.conversa || '' });
  $('#h-nome').textContent = nome;
  $('#h-numero').textContent = [detalhe || 'Conversa no WhatsApp', referencia.sessao ? 'pelo número ' + nomeDoNumero(referencia.sessao) : '', plural(itens.length, 'registro', 'registros')].filter(Boolean).join(' · ');
  $('#h-avatar').textContent = (nome.match(/[A-Za-zÀ-ÿ0-9]/) || ['✳'])[0].toUpperCase();
  const nodos = [];
  let anterior = '';
  for (const r of itens) {
    const dia = diaLocal(r.quando);
    if (dia !== anterior) { nodos.push(elemento('div', 'separador-dia', dia)); anterior = dia; }
    if (r.resultado === 'robo_pausado' || r.resultado === 'robo_reativado') {
      if (r.texto) nodos.push(balao('equipe', r.texto, 'Equipe · pelo celular', r.quando));
      nodos.push(nota(r.resultado === 'robo_pausado' ? 'Robô pausado para este contato.' : 'Robô reativado para este contato.'));
      continue;
    }
    nodos.push(balao('recebida', r.texto || '(mensagem vazia)', '', r.quando));
    if (r.resultado === 'respondida') {
      const deIA = r.ia === 'respondeu';
      nodos.push(balao(deIA ? 'robo de-ia' : 'robo', r.resposta || '(resposta não registrada)', deIA ? 'Robô · resposta da IA' : 'Robô · ' + (assunto(r.intencao) || 'resposta'), r.quando));
    } else if (r.resultado === 'falha_no_envio') {
      nodos.push(balao('robo falhou', r.resposta || '', 'Não entregue · falha ao enviar pelo WhatsApp', r.quando));
    } else {
      nodos.push(nota('Sem resposta: ' + (motivos[r.motivo] || r.motivo || 'motivo não informado') + '.', r.motivo === 'agrupada_com_mensagem_seguinte' ? 'discreta' : 'alerta'));
    }
  }
  area.replaceChildren(...nodos);
  area.scrollTop = area.scrollHeight;
}

async function abrirConversaHistorico(referencia) {
  if (!referencia.conversa) return;
  hist.selecionada = referencia.conversa;
  $('#historico-banco').classList.add('mostrando-conversa');
  $('#h-mensagens').replaceChildren(nota('Carregando a conversa…'));
  try {
    const dados = await apiBanco('/api/historico/conversa/' + encodeURIComponent(referencia.conversa));
    desenharConversaHistorico(Array.isArray(dados.itens) ? dados.itens : [], referencia);
  } catch (erro) {
    $('#h-mensagens').replaceChildren(nota(erro.banco ? 'Histórico indisponível: banco de dados fora do ar.' : erro.message, 'alerta'));
  }
  if (window.matchMedia('(max-width: 760px)').matches) $('#historico-banco').scrollIntoView({ block: 'start' });
}

function definirModo(modo) {
  hist.ativo = modo === 'historico';
  $('#historico-banco').hidden = !hist.ativo;
  $('#conversas').hidden = hist.ativo;
  for (const b of document.querySelectorAll('#seletor-modo button')) b.setAttribute('aria-pressed', String(b.dataset.modo === modo));
}

async function iniciarHistorico() {
  // Últimos 30 dias por padrão.
  const hojeLocal = new Date();
  const inicio = new Date(); inicio.setDate(inicio.getDate() - 29);
  const fmt = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  $('#h-de').value = fmt(inicio);
  $('#h-ate').value = fmt(hojeLocal);

  $('#h-filtros').addEventListener('submit', (evento) => { evento.preventDefault(); $('#historico-banco').classList.remove('mostrando-conversa'); buscarHistorico(true); });
  $('#h-mais').addEventListener('click', () => buscarHistorico(false));
  $('#h-voltar').addEventListener('click', () => $('#historico-banco').classList.remove('mostrando-conversa'));
  $('#h-lista').addEventListener('click', (evento) => {
    const botao = evento.target.closest('button[data-conversa]');
    if (!botao) return;
    const nodo = botao.querySelector('.contato-nome');
    const sessao = botao.querySelector('.contato-numero');
    for (const outro of $('#h-lista').querySelectorAll('button.ativo')) outro.classList.remove('ativo');
    botao.classList.add('ativo');
    abrirConversaHistorico({ conversa: botao.dataset.conversa, nome: botao.dataset.nome || '', telefone: botao.dataset.telefone || '', sessao: botao.dataset.sessao || '', rotulo: nodo ? nodo.textContent : '' });
  });
  for (const b of document.querySelectorAll('#seletor-modo button')) b.addEventListener('click', () => definirModo(b.dataset.modo));

  try {
    await buscarHistorico(true);
    $('#seletor-modo').hidden = false;
    definirModo('historico');
  } catch (erro) {
    // Sem banco (ou rota ausente): fica no modo atual, por arquivo.
    if (erro.banco) {
      $('#h-aviso').textContent = 'Histórico completo indisponível: banco de dados fora do ar. Mostrando as conversas recentes lidas dos arquivos.';
      $('#h-aviso').hidden = false;
    }
  }
}

// ---------- atualização ----------

async function atualizar() {
  if (estado.atualizando) return;
  estado.atualizando = true;
  try {
    const situacao = await api('/api/situacao');
    $('#dias-retencao').textContent = String(situacao.retencaoDias);
    if (!situacao.registros) throw new Error('O painel não tem acesso aos registros do robô. Inicie tudo pelo Docker: docker compose up -d');
    const mudouDia = estado.hoje !== situacao.hoje;
    estado.hoje = situacao.hoje;
    estado.retencao = situacao.retencaoDias;
    if (JSON.stringify(estado.whatsapp) !== JSON.stringify(situacao.whatsapp)) { estado.whatsapp = situacao.whatsapp; estado.versao += 1; }
    if (mudouDia) {
      estado.versao += 1;
      for (const dia of estado.dias.keys()) if (dia < somarDias(estado.hoje, -(estado.retencao - 1))) estado.dias.delete(dia);
    }
    for (const dia of diasDoPeriodo()) {
      // Dias anteriores não mudam mais: são lidos uma vez. O dia de hoje é lido do ponto em que parou.
      if (dia === estado.hoje || !estado.dias.has(dia)) await carregarDia(dia);
    }
    const { erros } = await api('/api/erros');
    if (JSON.stringify(erros) !== JSON.stringify(estado.erros)) { estado.erros = erros; estado.versao += 1; }
    $('#aviso').hidden = true;
    $('#atualizado').textContent = 'Atualizado às ' + new Date().toLocaleTimeString('pt-BR');
    $('#atualizado').classList.remove('falhou');
    desenhar();
  } catch (erro) {
    $('#aviso').textContent = erro.message || 'Não foi possível atualizar as conversas.';
    $('#aviso').hidden = false;
    $('#atualizado').textContent = 'Sem atualização desde ' + new Date().toLocaleTimeString('pt-BR');
    $('#atualizado').classList.add('falhou');
  } finally {
    estado.atualizando = false;
  }
}

function selecionar(chave) {
  estado.selecionada = chave;
  $('#conversas').classList.add('mostrando-conversa');
  desenhar(true);
  if (window.matchMedia('(max-width: 760px)').matches) $('#conversas').scrollIntoView({ block: 'start' });
}

function iniciar() {
  $('#contatos').addEventListener('click', (evento) => {
    const botao = evento.target.closest('button[data-chave]');
    if (botao) selecionar(botao.dataset.chave);
  });
  $('#lista-erros').addEventListener('click', (evento) => {
    const botao = evento.target.closest('button[data-chave]');
    if (!botao) return;
    if (estado.periodo < estado.retencao) { estado.periodo = estado.retencao; $('#periodo').value = String(estado.retencao); }
    estado.filtro = 'todas';
    estado.busca = '';
    $('#busca').value = '';
    for (const chip of document.querySelectorAll('.chips button')) chip.setAttribute('aria-pressed', String(chip.dataset.filtro === 'todas'));
    atualizar().then(() => { selecionar(botao.dataset.chave); $('#conversas').scrollIntoView({ behavior: 'smooth' }); });
  });
  $('#voltar-lista').addEventListener('click', () => $('#conversas').classList.remove('mostrando-conversa'));
  $('#busca').addEventListener('input', (evento) => { estado.busca = evento.target.value; desenhar(true); });
  $('#periodo').addEventListener('change', (evento) => {
    estado.periodo = Math.min(Number(evento.target.value) || 1, estado.retencao);
    $('#atualizado').textContent = 'Carregando…';
    atualizar().then(() => desenhar(true));
  });
  for (const chip of document.querySelectorAll('.chips button')) {
    chip.addEventListener('click', () => {
      estado.filtro = chip.dataset.filtro;
      for (const outro of document.querySelectorAll('.chips button')) outro.setAttribute('aria-pressed', String(outro === chip));
      desenhar(true);
    });
  }
  // Com a aba em segundo plano, a página para de consultar e retoma ao voltar.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) atualizar(); });
  setInterval(() => { if (!document.hidden) atualizar(); }, INTERVALO_MS);

  // A configuração é lida uma vez; se falhar, a página segue sem os nomes dos números.
  api('/api/config').then((dados) => { estado.config = dados.config; mapearNumeros(dados.config); desenhar(true); }).catch(() => {});
  atualizar();
}

iniciar();
iniciarHistorico();

// Mostra o botão "Sair" quando o login é obrigatório e trata o logout.
async function prepararSair() {
  const botao = document.getElementById('botao-sair');
  if (!botao) return;
  try {
    const r = await fetch('/api/sessao', { headers: { Accept: 'application/json' } });
    const s = await r.json();
    const admin = s.papel === 'admin' || ((s.papel === null || s.papel === undefined) && !s.loginObrigatorio);
    const aba = document.getElementById('aba-usuarios');
    if (aba) aba.hidden = !admin;
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
