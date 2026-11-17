'use strict';

const { STATUS, configDoEvento } = require('./eventos.js');

const objeto = valor => valor !== null && typeof valor === 'object' && !Array.isArray(valor);
const textoValido = valor => typeof valor === 'string' && valor.trim() !== '';
const normalizar = texto => String(texto ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9#]+/g, ' ').trim().replace(/\s+/g, ' ');

function validarConfig(cfg) {
  const erros = [];
  const avisos = [];
  if (!objeto(cfg)) return { erros: ['A configuração precisa ser um objeto JSON.'], avisos };
  if (Array.isArray(cfg.eventos)) return validarV2(cfg);
  if (cfg.eventos !== undefined) erros.push('eventos precisa ser uma lista.');
  for (const campo of ['evento', 'mensagens', 'atendimento_humano', 'protecoes', 'fallback', 'ia']) {
    if (cfg[campo] !== undefined && !objeto(cfg[campo])) erros.push(campo + ' precisa ser um objeto.');
  }
  const evento = objeto(cfg.evento) ? cfg.evento : {};
  const mensagens = objeto(cfg.mensagens) ? cfg.mensagens : {};
  const conferirMarcadores = (texto, onde) => {
    for (const [, chave] of String(texto ?? '').matchAll(/\{\{\s*([\w-]+)\s*\}\}/g)) {
      if (chave !== 'opcoes' && !Object.prototype.hasOwnProperty.call(evento, chave)) erros.push(onde + ': usa {{' + chave + '}}, mas não existe "' + chave + '" em "evento".');
    }
  };
  for (const [chave, valor] of Object.entries(evento)) {
    if (chave.startsWith('_')) continue;
    if (!textoValido(valor)) avisos.push('evento.' + chave + ' está vazio.');
    else if (/^\[[A-Z0-9_]+\]$/.test(valor.trim())) avisos.push('evento.' + chave + ' ainda está com o marcador ' + valor.trim() + ' (preencha com o dado real).');
  }
  if (!textoValido(mensagens.menu)) erros.push('mensagens.menu é obrigatória.');
  else conferirMarcadores(mensagens.menu, 'mensagens.menu');
  if (!textoValido(mensagens.nao_entendi)) avisos.push('mensagens.nao_entendi está vazia; o fallback usará o encaminhamento padrão quando necessário.');
  else conferirMarcadores(mensagens.nao_entendi, 'mensagens.nao_entendi');
  if (!textoValido(mensagens.reativado)) avisos.push('mensagens.reativado está vazia; será usado um texto padrão.');
  else conferirMarcadores(mensagens.reativado, 'mensagens.reativado');
  if (mensagens.agradecimento !== undefined) {
    if (!textoValido(mensagens.agradecimento)) erros.push('mensagens.agradecimento não pode ser vazia (apague o campo para usar o texto padrão).');
    else conferirMarcadores(mensagens.agradecimento, 'mensagens.agradecimento');
  }
  const fallback = objeto(cfg.fallback) ? cfg.fallback : {};
  if (fallback.mensagens !== undefined) {
    const lista = fallback.mensagens;
    if (!Array.isArray(lista) || lista.length !== 3 || lista.some(texto => !textoValido(texto))) erros.push('fallback.mensagens precisa ter três mensagens não vazias.');
    else {
      if (new Set(lista.map(normalizar)).size !== 3) erros.push('fallback.mensagens precisa ter três mensagens distintas.');
      lista.forEach((texto, i) => conferirMarcadores(texto, 'fallback.mensagens[' + i + ']'));
    }
  }
  if (fallback.mensagem_midia !== undefined) {
    if (!textoValido(fallback.mensagem_midia)) erros.push('fallback.mensagem_midia não pode ser vazia.');
    else conferirMarcadores(fallback.mensagem_midia, 'fallback.mensagem_midia');
  }
  if (cfg.saudacoes !== undefined && (!Array.isArray(cfg.saudacoes) || cfg.saudacoes.some(texto => !textoValido(texto)))) erros.push('saudacoes precisa ser uma lista de textos não vazios.');
  const opcoes = Array.isArray(cfg.opcoes) ? cfg.opcoes : [];
  if (!opcoes.length) erros.push('"opcoes" precisa ter pelo menos uma opção.');
  const ids = new Set();
  const donoDaPalavra = new Map();
  opcoes.forEach((opcao, i) => {
    const onde = 'opcoes[' + i + ']' + (textoValido(opcao?.id) ? ' (' + opcao.id + ')' : '');
    if (!objeto(opcao)) { erros.push(onde + ': precisa ser um objeto.'); return; }
    if (!textoValido(opcao.id)) erros.push(onde + ': falta "id".');
    else if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(opcao.id) || ['__proto__', 'constructor', 'prototype'].includes(opcao.id)) erros.push(onde + ': "id" deve usar somente letras, números, _ ou -, com até 64 caracteres.');
    else if (ids.has(opcao.id)) erros.push(onde + ': "id" repetido.');
    else ids.add(opcao.id);
    if (opcao.titulo !== undefined && !textoValido(opcao.titulo)) erros.push(onde + ': "titulo" não pode ser vazio.');
    for (const campo of ['mostrar_no_menu', 'usar_na_ia', 'transferir_para_humano']) {
      if (opcao[campo] !== undefined && typeof opcao[campo] !== 'boolean') erros.push(onde + ': "' + campo + '" precisa ser true ou false (sem aspas).');
    }
    if (!textoValido(opcao.resposta)) erros.push(onde + ': falta "resposta".');
    else conferirMarcadores(opcao.resposta, onde + '.resposta');
    const palavras = [];
    for (const campo of ['palavras_exatas', 'palavras_chave', 'perguntas']) {
      const lista = opcao[campo];
      if (lista === undefined) continue;
      if (!Array.isArray(lista) || lista.some(palavra => !textoValido(palavra))) {
        erros.push(onde + ': "' + campo + '" precisa ser uma lista de textos não vazios entre aspas.');
        continue;
      }
      palavras.push(...lista);
    }
    if (!palavras.length) erros.push(onde + ': precisa de ao menos uma palavra ou exemplo em "palavras_exatas", "palavras_chave" ou "perguntas".');
    for (const palavra of palavras) {
      const normalizada = normalizar(palavra);
      if (!normalizada) avisos.push(onde + ': a palavra "' + palavra + '" fica vazia depois de tirar acentos e pontuação.');
      else if (donoDaPalavra.has(normalizada) && donoDaPalavra.get(normalizada) !== opcao.id) erros.push(onde + ': a palavra "' + palavra + '" também está na opção "' + donoDaPalavra.get(normalizada) + '".');
      else donoDaPalavra.set(normalizada, opcao.id);
    }
  });
  const humano = objeto(cfg.atendimento_humano) ? cfg.atendimento_humano : {};
  if (humano.horas_pausa !== undefined && !(Number.isFinite(Number(humano.horas_pausa)) && Number(humano.horas_pausa) > 0)) erros.push('atendimento_humano.horas_pausa precisa ser um número maior que zero.');
  for (const campo of ['comando_reativar', 'comando_pausar']) {
    if (humano[campo] !== undefined && !normalizar(humano[campo])) erros.push('atendimento_humano.' + campo + ' não pode ser vazio.');
  }
  if (humano.comando_reativar !== undefined && normalizar(humano.comando_reativar) === normalizar(humano.comando_pausar ?? '#humano')) erros.push('atendimento_humano: os comandos de reativar e de pausar não podem ser iguais.');
  if (humano.pausar_quando_atendente_responder !== undefined && typeof humano.pausar_quando_atendente_responder !== 'boolean') erros.push('atendimento_humano.pausar_quando_atendente_responder precisa ser true ou false (sem aspas).');
  if (humano.palavras_para_voltar !== undefined && (!Array.isArray(humano.palavras_para_voltar) || humano.palavras_para_voltar.some(palavra => typeof palavra !== 'string'))) erros.push('atendimento_humano.palavras_para_voltar precisa ser uma lista de textos entre aspas (ou [] para desligar).');
  const prot = objeto(cfg.protecoes) ? cfg.protecoes : {};
  const numeroValido = (valor, minimo) => Number.isFinite(Number(valor)) && Number(valor) >= minimo;
  if (prot.agrupar_mensagens_segundos !== undefined) {
    if (!numeroValido(prot.agrupar_mensagens_segundos, 0)) erros.push('protecoes.agrupar_mensagens_segundos precisa ser um número (0 desliga o agrupamento).');
    else if (Number(prot.agrupar_mensagens_segundos) > 30) avisos.push('protecoes.agrupar_mensagens_segundos acima de 30 é tratado como 30.');
  }
  for (const campo of ['max_mensagens_por_hora', 'max_respostas_iguais', 'janela_respostas_iguais_minutos']) {
    if (prot[campo] !== undefined && !numeroValido(prot[campo], 1)) erros.push('protecoes.' + campo + ' precisa ser um número maior ou igual a 1.');
  }
  if (prot.idade_maxima_mensagem_segundos !== undefined && !numeroValido(prot.idade_maxima_mensagem_segundos, 0)) erros.push('protecoes.idade_maxima_mensagem_segundos precisa ser um número (0 desliga a verificação).');
  for (const campo of ['responder_mensagens_recebidas_offline', 'responder_midia_com_menu']) {
    if (prot[campo] !== undefined && typeof prot[campo] !== 'boolean') erros.push('protecoes.' + campo + ' precisa ser true ou false (sem aspas).');
  }
  if (prot.atraso_resposta_segundos !== undefined) {
    const atraso = prot.atraso_resposta_segundos;
    if (!objeto(atraso) || !numeroValido(atraso.min, 0) || !numeroValido(atraso.max, 0)) erros.push('protecoes.atraso_resposta_segundos precisa de "min" e "max" numéricos.');
    else if (Number(atraso.min) > Number(atraso.max)) erros.push('protecoes.atraso_resposta_segundos: "min" não pode ser maior que "max".');
    else if (Number(atraso.max) > 30) avisos.push('protecoes.atraso_resposta_segundos.max acima de 30 segundos deixa as respostas muito lentas.');
  }

  // Assistente de IA para o que o robô não reconhece (opcional).
  const ia = objeto(cfg.ia) ? cfg.ia : {};
  if (ia.ativa !== undefined && typeof ia.ativa !== 'boolean') erros.push('ia.ativa precisa ser true ou false (sem aspas).');
  if (ia.provedor !== undefined && !['groq', 'xai'].includes(String(ia.provedor).trim().toLowerCase())) {
    erros.push('ia.provedor precisa ser "groq" ou "xai". Para outro serviço compatível, informe ia.url e ia.modelo.');
  }
  if (ia.url !== undefined) {
    let endereco = null;
    try { endereco = new URL(String(ia.url).trim()); } catch { endereco = null; }
    if (typeof ia.url !== 'string' || !endereco || !['http:', 'https:'].includes(endereco.protocol)) erros.push('ia.url precisa ser um endereço completo começando com https:// (ou apague o campo para usar o do provedor).');
    else if (!textoValido(ia.modelo)) erros.push('ia.modelo é obrigatório quando ia.url é informado.');
  }
  if (ia.modelo !== undefined && !textoValido(ia.modelo)) erros.push('ia.modelo não pode ser vazio (apague o campo para usar o modelo padrão do provedor).');
  for (const [campo, minimo, maximo] of [
    ['max_usos_por_contato', 0, 1000], ['max_usos_por_dia', 0, 1000000], ['janela_horas', 0.25, 720],
    ['tamanho_maximo_resposta', 120, 3000], ['tempo_limite_segundos', 2, 30], ['temperatura', 0, 2], ['max_tokens', 64, 4000],
  ]) {
    if (ia[campo] === undefined) continue;
    if (typeof ia[campo] !== 'number' || !Number.isFinite(ia[campo]) || ia[campo] < minimo || ia[campo] > maximo) {
      erros.push('ia.' + campo + ' precisa ser um número entre ' + minimo + ' e ' + maximo + ' (sem aspas).');
    }
  }
  for (const campo of ['conhecimento', 'instrucoes', 'rodape']) {
    if (ia[campo] === undefined) continue;
    if (typeof ia[campo] !== 'string') erros.push('ia.' + campo + ' precisa ser um texto entre aspas.');
    else conferirMarcadores(ia[campo], 'ia.' + campo);
  }
  if (ia.parametros !== undefined && !objeto(ia.parametros)) erros.push('ia.parametros precisa ser um objeto.');
  if (ia.ativa === true && (ia.max_usos_por_contato === 0 || ia.max_usos_por_dia === 0)) {
    avisos.push('ia.ativa está ligada, mas um dos limites de uso é 0: a IA nunca será consultada.');
  }
  return { erros, avisos };
}

// ---------- Formato v2 (vários eventos) ----------

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
// Assuntos da raiz (conferidos uma vez só, não a cada evento).
const SO_NA_RAIZ = ['atendimento_humano', 'protecoes', 'saudacoes', 'mensagens.reativado', 'ia.'];

function validarV2(cfg) {
  const erros = [];
  const avisos = [];
  for (const campo of ['produtora', 'mensagens', 'atendimento_humano', 'protecoes', 'fallback', 'ia']) {
    if (cfg[campo] !== undefined && !objeto(cfg[campo])) erros.push(campo + ' precisa ser um objeto.');
  }
  if (!objeto(cfg.produtora)) erros.push('produtora é obrigatória e precisa ser um objeto.');
  const produtora = objeto(cfg.produtora) ? cfg.produtora : {};
  const mensagens = objeto(cfg.mensagens) ? cfg.mensagens : {};
  for (const chave of ['sem_eventos', 'escolher_evento']) {
    if (mensagens[chave] === undefined) continue;
    if (!textoValido(mensagens[chave])) { erros.push('mensagens.' + chave + ' não pode ser vazia (apague o campo para usar o texto padrão).'); continue; }
    for (const [, nome] of mensagens[chave].matchAll(/\{\{\s*([\w-]+)\s*\}\}/g)) {
      const permitido = nome === 'opcoes' ? false : (chave === 'escolher_evento' && nome === 'eventos') || Object.prototype.hasOwnProperty.call(produtora, nome);
      if (!permitido) erros.push('mensagens.' + chave + ': usa {{' + nome + '}}, mas não existe "' + nome + '" em "produtora".');
    }
  }

  // Raiz: reaproveita a validação v1 sobre a configuração "sem evento", ignorando o que só vale por evento.
  const raiz = validarConfig(configDoEvento(cfg, null));
  const ajustar = (msg) => msg.replace(/^evento\./, 'produtora.').replace(' em "evento".', ' em "produtora".');
  for (const e of raiz.erros) {
    if (e.startsWith('"opcoes" precisa') || e.startsWith('mensagens.menu é obrigatória')) continue;
    erros.push(ajustar(e));
  }
  for (const a of raiz.avisos) {
    if (a.startsWith('mensagens.nao_entendi está vazia')) continue;
    avisos.push(ajustar(a));
  }

  const eventos = cfg.eventos;
  const ids = new Set();
  const donoDoGatilho = new Map();
  eventos.forEach((ev, i) => {
    if (!objeto(ev)) { erros.push('eventos[' + i + ']: precisa ser um objeto.'); return; }
    const id = textoValido(ev.id) ? ev.id : '';
    const onde = 'eventos[' + i + ']' + (id ? ' (' + id + ')' : '') + ': ';
    const estrutura = [];
    if (!SLUG.test(id)) erros.push(onde + '"id" deve usar letras minúsculas sem acento, números e hífen, com até 64 caracteres.');
    else if (ids.has(id)) erros.push(onde + '"id" repetido.');
    else ids.add(id);
    if (!STATUS.includes(ev.status)) erros.push(onde + '"status" precisa ser "rascunho", "ativo" ou "encerrado".');
    // Erros de conteúdo bloqueiam só quando o evento está ativo (ou com status inválido).
    const destino = ev.status === 'rascunho' || ev.status === 'encerrado' ? avisos : erros;
    for (const campo of ['evento', 'mensagens', 'fallback', 'ia']) {
      if (ev[campo] !== undefined && !objeto(ev[campo])) estrutura.push(campo + ' precisa ser um objeto.');
    }
    if (ev.opcoes !== undefined && !Array.isArray(ev.opcoes)) estrutura.push('opcoes precisa ser uma lista.');
    const gatilhos = ev.gatilhos;
    if (!Array.isArray(gatilhos) || gatilhos.some((g) => !textoValido(g) || !normalizar(g))) estrutura.push('gatilhos precisa ser uma lista de textos não vazios (pode ser vazia).');
    else if (ev.status === 'ativo') {
      for (const g of gatilhos) {
        const chave = normalizar(g);
        if (donoDoGatilho.has(chave) && donoDoGatilho.get(chave) !== id) erros.push(onde + 'o gatilho "' + g + '" também está no evento "' + donoDoGatilho.get(chave) + '".');
        else donoDoGatilho.set(chave, id);
      }
    }
    for (const m of estrutura) destino.push(onde + m);
    if (estrutura.length || !SLUG.test(id)) return;

    const resultado = validarConfig(configDoEvento(cfg, id));
    const proprias = (chave) => objeto(ev[chave]) ? ev[chave] : {};
    const manter = (msg) => {
      if (SO_NA_RAIZ.some((p) => msg.startsWith(p) && !(p === 'ia.' && msg.startsWith('ia.conhecimento')))) return false;
      if (msg.startsWith('mensagens.agradecimento') && proprias('mensagens').agradecimento === undefined) return false;
      const campo = msg.match(/^evento\.(\S+) está/);
      if (campo && Object.prototype.hasOwnProperty.call(produtora, campo[1]) && !Object.prototype.hasOwnProperty.call(proprias('evento'), campo[1])) return false;
      // fallback herdado da raiz já foi conferido lá; só repete se o evento trouxer o seu.
      if (msg.startsWith('fallback.') && ev.fallback === undefined) return false;
      return true;
    };
    for (const e of resultado.erros.filter(manter)) destino.push(onde + e);
    for (const a of resultado.avisos.filter(manter)) avisos.push(onde + a);
  });
  if (!eventos.some((ev) => objeto(ev) && ev.status === 'ativo')) {
    avisos.push('Nenhum evento está ativo: o robô só vai responder a mensagem "sem_eventos".');
  }
  return { erros, avisos };
}

module.exports = { validarConfig };
