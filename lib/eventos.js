'use strict';
// Camada de vários eventos (configuração v2). Escolhe o evento da conversa e monta a
// configuração "achatada" (formato v1) que o motor (conversa.js) e a IA (ia.js) já entendem.
// Puro: sem arquivos nem rede. Também é embutido nos nós do n8n, onde o motor já existe como
// a constante global "Chatbot"; no Node ele é carregado com require.

const motor = typeof Chatbot !== 'undefined' ? Chatbot : require('./conversa.js'); // eslint-disable-line no-undef

const STATUS = ['rascunho', 'ativo', 'encerrado'];
const COMANDOS_TROCA = ['eventos', 'trocar evento', 'outro evento', 'mudar evento'];
const SEM_EVENTOS_PADRAO = 'No momento não temos eventos com atendimento aberto. Acompanhe as novidades no nosso Instagram: {{instagram}}';
const ESCOLHER_EVENTO_PADRAO = 'Sobre qual evento você quer falar?\n\n{{eventos}}\n\nDigite o número do evento.';
// Frase que não é saudação nem opção de ninguém: serve para o motor devolver só o texto pedido.
const FRASE_FIXA = 'qqxfrasefixaqqx';

const objeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const texto = (v) => (typeof v === 'string' ? v : '');

const ehMultiEvento = (cfg) => Array.isArray(cfg?.eventos);

// Com "sessao" (número de WhatsApp), só entram eventos sem "numeros" ou que incluem a sessão.
function eventosDisponiveis(cfg, { incluirRascunhos = false, sessao } = {}) {
  if (!ehMultiEvento(cfg)) return [];
  const naSessao = (ev) => typeof sessao !== 'string' || !sessao || !Array.isArray(ev.numeros) || !ev.numeros.length || ev.numeros.includes(sessao);
  return cfg.eventos.filter((ev) => objeto(ev) && (ev.status === 'ativo' || (incluirRascunhos && ev.status === 'rascunho')) && naSessao(ev));
}

function configDoEvento(cfg, id) {
  if (!ehMultiEvento(cfg)) return cfg;
  const produtora = objeto(cfg.produtora) ? cfg.produtora : {};
  const ev = id ? cfg.eventos.find((e) => objeto(e) && e.id === id) : null;
  const iaRaiz = objeto(cfg.ia) ? cfg.ia : {};
  const base = {
    saudacoes: cfg.saudacoes,
    atendimento_humano: cfg.atendimento_humano,
    protecoes: cfg.protecoes,
  };
  if (!ev) {
    return { ...base, evento: { ...produtora }, mensagens: { ...cfg.mensagens }, fallback: { ...cfg.fallback }, opcoes: [], ia: { ...iaRaiz, ativa: false } };
  }
  const conhecimento = [iaRaiz.conhecimento, ev.ia?.conhecimento]
    .filter((t) => typeof t === 'string' && t.trim()).join('\n\n');
  return {
    ...base,
    evento: { ...produtora, ...(objeto(ev.evento) ? ev.evento : {}) },
    mensagens: { ...cfg.mensagens, ...ev.mensagens },
    fallback: { ...cfg.fallback, ...ev.fallback },
    opcoes: Array.isArray(ev.opcoes) ? ev.opcoes : [],
    ia: { ...iaRaiz, conhecimento },
  };
}

// Resposta com um texto qualquer (já com {{campos}} preenchidos pelo motor), sem passar pelas opções.
function responderTexto(cfgBase, textoResposta, estado, intencao, origem) {
  const cfg = {
    ...cfgBase,
    opcoes: [],
    saudacoes: [FRASE_FIXA],
    mensagens: { menu: textoResposta },
  };
  const saida = motor.resolver(cfg, FRASE_FIXA, estado, {});
  return { ...saida, intencao, origem, estado: { ...saida.estado, ultimaIntencao: intencao } };
}

function listaDeEventos(disp) {
  return disp.map((ev, i) => {
    const e = objeto(ev.evento) ? ev.evento : {};
    const nome = texto(e.nome) || ev.id;
    return (i + 1) + ' - ' + nome + (texto(e.data) ? ' (' + e.data + ')' : '');
  }).join('\n');
}

function resolver(cfg, textoEntrada, estado = {}, contexto = {}) {
  if (!ehMultiEvento(cfg)) return { ...motor.resolver(cfg, textoEntrada, estado, contexto), config: cfg, eventoId: null };

  const anterior = objeto(estado) ? estado : {};
  const ctx = objeto(contexto) ? contexto : {};
  const disp = eventosDisponiveis(cfg, ctx);
  const norm = motor.normalizar(textoEntrada);
  const mensagens = objeto(cfg.mensagens) ? cfg.mensagens : {};
  const configNula = configDoEvento(cfg, null);
  const eventoAnterior = typeof anterior.evento === 'string' ? anterior.evento : null;

  // O motor original descarta evento/escolhendoEvento: recoloca depois.
  const fechar = (saida, config, eventoId, escolhendo) => ({
    ...saida,
    config,
    eventoId,
    estado: { ...saida.estado, evento: eventoId ?? eventoAnterior, escolhendoEvento: escolhendo },
  });
  const comEvento = (ev) => {
    const config = configDoEvento(cfg, ev.id);
    return fechar(motor.resolver(config, textoEntrada, anterior, ctx), config, ev.id, false);
  };
  // Menu do evento (com as opções), sem contar como falha de fallback.
  const menuDoEvento = (ev, origem) => {
    const config = configDoEvento(cfg, ev.id);
    const menu = motor.resolver({ ...config, saudacoes: [FRASE_FIXA] }, FRASE_FIXA, anterior, {});
    return fechar({ ...menu, intencao: 'menu', origem, estado: { ...menu.estado, ultimaIntencao: 'menu' } }, config, ev.id, false);
  };
  const menuDeEventos = () => {
    const modelo = texto(mensagens.escolher_evento).trim() ? mensagens.escolher_evento : ESCOLHER_EVENTO_PADRAO;
    const saida = responderTexto(configNula, modelo.split('{{eventos}}').join(listaDeEventos(disp)), anterior, 'escolher_evento', 'escolher_evento');
    return fechar(saida, configNula, null, true);
  };
  const semEventos = () => {
    // Agradecimento continua sendo agradecimento; o resto recebe o aviso da produtora.
    const agradecimento = motor.resolver(configNula, textoEntrada, anterior, ctx);
    if (agradecimento.intencao === 'agradecimento') return fechar(agradecimento, configNula, null, false);
    const modelo = texto(mensagens.sem_eventos).trim() ? mensagens.sem_eventos : SEM_EVENTOS_PADRAO;
    return fechar(responderTexto(configNula, modelo, anterior, 'sem_eventos', 'sem_eventos'), configNula, null, false);
  };

  // 2. Evento forçado (simulador): vale qualquer status e ignora o filtro por número.
  const forcado = ctx.eventoId ? cfg.eventos.find((ev) => objeto(ev) && ev.id === ctx.eventoId) : null;
  if (forcado) return comEvento(forcado);

  // 3. Comando de troca de evento.
  if (COMANDOS_TROCA.includes(norm)) return disp.length ? menuDeEventos() : semEventos();

  // 4. Resposta ao menu de eventos.
  if (anterior.escolhendoEvento === true && disp.length) {
    const escolha = norm.match(/^(?:o |a )?(?:evento |opcao |numero )?(\d{1,2})$/);
    if (escolha) {
      const escolhido = disp[Number(escolha[1]) - 1];
      if (!escolhido) return menuDeEventos();
      return menuDoEvento(escolhido, 'escolha_evento');
    }
  }

  // 5. Gatilho na mensagem.
  if (norm) {
    const achados = disp.filter((ev) => (Array.isArray(ev.gatilhos) ? ev.gatilhos : []).some((g) => {
      const t = motor.normalizar(g);
      return t && (' ' + norm + ' ').includes(' ' + t + ' ');
    }));
    if (achados.length > 1) return menuDeEventos();
    if (achados.length === 1) {
      const ev = achados[0];
      const config = configDoEvento(cfg, ev.id);
      const saida = motor.resolver(config, textoEntrada, anterior, ctx);
      if (saida.intencao === 'nao_entendi' || saida.intencao === 'menu') {
        return menuDoEvento(ev, 'gatilho');
      }
      return fechar(saida, config, ev.id, false);
    }
  }

  // 6. Sem gatilho: evento lembrado, único evento ou nenhum.
  const lembrado = eventoAnterior ? disp.find((ev) => ev.id === eventoAnterior) : null;
  if (lembrado) return comEvento(lembrado);
  if (disp.length === 1) return comEvento(disp[0]);
  if (disp.length === 0) return semEventos();

  // 7. Mais de um evento e nenhuma escolha.
  return menuDeEventos();
}

// Converte uma configuração v1 (um evento só) para o formato v2.
function migrarParaV2(cfgV1, { id, status = 'ativo', gatilhos = [], produtora: nomeProdutora } = {}) {
  const v1 = objeto(cfgV1) ? cfgV1 : {};
  const dados = objeto(v1.evento) ? v1.evento : {};
  const produtora = { nome: nomeProdutora ?? dados.nome ?? '' };
  const evento = {};
  for (const [chave, valor] of Object.entries(dados)) {
    if (['instagram', 'email', 'linktree'].includes(chave)) produtora[chave] = valor;
    else evento[chave] = valor;
  }
  const mensagens = {};
  const mensagensEvento = {};
  for (const [chave, valor] of Object.entries(objeto(v1.mensagens) ? v1.mensagens : {})) {
    if (['reativado', 'agradecimento'].includes(chave)) mensagens[chave] = valor;
    else mensagensEvento[chave] = valor;
  }
  const { conhecimento, ...iaGlobal } = objeto(v1.ia) ? v1.ia : {};
  const novoEvento = { id, status, gatilhos: [...gatilhos], evento, mensagens: mensagensEvento, opcoes: v1.opcoes || [] };
  if (typeof conhecimento === 'string' && conhecimento.trim()) novoEvento.ia = { conhecimento };
  const saida = { versao: 2 };
  if (v1._ajuda !== undefined) saida._ajuda = v1._ajuda;
  Object.assign(saida, { produtora, mensagens });
  for (const campo of ['saudacoes', 'atendimento_humano', 'protecoes', 'fallback']) {
    if (v1[campo] !== undefined) saida[campo] = v1[campo];
  }
  saida.ia = iaGlobal;
  saida.eventos = [novoEvento];
  return saida;
}

module.exports = { STATUS, ehMultiEvento, eventosDisponiveis, configDoEvento, resolver, migrarParaV2 };
