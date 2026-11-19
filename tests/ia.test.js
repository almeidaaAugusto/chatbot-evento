'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const IA = require('../lib/ia');
const { resolver } = require('../lib/conversa');

function exemplo() {
  return {
    evento: {
      _ajuda: 'texto de ajuda que não é dado do evento',
      nome: 'Baile Teste', data: 'Sábado, 14/11', horario: '22h', local: 'Arena Central',
      ingresso: 'Geral: R$ 40,00 + taxa', link_ingressos: 'https://ingressos.example.com/baile',
      link_compra: 'https://ingressos.example.com/baile', instagram: 'https://www.instagram.com/baile.teste/',
      pendente: '[CAMPO_NAO_PREENCHIDO]',
    },
    mensagens: { menu: '1 - Comprar ingresso\n2 - Documentos' },
    opcoes: [
      { id: 'comprar', titulo: 'Comprar ingresso', palavras_exatas: ['1'], palavras_chave: ['comprar'],
        resposta: 'Compre em {{link_compra}} ou sem taxa com a Ana: https://wa.me/5518999990000' },
      { id: 'documentos', titulo: 'Documentos', palavras_exatas: ['2'], palavras_chave: ['documento'],
        resposta: 'Leve documento com foto. Proibido para menores de 18.' },
    ],
    ia: {
      ativa: true,
      conhecimento: 'Contato: @baile.teste e sac@baile.example.com.\nEstacionamento: ainda não divulgado. Instagram: {{instagram}}',
    },
  };
}

const respostaDaApi = (conteudo, extras = {}) => ({ choices: [{ message: { role: 'assistant', content: conteudo }, finish_reason: 'stop', ...extras }] });
const naoEntendi = { intencao: 'nao_entendi', origem: 'nao_reconhecida' };

test('padrões: Groq, modelo gratuito, poucos usos por contato e teto diário', () => {
  const conf = IA.configuracao({});
  assert.equal(conf.ativa, false);
  assert.equal(conf.provedor, 'groq');
  assert.equal(conf.url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(conf.modelo, 'openai/gpt-oss-120b');
  assert.equal(conf.maxUsosPorContato, 3);
  assert.equal(conf.janelaSegundos, 12 * 3600);
  assert.equal(conf.maxUsosPorDia, 80);
  assert.equal(conf.tempoLimiteMs, 12000);
});

test('configuração aceita xAI, serviço próprio e mantém valores dentro de faixas seguras', () => {
  const xai = IA.configuracao({ ia: { ativa: true, provedor: 'XAI' } });
  assert.equal(xai.provedor, 'xai');
  assert.equal(xai.url, 'https://api.x.ai/v1/chat/completions');
  assert.equal(xai.modelo, 'grok-4.3');
  const proprio = IA.configuracao({ ia: { url: ' http://servidor.local:1234/v1/chat/completions ', modelo: 'meu-modelo' } });
  assert.equal(proprio.url, 'http://servidor.local:1234/v1/chat/completions');
  assert.equal(proprio.modelo, 'meu-modelo');
  const exagerada = IA.configuracao({ ia: { ativa: 'sim', provedor: 'desconhecido', max_usos_por_contato: -5, janela_horas: 0,
    max_usos_por_dia: 'abc', tempo_limite_segundos: 999, tamanho_maximo_resposta: 5, temperatura: 9, parametros: [] } });
  assert.equal(exagerada.ativa, false, 'só o booleano true liga a IA');
  assert.equal(exagerada.provedor, 'groq');
  assert.equal(exagerada.maxUsosPorContato, 0);
  assert.equal(exagerada.janelaSegundos, 900);
  assert.equal(exagerada.maxUsosPorDia, 80);
  assert.equal(exagerada.tempoLimiteMs, 30000);
  assert.equal(exagerada.tamanhoMaximo, 120);
  assert.equal(exagerada.temperatura, 2);
  assert.deepEqual(exagerada.parametros, {});
});

test('a chave indica o provedor', () => {
  assert.equal(IA.provedorDaChave('gsk_abc123'), 'groq');
  assert.equal(IA.provedorDaChave('  xai-abc123 '), 'xai');
  assert.equal(IA.provedorDaChave('sk-outra'), '');
  assert.equal(IA.provedorDaChave(null), '');
});

test('conhecimento reúne dados do evento, respostas preenchidas e informações extras', () => {
  const fatos = IA.conhecimentoDoEvento(exemplo());
  assert.match(fatos, /Nome do evento: Baile Teste/);
  assert.match(fatos, /Horário de início: 22h/);
  assert.match(fatos, /\[Comprar ingresso - opção 1 do menu\]\nCompre em https:\/\/ingressos\.example\.com\/baile/);
  assert.match(fatos, /Estacionamento: ainda não divulgado\. Instagram: https:\/\/www\.instagram\.com\/baile\.teste\//);
  assert.doesNotMatch(fatos, /texto de ajuda|CAMPO_NAO_PREENCHIDO|\{\{/);
  assert.equal(fatos.match(/https:\/\/ingressos\.example\.com\/baile/g).length, 2, 'link repetido nos dados do evento aparece uma vez só ali');
  const semOpcao = exemplo();
  semOpcao.opcoes[1].usar_na_ia = false;
  assert.doesNotMatch(IA.conhecimentoDoEvento(semOpcao), /menores de 18/);
  assert.equal(IA.conhecimentoDoEvento(null), '');
});

test('instruções são estáveis para a mesma configuração e proíbem inventar', () => {
  const a = IA.promptDoSistema(exemplo());
  assert.equal(a, IA.promptDoSistema(exemplo()), 'prefixo idêntico permite cache no provedor');
  assert.ok(a.includes(IA.SEM_RESPOSTA));
  assert.match(a, /Nunca invente/);
  assert.match(a, /"Baile Teste"/);
  assert.ok(a.endsWith(IA.conhecimentoDoEvento(exemplo())));
  const comRegra = exemplo();
  comRegra.ia.instrucoes = 'Chame o evento de {{nome}}.\nSeja breve.';
  assert.match(IA.promptDoSistema(comRegra), /9\. Chame o evento de Baile Teste\. Seja breve\./);
  assert.match(IA.promptDoSistema({}), /"um evento"/);
});

test('pedido leva só as instruções e a mensagem, com data atual e assunto anterior', () => {
  const pedido = IA.montarPedido(exemplo(), '  tem\u0000 estacionamento?\n\n  ', {
    agora: new Date('2026-11-10T22:30:00Z'), fuso: 'America/Sao_Paulo', ultimaIntencao: 'documentos',
  });
  assert.equal(pedido.url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(pedido.tempoLimiteMs, 12000);
  assert.equal(pedido.corpo.model, 'openai/gpt-oss-120b');
  assert.equal(pedido.corpo.max_completion_tokens, 700);
  assert.equal(pedido.corpo.reasoning_effort, 'low');
  assert.equal(pedido.corpo.include_reasoning, false);
  assert.equal(pedido.corpo.messages.length, 2);
  assert.equal(pedido.corpo.messages[0].role, 'system');
  assert.equal(pedido.corpo.messages[0].content, IA.promptDoSistema(exemplo()));
  assert.equal(pedido.corpo.messages[1].role, 'user');
  assert.equal(pedido.corpo.messages[1].content,
    '[Agora: terça-feira, 10/11/2026, 19:30 | Assunto da resposta anterior: Documentos]\nMensagem do cliente: tem estacionamento?');
});

test('mensagem longa é cortada e fuso inválido não derruba o pedido', () => {
  const pedido = IA.montarPedido(exemplo(), 'a'.repeat(5000), { agora: new Date('2026-11-10T22:30:00Z'), fuso: 'Fuso/Inexistente' });
  const usuario = pedido.corpo.messages[1].content;
  assert.ok(usuario.endsWith('Mensagem do cliente: ' + 'a'.repeat(600)));
  assert.match(usuario, /^\[Agora: terça-feira, 10\/11\/2026, 19:30\]/);
});

test('parâmetros seguem o provedor e podem ser sobrescritos', () => {
  const xai = exemplo();
  xai.ia.provedor = 'xai';
  const pedidoXai = IA.montarPedido(xai, 'oi tudo bem');
  assert.equal(pedidoXai.corpo.model, 'grok-4.3');
  assert.equal(pedidoXai.corpo.max_completion_tokens, 700);
  assert.equal(pedidoXai.corpo.reasoning_effort, undefined);

  const proprio = exemplo();
  Object.assign(proprio.ia, { url: 'http://servidor.local:1234/v1/chat/completions', modelo: 'meu-modelo', max_tokens: 300, parametros: { temperature: 0, top_p: 0.9 } });
  const pedidoProprio = IA.montarPedido(proprio, 'oi tudo bem');
  assert.equal(pedidoProprio.corpo.max_tokens, 300);
  assert.equal(pedidoProprio.corpo.max_completion_tokens, undefined);
  assert.equal(pedidoProprio.corpo.temperature, 0);
  assert.equal(pedidoProprio.corpo.top_p, 0.9);

  const outroModelo = exemplo();
  outroModelo.ia.modelo = 'qwen/qwen3.8-27b';
  assert.equal(IA.montarPedido(outroModelo, 'oi tudo bem').corpo.reasoning_effort, undefined);
});

test('IA só é consultada para texto não reconhecido e com a IA ligada (limite 0 = sem limite)', () => {
  const cfg = exemplo();
  assert.equal(IA.deveConsultar(cfg, naoEntendi, 'tem estacionamento?'), true);
  assert.equal(IA.deveConsultar(cfg, { intencao: 'nao_entendi', origem: 'fallback_esgotado', silenciar: true }, 'e open bar?'), true);
  assert.equal(IA.deveConsultar(cfg, { intencao: 'nao_entendi', origem: 'midia_sem_texto' }, ''), false);
  assert.equal(IA.deveConsultar(cfg, { intencao: 'comprar', origem: 'palavra_chave' }, 'quero comprar'), false);
  assert.equal(IA.deveConsultar(cfg, { intencao: 'esclarecer', origem: 'desambiguacao' }, 'valor e endereço'), false);
  assert.equal(IA.deveConsultar(cfg, { intencao: 'menu', origem: 'saudacao' }, 'oi'), false);
  for (const semLetras of ['12', '??', '👍👍', '   ', 'ok']) assert.equal(IA.deveConsultar(cfg, naoEntendi, semLetras), false, semLetras);
  assert.equal(IA.deveConsultar(cfg, null, 'tem estacionamento?'), false);
  const desligada = exemplo();
  desligada.ia.ativa = false;
  assert.equal(IA.deveConsultar(desligada, naoEntendi, 'tem estacionamento?'), false);
  for (const ajuste of [{ max_usos_por_contato: 0 }, { max_usos_por_dia: 0 }, { max_usos_por_contato: 0, max_usos_por_dia: 0 }]) {
    const semLimite = exemplo();
    Object.assign(semLimite.ia, ajuste);
    assert.equal(IA.deveConsultar(semLimite, naoEntendi, 'tem estacionamento?'), true, JSON.stringify(ajuste));
  }
  const semSecao = exemplo();
  delete semSecao.ia;
  assert.equal(IA.deveConsultar(semSecao, naoEntendi, 'tem estacionamento?'), false);
});

test('resposta simples é aceita e o sinal de "sem resposta" devolve o atendimento ao fallback', () => {
  const lida = IA.interpretarResposta(exemplo(), respostaDaApi('  O baile começa às 22h, na Arena Central.  '));
  assert.deepEqual(lida, { ok: true, texto: 'O baile começa às 22h, na Arena Central.' });
  for (const sinal of ['[[SEM_RESPOSTA]]', ' [[sem_resposta]] ', '[SEM RESPOSTA]', 'SEM_RESPOSTA', 'Desculpe. [[SEM_RESPOSTA]]']) {
    assert.deepEqual(IA.interpretarResposta(exemplo(), respostaDaApi(sinal)), { ok: false, motivo: 'sem_resposta' }, sinal);
  }
  assert.equal(IA.interpretarResposta(exemplo(), respostaDaApi('Se ficar sem resposta por lá, tente de novo.')).ok, true);
});

test('markdown vira formatação de WhatsApp e o raciocínio do modelo é descartado', () => {
  const bruto = '<think>o cliente quer saber do documento</think>## Documentos\n**Leve documento com foto.**\n- menores não entram\n* veja [aqui](https://ingressos.example.com/baile)\n\n\n\n"fim"';
  const lida = IA.interpretarResposta(exemplo(), respostaDaApi(bruto));
  assert.equal(lida.ok, true);
  assert.equal(lida.texto, 'Documentos\n*Leve documento com foto.*\n• menores não entram\n• veja aqui: https://ingressos.example.com/baile\n\n"fim"');
  assert.equal(IA.interpretarResposta(exemplo(), respostaDaApi('"Começa às 22h."')).texto, 'Começa às 22h.', 'aspas em volta da resposta inteira saem');
  const emPartes = IA.interpretarResposta(exemplo(), respostaDaApi([{ type: 'text', text: 'Começa ' }, { type: 'text', text: 'às 22h.' }]));
  assert.equal(emPartes.texto, 'Começa às 22h.');
});

test('respostas vazias, cortadas ou em formato inesperado não são enviadas', () => {
  assert.equal(IA.interpretarResposta(exemplo(), respostaDaApi('   ')).motivo, 'vazia');
  assert.equal(IA.interpretarResposta(exemplo(), respostaDaApi('<think>pensando sem concluir')).motivo, 'vazia');
  assert.equal(IA.interpretarResposta(exemplo(), respostaDaApi('', { finish_reason: 'length' })).motivo, 'resposta_cortada');
  assert.equal(IA.interpretarResposta(exemplo(), respostaDaApi(null)).motivo, 'vazia');
  for (const invalida of [null, 'texto', [], {}, { choices: [] }, { choices: ['x'] }]) {
    assert.equal(IA.interpretarResposta(exemplo(), invalida).motivo, 'resposta_invalida', JSON.stringify(invalida));
  }
});

test('erros da API viram um rótulo curto, sem o conteúdo', () => {
  const motivo = (erro) => IA.interpretarResposta(exemplo(), { error: erro }).motivo;
  assert.equal(motivo({ httpCode: '429', message: 'Too many requests' }), 'erro_429');
  assert.equal(motivo({ status: 401 }), 'erro_401');
  assert.equal(motivo({ response: { status: 503 } }), 'erro_503');
  assert.equal(motivo('Request failed with status code 500'), 'erro_500');
  assert.equal(motivo({ message: 'timeout of 3000ms exceeded', code: 'ECONNABORTED' }), 'tempo_esgotado');
  assert.equal(motivo({ name: 'AbortError', message: 'The operation was aborted' }), 'tempo_esgotado');
  assert.equal(motivo({ message: 'connect ECONNREFUSED 10.0.0.1:443' }), 'erro');
  assert.equal(motivo(null), 'erro');
});

test('links, perfis, e-mails, telefones e preços precisam existir no conhecimento', () => {
  const lida = (conteudo) => IA.interpretarResposta(exemplo(), respostaDaApi(conteudo));
  // Conferem com o cadastrado (inclusive com pontuação colada e outro formato).
  for (const certa of [
    'Compre aqui: https://ingressos.example.com/baile.',
    'Fale com a Ana (https://wa.me/5518999990000)!',
    'O Instagram é https://www.instagram.com/baile.teste/ e o perfil é @baile.teste.',
    'Escreva para sac@baile.example.com.',
    'Chame a Ana no (18) 99999-0000 ou +55 18 99999-0000.',
    'O ingresso Geral está R$ 40,00 (R$40 + taxa), ou seja, 40 reais.',
    'É no sábado, 14/11/2026, às 22h. Menores de 18 não entram.',
  ]) assert.equal(lida(certa).ok, true, certa);
  // Inventados: a resposta inteira é descartada.
  for (const [inventada, motivo] of [
    ['Compre em https://ingressos.example.com/outro-baile', 'link_nao_confirmado'],
    ['Compre em https://sympla.com.br/baile', 'link_nao_confirmado'],
    ['Veja em sympla.com.br/baile-teste', 'link_nao_confirmado'],
    ['Fale no https://wa.me/5511988887777', 'link_nao_confirmado'],
    ['Chame o @outro.perfil no Instagram', 'contato_nao_confirmado'],
    ['Escreva para contato@outro.example.com', 'contato_nao_confirmado'],
    ['Ligue para (11) 98888-7777', 'contato_nao_confirmado'],
    ['O ingresso custa R$ 25,00', 'preco_nao_confirmado'],
    ['Sai por 60 reais na portaria', 'preco_nao_confirmado'],
  ]) assert.deepEqual(lida(inventada), { ok: false, motivo }, inventada);
});

test('resposta longa é cortada no fim de uma frase e nunca no meio de um link', () => {
  const cfg = exemplo();
  cfg.ia.tamanho_maximo_resposta = 120;
  const frases = 'Primeira frase curta. ' + 'Segunda frase um pouco mais comprida para passar do limite. ' + 'Terceira frase que não cabe de jeito nenhum aqui.';
  const cortada = IA.interpretarResposta(cfg, respostaDaApi(frases));
  assert.equal(cortada.texto, 'Primeira frase curta. Segunda frase um pouco mais comprida para passar do limite.');
  const comLink = IA.interpretarResposta(cfg, respostaDaApi('palavra '.repeat(11) + 'https://ingressos.example.com/baile e mais texto depois do link sem ponto final'));
  assert.ok(comLink.ok);
  assert.ok(comLink.texto.length <= 121);
  assert.doesNotMatch(comLink.texto, /https?:\/\/(?!ingressos\.example\.com\/baile(?:\s|…|$))/, 'link pela metade não pode ser enviado');
  assert.ok(comLink.texto.endsWith('…'));
});

test('rodapé configurado acompanha a resposta, com os campos do evento preenchidos', () => {
  const cfg = exemplo();
  cfg.ia.rodape = '_Resposta automática de {{nome}}. Digite *menu*._';
  const lida = IA.interpretarResposta(cfg, respostaDaApi('Começa às 22h.'));
  assert.equal(lida.texto, 'Começa às 22h.\n\n_Resposta automática de Baile Teste. Digite *menu*._');
});

test('assinatura é a mesma usada pelo motor de conversa', () => {
  const saida = resolver(exemplo(), '1');
  assert.equal(IA.assinatura(saida.resposta), saida.estado.ultimaResposta);
  assert.match(IA.assinatura('qualquer texto'), /^[a-f0-9]{1,8}$/);
});

test('consulta completa envia a chave no cabeçalho e interpreta a resposta', async () => {
  const chamadas = [];
  const fetchFalso = async (url, opcoes) => {
    chamadas.push({ url, opcoes });
    return { ok: true, status: 200, json: async () => ({ ...respostaDaApi('Começa às **22h**.'), usage: { total_tokens: 321 } }) };
  };
  const saida = await IA.consultar(exemplo(), 'que horas começa mesmo?', { chave: ' gsk_teste ', fetch: fetchFalso });
  assert.deepEqual(saida, { ok: true, texto: 'Começa às *22h*.', uso: { total_tokens: 321 } });
  assert.equal(chamadas.length, 1);
  assert.equal(chamadas[0].url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(chamadas[0].opcoes.method, 'POST');
  assert.equal(chamadas[0].opcoes.headers.Authorization, 'Bearer gsk_teste');
  const corpo = JSON.parse(chamadas[0].opcoes.body);
  assert.equal(corpo.model, 'openai/gpt-oss-120b');
  assert.ok(corpo.messages[1].content.endsWith('Mensagem do cliente: que horas começa mesmo?'));
});

test('consulta sem chave, com erro HTTP, sem rede ou lenta devolve o motivo', async () => {
  assert.deepEqual(await IA.consultar(exemplo(), 'oi tudo bem', { chave: '' }), { ok: false, motivo: 'sem_chave' });
  const limite = await IA.consultar(exemplo(), 'oi tudo bem', {
    chave: 'gsk_teste',
    fetch: async () => ({ ok: false, status: 429, json: async () => ({ error: { message: 'Rate limit reached' } }) }),
  });
  assert.deepEqual(limite, { ok: false, motivo: 'erro_429', status: 429, detalhe: 'Rate limit reached' });
  const semJson = await IA.consultar(exemplo(), 'oi tudo bem', {
    chave: 'gsk_teste', fetch: async () => ({ ok: false, status: 502, json: async () => { throw new Error('html'); } }),
  });
  assert.equal(semJson.motivo, 'erro_502');
  const semRede = await IA.consultar(exemplo(), 'oi tudo bem', { chave: 'gsk_teste', fetch: async () => { throw new Error('ENOTFOUND'); } });
  assert.deepEqual(semRede, { ok: false, motivo: 'erro_de_rede' });
  const lenta = exemplo();
  lenta.ia.tempo_limite_segundos = 2;
  const inicio = Date.now();
  const esgotada = await IA.consultar(lenta, 'oi tudo bem', {
    chave: 'gsk_teste',
    fetch: (url, opcoes) => new Promise((resolve, reject) => {
      opcoes.signal.addEventListener('abort', () => { const erro = new Error('abortada'); erro.name = 'AbortError'; reject(erro); });
    }),
  });
  assert.deepEqual(esgotada, { ok: false, motivo: 'tempo_esgotado' });
  assert.ok(Date.now() - inicio < 4000, 'a espera respeita o tempo limite configurado');
});

test('modelosReserva: até 2, sem vazios, repetidos nem o modelo principal', () => {
  assert.deepEqual(IA.configuracao({}).modelosReserva, []);
  const cfg = exemplo();
  cfg.ia.modelos_reserva = [' openai/gpt-oss-20b ', '', 'openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b', 'outro'];
  assert.deepEqual(IA.configuracao(cfg).modelosReserva, ['openai/gpt-oss-20b', 'qwen/qwen3.8-27b']);
  cfg.ia.modelos_reserva = 'texto';
  assert.deepEqual(IA.configuracao(cfg).modelosReserva, []);
});

test('montarPedido aceita contexto.modelo e decide o raciocínio pelo modelo efetivo', () => {
  const cfg = exemplo();
  cfg.ia.parametros = { top_p: 0.5 };
  const qwen = IA.montarPedido(cfg, 'oi tudo bem', { modelo: 'qwen/qwen3.8-27b' });
  assert.equal(qwen.corpo.model, 'qwen/qwen3.8-27b');
  assert.equal(qwen.corpo.reasoning_effort, undefined);
  assert.equal(qwen.corpo.include_reasoning, undefined);
  assert.equal(qwen.corpo.top_p, 0.5);
  const oss = IA.montarPedido(cfg, 'oi tudo bem', { modelo: 'openai/gpt-oss-20b' });
  assert.equal(oss.corpo.reasoning_effort, 'low');
  const principalQwen = exemplo();
  principalQwen.ia.modelo = 'qwen/qwen3.8-27b';
  assert.equal(IA.montarPedido(principalQwen, 'oi tudo bem', { modelo: 'openai/gpt-oss-20b' }).corpo.reasoning_effort, 'low');
});

test('montarPedidos devolve principal e reservas, só os gpt-oss com raciocínio', () => {
  const cfg = exemplo();
  cfg.ia.modelos_reserva = ['openai/gpt-oss-20b', 'qwen/qwen3.8-27b'];
  const pedidos = IA.montarPedidos(cfg, 'tem estacionamento?', { agora: new Date('2026-11-10T22:30:00Z') });
  assert.deepEqual(pedidos.map((p) => p.corpo.model), ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b']);
  assert.deepEqual(pedidos.map((p) => p.corpo.reasoning_effort), ['low', 'low', undefined]);
  assert.deepEqual(pedidos.map((p) => p.corpo.include_reasoning), [false, false, undefined]);
  assert.ok(pedidos.every((p) => p.url === pedidos[0].url && p.tempoLimiteMs === pedidos[0].tempoLimiteMs));
  assert.deepEqual(pedidos[0], IA.montarPedido(cfg, 'tem estacionamento?', { agora: new Date('2026-11-10T22:30:00Z') }));
  assert.equal(IA.montarPedidos(exemplo(), 'oi tudo bem').length, 1);
});

test('deveTentarReserva: só falhas que outro modelo pode resolver', () => {
  for (const motivo of ['erro_429', 'erro_500', 'erro_502', 'erro_503', 'erro_599', 'tempo_esgotado', 'erro', 'erro_de_rede', 'resposta_invalida']) {
    assert.equal(IA.deveTentarReserva(motivo), true, motivo);
  }
  for (const motivo of ['sem_resposta', 'vazia', 'resposta_cortada', 'link_nao_confirmado', 'contato_nao_confirmado', 'preco_nao_confirmado',
    'erro_400', 'erro_401', 'erro_403', 'erro_404', 'limite_por_contato', 'limite_do_dia', '', undefined]) {
    assert.equal(IA.deveTentarReserva(motivo), false, String(motivo));
  }
});
