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
let historicoConversa = []; // turnos {de, texto} do simulador: viram a memória da conversa natural
let papelEfetivo = 'admin'; // ajustado por /api/sessao; o servidor também confere
let selecionado = 'produtora'; // v2: índice do evento em edição ou 'produtora'
const idsNovos = new Set(); // eventos criados nesta sessão (o id ainda pode mudar)
const nomesStatus = { ativo: 'Ativo', rascunho: 'Rascunho', encerrado: 'Encerrado' };
const nomesProdutora = { nome: 'Nome da produtora', instagram: 'Instagram', email: 'E-mail', linktree: 'Página com todos os links' };
const textoSemEventos = 'No momento não temos eventos com atendimento aberto. Acompanhe as novidades no nosso Instagram: {{instagram}}';
const textoEscolherEvento = 'Sobre qual evento você quer falar?\n\n{{eventos}}\n\nDigite o número do evento.';
const numerosNovos = new Set(); // números criados nesta sessão (a sessão ainda pode mudar)
const numerosCadastrados = () => (Array.isArray(config?.numeros) ? config.numeros : []);
const nomeDoNumero = sessao => numerosCadastrados().find(n => n.sessao === sessao)?.nome || sessao;
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
const ajudaForaDoAssunto = 'Enviada, sem usar a IA, quando a mensagem é barrada pelas travas (pedido para ignorar regras, revelar instruções, etc.). Vazio usa: Por aqui eu só consigo ajudar com o evento 😉 Digite *menu* para ver as opções.';
const titulosPadrao = { qrcode: 'Onde encontro meu QR Code?', valores: 'Valores dos ingressos', local: 'Local e horário do evento', comprar: 'Comprar ingressos', atendente: 'Falar com um atendente' };
const fallbackPadrao = ['Não consegui identificar sua dúvida. Digite menu para ver as opções ou escreva o assunto que procura.', 'Ainda não entendi. Tente reformular com mais detalhes ou escolha uma opção do menu.', 'Para receber ajuda da nossa equipe, fale pelo Instagram: {{instagram}}. Quando quiser, digite menu para retomar.'];

function alterado() { return config && JSON.stringify(config) !== inicial; }

function atualizarSituacao() {
  const pendente = alterado();
  $('#situacao-titulo').textContent = salvando ? 'Salvando suas alterações…' : pendente ? 'Você tem alterações não salvas' : config ? 'Tudo salvo por aqui' : 'A configuração ainda não foi carregada';
  $('#situacao-detalhe').textContent = pendente ? 'Salve para usar o novo conteúdo no atendimento.' : 'Você pode testar novas ideias na prévia ao lado.';
  $('#indicador-salvo').classList.toggle('pendente', Boolean(pendente));
  $('#salvar').disabled = !config || !pendente || salvando || papelEfetivo === 'leitor';
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
  if (res.status === 401) { location.href = '/login'; throw new Error('Sessão expirada. Entre novamente.'); }
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
  for (const [id, visivel] of [['identidade', Boolean(ev)], ['produtora-cartao', prod], ['numeros-cartao', prod], ['dados', !prod], ['mensagens', !prod], ['opcoes', !prod]]) mostrar(id, visivel);
  $('#remover-evento').hidden = !ev; $('#nota-ia-evento').hidden = !ev;
  $('#area-simular-como').hidden = !v2;
  if (v2) { atualizarSeletores(); renderizarIdentidade(); renderizarProdutora(); renderizarNumeros(); }
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
    if (!v2) outras.push(['fora_do_assunto', 'Mensagem para assunto fora do evento ou tentativa de manipular a IA', ajudaForaDoAssunto]);
    for (const [chave, titulo, ajuda] of outras) $('#campos-mensagens').append(campo({ titulo, valor: mensagens[chave] || '', linhas: true, ajuda, mudar: valor => { if (chave === 'fora_do_assunto' && !valor.trim()) delete mensagens[chave]; else mensagens[chave] = valor; } }));
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
  atualizarNumerosSimulador();
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
  const numeros = $('#numeros-evento');
  numeros.hidden = !ev || !numerosCadastrados().length;
  if (ev) numeros.textContent = (ev.numeros || []).length ? 'Atende em: ' + ev.numeros.map(nomeDoNumero).join(', ') : 'Atende em todos os números';
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
  area.append(id, status, gatilhos, caixasNumeros(ev));
}

// "Atende nos números": uma caixa por número cadastrado; nenhuma marcada = todos os números.
function caixasNumeros(ev) {
  const caixa = document.createElement('div'); caixa.className = 'campo caixas-numeros';
  const t = document.createElement('span'); t.textContent = 'Atende nos números'; caixa.append(t);
  const cadastrados = numerosCadastrados();
  const ajuda = document.createElement('small');
  if (!cadastrados.length) {
    ajuda.textContent = 'Nenhum número cadastrado: este evento é atendido em qualquer número conectado. Para separar eventos por número, cadastre os números em “Produtora (geral)”.';
    caixa.append(ajuda); return caixa;
  }
  const opcoes = cadastrados.map(n => ({ sessao: n.sessao, rotulo: (n.nome || n.sessao) + ' (' + n.sessao + ')' }));
  for (const sessao of ev.numeros || []) if (!cadastrados.some(n => n.sessao === sessao)) opcoes.push({ sessao, rotulo: sessao + ' (não cadastrado)' });
  for (const opcao of opcoes) {
    const label = document.createElement('label'); label.className = 'campo campo-marcar';
    const input = document.createElement('input'); input.type = 'checkbox'; input.checked = (ev.numeros || []).includes(opcao.sessao);
    const nome = document.createElement('span'); nome.textContent = opcao.rotulo;
    input.addEventListener('change', () => {
      const marcados = new Set(ev.numeros || []);
      if (input.checked) marcados.add(opcao.sessao); else marcados.delete(opcao.sessao);
      const ordem = opcoes.map(o => o.sessao).filter(sessao => marcados.has(sessao));
      if (ordem.length) ev.numeros = ordem; else delete ev.numeros;
      atualizarRotulos(); mudou();
    });
    label.append(input, nome); caixa.append(label);
  }
  ajuda.textContent = 'Nenhuma marcada: o evento é atendido em todos os números.';
  caixa.append(ajuda);
  return caixa;
}

// Cartão "Números de WhatsApp" da produtora.
function renderizarNumeros() {
  const lista = $('#lista-numeros'); lista.replaceChildren();
  if (!emProdutora()) return;
  const numeros = numerosCadastrados();
  if (!numeros.length) {
    const vazio = document.createElement('p'); vazio.className = 'vazio-numeros';
    vazio.textContent = 'Nenhum número cadastrado: todos os eventos são atendidos em qualquer número conectado.';
    lista.append(vazio);
  }
  numeros.forEach((numero, indice) => {
    const linha = document.createElement('div'); linha.className = 'linha-numero';
    const sessao = campo({ titulo: 'Sessão (nome no WAHA)', valor: numero.sessao, obrigatorio: true, padrao: '[a-zA-Z0-9_-]{1,54}', maximo: 54, ajuda: numerosNovos.has(numero) ? 'Letras, números, hífen e sublinhado. Depois de salvar, não muda mais.' : 'Não pode ser alterada depois de salva.', mudar: valor => {
      for (const ev of config.eventos || []) if (ev.numeros) ev.numeros = ev.numeros.map(item => (item === numero.sessao ? valor : item));
      numero.sessao = valor; atualizarRotulos(); atualizarNumerosSimulador();
    } });
    if (!numerosNovos.has(numero)) sessao.querySelector('input').readOnly = true;
    const nome = campo({ titulo: 'Nome do número', valor: numero.nome || '', obrigatorio: true, ajuda: 'Como o painel mostra este número.', mudar: valor => { numero.nome = valor; atualizarRotulos(); atualizarNumerosSimulador(); } });
    const remover = document.createElement('button'); remover.type = 'button'; remover.className = 'botao-remover'; remover.textContent = 'Remover';
    remover.setAttribute('aria-label', 'Remover o número ' + (numero.nome || numero.sessao));
    remover.addEventListener('click', () => {
      const usados = (config.eventos || []).filter(ev => (ev.numeros || []).includes(numero.sessao));
      // Um evento que só usa este número passaria a ser atendido em todos os números: bloqueia.
      const dependentes = usados.filter(ev => ev.numeros.length === 1);
      if (dependentes.length) {
        const nomes = dependentes.map(ev => '“' + (ev.evento?.nome || ev.id) + '”').join(', ');
        return feedback('Não é possível remover este número: ' + nomes + ' só é atendido por ele. Marque outro número nesse evento (ou remova o evento) antes.', true);
      }
      if (usados.length && !confirm('O número “' + (numero.nome || numero.sessao) + '” é usado por ' + usados.length + ' evento(s), que também têm outros números. Ao remover, ele sai desses eventos. Continuar?')) return;
      for (const ev of usados) ev.numeros = ev.numeros.filter(item => item !== numero.sessao);
      numerosNovos.delete(numero); numeros.splice(indice, 1);
      if (!numeros.length) delete config.numeros;
      renderizarNumeros(); atualizarRotulos(); atualizarNumerosSimulador(); mudou();
      $('#adicionar-numero').focus();
    });
    linha.append(sessao, nome, remover); lista.append(linha);
  });
}

function atualizarNumerosSimulador() {
  if (!multi()) { $('#area-simular-numero').hidden = true; return; }
  const select = $('#simular-numero'); const anterior = select.value; select.replaceChildren();
  for (const n of numerosCadastrados()) { const o = document.createElement('option'); o.value = n.sessao; o.textContent = (n.nome || n.sessao) + ' (' + n.sessao + ')'; select.append(o); }
  if ([...select.options].some(o => o.value === anterior)) select.value = anterior;
  $('#area-simular-numero').hidden = !numerosCadastrados().length || $('#simular-como').value !== '';
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
    ['agradecimento', 'Resposta a um agradecimento', '', ''],
    ['fora_do_assunto', 'Mensagem para assunto fora do evento ou tentativa de manipular a IA', '', ajudaForaDoAssunto]])
    m.append(campo({ titulo, valor: config.mensagens[chave] ?? padrao, linhas: true, ajuda, mudar: valor => { if (chave === 'fora_do_assunto' && !valor.trim()) delete config.mensagens[chave]; else config.mensagens[chave] = valor; } }));
}

function campoIA({ titulo, tipo = 'texto', chave, ajuda, opcoes, minimo, maximo, passo, linhas, largo, sub, padrao }) {
  // "sub" edita um objeto dentro de ia (audio, travas), criado só na primeira alteração.
  const ler = () => (sub ? (iaEditada()[sub] || {}) : iaEditada());
  const alvo = () => (sub ? (iaEditada()[sub] ||= {}) : iaEditada());
  if (tipo === 'texto') return campo({ titulo, valor: ler()[chave] || '', linhas, maximo, classe: largo ? 'campo-largo' : '', ajuda, mudar: valor => { if (valor.trim()) alvo()[chave] = valor; else delete alvo()[chave]; } });
  if (tipo === 'lista_texto') return campo({ titulo, valor: Array.isArray(ler()[chave]) ? ler()[chave].join(', ') : '', ajuda, mudar: valor => { alvo()[chave] = [...new Set(valor.split(',').map(item => item.trim()).filter(Boolean))]; } });
  const label = document.createElement('label');
  label.className = 'campo' + (tipo === 'marcar' ? ' campo-marcar campo-largo' : '');
  const input = document.createElement(tipo === 'lista' ? 'select' : 'input');
  input.id = 'campo-' + ++sequenciaCampo;
  if (tipo === 'marcar') { input.type = 'checkbox'; input.checked = (ler()[chave] ?? padrao) === true; }
  else if (tipo === 'lista') {
    for (const [valor, nome] of opcoes) { const item = document.createElement('option'); item.value = valor; item.textContent = nome; input.append(item); }
    input.value = ler()[chave] || opcoes[0][0];
  } else { input.type = 'number'; input.min = minimo; input.max = maximo; input.step = passo || 1; input.value = ler()[chave] ?? ''; input.inputMode = 'decimal'; }
  input.addEventListener(tipo === 'marcar' || tipo === 'lista' ? 'change' : 'input', () => {
    if (tipo === 'marcar') alvo()[chave] = input.checked;
    else if (tipo === 'lista') alvo()[chave] = input.value;
    else if (input.value === '') delete alvo()[chave];
    else alvo()[chave] = Number(input.value);
    mudou();
  });
  const span = document.createElement('span'); span.textContent = titulo;
  if (tipo === 'marcar') label.append(input, span); else label.append(span, input);
  if (ajuda) { const small = document.createElement('small'); small.id = input.id + '-ajuda'; small.textContent = ajuda; input.setAttribute('aria-describedby', small.id); label.append(small); }
  return label;
}

// Chave por evento: herdar (sem o campo), ligada ou desligada.
function campoConversaNaturalDoEvento(ev) {
  const label = document.createElement('label'); label.className = 'campo campo-largo';
  const select = document.createElement('select'); select.id = 'campo-' + ++sequenciaCampo;
  const herdado = config.ia?.conversa_natural === true ? 'ligada' : 'desligada';
  for (const [valor, nome] of [['herdar', 'Herdar da produtora (' + herdado + ')'], ['ligada', 'Ligada neste evento'], ['desligada', 'Desligada neste evento']]) { const o = document.createElement('option'); o.value = valor; o.textContent = nome; select.append(o); }
  select.value = typeof ev.ia?.conversa_natural === 'boolean' ? (ev.ia.conversa_natural ? 'ligada' : 'desligada') : 'herdar';
  select.addEventListener('change', () => {
    ev.ia ||= {};
    if (select.value === 'herdar') delete ev.ia.conversa_natural; else ev.ia.conversa_natural = select.value === 'ligada';
    mudou();
  });
  const span = document.createElement('span'); span.textContent = 'Conversa natural neste evento';
  const small = document.createElement('small'); small.id = select.id + '-ajuda'; select.setAttribute('aria-describedby', small.id);
  small.textContent = 'Sobrescreve a chave geral só para este evento. Atalhos (número do menu) continuam instantâneos; com ela ligada, a IA reescreve a resposta do texto livre reconhecido.';
  label.append(span, select, small);
  return label;
}

function renderizarIA() {
  const area = $('#campos-ia'); area.replaceChildren();
  if (eventoAtual()) {
    area.append(campoConversaNaturalDoEvento(eventoAtual()));
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
    campoIA({ titulo: 'Modelos reserva', tipo: 'lista_texto', chave: 'modelos_reserva', ajuda: 'Até 2 modelos, separados por vírgula. Usados em ordem quando o principal falha por cota (429), erro do servidor ou tempo esgotado. Mesma chave e mesmo endereço.' }),
    campoIA({ titulo: 'Usos da IA por contato', tipo: 'numero', chave: 'max_usos_por_contato', minimo: 0, maximo: 1000, ajuda: 'Quantas vezes cada contato pode usar a IA por janela. 0 = sem limite. Se ausente, o padrão é 3.' }),
    campoIA({ titulo: 'Zerar o contador do contato após (horas)', tipo: 'numero', chave: 'janela_horas', minimo: 0.25, maximo: 720, passo: 0.25, ajuda: 'Padrão 12 horas sem usar a IA.' }),
    campoIA({ titulo: 'Usos da IA por dia (todos os contatos)', tipo: 'numero', chave: 'max_usos_por_dia', minimo: 0, maximo: 1000000, ajuda: '0 = sem limite. Se ausente, o padrão é 80.' }),
    campoIA({ titulo: 'Tamanho máximo da resposta (caracteres)', tipo: 'numero', chave: 'tamanho_maximo_resposta', minimo: 120, maximo: 3000, ajuda: 'Padrão 600.' }),
  );
  const natural = document.createElement('div'); natural.className = 'grade-campos';
  natural.append(
    campoIA({ titulo: 'Conversa natural (a IA reescreve as respostas)', tipo: 'marcar', chave: 'conversa_natural', ajuda: 'As regras decidem o quê e a IA decide o como. Atalhos (número do menu, saudação, atendente) continuam instantâneos e sem IA. Texto livre que as regras reconhecem é reescrito pela IA com base na resposta oficial. Se a IA falhar, vai a resposta pronta. Texto não reconhecido segue para a IA como antes.' }),
    campoIA({ titulo: 'Mensagens por resposta', tipo: 'numero', chave: 'max_mensagens', minimo: 1, maximo: 4, ajuda: 'De 1 a 4. A IA pode dividir a resposta em mensagens curtas enviadas em sequência. Padrão 3.' }),
    campoIA({ titulo: 'Memória da conversa (mensagens)', tipo: 'numero', chave: 'memoria_mensagens', minimo: 0, maximo: 20, ajuda: 'Quantas mensagens recentes (do contato e do robô) a IA lembra, por 24 horas. 0 desliga a memória. Padrão 6.' }),
    campoIA({ sub: 'audio', padrao: true, titulo: 'Transcrever áudios e mensagens de voz', tipo: 'marcar', chave: 'ativo', ajuda: 'Com a IA ativa, o áudio vira texto e segue o fluxo normal. Se a transcrição falhar, vale a resposta padrão para mídia. Padrão ligado.' }),
    campoIA({ sub: 'audio', titulo: 'Duração máxima do áudio (segundos)', tipo: 'numero', chave: 'max_segundos', minimo: 10, maximo: 600, ajuda: 'De 10 a 600. Áudios mais longos recebem a resposta padrão para mídia. Padrão 120.' }),
  );
  const persona = campoIA({ titulo: 'Persona (jeito de falar da IA)', chave: 'persona', linhas: true, largo: true, maximo: 1500, ajuda: 'Até 1500 caracteres. Só muda o tom: não altera as regras nem libera assuntos fora do evento. Vazio usa a persona padrão (promoter jovem e simpático).' });
  const travas = document.createElement('div'); travas.className = 'grade-campos';
  travas.append(
    campoIA({ sub: 'travas', titulo: 'Limite do classificador de ataques (0,1 a 0,99)', tipo: 'numero', chave: 'limite_ataque', minimo: 0.1, maximo: 0.99, passo: 0.01, ajuda: 'Um classificador dá uma nota de 0 a 1 para cada mensagem: perto de 1 parece tentativa de manipular a IA. A partir deste valor a mensagem é barrada e recebe a resposta pronta. Menor = mais rígido (pode barrar perguntas normais). Padrão 0,5.' }),
    campoIA({ sub: 'travas', titulo: 'Termos proibidos na resposta da IA', tipo: 'lista_texto', chave: 'termos_proibidos', ajuda: 'Termos separados por vírgula, no máximo 200. Se a resposta da IA contiver algum, ela é descartada e vai a resposta pronta. Somam-se à lista padrão do sistema.' }),
  );
  const conhecimento = campoIA({ titulo: multi() ? 'Informações extras da produtora (valem para todos os eventos)' : 'Informações extras para a IA', chave: 'conhecimento', linhas: true, largo: true, ajuda: 'Tudo o que a IA pode usar além dos dados do evento e das respostas. Liste também o que ainda não foi divulgado, para ela não inventar.' });
  conhecimento.querySelector('textarea').classList.add('conhecimento');
  area.append(grade, natural, persona, travas, conhecimento,
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
    $('#simular-natural').checked = config.ia?.conversa_natural === true;
    renderizar(); avisos(dados.avisos); feedback(''); reiniciarConversa(); statusIA(); carregarVersoes();
  } catch (erro) { feedback(erro.message, true, erro.detalhes); atualizarSituacao(); }
  finally { $('#recarregar').disabled = false; }
}

function reiniciarConversa() {
  estadoConversa = {};
  usosIA = 0;
  historicoConversa = [];
  const inicio = document.createElement('div'); inicio.className = 'inicio-conversa';
  const simbolo = document.createElement('span'); simbolo.textContent = '↗'; simbolo.setAttribute('aria-hidden', 'true');
  const titulo = document.createElement('p'); titulo.textContent = 'Que tal começar com um “oi”?';
  const ajuda = document.createElement('small'); ajuda.textContent = 'Digite como se fosse um participante.';
  inicio.append(simbolo, titulo, ajuda); $('#historico').replaceChildren(inicio); $('#erro-simulador').hidden = true;
}

const nomesTrava = { entrada: 'filtro de entrada', classificador: 'classificador de ataques', saida: 'filtro de saída', contato: 'contato insistente' };
const nomesOrigem = { ia_redigida: 'IA reescreveu a resposta pronta', ia: 'IA respondeu (não reconhecido pelas regras)' };

// Legenda pequena abaixo das respostas: quem respondeu e em quantas mensagens.
function balaoOrigem(resultado, quantas) {
  const nome = nomesOrigem[resultado.origem];
  if (!nome) return;
  balao(nome + (quantas > 1 ? ' · ' + quantas + ' mensagens' : ''), 'silencio');
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
    const corpo = { config: structuredClone(config), texto: midia ? '' : texto, estado: estadoConversa, midia, usosIA, conversaNatural: $('#simular-natural').checked, historico: historicoConversa };
    if (multi()) { const como = $('#simular-como').value; if (como) corpo.eventoId = como; else { corpo.incluirRascunhos = $('#incluir-rascunhos').checked; if (numerosCadastrados().length && $('#simular-numero').value) corpo.sessao = $('#simular-numero').value; } }
    const resultado = await api('/api/simular', 'POST', corpo);
    balao(midia ? 'Áudio ou imagem sem legenda' : texto, 'usuario');
    if (resultado.ia?.resultado && resultado.ia.resultado !== 'respondeu') {
      const trava = resultado.ia.trava ? ' Trava: ' + (nomesTrava[resultado.ia.trava] || resultado.ia.trava) + '.' : '';
      const reserva = resultado.ia.reservaPronta ? ' Foi enviada a resposta pronta.' : '';
      balao('IA não usada: ' + (resultadosIA[resultado.ia.resultado] || resultado.ia.resultado) + '.' + trava + reserva, 'silencio');
    }
    const partes = Array.isArray(resultado.partes) && resultado.partes.length ? resultado.partes : (resultado.resposta ? [resultado.resposta] : []);
    for (const parte of partes) balao(parte, ['ia', 'ia_redigida'].includes(resultado.origem) ? 'ia' : '');
    if (resultado.resposta) balaoOrigem(resultado, partes.length);
    else balao('O atendimento aguarda uma opção reconhecida para continuar.', 'silencio');
    if (resultado.memorizar !== false) {
      historicoConversa.push({ de: 'contato', texto: midia ? '' : texto });
      if (resultado.resposta) historicoConversa.push({ de: 'bot', texto: resultado.resposta });
      historicoConversa = historicoConversa.filter(item => item.texto).slice(-40);
    }
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
    const comentario = $('#comentario-salvar').value.trim();
    const dados = await api('/api/config', 'PUT', comentario ? { config: enviada, revisao, comentario } : { config: enviada, revisao });
    $('#comentario-salvar').value = '';
    revisao = dados.revisao;
    inicial = JSON.stringify(dados.config);
    avisos(dados.avisos);
    // O arquivo foi salvo; avisoVersao indica que só o registro no histórico (banco) falhou.
    feedback('Alterações salvas. O novo conteúdo será usado na próxima mensagem recebida.' + (dados.avisoVersao ? ' Atenção: ' + dados.avisoVersao : ''), Boolean(dados.avisoVersao));
    carregarVersoes();
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
$('#simular-como').addEventListener('change', () => { $('#rotulo-rascunhos').hidden = $('#simular-como').value !== ''; atualizarNumerosSimulador(); reiniciarConversa(); });
$('#simular-numero').addEventListener('change', reiniciarConversa);
$('#adicionar-numero').addEventListener('click', () => {
  config.numeros ||= [];
  const usadas = new Set(config.numeros.map(n => n.sessao));
  let i = config.numeros.length + 1; while (usadas.has('numero' + i)) i++;
  const novo = { sessao: 'numero' + i, nome: 'Novo número' };
  config.numeros.push(novo); numerosNovos.add(novo);
  renderizarNumeros(); atualizarNumerosSimulador(); mudou();
  const campos = $('#lista-numeros').querySelectorAll('.linha-numero:last-child input'); if (campos[0]) campos[0].focus();
});
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

// ---------- papéis ----------

// Leitor só visualiza: o servidor recusa a gravação, aqui apenas evitamos o botão inútil.
function aplicarPapel() {
  const leitor = papelEfetivo === 'leitor';
  $('#comentario-salvar').hidden = leitor;
  $('#comentario-salvar').closest('.campo-comentario').hidden = leitor;
  if (leitor) $('#situacao-detalhe').textContent = 'Seu acesso é só de leitura: não é possível salvar alterações.';
  atualizarSituacao();
  desenharVersoes();
}
const podeRestaurar = () => papelEfetivo === 'admin' || papelEfetivo === 'editor';

// ---------- histórico de versões ----------

let versoes = [];

function quandoTexto(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso || '') : d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

function avisoVersoes(texto) {
  const caixa = $('#aviso-versoes');
  caixa.textContent = texto || '';
  caixa.hidden = !texto;
}

async function chamarVersoes(rota, metodo, corpo) {
  try { return await api(rota, metodo, corpo); }
  catch (erro) {
    if (erro.status === 503) erro.message = 'Histórico de versões indisponível: banco de dados fora do ar. Você pode continuar editando e salvando normalmente.';
    throw erro;
  }
}

function desenharVersoes() {
  const lista = $('#lista-versoes');
  lista.replaceChildren();
  $('#vazio-versoes').hidden = versoes.length > 0 || !$('#aviso-versoes').hidden;
  versoes.forEach((v, i) => {
    const item = document.createElement('li');
    item.className = 'versao';
    const info = document.createElement('div');
    info.className = 'versao-info';
    const titulo = document.createElement('strong');
    titulo.textContent = 'Versão ' + v.id + (i === 0 ? ' · mais recente' : '');
    const detalhe = document.createElement('small');
    detalhe.textContent = quandoTexto(v.criadoEm) + ' · ' + (v.autor || 'autor desconhecido');
    info.append(titulo, detalhe);
    if (v.comentario) { const c = document.createElement('span'); c.className = 'versao-comentario'; c.textContent = v.comentario; info.append(c); }
    const acoes = document.createElement('div');
    acoes.className = 'versao-acoes';
    const ver = document.createElement('button');
    ver.type = 'button'; ver.className = 'botao botao-secundario botao-pequeno'; ver.textContent = 'Ver';
    ver.addEventListener('click', () => verVersao(v));
    acoes.append(ver);
    if (podeRestaurar() && i > 0) {
      const rest = document.createElement('button');
      rest.type = 'button'; rest.className = 'botao botao-secundario botao-pequeno'; rest.textContent = 'Restaurar';
      rest.addEventListener('click', () => restaurarVersao(v));
      acoes.append(rest);
    }
    item.append(info, acoes);
    lista.append(item);
  });
}

async function carregarVersoes() {
  try {
    const dados = await chamarVersoes('/api/config/versoes');
    versoes = Array.isArray(dados.versoes) ? dados.versoes : [];
    avisoVersoes('');
  } catch (erro) { versoes = []; avisoVersoes(erro.message); }
  desenharVersoes();
}

async function verVersao(v) {
  try {
    const dados = await chamarVersoes('/api/config/versoes/' + encodeURIComponent(v.id));
    $('#titulo-dialogo-versao').textContent = 'Versão ' + dados.id;
    $('#texto-versao').textContent = quandoTexto(dados.criadoEm) + ' · ' + (dados.autor || 'autor desconhecido') + (dados.comentario ? ' · ' + dados.comentario : '');
    $('#conteudo-versao').textContent = JSON.stringify(dados.config, null, 2);
    abrirDialogo($('#dialogo-versao'), () => {});
  } catch (erro) { avisoVersoes(erro.message); desenharVersoes(); }
}

function restaurarVersao(v) {
  $('#texto-restaurar').textContent = 'A configuração em uso será substituída pela versão ' + v.id + ' (' + quandoTexto(v.criadoEm) + ', ' + (v.autor || 'autor desconhecido') + '). A versão atual continua guardada no histórico.' + (alterado() ? ' Atenção: as alterações que você ainda não salvou serão perdidas.' : '');
  abrirDialogo($('#dialogo-restaurar'), async retorno => {
    if (retorno !== 'restaurar') return;
    try {
      const dados = await chamarVersoes('/api/config/versoes/' + encodeURIComponent(v.id) + '/restaurar', 'POST', { revisao });
      config = structuredClone(dados.config); revisao = dados.revisao; inicial = JSON.stringify(config);
      idsNovos.clear();
      const primeiroAtivo = multi() ? config.eventos.findIndex(ev => ev.status === 'ativo') : -1;
      selecionado = primeiroAtivo >= 0 ? primeiroAtivo : 'produtora';
      renderizar(); avisos(dados.avisos); reiniciarConversa(); statusIA();
      feedback('Versão ' + v.id + ' restaurada. O conteúdo será usado na próxima mensagem recebida.');
      carregarVersoes();
    } catch (erro) { feedback(erro.message, true, erro.detalhes); $('#feedback').scrollIntoView({ block: 'center' }); }
  });
}

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
    papelEfetivo = admin ? 'admin' : s.papel;
    aplicarPapel();
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
