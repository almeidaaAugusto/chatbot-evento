'use strict';

const $ = seletor => document.querySelector(seletor);
let config;
let revisao;
let inicial;
let estadoConversa = {};
let salvando = false;
let simulando = false;
let sequenciaCampo = 0;
let usosIA = 0;
let selecionado = 'produtora'; // v2: índice do evento em edição ou 'produtora'
const idsNovos = new Set(); // eventos criados nesta sessão (o id ainda pode mudar)
const nomesStatus = { ativo: 'Ativo', rascunho: 'Rascunho', encerrado: 'Encerrado' };
const nomesProdutora = { nome: 'Nome da produtora', instagram: 'Instagram', email: 'E-mail', linktree: 'Página com todos os links' };
const textoSemEventos = 'No momento não temos eventos com atendimento aberto. Acompanhe as novidades no nosso Instagram: {{instagram}}';
const textoEscolherEvento = 'Sobre qual evento você quer falar?\n\n{{eventos}}\n\nDigite o número do evento.';
const multi = () => Boolean(config) && Array.isArray(config.eventos);
const eventoAtual = () => (multi() && typeof selecionado === 'number' ? config.eventos[selecionado] || null : null);
const emProdutora = () => multi() && !eventoAtual();
// Partes da configuração que as seções 01 a 05 editam: o v1 inteiro ou o evento selecionado.
const dadosDoEvento = () => { const ev = eventoAtual(); if (!ev) return (config.evento ||= {}); return (ev.evento ||= {}); };
const mensagensDoEvento = () => { const ev = eventoAtual(); if (!ev) return (config.mensagens ||= {}); return (ev.mensagens ||= {}); };
const opcoesDoEvento = () => { const ev = eventoAtual(); if (!ev) return (config.opcoes ||= []); return (ev.opcoes ||= []); };
const fallbackEditado = () => { const ev = eventoAtual(); if (!ev) return (config.fallback ||= {}); return (ev.fallback ||= {}); };
const fallbackVigente = () => ({ ...(config.fallback || {}), ...(eventoAtual()?.fallback || {}) });
const iaEditada = () => { const ev = eventoAtual(); if (!ev) return (config.ia ||= {}); return (ev.ia ||= {}); };

function gerarId(nome, existentes) {
  const base = String(nome).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 56).replace(/-+$/, '') || 'evento';
  let id = base; let n = 2;
  while (existentes.has(id)) id = base + '-' + n++;
  return id;
}

const nomesEvento = { nome: 'Nome do evento', data: 'Data', horario: 'Horário de início', termino: 'Término previsto', cidade: 'Cidade', local: 'Local / endereço', ingresso: 'Ingresso e lote atual', lineup: 'Line-up', link_ingressos: 'Link de valores dos ingressos', link_compra: 'Link para comprar', instagram: 'Instagram do atendimento', grupo: 'Grupo oficial (WhatsApp)', linktree: 'Página com todos os links', email: 'E-mail' };
const camposLargos = ['nome', 'data', 'local', 'ingresso', 'lineup', 'link_ingressos', 'link_compra', 'instagram', 'grupo', 'linktree'];
const resultadosIA = {"sem_chave":"a chave da IA não está configurada (rode scripts\\configurar-ia.ps1)","limite_por_contato":"este contato já usou a IA o máximo de vezes permitido","limite_do_simulador":"o simulador já usou a IA 30 vezes na última hora","sem_resposta":"a IA não tinha essa informação","tempo_esgotado":"a IA demorou demais","erro_401":"a chave da IA foi recusada","erro_429":"a cota da API de IA esgotou por enquanto","erro_de_rede":"não foi possível conectar à API de IA","link_nao_confirmado":"a IA citou um link que não está cadastrado","contato_nao_confirmado":"a IA citou um contato que não está cadastrado","preco_nao_confirmado":"a IA citou um valor que não está cadastrado"};
const titulosPadrao = { qrcode: 'Onde encontro meu QR Code?', valores: 'Valores dos ingressos', local: 'Local e horário do evento', comprar: 'Comprar ingressos', atendente: 'Falar com um atendente' };
const fallbackPadrao = ['Não consegui identificar sua dúvida. Digite menu para ver as opções ou escreva o assunto que procura.', 'Ainda não entendi. Tente reformular com mais detalhes ou escolha uma opção do menu.', 'Para receber ajuda da nossa equipe, fale pelo Instagram: {{instagram}}. Quando quiser, digite menu para retomar.'];

function alterado() { return config && JSON.stringify(config) !== inicial; }

function atualizarSituacao() {
  const pendente = alterado();
  $('#situacao-titulo').textContent = salvando ? 'Salvando suas alterações…' : pendente ? 'Você tem alterações não salvas' : config ? 'Tudo salvo por aqui' : 'A configuração ainda não foi carregada';
  $('#situacao-detalhe').textContent = pendente ? 'Salve para usar o novo conteúdo no atendimento.' : 'Você pode testar novas ideias na prévia ao lado.';
  $('#indicador-salvo').classList.toggle('pendente', Boolean(pendente));
  $('#salvar').disabled = !config || !pendente || salvando;
  $('#recarregar').disabled = salvando;
  if (config) {
    const dados = multi() ? (eventoAtual()?.evento || {}) : (config.evento || {});
    const nome = multi() && !eventoAtual() ? (config.produtora?.nome || 'Produtora') : dados.nome;
    $('#nome-resumo').textContent = nome || 'Seu evento';
    $('#nome-conversa').textContent = (multi() ? config.produtora?.nome : dados.nome) || 'Atendimento do evento';
    $('#data-resumo').textContent = (multi() && !eventoAtual() ? 'Mensagens gerais da produtora' : [dados.data, dados.local].filter(Boolean).join(' · ')) || 'Conteúdo disponível neste computador';
  }
}

function feedback(texto, erro = false, detalhes = []) {
  const caixa = $('#feedback');
  caixa.replaceChildren(document.createTextNode(texto));
  caixa.classList.toggle('erro', erro);
  caixa.hidden = !texto;
  if (detalhes.length) {
    const lista = document.createElement('ul');
    for (const detalhe of detalhes) { const item = document.createElement('li'); item.textContent = detalhe; lista.append(item); }
    caixa.append(lista);
  }
}

function avisos(lista = []) {
  const caixa = $('#avisos');
  caixa.replaceChildren();
  caixa.hidden = !lista.length;
  if (!lista.length) return;
  const titulo = document.createElement('strong');
  titulo.textContent = 'Antes de colocar o atendimento em uso';
  const ul = document.createElement('ul');
  for (const texto of lista) { const li = document.createElement('li'); li.textContent = texto; ul.append(li); }
  caixa.append(titulo, ul);
}

async function api(rota, metodo = 'GET', corpo) {
  let res;
  try { res = await fetch(rota, { method: metodo, headers: corpo === undefined ? {} : { 'Content-Type': 'application/json' }, body: corpo === undefined ? undefined : JSON.stringify(corpo) }); }
  catch { throw new Error('Não foi possível conectar ao painel local. Confira se o serviço está ligado e tente novamente.'); }
  let dados;
  try { dados = await res.json(); } catch { throw new Error('O painel retornou uma resposta inesperada. Recarregue e tente novamente.'); }
  if (!res.ok) {
    const erro = new Error(dados.erro || 'Não foi possível concluir a operação.');
    erro.detalhes = dados.erros || [];
    erro.status = res.status;
    throw erro;
  }
  return dados;
}

function mudou() {
  feedback('');
  atualizarSituacao();
}

function campo({ titulo, valor = '', mudar, ajuda, linhas = false, classe = '', obrigatorio = false, padrao, maximo }) {
  const label = document.createElement('label');
  label.className = 'campo' + (classe.includes('campo-largo') ? ' campo-largo' : '');
  const span = document.createElement('span');
  span.textContent = titulo;
  const input = document.createElement(linhas ? 'textarea' : 'input');
  input.id = 'campo-' + ++sequenciaCampo;
  input.value = valor;
  input.required = obrigatorio;
  input.className = classe.replace('campo-largo', '').trim();
  if (padrao) input.pattern = padrao;
  if (maximo) input.maxLength = maximo;
  input.addEventListener('input', () => { mudar(input.value); mudou(); });
  label.append(span, input);
  if (ajuda) { const small = document.createElement('small'); small.id = input.id + '-ajuda'; small.textContent = ajuda; input.setAttribute('aria-describedby', small.id); label.append(small); }
  return label;
}

function listaTexto(texto) { return texto.split(/\r?\n/).map(item => item.trim()).filter(Boolean); }

function tituloOpcao(opcao) {
  if (opcao.titulo) return opcao.titulo;
  const numero = (opcao.palavras_exatas || []).find(texto => /^\d+$/.test(texto));
  if (numero) {
    const linha = (mensagensDoEvento().menu || '').split('\n').find(texto => new RegExp('^\\s*' + numero + '\\s*[-–—.:)]\\s*').test(texto));
    if (linha) return linha.replace(new RegExp('^\\s*' + numero + '\\s*[-–—.:)]\\s*'), '').trim();
  }
  return titulosPadrao[opcao.id] || opcao.id || 'Nova opção';
}

function renderizarOpcoes() {
  const lista = $('#lista-opcoes');
  lista.replaceChildren();
  const opcoes = opcoesDoEvento();
  opcoes.forEach((opcao, indice) => {
    const cartao = document.createElement('section'); cartao.className = 'opcao';
    const cabecalho = document.createElement('div'); cabecalho.className = 'opcao-cabecalho';
    const titulo = document.createElement('div'); titulo.className = 'opcao-titulo';
    const numero = document.createElement('span'); numero.className = 'opcao-badge'; numero.textContent = indice + 1;
    const nome = document.createElement('strong'); nome.textContent = tituloOpcao(opcao);
    titulo.append(numero, nome);
    const remover = document.createElement('button'); remover.type = 'button'; remover.className = 'botao-remover'; remover.textContent = 'Remover'; remover.setAttribute('aria-label', 'Remover opção ' + tituloOpcao(opcao));
    remover.addEventListener('click', () => { opcoes.splice(indice, 1); renderizarOpcoes(); mudou(); $('#adicionar-opcao').focus(); });
    cabecalho.append(titulo, remover);
    const grade = document.createElement('div'); grade.className = 'grade-campos';
    grade.append(campo({ titulo: 'Título no menu', valor: tituloOpcao(opcao), obrigatorio: true, mudar: valor => { opcao.titulo = valor; nome.textContent = valor || 'Nova opção'; } }));
    grade.append(campo({ titulo: 'Identificador', valor: opcao.id, ajuda: 'Sem espaços ou acentos. Ex.: local_evento', padrao: '[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}', maximo: 64, obrigatorio: true, mudar: valor => { opcao.id = valor; } }));
    const perguntas = campo({ titulo: 'Exemplos de perguntas', valor: (opcao.perguntas || []).join('\n'), linhas: true, classe: 'campo-largo', ajuda: 'Uma pergunta por linha. Ex.: Como faço para chegar?', mudar: valor => { opcao.perguntas = listaTexto(valor); } });
    const resposta = campo({ titulo: 'Resposta do atendimento', valor: opcao.resposta || '', linhas: true, classe: 'campo-largo resposta', obrigatorio: true, ajuda: 'Você pode usar os dados do evento: {{nome}}, {{local}}, {{data}}…', mudar: valor => { opcao.resposta = valor; } });
    const avancado = document.createElement('details');
    const summary = document.createElement('summary'); summary.textContent = 'Números, comandos e palavras-chave';
    const gradePalavras = document.createElement('div'); gradePalavras.className = 'grade-campos';
    gradePalavras.append(campo({ titulo: 'Mensagens exatas', valor: (opcao.palavras_exatas || []).join('\n'), linhas: true, ajuda: 'Uma por linha. Ex.: ' + (indice + 1), mudar: valor => { opcao.palavras_exatas = listaTexto(valor); } }));
    gradePalavras.append(campo({ titulo: 'Palavras-chave', valor: (opcao.palavras_chave || []).join('\n'), linhas: true, ajuda: 'Uma expressão por linha. Ex.: endereço', mudar: valor => { opcao.palavras_chave = listaTexto(valor); } }));
    avancado.append(summary, gradePalavras);
    cartao.append(cabecalho, grade, perguntas, resposta, avancado);
    lista.append(cartao);
  });
}

function mostrar(id, visivel) { $('#' + id).hidden = !visivel; }

function renderizar() {
  const v2 = multi(); const ev = eventoAtual(); const prod = emProdutora();
  mostrar('seletor-evento', v2); mostrar('aviso-v1', !v2);
  for (const [id, visivel] of [['identidade', Boolean(ev)], ['produtora-cartao', prod], ['dados', !prod], ['mensagens', !prod], ['opcoes', !prod]]) mostrar(id, visivel);
  $('#remover-evento').hidden = !ev; $('#nota-ia-evento').hidden = !ev;
  $('#area-simular-como').hidden = !v2;
  if (v2) { atualizarSeletores(); renderizarIdentidade(); renderizarProdutora(); }
  const evento = $('#campos-evento'); evento.replaceChildren();
  const campos = $('#campo-menu'); campos.replaceChildren(); $('#campos-mensagens').replaceChildren(); $('#lista-opcoes').replaceChildren();
  if (!prod) {
    const dados = dadosDoEvento();
    const chaves = [...new Set([...Object.keys(nomesEvento), ...Object.keys(dados).filter(chave => !chave.startsWith('_') && typeof dados[chave] === 'string')])];
    for (const chave of chaves) evento.append(campo({ titulo: nomesEvento[chave] || chave, valor: dados[chave] || '', classe: camposLargos.includes(chave) ? 'campo-largo' : '', mudar: valor => { dados[chave] = valor; if (chave === 'nome') atualizarRotulos(); } }));
    const mensagens = mensagensDoEvento();
    campos.append(campo({ titulo: 'Mensagem de boas-vindas e menu', valor: mensagens.menu || '', linhas: true, classe: 'menu', obrigatorio: true, mudar: valor => { mensagens.menu = valor; } }));
    const outras = [['nao_entendi', 'Resposta geral para dúvida não reconhecida']];
    if (!v2) outras.push(['reativado', 'Mensagem ao reativar o atendimento']);
    for (const [chave, titulo] of outras) $('#campos-mensagens').append(campo({ titulo, valor: mensagens[chave] || '', linhas: true, mudar: valor => { mensagens[chave] = valor; } }));
    renderizarOpcoes();
  }
  const fallback = $('#campos-fallback'); fallback.replaceChildren();
  const vigente = fallbackVigente();
  const lista = vigente.mensagens || fallbackPadrao;
  for (let i = 0; i < 3; i++) fallback.append(campo({ titulo: ['Primeira tentativa · orientar', 'Segunda tentativa · pedir mais detalhes', 'Terceira tentativa · encaminhar para a equipe'][i], valor: lista[i] || '', linhas: true, obrigatorio: true, mudar: valor => { const alvo = fallbackEditado(); alvo.mensagens ||= [...(fallbackVigente().mensagens || fallbackPadrao)]; alvo.mensagens[i] = valor; } }));
  fallback.append(campo({ titulo: 'Ao receber áudio ou imagem sem legenda', valor: vigente.mensagem_midia || 'Para eu ajudar, escreva sua dúvida em uma mensagem de texto. Ainda não consigo ouvir áudios ou interpretar imagens.', linhas: true, obrigatorio: true, mudar: valor => { fallbackEditado().mensagem_midia = valor; } }));
  renderizarIA();
  for (const fieldset of document.querySelectorAll('#editor>fieldset')) fieldset.disabled = false;
  $('#evento-atual').disabled = false;
  for (const id of ['texto-simulador', 'enviar-simulacao', 'simular-midia', 'reiniciar-conversa']) $('#' + id).disabled = false;
  atualizarSituacao();
}

function rotuloEvento(ev) { return (ev.evento?.nome || ev.id || 'Sem nome') + ' · ' + (nomesStatus[ev.status] || ev.status || '?'); }

// Reconstrói a lista de eventos do editor e do simulador (ao criar, remover ou carregar).
function atualizarSeletores() {
  const editor = $('#evento-atual'); editor.replaceChildren();
  const simular = $('#simular-como'); const anterior = simular.value; simular.replaceChildren();
  const novo = document.createElement('option'); novo.value = ''; novo.textContent = 'Contato novo (o robô escolhe o evento)'; simular.append(novo);
  config.eventos.forEach((ev, i) => {
    const o = document.createElement('option'); o.value = String(i); editor.append(o);
    const p = document.createElement('option'); p.value = ev.id; simular.append(p);
  });
  const geral = document.createElement('option'); geral.value = 'produtora'; geral.textContent = 'Produtora (geral)'; editor.append(geral);
  editor.value = typeof selecionado === 'number' ? String(selecionado) : 'produtora';
  atualizarRotulos();
  simular.value = [...simular.options].some(o => o.value === anterior) ? anterior : '';
  $('#rotulo-rascunhos').hidden = simular.value !== '';
}

// Atualiza só os textos (nome, status, id) sem perder a seleção.
function atualizarRotulos() {
  if (!multi()) return;
  const editor = $('#evento-atual'); const simular = $('#simular-como');
  config.eventos.forEach((ev, i) => {
    editor.options[i].textContent = rotuloEvento(ev);
    simular.options[i + 1].value = ev.id; simular.options[i + 1].textContent = rotuloEvento(ev);
  });
  const ev = eventoAtual(); const selo = $('#selo-status');
  selo.hidden = !ev;
  if (ev) { selo.textContent = nomesStatus[ev.status] || ev.status; selo.dataset.status = ev.status; }
}

function renderizarIdentidade() {
  const ev = eventoAtual(); const area = $('#campos-identidade'); area.replaceChildren();
  if (!ev) return;
  const id = campo({ titulo: 'Identificador do evento', valor: ev.id, obrigatorio: true, padrao: '[a-z0-9][a-z0-9\\-]{0,63}', maximo: 64, ajuda: idsNovos.has(ev.id) ? 'Letras minúsculas, números e hífens. Depois de salvar, não muda mais.' : 'Não pode ser alterado depois de criado.', mudar: valor => { ev.id = valor; atualizarRotulos(); } });
  if (!idsNovos.has(ev.id)) id.querySelector('input').readOnly = true;
  const status = document.createElement('label'); status.className = 'campo';
  const t = document.createElement('span'); t.textContent = 'Situação';
  const sel = document.createElement('select'); sel.id = 'campo-' + ++sequenciaCampo;
  for (const [valor, nome] of [['rascunho', 'Rascunho (só no simulador)'], ['ativo', 'Ativo (o robô atende)'], ['encerrado', 'Encerrado (arquivado)']]) { const o = document.createElement('option'); o.value = valor; o.textContent = nome; sel.append(o); }
  sel.value = ev.status;
  sel.addEventListener('change', () => { ev.status = sel.value; atualizarRotulos(); mudou(); });
  status.append(t, sel);
  const gatilhos = campo({ titulo: 'Gatilhos', valor: (ev.gatilhos || []).join('\n'), linhas: true, classe: 'campo-largo', ajuda: 'Uma palavra ou frase por linha. Quando o contato escreve um deles, o robô passa a falar deste evento. Ex.: nome da atração.', mudar: valor => { ev.gatilhos = listaTexto(valor); } });
  area.append(id, status, gatilhos);
}

function renderizarProdutora() {
  const area = $('#campos-produtora'); area.replaceChildren();
  const m = $('#campos-mensagens-gerais'); m.replaceChildren();
  if (!emProdutora()) return;
  config.produtora ||= {};
  const chaves = [...new Set([...Object.keys(nomesProdutora), ...Object.keys(config.produtora).filter(chave => !chave.startsWith('_') && typeof config.produtora[chave] === 'string')])];
  for (const chave of chaves) area.append(campo({ titulo: nomesProdutora[chave] || chave, valor: config.produtora[chave] || '', classe: ['nome', 'instagram', 'linktree'].includes(chave) ? 'campo-largo' : '', mudar: valor => { config.produtora[chave] = valor; } }));
  config.mensagens ||= {};
  for (const [chave, titulo, padrao, ajuda] of [
    ['escolher_evento', 'Menu de eventos (quando há mais de um ativo)', textoEscolherEvento, 'Use {{eventos}} onde a lista numerada deve aparecer.'],
    ['sem_eventos', 'Quando não há evento ativo', textoSemEventos, 'Resposta enquanto nenhum evento estiver com atendimento aberto.'],
    ['reativado', 'Mensagem ao reativar o atendimento', '', ''],
    ['agradecimento', 'Resposta a um agradecimento', '', '']])
    m.append(campo({ titulo, valor: config.mensagens[chave] ?? padrao, linhas: true, ajuda, mudar: valor => { config.mensagens[chave] = valor; } }));
}

function campoIA({ titulo, tipo = 'texto', chave, ajuda, opcoes, minimo, maximo, passo, linhas, largo }) {
  const ia = iaEditada();
  if (tipo === 'texto') return campo({ titulo, valor: ia[chave] || '', linhas, classe: largo ? 'campo-largo' : '', ajuda, mudar: valor => { if (valor.trim()) ia[chave] = valor; else delete ia[chave]; } });
  const label = document.createElement('label');
  label.className = 'campo' + (tipo === 'marcar' ? ' campo-marcar campo-largo' : '');
  const input = document.createElement(tipo === 'lista' ? 'select' : 'input');
  input.id = 'campo-' + ++sequenciaCampo;
  if (tipo === 'marcar') { input.type = 'checkbox'; input.checked = ia[chave] === true; }
  else if (tipo === 'lista') {
    for (const [valor, nome] of opcoes) { const item = document.createElement('option'); item.value = valor; item.textContent = nome; input.append(item); }
    input.value = ia[chave] || opcoes[0][0];
  } else { input.type = 'number'; input.min = minimo; input.max = maximo; input.step = passo || 1; input.value = ia[chave] ?? ''; input.inputMode = 'decimal'; }
  input.addEventListener(tipo === 'marcar' || tipo === 'lista' ? 'change' : 'input', () => {
    if (tipo === 'marcar') ia[chave] = input.checked;
    else if (tipo === 'lista') ia[chave] = input.value;
    else if (input.value === '') delete ia[chave];
    else ia[chave] = Number(input.value);
    mudou();
  });
  const span = document.createElement('span'); span.textContent = titulo;
  if (tipo === 'marcar') label.append(input, span); else label.append(span, input);
  if (ajuda) { const small = document.createElement('small'); small.id = input.id + '-ajuda'; small.textContent = ajuda; input.setAttribute('aria-describedby', small.id); label.append(small); }
  return label;
}

function renderizarIA() {
  const area = $('#campos-ia'); area.replaceChildren();
  if (eventoAtual()) {
    const c = campoIA({ titulo: 'Informações extras sobre este evento', chave: 'conhecimento', linhas: true, largo: true, ajuda: 'Tudo o que a IA pode usar sobre este evento além dos dados e das respostas. Liste também o que ainda não foi divulgado, para ela não inventar.' });
    c.querySelector('textarea').classList.add('conhecimento');
    area.append(c);
    return;
  }
  area.append(campoIA({ titulo: 'Usar a IA quando o atendimento não entender a mensagem', tipo: 'marcar', chave: 'ativa' }));
  const grade = document.createElement('div'); grade.className = 'grade-campos';
  grade.append(
    campoIA({ titulo: 'Provedor', tipo: 'lista', chave: 'provedor', opcoes: [['groq', 'Groq (gratuito, com cota)'], ['xai', 'xAI · Grok (pago)']], ajuda: 'A chave fica no arquivo .env, nunca neste painel.' }),
    campoIA({ titulo: 'Modelo', chave: 'modelo', ajuda: 'Vazio usa o padrão: openai/gpt-oss-120b (Groq) ou grok-4.3 (xAI).' }),
    campoIA({ titulo: 'Usos da IA por contato', tipo: 'numero', chave: 'max_usos_por_contato', minimo: 0, maximo: 1000, ajuda: 'Padrão 3. Depois disso o contato recebe as orientações normais.' }),
    campoIA({ titulo: 'Zerar o contador do contato após (horas)', tipo: 'numero', chave: 'janela_horas', minimo: 0.25, maximo: 720, passo: 0.25, ajuda: 'Padrão 12 horas sem usar a IA.' }),
    campoIA({ titulo: 'Usos da IA por dia (todos os contatos)', tipo: 'numero', chave: 'max_usos_por_dia', minimo: 0, maximo: 1000000, ajuda: 'Padrão 80. Protege a cota gratuita da API.' }),
    campoIA({ titulo: 'Tamanho máximo da resposta (caracteres)', tipo: 'numero', chave: 'tamanho_maximo_resposta', minimo: 120, maximo: 3000, ajuda: 'Padrão 600.' }),
  );
  const conhecimento = campoIA({ titulo: multi() ? 'Informações extras da produtora (valem para todos os eventos)' : 'Informações extras para a IA', chave: 'conhecimento', linhas: true, largo: true, ajuda: 'Tudo o que a IA pode usar além dos dados do evento e das respostas. Liste também o que ainda não foi divulgado, para ela não inventar.' });
  conhecimento.querySelector('textarea').classList.add('conhecimento');
  area.append(grade, conhecimento,
    campoIA({ titulo: 'Texto no fim das respostas da IA', chave: 'rodape', linhas: true, largo: true, ajuda: 'Opcional. Ex.: _Resposta automática. Digite *menu* para ver as opções._' }));
}

async function statusIA() {
  try {
    const dados = await api('/api/ia');
    $('#status-ia').textContent = dados.chaveConfigurada
      ? 'Chave da IA configurada' + (dados.provedorDaChave ? ' (' + (dados.provedorDaChave === 'groq' ? 'Groq' : 'xAI') + ')' : '') + '. O simulador usa a IA de verdade e gasta a mesma cota.'
      : 'Sem chave da IA neste computador. Para ligar, rode no terminal: powershell -ExecutionPolicy Bypass -File scripts\\configurar-ia.ps1';
    $('#status-ia').classList.toggle('pendente', !dados.chaveConfigurada);
  } catch { $('#status-ia').textContent = 'Não foi possível verificar a chave da IA.'; }
}

function estruturaValida(c) {
  if (!c.mensagens || typeof c.mensagens !== 'object') return false;
  if (Array.isArray(c.eventos)) return c.eventos.every(ev => ev && typeof ev === 'object' && !Array.isArray(ev));
  return Array.isArray(c.opcoes) && c.opcoes.every(opcao => opcao && typeof opcao === 'object');
}

async function carregar() {
  $('#recarregar').disabled = true;
  try {
    const dados = await api('/api/config');
    if (!dados.config || Array.isArray(dados.config) || !estruturaValida(dados.config)) throw new Error('A estrutura da configuração está inválida. Corrija o arquivo de configuração antes de usar o painel.');
    config = structuredClone(dados.config); revisao = dados.revisao; inicial = JSON.stringify(config);
    idsNovos.clear();
    const primeiroAtivo = multi() ? config.eventos.findIndex(ev => ev.status === 'ativo') : -1;
    selecionado = primeiroAtivo >= 0 ? primeiroAtivo : 'produtora';
    $('#simular-como').value = '';
    renderizar(); avisos(dados.avisos); feedback(''); reiniciarConversa(); statusIA();
  } catch (erro) { feedback(erro.message, true, erro.detalhes); atualizarSituacao(); }
  finally { $('#recarregar').disabled = false; }
}

function reiniciarConversa() {
  estadoConversa = {};
  usosIA = 0;
  const inicio = document.createElement('div'); inicio.className = 'inicio-conversa';
  const simbolo = document.createElement('span'); simbolo.textContent = '↗'; simbolo.setAttribute('aria-hidden', 'true');
  const titulo = document.createElement('p'); titulo.textContent = 'Que tal começar com um “oi”?';
  const ajuda = document.createElement('small'); ajuda.textContent = 'Digite como se fosse um participante.';
  inicio.append(simbolo, titulo, ajuda); $('#historico').replaceChildren(inicio); $('#erro-simulador').hidden = true;
}

function balao(texto, tipo) {
  $('#historico .inicio-conversa')?.remove();
  const div = document.createElement('div'); div.className = 'balao ' + (tipo || ''); div.textContent = texto;
  $('#historico').append(div); $('#historico').scrollTop = $('#historico').scrollHeight;
}

async function simular(midia = false) {
  if (simulando || !config) return;
  const input = $('#texto-simulador'); const texto = input.value.trim();
  if (!midia && !texto) { input.focus(); return; }
  simulando = true;
  for (const id of ['enviar-simulacao', 'simular-midia', 'reiniciar-conversa']) $('#' + id).disabled = true;
  $('#erro-simulador').hidden = true;
  try {
    const corpo = { config: structuredClone(config), texto: midia ? '' : texto, estado: estadoConversa, midia, usosIA };
    if (multi()) { const como = $('#simular-como').value; if (como) corpo.eventoId = como; else corpo.incluirRascunhos = $('#incluir-rascunhos').checked; }
    const resultado = await api('/api/simular', 'POST', corpo);
    balao(midia ? 'Áudio ou imagem sem legenda' : texto, 'usuario');
    if (resultado.ia?.resultado && resultado.ia.resultado !== 'respondeu') balao('IA não usada: ' + (resultadosIA[resultado.ia.resultado] || resultado.ia.resultado) + '.', 'silencio');
    if (resultado.resposta) balao(resultado.resposta, resultado.intencao === 'ia' ? 'ia' : '');
    else balao('O atendimento aguarda uma opção reconhecida para continuar.', 'silencio');
    estadoConversa = resultado.estado || {};
    usosIA = Number.isInteger(resultado.usosIA) ? resultado.usosIA : usosIA;
    input.value = '';
  } catch (erro) { $('#erro-simulador').textContent = [erro.message, ...(erro.detalhes || [])].join('\n'); $('#erro-simulador').hidden = false; }
  finally { simulando = false; for (const id of ['enviar-simulacao', 'simular-midia', 'reiniciar-conversa']) $('#' + id).disabled = false; input.focus(); }
}

$('#editor').addEventListener('submit', async evento => {
  evento.preventDefault();
  if (salvando || !config || !alterado()) return;
  if (!$('#editor').reportValidity()) return;
  salvando = true; atualizarSituacao();
  const enviada = structuredClone(config);
  try {
    const dados = await api('/api/config', 'PUT', { config: enviada, revisao });
    revisao = dados.revisao;
    inicial = JSON.stringify(dados.config);
    avisos(dados.avisos);
    feedback('Alterações salvas. O novo conteúdo será usado na próxima mensagem recebida.');
  } catch (erro) { feedback(erro.message, true, erro.detalhes); $('#feedback').scrollIntoView({ block: 'center' }); }
  finally { salvando = false; atualizarSituacao(); }
});

$('#gerar-menu').addEventListener('click', () => {
  const linhas = opcoesDoEvento().map(opcao => {
    const numero = (opcao.palavras_exatas || []).find(texto => /^\d+$/.test(texto));
    const seletor = numero || (opcao.palavras_exatas || []).find(texto => texto.trim());
    return (seletor ? seletor + ' - ' : '') + tituloOpcao(opcao);
  });
  const menu = mensagensDoEvento();
  menu.menu = 'Olá! Boas-vindas ao ' + (dadosDoEvento().nome || 'nosso evento') + '!\n\nComo podemos ajudar?\n\n' + linhas.join('\n') + '\n\nDigite o número ou escreva o assunto da opção desejada.';
  $('#campo-menu textarea').value = menu.menu;
  mudou(); feedback('Menu atualizado com as opções atuais. Salve para usar esta versão.');
});

$('#adicionar-opcao').addEventListener('click', () => {
  const opcoes = opcoesDoEvento();
  const ids = new Set(opcoes.map(opcao => opcao.id));
  let i = opcoes.length + 1; while (ids.has('opcao_' + i)) i++;
  const numeros = new Set(opcoes.flatMap(opcao => opcao.palavras_exatas || []));
  let numero = opcoes.length + 1; while (numeros.has(String(numero))) numero++;
  opcoes.push({ id: 'opcao_' + i, titulo: 'Nova opção', palavras_exatas: [String(numero)], palavras_chave: [], perguntas: [], resposta: '' });
  renderizarOpcoes(); mudou(); $('#lista-opcoes .opcao:last-child input').focus();
});

function abrirDialogo(dialog, aoFechar) {
  dialog.returnValue = 'cancelar';
  dialog.addEventListener('close', () => aoFechar(dialog.returnValue), { once: true });
  dialog.showModal();
}

function trocarSelecao(valor) {
  selecionado = valor;
  renderizar();
}

$('#evento-atual').addEventListener('change', () => { const v = $('#evento-atual').value; trocarSelecao(v === 'produtora' ? 'produtora' : Number(v)); });
$('#simular-como').addEventListener('change', () => { $('#rotulo-rascunhos').hidden = $('#simular-como').value !== ''; reiniciarConversa(); });
$('#incluir-rascunhos').addEventListener('change', reiniciarConversa);

$('#nome-novo').addEventListener('input', () => {
  const nome = $('#nome-novo').value.trim();
  $('#id-novo').textContent = nome ? 'Identificador: ' + gerarId(nome, new Set(config.eventos.map(ev => ev.id))) : '';
});
$('#novo-evento').addEventListener('click', () => {
  $('#nome-novo').value = ''; $('#id-novo').textContent = '';
  abrirDialogo($('#dialogo-novo'), retorno => {
    const nome = $('#nome-novo').value.trim();
    if (retorno !== 'criar' || !nome) return;
    const id = gerarId(nome, new Set(config.eventos.map(ev => ev.id)));
    const base = eventoAtual();
    const novo = base ? structuredClone(base) : { evento: {}, mensagens: { menu: 'Olá! Boas-vindas ao {{nome}}!\n\nEm breve teremos mais informações por aqui.' }, opcoes: [] };
    novo.id = id; novo.status = 'rascunho'; novo.gatilhos = [];
    novo.evento = { ...(novo.evento || {}), nome };
    config.eventos.push(novo); idsNovos.add(id);
    trocarSelecao(config.eventos.length - 1);
    mudou(); feedback('Rascunho criado. Ajuste os dados, teste no simulador e mude a situação para Ativo quando estiver pronto.');
  });
  $('#nome-novo').focus();
});
$('#criar-evento').addEventListener('click', evento => { if (!$('#nome-novo').value.trim()) { evento.preventDefault(); $('#nome-novo').focus(); } });

$('#remover-evento').addEventListener('click', () => {
  const ev = eventoAtual(); if (!ev) return;
  if (ev.status === 'ativo') { feedback('Um evento ativo não pode ser removido. Mude a situação para Encerrado ou Rascunho primeiro.', true); return; }
  $('#texto-remover').textContent = 'O evento “' + (ev.evento?.nome || ev.id) + '” será removido do arquivo quando você salvar. Para só arquivar, prefira a situação Encerrado.';
  abrirDialogo($('#dialogo-remover'), retorno => {
    if (retorno !== 'remover') return;
    idsNovos.delete(ev.id); config.eventos.splice(selecionado, 1);
    trocarSelecao('produtora'); mudou(); reiniciarConversa();
  });
});

// Mesma regra do migrarParaV2 (lib/eventos.js), de forma mínima para o navegador.
function converterParaV2(v1, nomeProdutora) {
  const { evento = {}, mensagens = {}, opcoes = [], ia = {}, fallback, ...raiz } = v1;
  const { menu, nao_entendi: naoEntendi, ...mensagensGerais } = mensagens;
  const { conhecimento, ...iaGlobal } = ia;
  const produtora = { nome: nomeProdutora };
  const dadosEvento = { ...evento };
  // Os contatos da produtora saem do evento: uma cópia ali sobrescreveria a da produtora.
  for (const chave of ['instagram', 'email', 'linktree']) {
    if (evento[chave]) produtora[chave] = evento[chave];
    delete dadosEvento[chave];
  }
  const novo = { id: gerarId(evento.nome || 'evento', new Set()), status: 'ativo', gatilhos: evento.nome ? [evento.nome.toLowerCase()] : [], evento: dadosEvento, mensagens: { menu, ...(naoEntendi ? { nao_entendi: naoEntendi } : {}) }, opcoes };
  if (conhecimento) novo.ia = { conhecimento };
  const v2 = { ...raiz, versao: 2, produtora, mensagens: { sem_eventos: textoSemEventos, escolher_evento: textoEscolherEvento, ...mensagensGerais }, ...(fallback ? { fallback } : {}), ia: iaGlobal, eventos: [novo] };
  if (!Object.keys(iaGlobal).length) delete v2.ia;
  return v2;
}
$('#converter-v2').addEventListener('click', () => {
  $('#nome-produtora').value = config.produtora?.nome || '';
  abrirDialogo($('#dialogo-converter'), retorno => {
    const nome = $('#nome-produtora').value.trim();
    if (retorno !== 'converter') return;
    config = converterParaV2(config, nome || 'Produtora');
    idsNovos.add(config.eventos[0].id);
    selecionado = 0; renderizar(); reiniciarConversa(); mudou();
    feedback('Configuração convertida. Revise os dados e clique em Salvar para gravar.');
  });
});

$('#recarregar').addEventListener('click', async () => {
  if (!alterado()) return carregar();
  const dialog = $('#confirmar-descarte'); dialog.returnValue = 'cancelar';
  dialog.addEventListener('close', () => { if (dialog.returnValue === 'descartar') carregar(); }, { once: true });
  dialog.showModal();
});
$('#form-simular').addEventListener('submit', evento => { evento.preventDefault(); simular(); });
$('#simular-midia').addEventListener('click', () => simular(true));
$('#reiniciar-conversa').addEventListener('click', reiniciarConversa);
window.addEventListener('beforeunload', evento => { if (alterado()) { evento.preventDefault(); evento.returnValue = ''; } });
carregar();
