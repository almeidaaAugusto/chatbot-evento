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
    $('#nome-resumo').textContent = config.evento?.nome || 'Seu evento';
    $('#nome-conversa').textContent = config.evento?.nome || 'Atendimento do evento';
    $('#data-resumo').textContent = [config.evento?.data, config.evento?.local].filter(Boolean).join(' · ') || 'Conteúdo disponível neste computador';
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
    const linha = (config.mensagens?.menu || '').split('\n').find(texto => new RegExp('^\\s*' + numero + '\\s*[-–—.:)]\\s*').test(texto));
    if (linha) return linha.replace(new RegExp('^\\s*' + numero + '\\s*[-–—.:)]\\s*'), '').trim();
  }
  return titulosPadrao[opcao.id] || opcao.id || 'Nova opção';
}

function renderizarOpcoes() {
  const lista = $('#lista-opcoes');
  lista.replaceChildren();
  config.opcoes.forEach((opcao, indice) => {
    const cartao = document.createElement('section'); cartao.className = 'opcao';
    const cabecalho = document.createElement('div'); cabecalho.className = 'opcao-cabecalho';
    const titulo = document.createElement('div'); titulo.className = 'opcao-titulo';
    const numero = document.createElement('span'); numero.className = 'opcao-badge'; numero.textContent = indice + 1;
    const nome = document.createElement('strong'); nome.textContent = tituloOpcao(opcao);
    titulo.append(numero, nome);
    const remover = document.createElement('button'); remover.type = 'button'; remover.className = 'botao-remover'; remover.textContent = 'Remover'; remover.setAttribute('aria-label', 'Remover opção ' + tituloOpcao(opcao));
    remover.addEventListener('click', () => { config.opcoes.splice(indice, 1); renderizarOpcoes(); mudou(); $('#adicionar-opcao').focus(); });
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

function renderizar() {
  const evento = $('#campos-evento'); evento.replaceChildren();
  const chaves = [...new Set([...Object.keys(nomesEvento), ...Object.keys(config.evento || {}).filter(chave => !chave.startsWith('_') && typeof config.evento[chave] === 'string')])];
  for (const chave of chaves) evento.append(campo({ titulo: nomesEvento[chave] || chave, valor: config.evento?.[chave] || '', classe: camposLargos.includes(chave) ? 'campo-largo' : '', mudar: valor => { config.evento ||= {}; config.evento[chave] = valor; } }));
  $('#campo-menu').replaceChildren(campo({ titulo: 'Mensagem de boas-vindas e menu', valor: config.mensagens.menu, linhas: true, classe: 'menu', obrigatorio: true, mudar: valor => { config.mensagens.menu = valor; } }));
  const outras = $('#campos-mensagens'); outras.replaceChildren();
  for (const [chave, titulo] of [['nao_entendi', 'Resposta geral para dúvida não reconhecida'], ['reativado', 'Mensagem ao reativar o atendimento']]) outras.append(campo({ titulo, valor: config.mensagens[chave] || '', linhas: true, mudar: valor => { config.mensagens[chave] = valor; } }));
  const fallback = $('#campos-fallback'); fallback.replaceChildren();
  const lista = config.fallback?.mensagens || fallbackPadrao;
  for (let i = 0; i < 3; i++) fallback.append(campo({ titulo: ['Primeira tentativa · orientar', 'Segunda tentativa · pedir mais detalhes', 'Terceira tentativa · encaminhar para a equipe'][i], valor: lista[i] || '', linhas: true, obrigatorio: true, mudar: valor => { config.fallback ||= {}; config.fallback.mensagens ||= [...fallbackPadrao]; config.fallback.mensagens[i] = valor; } }));
  fallback.append(campo({ titulo: 'Ao receber áudio ou imagem sem legenda', valor: config.fallback?.mensagem_midia || 'Para eu ajudar, escreva sua dúvida em uma mensagem de texto. Ainda não consigo ouvir áudios ou interpretar imagens.', linhas: true, obrigatorio: true, mudar: valor => { config.fallback ||= {}; config.fallback.mensagem_midia = valor; } }));
  renderizarOpcoes();
  renderizarIA();
  for (const fieldset of document.querySelectorAll('#editor>fieldset')) fieldset.disabled = false;
  for (const id of ['texto-simulador', 'enviar-simulacao', 'simular-midia', 'reiniciar-conversa']) $('#' + id).disabled = false;
  atualizarSituacao();
}

function campoIA({ titulo, tipo = 'texto', chave, ajuda, opcoes, minimo, maximo, passo, linhas, largo }) {
  config.ia ||= {};
  const ia = config.ia;
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
  const conhecimento = campoIA({ titulo: 'Informações extras para a IA', chave: 'conhecimento', linhas: true, largo: true, ajuda: 'Tudo o que a IA pode usar além dos dados do evento e das respostas. Liste também o que ainda não foi divulgado, para ela não inventar.' });
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

async function carregar() {
  $('#recarregar').disabled = true;
  try {
    const dados = await api('/api/config');
    if (!dados.config || Array.isArray(dados.config) || !Array.isArray(dados.config.opcoes) || dados.config.opcoes.some(opcao => !opcao || typeof opcao !== 'object') || !dados.config.mensagens) throw new Error('A estrutura da configuração está inválida. Corrija o arquivo de configuração antes de usar o painel.');
    config = structuredClone(dados.config); revisao = dados.revisao; inicial = JSON.stringify(config);
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
    const resultado = await api('/api/simular', 'POST', { config: structuredClone(config), texto: midia ? '' : texto, estado: estadoConversa, midia, usosIA });
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
  const linhas = config.opcoes.map(opcao => {
    const numero = (opcao.palavras_exatas || []).find(texto => /^\d+$/.test(texto));
    const seletor = numero || (opcao.palavras_exatas || []).find(texto => texto.trim());
    return (seletor ? seletor + ' - ' : '') + tituloOpcao(opcao);
  });
  config.mensagens.menu = 'Olá! Boas-vindas ao ' + (config.evento?.nome || 'nosso evento') + '!\n\nComo podemos ajudar?\n\n' + linhas.join('\n') + '\n\nDigite o número ou escreva o assunto da opção desejada.';
  $('#campo-menu textarea').value = config.mensagens.menu;
  mudou(); feedback('Menu atualizado com as opções atuais. Salve para usar esta versão.');
});

$('#adicionar-opcao').addEventListener('click', () => {
  const ids = new Set(config.opcoes.map(opcao => opcao.id));
  let i = config.opcoes.length + 1; while (ids.has('opcao_' + i)) i++;
  const numeros = new Set(config.opcoes.flatMap(opcao => opcao.palavras_exatas || []));
  let numero = config.opcoes.length + 1; while (numeros.has(String(numero))) numero++;
  config.opcoes.push({ id: 'opcao_' + i, titulo: 'Nova opção', palavras_exatas: [String(numero)], palavras_chave: [], perguntas: [], resposta: '' });
  renderizarOpcoes(); mudou(); $('#lista-opcoes .opcao:last-child input').focus();
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
