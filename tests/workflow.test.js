const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const workflow = JSON.parse(fs.readFileSync(path.join(__dirname, '../n8n/workflows/chatbot-evento.json'), 'utf8'));
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const destino = (nome, saida = 0) => workflow.connections[nome]?.main[saida]?.[0]?.node;
const buscarNo = nome => {
  const no = workflow.nodes.find(n => n.name === nome);
  assert.ok(no, 'nó necessário: ' + nome);
  return no;
};
const avaliar = (expressao, json, base = {}) => new Function('$json', '$', 'return (' + expressao.slice(3, -2) + ');')(
  json, () => ({ first: () => ({ json: base }) }));
const condicao = nome => buscarNo(nome).parameters.conditions.conditions[0].leftValue;

test('workflow resolve o contexto depois do agrupamento e envia a resposta resolvida', () => {
  assert.ok(workflow.nodes.find(n => n.name === 'Resolver conversa'), 'falta resolução contextual');
  assert.equal(destino('É a última da sequência?'), 'Redis: adquirir trava da conversa');
  const envio = workflow.nodes.find(n => n.name === 'WAHA: enviar resposta');
  assert.match(envio.parameters.jsonBody, /Resposta final/);
  assert.match(buscarNo('Redis: guardar conversa').parameters.value, /Resposta final/);
  assert.match(buscarNo('Redis: contador de respostas iguais').parameters.key, /Resposta final/);
  assert.equal(workflow.connections['WAHA: enviar resposta'].main[0][0].node, 'Redis: guardar conversa');
});

test('apenas uma execução por contato resolve e persiste o contexto por vez', () => {
  const adquirir = buscarNo('Redis: adquirir trava da conversa');
  assert.equal(adquirir.parameters.operation, 'incr');
  assert.equal(adquirir.parameters.expire, true);
  assert.ok(adquirir.parameters.ttl > workflow.settings.executionTimeout, 'lease deve sobreviver à execução anterior');
  assert.equal(avaliar(adquirir.parameters.key, {}, {chaveConversa: 'conversa:contato-a'}), 'conversa:contato-a:trava');
  assert.equal(avaliar(adquirir.parameters.key, {}, {chaveConversa: 'conversa:contato-b'}), 'conversa:contato-b:trava');
  assert.equal(destino('Redis: adquirir trava da conversa'), 'Trava da conversa adquirida?');
  assert.equal(avaliar(condicao('Trava da conversa adquirida?'), {contador: 1}), true);
  assert.equal(avaliar(condicao('Trava da conversa adquirida?'), {contador: 2}), false);
  assert.equal(destino('Trava da conversa adquirida?'), 'Redis: conferir última após trava');
  assert.equal(destino('Última mensagem após a trava?'), 'Redis: ler conversa');
});

test('espera consulta o valor atual sem renovar a trava ou reutilizar dados da primeira volta', () => {
  assert.equal(destino('Trava da conversa adquirida?', 1), 'Aguardar liberação da conversa');
  assert.equal(buscarNo('Aguardar liberação da conversa').parameters.amount, 1);
  assert.equal(destino('Aguardar liberação da conversa'), 'Redis: consultar trava da conversa');
  const consultar = buscarNo('Redis: consultar trava da conversa');
  assert.equal(consultar.parameters.operation, 'get');
  assert.equal(consultar.parameters.expire, undefined);
  assert.equal(destino('Redis: consultar trava da conversa'), 'Trava da conversa livre?');
  assert.equal(avaliar(condicao('Trava da conversa livre?'), {trava: '2'}), false);
  assert.equal(avaliar(condicao('Trava da conversa livre?'), {trava: null}), true);
  assert.equal(destino('Trava da conversa livre?'), 'Redis: adquirir trava da conversa');
  assert.equal(destino('Trava da conversa livre?', 1), 'Aguardar liberação da conversa');
});

test('mensagem superada enquanto aguardava a trava é descartada antes do contexto', () => {
  assert.equal(destino('Redis: conferir última após trava'), 'Redis: conferir pausa após trava');
  assert.equal(destino('Redis: conferir pausa após trava'), 'Redis: conferir sessão após trava');
  assert.equal(destino('Redis: conferir sessão após trava'), 'Verificar proteções após trava');
  assert.equal(destino('Verificar proteções após trava'), 'Última mensagem após a trava?');
  assert.equal(avaliar(condicao('Última mensagem após a trava?'), {seguir: false}), false);
  assert.equal(avaliar(condicao('Última mensagem após a trava?'), {seguir: true}), true);
  assert.equal(destino('Última mensagem após a trava?', 1), 'Redis: liberar trava (superada)');
  assert.equal(destino('Redis: liberar trava (superada)'), 'Montar linha de log');
});

test('revalidação após a trava respeita nova pausa, sessão e mensagens superadas', async () => {
  const no = buscarNo('Verificar proteções após trava');
  const executar = new AsyncFunction('$', '$input', '$now', no.parameters.jsCode);
  const base = {acao: 'processar', chaveMensagem: 'mensagem-b', voltar: true, carimboSegundos: 1000, responderPendentes: false};
  const conferir = async (ultima = 'mensagem-b', pausa = null, sessao = '', extra = {}) => {
    const saidas = {
      'Interpretar mensagem': {...base, ...extra},
      'Redis: conferir última após trava': {ultima},
      'Redis: conferir pausa após trava': {pausa},
      'Redis: conferir sessão após trava': {sessao},
    };
    return (await executar(nome => ({first: () => ({json: saidas[nome]})})))[0].json;
  };
  assert.equal((await conferir()).seguir, true);
  const superada = await conferir('mensagem-c');
  assert.equal(superada.seguir, false);
  assert.equal(superada.motivo, 'agrupada_com_mensagem_seguinte');
  const pausada = await conferir('mensagem-b', 'pausa-do-operador');
  assert.equal(pausada.seguir, false, 'menu anterior à pausa nova não deve desfazê-la');
  assert.equal(pausada.motivo, 'em_atendimento_humano');
  const offline = await conferir('mensagem-b', null, '1003000|WORKING');
  assert.equal(offline.seguir, false);
  assert.equal(offline.motivo, 'recebida_com_o_robo_desligado');
  assert.equal((await conferir('mensagem-b', null, '1002000|WORKING')).seguir, true, 'mantém folga de dois segundos');
  assert.equal((await conferir('mensagem-b', null, '1003000|WORKING', {responderPendentes: true})).seguir, true);
});

test('log preserva os motivos de descarte encontrados depois da trava', async () => {
  const executar = new AsyncFunction('$', '$input', '$now', buscarNo('Montar linha de log').parameters.jsCode);
  for (const [motivo, resultado] of [['em_atendimento_humano', 'silenciada'], ['recebida_com_o_robo_desligado', 'ignorada']]) {
    const saida = await executar(nome => ({
      isExecuted: ['Redis: ler última mensagem', 'Verificar proteções após trava'].includes(nome),
      first: () => ({json: nome === 'Verificar proteções após trava' ? {seguir: false, motivo} : {acao: 'processar'}}),
    }), null, {toISO: () => '2026-11-10T12:00:00Z'});
    const linha = JSON.parse(saida[0].json.linha);
    assert.equal(linha.motivo, motivo);
    assert.equal(linha.resultado, resultado);
  }
});

test('sucesso, resposta silenciada e erro de envio liberam a trava', () => {
  assert.equal(destino('Redis: guardar conversa'), 'Redis: liberar trava (sucesso)');
  assert.equal(destino('Deve responder?', 1), 'Redis: liberar trava (sem resposta)');
  assert.equal(destino('Redis: liberar trava (sucesso)'), 'Montar linha de log');
  assert.equal(destino('Redis: liberar trava (sem resposta)'), 'Montar linha de log');
  assert.equal(buscarNo('WAHA: enviar resposta').onError, 'continueErrorOutput');
  assert.equal(destino('WAHA: enviar resposta', 1), 'Redis: liberar trava (erro no envio)');
  assert.equal(destino('Redis: liberar trava (erro no envio)'), 'Montar linha de log', 'a falha é registrada antes de ser propagada');
  for (const sufixo of ['sucesso', 'sem resposta', 'superada', 'erro no envio']) {
    const liberar = buscarNo('Redis: liberar trava (' + sufixo + ')');
    assert.equal(liberar.parameters.operation, 'delete');
    assert.equal(avaliar(liberar.parameters.key, {}, {chaveConversa: 'conversa:contato-a'}), 'conversa:contato-a:trava');
  }
});

test('erro propagado identifica o envio WAHA e não expõe o payload original', async () => {
  const propagar = buscarNo('Propagar falha de envio');
  const executar = new AsyncFunction('$', '$input', '$now', propagar.parameters.jsCode);
  const comFalha = falhaNoEnvio => nome => ({ first: () => ({ json: nome === 'Montar linha de log' ? { falhaNoEnvio } : {} }) });
  assert.deepEqual(await executar(comFalha(false)), [], 'sem falha, o atendimento termina normalmente');
  let erroPropagado;
  try { await executar(comFalha(true)); } catch (e) { erroPropagado = e; }
  assert.ok(erroPropagado, 'a execução deve continuar falhando após liberar a trava e registrar os logs');
  const codigo = fs.readFileSync(path.join(__dirname, '../n8n/codigo/registrar-erro.js'), 'utf8');
  const registrar = new AsyncFunction('$', '$input', '$now', codigo);
  const saida = await registrar(null, {first: () => ({json: {execution: {
    lastNodeExecuted: 'Propagar falha de envio',
    error: {message: erroPropagado.message, description: 'PAYLOAD PRIVADO 5511999991234@c.us'}
  }}})}, {toISO: () => '2026-11-10T12:00:00Z'});
  const linha = JSON.parse(saida[0].json.linha);
  assert.equal(linha.no, 'WAHA: enviar resposta');
  assert.ok(linha.erro);
  assert.ok(!saida[0].json.linha.includes('PAYLOAD PRIVADO'));
  assert.ok(!saida[0].json.linha.includes('5511999991234'));
});

test('resolução utiliza estado recebido e não persiste o texto do cliente', async () => {
  const node = workflow.nodes.find(n => n.name === 'Resolver conversa');
  assert.ok(node, 'falta resolução contextual');
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config/chatbot.json'), 'utf8'));
  const base = { config: cfg, texto: 'mensagem completamente desconhecida abcxyz', chatId: 'teste@c.us',
    chaves: {}, ttl: {}, chaveConversa: 'conversa:teste', limites: { mensagensPorHora: 40, respostasIguais: 3 } };
  const executar = new AsyncFunction('$', '$input', '$now', node.parameters.jsCode);
  const saida = await executar(nome => ({first: () => ({json: nome === 'Interpretar mensagem' ? base : {conversa: JSON.stringify({falhas: 1})}})}));
  const atual = saida[0].json;
  assert.equal(atual.intencao, 'nao_entendi');
  assert.equal(JSON.parse(atual.valorConversa).falhas, 2);
  assert.ok(!atual.valorConversa.includes(base.texto));
  assert.ok(atual.resposta.trim());
});

test('log usa intenção resolvida e mantém texto/identificador fora do registro', async () => {
  const node = workflow.nodes.find(n => n.name === 'Montar linha de log');
  const base = { acao: 'processar', evento: 'message', contato: '***1234', msg: 'TEST1234' };
  const resolvido = { ...base, intencao: 'esclarecer', origem: 'ambigua', texto: 'SEGREDO DO CLIENTE', chatId: '551199991234@c.us' };
  const executar = new AsyncFunction('$', '$input', '$now', node.parameters.jsCode);
  const saida = await executar(nome => ({isExecuted: ['WAHA: enviar resposta', 'Resolver conversa'].includes(nome),
    first: () => ({json: nome === 'Resolver conversa' ? resolvido : base})}), null, {toISO: () => new Date().toISOString()});
  const linha = JSON.parse(saida[0].json.linha);
  assert.equal(linha.intencao, 'esclarecer');
  assert.ok(!saida[0].json.linha.includes(resolvido.texto));
  assert.ok(!saida[0].json.linha.includes(resolvido.chatId));
});

// ---------- assistente de IA ----------

const codigoDoNo = nome => new AsyncFunction('$', '$input', '$now', buscarNo(nome).parameters.jsCode);
const relogio = {
  toJSDate: () => new Date('2026-11-10T22:30:00Z'), zoneName: 'America/Sao_Paulo',
  toFormat: () => '2026-11-10', toISO: () => '2026-11-10T19:30:00.000-03:00',
};
const configDeTeste = () => JSON.parse(fs.readFileSync(path.join(__dirname, 'config/chatbot.json'), 'utf8'));
const mensagemBase = (texto, config = configDeTeste()) => ({
  acao: 'processar', config, texto, midia: false, chatId: '5599012345@c.us', contato: '***2345', msg: 'TEST0001',
  chaves: { porHora: 'taxa:5599012345@c.us' }, ttl: {}, chaveConversa: 'conversa:default:5599012345@c.us',
  limites: { mensagensPorHora: 40, respostasIguais: 3 },
});
const resolverNoWorkflow = async (texto, { config, conversa = null } = {}) => (await codigoDoNo('Resolver conversa')(
  nome => ({ first: () => ({ json: nome === 'Interpretar mensagem' ? mensagemBase(texto, config) : { conversa } }) }), null, relogio))[0].json;

test('workflow no formato v2: escolhe o evento, guarda a escolha no estado e entrega a configuração do evento', async () => {
  const E = require('../lib/eventos');
  const v1 = JSON.parse(fs.readFileSync(path.join(__dirname, 'config/chatbot.json'), 'utf8'));
  let v2 = E.migrarParaV2(v1, { id: 'alfa', gatilhos: ['alfa'], produtora: 'Produtora' });
  v2.eventos.push({ ...JSON.parse(JSON.stringify(v2.eventos[0])), id: 'beta', gatilhos: ['beta'], evento: { ...v2.eventos[0].evento, nome: 'Beta' } });
  const resolver = async (texto, conversa = null) => (await codigoDoNo('Resolver conversa')(
    nome => ({ first: () => ({ json: nome === 'Interpretar mensagem' ? mensagemBase(texto, v2) : { conversa } }) }), null, relogio))[0].json;
  const menu = await resolver('oi');
  assert.equal(menu.intencao, 'escolher_evento');
  assert.equal(JSON.parse(menu.valorConversa).escolhendoEvento, true);
  assert.equal(menu.ttlConversa, 86400);
  const escolha = await resolver('2', menu.valorConversa);
  assert.equal(escolha.intencao, 'menu');
  assert.equal(escolha.config.evento.nome, 'Beta');
  assert.equal(JSON.parse(escolha.valorConversa).evento, 'beta');
  const desconhecida = await resolver('mensagem completamente desconhecida abcxyz', escolha.valorConversa);
  assert.equal(desconhecida.intencao, 'nao_entendi');
  assert.equal(JSON.parse(desconhecida.valorConversa).evento, 'beta');
  assert.equal(desconhecida.config.evento.nome, 'Beta');
});

test('ramo da IA fica depois do contador por hora e confere os limites antes de chamar', () => {
  assert.equal(destino('Resolver conversa'), 'Redis: contador por hora');
  assert.equal(destino('Redis: contador por hora'), 'Consultar a IA?');
  assert.equal(destino('Consultar a IA?', 0), 'Redis: usos da IA (contato)');
  assert.equal(destino('Consultar a IA?', 1), 'Resposta final');
  assert.equal(destino('Redis: usos da IA (contato)'), 'Redis: usos da IA (dia)');
  assert.equal(destino('Redis: usos da IA (dia)'), 'Verificar limites da IA');
  assert.equal(destino('Verificar limites da IA'), 'IA dentro do limite?');
  assert.equal(destino('IA dentro do limite?', 0), 'Redis: contar uso da IA (contato)');
  assert.equal(destino('IA dentro do limite?', 1), 'Resposta final');
  assert.equal(destino('Redis: contar uso da IA (contato)'), 'Redis: contar uso da IA (dia)');
  assert.equal(destino('Redis: contar uso da IA (dia)'), 'IA: gerar resposta');
  assert.equal(destino('IA: gerar resposta'), 'Aplicar resposta da IA');
  assert.equal(destino('Aplicar resposta da IA'), 'IA: tentar reserva 1?');
  assert.equal(destino('IA: tentar reserva 1?', 0), 'IA: gerar resposta (reserva 1)');
  assert.equal(destino('IA: tentar reserva 1?', 1), 'Resposta final');
  assert.equal(destino('IA: gerar resposta (reserva 1)'), 'Aplicar resposta da IA (reserva 1)');
  assert.equal(destino('Aplicar resposta da IA (reserva 1)'), 'IA: tentar reserva 2?');
  assert.equal(destino('IA: tentar reserva 2?', 0), 'IA: gerar resposta (reserva 2)');
  assert.equal(destino('IA: tentar reserva 2?', 1), 'Resposta final');
  assert.equal(destino('IA: gerar resposta (reserva 2)'), 'Aplicar resposta da IA (reserva 2)');
  assert.equal(destino('Aplicar resposta da IA (reserva 2)'), 'Resposta final');
  assert.equal(destino('Resposta final'), 'Redis: contador de respostas iguais');
  assert.equal(destino('Redis: contador de respostas iguais'), 'Verificar limites');

  const plano = { ia: { usar: true, chaves: { contato: 'ia:contato:a', dia: 'ia:dia:2026-11-10' }, ttl: { contato: 3600, dia: 172800 } } };
  assert.equal(avaliar(condicao('Consultar a IA?'), {}, plano), true);
  assert.equal(avaliar(condicao('Consultar a IA?'), {}, { ia: { usar: false } }), false);
  assert.equal(avaliar(condicao('IA dentro do limite?'), { ia: { liberada: true } }), true);
  assert.equal(avaliar(condicao('IA dentro do limite?'), { ia: { liberada: false } }), false);
  for (const [nome, chave] of [['contato', 'ia:contato:a'], ['dia', 'ia:dia:2026-11-10']]) {
    const ler = buscarNo('Redis: usos da IA (' + nome + ')');
    assert.equal(ler.parameters.operation, 'get', 'a leitura não pode alterar o contador');
    assert.equal(avaliar(ler.parameters.key, {}, plano), chave);
    const contar = buscarNo('Redis: contar uso da IA (' + nome + ')');
    assert.equal(contar.parameters.operation, 'incr');
    assert.equal(contar.parameters.expire, true);
    assert.equal(avaliar(contar.parameters.key, {}, plano), chave);
    assert.equal(avaliar(contar.parameters.ttl, {}, plano), plano.ia.ttl[nome]);
  }
});

test('chamada à IA usa credencial própria, uma tentativa e nunca derruba o atendimento', () => {
  const chamada = buscarNo('IA: gerar resposta');
  assert.equal(chamada.type, 'n8n-nodes-base.httpRequest');
  assert.equal(chamada.parameters.method, 'POST');
  assert.equal(chamada.credentials.httpHeaderAuth.id, 'ChatbotIaApi0001');
  assert.notEqual(chamada.credentials.httpHeaderAuth.id, buscarNo('WAHA: enviar resposta').credentials.httpHeaderAuth.id);
  assert.equal(chamada.onError, 'continueRegularOutput');
  assert.ok(!chamada.retryOnFail, 'sem novas tentativas: cada uma gastaria a cota');
  const plano = { ia: { url: 'https://api.exemplo/v1/chat/completions', pedidos: [{ model: 'm0', messages: [] }, { model: 'm1', messages: [] }, { model: 'm2', messages: [] }], tempoLimiteMs: 3000 } };
  assert.equal(avaliar(chamada.parameters.url, {}, plano), plano.ia.url);
  assert.equal(avaliar(chamada.parameters.jsonBody, {}, plano), JSON.stringify(plano.ia.pedidos[0]));
  assert.equal(avaliar(chamada.parameters.options.timeout, {}, plano), 3000);
  // As reservas repetem as opções do principal; só o corpo (pedidos[n]) muda.
  ['IA: gerar resposta (reserva 1)', 'IA: gerar resposta (reserva 2)'].forEach((nome, i) => {
    const reserva = buscarNo(nome);
    assert.equal(reserva.type, 'n8n-nodes-base.httpRequest');
    assert.deepEqual(reserva.credentials, chamada.credentials);
    assert.equal(reserva.onError, 'continueRegularOutput');
    assert.ok(!reserva.retryOnFail);
    assert.equal(avaliar(reserva.parameters.url, {}, plano), plano.ia.url);
    assert.equal(avaliar(reserva.parameters.jsonBody, {}, plano), JSON.stringify(plano.ia.pedidos[i + 1]));
    assert.equal(avaliar(reserva.parameters.options.timeout, {}, plano), 3000);
    assert.deepEqual({ ...reserva.parameters, url: 0, jsonBody: 0 }, { ...chamada.parameters, url: 0, jsonBody: 0 });
  });
  for (const nome of ['IA: tentar reserva 1?', 'IA: tentar reserva 2?']) {
    assert.equal(avaliar(condicao(nome), { ia: { tentarReserva: true } }), true);
    assert.equal(avaliar(condicao(nome), { ia: { tentarReserva: false } }), false);
  }
  assert.ok(workflow.settings.executionTimeout > 30 + 10, 'o tempo limite da IA cabe na execução');
  const credenciais = fs.readFileSync(path.join(__dirname, '../n8n/init/gerar-credenciais.js'), 'utf8');
  assert.match(credenciais, /ChatbotIaApi0001/);
  assert.match(credenciais, /Authorization/);
});

test('pedido à IA só é preparado para texto não reconhecido e não leva dados do contato', async () => {
  const duvida = await resolverNoWorkflow('vocês têm estacionamento por aí?');
  assert.equal(duvida.intencao, 'nao_entendi');
  assert.equal(duvida.ia.usar, true);
  assert.equal(duvida.ia.url, 'http://waha:3000/ia/v1/chat/completions');
  assert.deepEqual(duvida.ia.chaves, { contato: 'ia:contato:5599012345@c.us', dia: 'ia:dia:2026-11-10' });
  assert.deepEqual(duvida.ia.limites, { porContato: 4, porDia: 100000 });
  assert.deepEqual(duvida.ia.ttl, { contato: 3600, dia: 172800 });
  assert.equal(duvida.ia.tempoLimiteMs, 3000);
  assert.equal(duvida.ia.pedidos[0].model, 'modelo-de-teste');
  assert.deepEqual(duvida.ia.modelos, duvida.ia.pedidos.map(p => p.model));
  assert.equal(duvida.ia.corpo, undefined, 'o campo antigo "corpo" foi substituído por "pedidos"');
  assert.match(duvida.ia.pedidos[0].messages[1].content, /^\[Agora: terça-feira, 10\/11\/2026, 19:30\]\nMensagem do cliente: vocês têm estacionamento por aí\?$/);
  assert.doesNotMatch(JSON.stringify(duvida.ia.pedidos), /5599012345|@c\.us/);
  assert.ok(duvida.resposta.trim(), 'a orientação normal fica pronta caso a IA não ajude');

  for (const texto of ['2', 'oi', 'obrigado', 'quais os valores e o endereço?', '12']) {
    assert.equal((await resolverNoWorkflow(texto)).ia.usar, false, texto);
  }
  const esgotado = await resolverNoWorkflow('e tem open bar?', { conversa: JSON.stringify({ falhas: 3 }) });
  assert.equal(esgotado.silenciar, true);
  assert.equal(esgotado.ia.usar, true, 'a IA ainda pode ajudar depois das três orientações');
  const continuacao = await resolverNoWorkflow('e para estudante?', { conversa: JSON.stringify({ falhas: 0, ultimaIntencao: 'valores' }) });
  assert.match(continuacao.ia.pedidos[0].messages[1].content, /Assunto da resposta anterior: Valores dos ingressos/);

  const desligada = configDeTeste();
  desligada.ia.ativa = false;
  assert.deepEqual((await resolverNoWorkflow('vocês têm estacionamento por aí?', { config: desligada })).ia, { usar: false });
  const semSecao = configDeTeste();
  delete semSecao.ia;
  assert.deepEqual((await resolverNoWorkflow('vocês têm estacionamento por aí?', { config: semSecao })).ia, { usar: false });
});

test('limites da IA: por contato, por dia e sem gastar cota com quem já passou do limite por hora', async () => {
  const base = { ...mensagemBase('duvida'), intencao: 'nao_entendi', ia: { usar: true, limites: { porContato: 3, porDia: 10 } } };
  const conferir = async (usosContato, usosDia, naHora = 1) => (await codigoDoNo('Verificar limites da IA')(nome => ({ first: () => ({ json: {
    'Resolver conversa': base,
    'Redis: usos da IA (contato)': { usosContato },
    'Redis: usos da IA (dia)': { usosDia },
    'Redis: contador por hora': { 'taxa:x': naHora },
  }[nome] }) })))[0].json.ia;
  assert.deepEqual(await conferir(null, null), { ...base.ia, liberada: true, resultado: undefined });
  assert.equal((await conferir('2', '9')).liberada, true);
  assert.deepEqual(await conferir('3', '0'), { ...base.ia, liberada: false, resultado: 'limite_por_contato' });
  assert.deepEqual(await conferir('0', '10'), { ...base.ia, liberada: false, resultado: 'limite_do_dia' });
  assert.deepEqual(await conferir('0', '0', 41), { ...base.ia, liberada: false, resultado: undefined });

  // Limite 0 = sem limite: nunca barra, mesmo com contadores altos.
  const lerIa = async (planoIa, usosContato, usosDia) => (await codigoDoNo('Verificar limites da IA')(nome => ({ first: () => ({ json: {
    'Resolver conversa': { ...base, ia: planoIa },
    'Redis: usos da IA (contato)': { usosContato },
    'Redis: usos da IA (dia)': { usosDia },
    'Redis: contador por hora': { 'taxa:x': 1 },
  }[nome] }) })))[0].json.ia;
  const semLimite = { usar: true, limites: { porContato: 0, porDia: 0 } };
  assert.deepEqual(await lerIa(semLimite, '0', '0'), { ...semLimite, liberada: true, resultado: undefined });
  assert.equal((await lerIa(semLimite, '5000', '999999')).liberada, true);
  const soDia = { usar: true, limites: { porContato: 0, porDia: 10 } };
  assert.equal((await lerIa(soDia, '99', '9')).liberada, true);
  assert.equal((await lerIa(soDia, '99', '10')).resultado, 'limite_do_dia');
  const soContato = { usar: true, limites: { porContato: 3, porDia: 0 } };
  assert.equal((await lerIa(soContato, '3', '999')).resultado, 'limite_por_contato');
  assert.equal((await lerIa(soContato, '2', '999')).liberada, true);
});

test('resposta da IA substitui a orientação e reinicia o fallback; falha mantém a orientação', async () => {
  const base = { ...mensagemBase('duvida'), intencao: 'nao_entendi', origem: 'fallback_esgotado', resposta: '', silenciar: true,
    motivo: 'fallback_esgotado', transferir: false, estado: { falhas: 3 }, valorConversa: '{"falhas":3}', ttlConversa: 1800,
    sessao: 'default', chaves: { iguais: 'rep:default:5599012345@c.us:nao_entendi:abc' },
    ia: { usar: true, liberada: true, modelos: ['m0', 'm1', 'm2'], pedidos: [{ model: 'm0' }, { model: 'm1' }, { model: 'm2' }] } };
  const aplicar = async corpo => (await codigoDoNo('Aplicar resposta da IA')(
    () => ({ first: () => ({ json: base }) }), { first: () => ({ json: corpo }) }))[0].json;

  const ok = await aplicar({ choices: [{ message: { content: 'O **estacionamento** ainda não foi divulgado.' }, finish_reason: 'stop' }] });
  assert.equal(ok.intencao, 'ia');
  assert.equal(ok.origem, 'ia');
  assert.equal(ok.resposta, 'O *estacionamento* ainda não foi divulgado.');
  assert.equal(ok.silenciar, false);
  assert.equal(ok.motivo, undefined);
  assert.equal(ok.transferir, false);
  assert.equal(ok.ia.resultado, 'respondeu');
  assert.equal(ok.ia.modelo, 'm0');
  assert.deepEqual(ok.ia.tentativas, []);
  assert.equal(ok.ia.tentarReserva, false);
  assert.deepEqual(Object.keys(ok.estado).sort(), ['falhas', 'pendentes', 'ultimaIntencao', 'ultimaResposta']);
  assert.equal(ok.estado.falhas, 0);
  assert.equal(ok.estado.ultimaIntencao, 'ia');
  assert.deepEqual(JSON.parse(ok.valorConversa), ok.estado);
  assert.doesNotMatch(ok.valorConversa, /estacionamento|duvida/, 'o contexto guarda só a assinatura da resposta');
  assert.match(ok.chaves.iguais, /^rep:default:5599012345@c\.us:ia:[a-f0-9]{1,8}$/);

  for (const [corpo, resultado] of [
    [{ choices: [{ message: { content: '[[SEM_RESPOSTA]]' } }] }, 'sem_resposta'],
    [{ error: { httpCode: '429', message: 'Too many requests' } }, 'erro_429'],
    [{ error: 'timeout of 3000ms exceeded' }, 'tempo_esgotado'],
    [{ choices: [{ message: { content: 'Compre em https://site.invalido/ingresso' } }] }, 'link_nao_confirmado'],
    [{}, 'resposta_invalida'],
  ]) {
    const falhou = await aplicar(corpo);
    assert.equal(falhou.ia.resultado, resultado);
    assert.deepEqual(falhou.ia.tentativas, [{ modelo: 'm0', motivo: resultado }]);
    assert.equal(falhou.ia.tentarReserva, ['erro_429', 'tempo_esgotado', 'resposta_invalida'].includes(resultado), resultado);
    assert.equal(falhou.intencao, 'nao_entendi');
    assert.equal(falhou.silenciar, true);
    assert.equal(falhou.valorConversa, base.valorConversa);
    assert.equal(falhou.chaves.iguais, base.chaves.iguais);
  }
});

test('cadeia de reservas: cada "Aplicar" acumula as falhas e só segue para a reserva quando vale a pena', async () => {
  const base = { ...mensagemBase('duvida'), intencao: 'nao_entendi', origem: 'fallback_esgotado', resposta: '', silenciar: true,
    motivo: 'fallback_esgotado', transferir: false, estado: { falhas: 3 }, valorConversa: '{"falhas":3}', ttlConversa: 1800,
    sessao: 'default', chaves: { iguais: 'rep:default:5599012345@c.us:nao_entendi:abc' },
    ia: { usar: true, liberada: true, modelos: ['m0', 'm1', 'm2'], pedidos: [{ model: 'm0' }, { model: 'm1' }, { model: 'm2' }] } };
  const aplicar = async (nome, anteriores, corpo, origem = base) => (await codigoDoNo(nome)(
    n => ({ first: () => ({ json: anteriores[n] ?? origem }) }), { first: () => ({ json: corpo }) }))[0].json;
  const erro429 = { error: { httpCode: '429', message: 'Too many requests' } };
  const p = await aplicar('Aplicar resposta da IA', {}, erro429);
  assert.equal(p.ia.tentarReserva, true);
  const r1 = await aplicar('Aplicar resposta da IA (reserva 1)', { 'Aplicar resposta da IA': p }, erro429);
  assert.deepEqual(r1.ia.tentativas, [{ modelo: 'm0', motivo: 'erro_429' }, { modelo: 'm1', motivo: 'erro_429' }]);
  assert.equal(r1.ia.tentarReserva, true);
  const r2 = await aplicar('Aplicar resposta da IA (reserva 2)', { 'Aplicar resposta da IA (reserva 1)': r1 }, erro429);
  assert.equal(r2.ia.tentativas.length, 3);
  assert.equal(r2.ia.tentarReserva, false, 'não existe reserva 3');
  assert.equal(r2.intencao, 'nao_entendi', 'tudo falhou: vale a orientação normal');
  assert.equal(r2.ia.resultado, 'erro_429');

  const certa = { choices: [{ message: { content: 'Ainda não foi divulgado.' }, finish_reason: 'stop' }] };
  const r1ok = await aplicar('Aplicar resposta da IA (reserva 1)', { 'Aplicar resposta da IA': p }, certa);
  assert.equal(r1ok.intencao, 'ia');
  assert.equal(r1ok.ia.modelo, 'm1');
  assert.equal(r1ok.ia.tentativas.length, 1);
  assert.equal(r1ok.ia.tentarReserva, false);

  const semResp = await aplicar('Aplicar resposta da IA', {}, { choices: [{ message: { content: '[[SEM_RESPOSTA]]' } }] });
  assert.equal(semResp.ia.tentarReserva, false, 'sem_resposta não tenta outro modelo');
  const unico = { ...base, ia: { ...base.ia, pedidos: [{ model: 'm0' }], modelos: ['m0'] } };
  const sozinho = await aplicar('Aplicar resposta da IA', {}, erro429, unico);
  assert.equal(sozinho.ia.tentarReserva, false, 'sem reservas configuradas');
});

test('resposta final escolhe o caminho percorrido e não leva adiante o pedido enviado à IA', async () => {
  const fontes = {
    'Resolver conversa': { resposta: 'orientação', ia: { usar: true, url: 'http://ia', corpo: { messages: ['TEXTO DO CLIENTE'] }, limites: {} } },
    'Verificar limites da IA': { resposta: 'orientação', ia: { usar: true, url: 'http://ia', corpo: { messages: ['TEXTO DO CLIENTE'] }, resultado: 'limite_por_contato' } },
    'Aplicar resposta da IA': { resposta: 'resposta da IA', ia: { usar: true, url: 'http://ia', corpo: { messages: ['TEXTO DO CLIENTE'] }, resultado: 'respondeu' } },
    'Aplicar resposta da IA (reserva 1)': { resposta: 'resposta da reserva 1', ia: { usar: true, url: 'http://ia', pedidos: [{ messages: ['TEXTO DO CLIENTE'] }], resultado: 'respondeu', modelo: 'm1' } },
    'Aplicar resposta da IA (reserva 2)': { resposta: 'resposta da reserva 2', ia: { usar: true, url: 'http://ia', pedidos: [{ messages: ['TEXTO DO CLIENTE'] }], resultado: 'respondeu', modelo: 'm2' } },
  };
  const final = async executados => (await codigoDoNo('Resposta final')(nome => ({
    isExecuted: executados.includes(nome), first: () => ({ json: fontes[nome] }),
  })))[0].json;
  const semIa = await final(['Resolver conversa']);
  assert.equal(semIa.resposta, 'orientação');
  assert.equal(semIa.ia.resultado, undefined);
  const barrada = await final(['Resolver conversa', 'Verificar limites da IA']);
  assert.equal(barrada.ia.resultado, 'limite_por_contato');
  const respondida = await final(['Resolver conversa', 'Verificar limites da IA', 'Aplicar resposta da IA']);
  assert.equal(respondida.resposta, 'resposta da IA');
  assert.equal(respondida.ia.resultado, 'respondeu');
  const viaReserva1 = await final(['Resolver conversa', 'Verificar limites da IA', 'Aplicar resposta da IA', 'Aplicar resposta da IA (reserva 1)']);
  assert.equal(viaReserva1.resposta, 'resposta da reserva 1');
  const viaReserva2 = await final(['Resolver conversa', 'Verificar limites da IA', 'Aplicar resposta da IA', 'Aplicar resposta da IA (reserva 1)', 'Aplicar resposta da IA (reserva 2)']);
  assert.equal(viaReserva2.resposta, 'resposta da reserva 2');
  assert.equal(viaReserva2.ia.modelo, 'm2');
  for (const saida of [semIa, barrada, respondida, viaReserva1, viaReserva2]) {
    assert.equal(saida.ia.pedidos, undefined);
    assert.equal(saida.ia.corpo, undefined);
    assert.equal(saida.ia.url, undefined);
    assert.doesNotMatch(JSON.stringify(saida), /TEXTO DO CLIENTE/);
  }
  assert.deepEqual((await codigoDoNo('Resposta final')(nome => ({ isExecuted: nome === 'Resolver conversa', first: () => ({ json: { resposta: 'x' } }) })))[0].json,
    { resposta: 'x', ia: {} }, 'configuração antiga, sem plano de IA');
});

test('limites gerais e log leem a resposta final e registram só o resultado da IA', async () => {
  const final = { ...mensagemBase('TEXTO SECRETO DO CLIENTE'), evento: 'message', intencao: 'ia', origem: 'ia', resposta: 'RESPOSTA SECRETA DA IA',
    transferir: false, silenciar: false, ia: { usar: true, resultado: 'respondeu' } };
  const limites = async (naHora, iguais, extra = {}) => (await codigoDoNo('Verificar limites')(nome => ({ first: () => ({ json: {
    'Resposta final': { ...final, ...extra }, 'Redis: contador por hora': { a: naHora }, 'Redis: contador de respostas iguais': { b: iguais },
  }[nome] }) })))[0].json;
  assert.equal((await limites(1, 1)).responder, true);
  assert.equal((await limites(41, 1)).motivo, 'limite_de_mensagens_por_hora');
  assert.equal((await limites(1, 4)).motivo, 'resposta_repetida');
  assert.equal((await limites(1, 1, { silenciar: true, motivo: 'fallback_esgotado' })).motivo, 'fallback_esgotado');

  const registrar = async (base, executados) => JSON.parse((await codigoDoNo('Montar linha de log')(nome => ({
    isExecuted: executados.includes(nome), first: () => ({ json: nome === 'Verificar limites' ? { motivo: base.motivo } : base }),
  }), null, relogio))[0].json.linha);
  const respondida = await registrar(final, ['Resolver conversa', 'Resposta final', 'Verificar limites', 'WAHA: enviar resposta']);
  assert.equal(respondida.resultado, 'respondida');
  assert.equal(respondida.intencao, 'ia');
  assert.equal(respondida.motivo, 'ia');
  assert.equal(respondida.ia, 'respondeu');
  assert.doesNotMatch(JSON.stringify(respondida), /SECRET|5599012345/);
  assert.equal(respondida.iaModelo, undefined);
  assert.equal(respondida.iaTentativas, undefined);
  const viaReserva = await registrar({ ...final, ia: { usar: true, resultado: 'respondeu', modelo: 'm1', tentativas: [{ modelo: 'm0', motivo: 'erro_429' }] } },
    ['Resolver conversa', 'Resposta final', 'Verificar limites', 'WAHA: enviar resposta']);
  assert.equal(viaReserva.iaModelo, 'm1');
  assert.equal(viaReserva.iaTentativas, 1);
  assert.doesNotMatch(JSON.stringify(viaReserva), /SECRET|5599012345/);
  const semIa = await registrar({ ...final, intencao: 'valores', origem: 'numero', ia: { usar: false } },
    ['Resolver conversa', 'Resposta final', 'Verificar limites', 'WAHA: enviar resposta']);
  assert.equal(semIa.ia, undefined);
  const barrada = await registrar({ ...final, intencao: 'nao_entendi', origem: 'fallback_esgotado', silenciar: true, motivo: 'fallback_esgotado', ia: { usar: true, resultado: 'limite_por_contato' } },
    ['Resolver conversa', 'Resposta final', 'Verificar limites']);
  assert.equal(barrada.resultado, 'silenciada');
  assert.equal(barrada.motivo, 'fallback_esgotado');
  assert.equal(barrada.ia, 'limite_por_contato');
});
// ---------- registro das conversas (página "Conversas" do painel) ----------

test('conversa é gravada em arquivo próprio depois do log de atividade, e a falha de envio é propagada no fim', () => {
  assert.equal(destino('Gravar no arquivo de log'), 'Montar linha da conversa');
  assert.equal(destino('Montar linha da conversa'), 'Converter conversa em arquivo');
  assert.equal(destino('Converter conversa em arquivo'), 'Gravar no arquivo de conversas');
  assert.equal(destino('Gravar no arquivo de conversas'), 'Propagar falha de envio');
  const gravar = buscarNo('Gravar no arquivo de conversas');
  assert.equal(gravar.parameters.options.append, true);
  assert.match(gravar.parameters.fileName, /^=\/files\/logs\/conversas-\{\{ \$now\.toFormat\('yyyy-LL-dd'\) \}\}\.log$/);
  assert.equal(buscarNo('Converter conversa em arquivo').parameters.sourceProperty, 'linha');
  assert.match(buscarNo('Gravar no arquivo de log').parameters.fileName, /\/files\/logs\/chatbot-/, 'log de atividade continua separado');
});

test('interpretar guarda nome, telefone e texto do contato só no bloco da conversa (formato real do WAHA GOWS)', async () => {
  const cfg = configDeTeste();
  const executar = codigoDoNo('Interpretar mensagem');
  const evento = (payload) => executar(nome => ({ first: () => ({ json: {
    'Webhook WAHA': { body: { event: 'message.any', session: 'default', payload } },
    'Extrair configuração': { data: JSON.stringify(cfg) },
    'Redis: estado da sessão': { sessao: '' },
  }[nome] }) }));
  const agora = Math.floor(Date.now() / 1000);
  const recebida = (await evento({
    id: 'false_123456789012345@lid_ABCDEF123', timestamp: agora, from: '123456789012345@lid', fromMe: false, source: 'app', to: null,
    body: 'quanto custa?', hasMedia: false,
    _data: { Info: { Chat: '123456789012345@lid', Sender: '123456789012345@lid', SenderAlt: '5518991234567@s.whatsapp.net', RecipientAlt: '', PushName: 'Ana Souza' } },
  }))[0].json;
  assert.equal(recebida.acao, 'processar');
  assert.deepEqual(recebida.registro, { sessao: 'default', conversa: '123456789012345@lid', telefone: '5518991234567', nome: 'Ana Souza', texto: 'quanto custa?', midia: false });
  assert.equal(recebida.contato, '***2345', 'o log de atividade continua só com os 4 últimos dígitos');
  assert.equal(recebida.chavePausa, 'pausa:default:123456789012345@lid', 'a pausa é por número (sessão)');
  assert.equal(recebida.chaves.ultima, 'ultima:default:123456789012345@lid');
  assert.equal(recebida.chaves.porHora, 'taxa:123456789012345@lid', 'o limite por hora continua por contato');

  const doCelular = (await evento({
    id: 'true_123456789012345@lid_XYZ', timestamp: agora, from: '123456789012345@lid', fromMe: true, source: 'app', to: null, body: 'Oi, aqui é da equipe',
    _data: { Info: { Chat: '123456789012345@lid', SenderAlt: '', RecipientAlt: '5518991234567@s.whatsapp.net', PushName: 'Produtora' } },
  }))[0].json;
  assert.equal(doCelular.acao, 'pausar', 'a equipe respondeu pelo celular: o robô para nesta conversa');
  assert.equal(doCelular.motivo, 'atendente_respondeu');
  assert.equal(doCelular.chatId, '123456789012345@lid');

  const semPausa = { ...cfg, atendimento_humano: { ...cfg.atendimento_humano, pausar_quando_atendente_responder: false } };
  const desligado = (await executar(nome => ({ first: () => ({ json: {
    'Webhook WAHA': { body: { event: 'message.any', session: 'default', payload: { id: 'true_1@lid_Z', timestamp: agora, from: '123456789012345@lid', fromMe: true, source: 'app', to: null, body: 'Oi, aqui é da equipe' } } },
    'Extrair configuração': { data: JSON.stringify(semPausa) },
    'Redis: estado da sessão': { sessao: '' },
  }[nome] }) })))[0].json;
  assert.equal(desligado.motivo, 'enviada_pelo_atendente', 'com a opção desligada a mensagem da equipe só é ignorada');
  assert.equal(doCelular.registro.nome, '', 'o nome do celular do robô não vira nome do contato');
  assert.equal(doCelular.registro.telefone, '5518991234567');

  const classico = (await evento({ id: 'false_5511988887777@c.us_AAA', timestamp: agora, from: '5511988887777@c.us', fromMe: false, body: 'oi' }))[0].json;
  assert.equal(classico.registro.telefone, '5511988887777');
  assert.equal(classico.registro.nome, '');

  const grupo = (await evento({ id: 'x', timestamp: agora, from: '120363000000@g.us', fromMe: false, body: 'oi' }))[0].json;
  assert.equal(grupo.registro, undefined, 'grupos não entram nas conversas');
});

const registrarConversa = async (interpretada, executados, extras = {}) => {
  const saidas = { 'Interpretar mensagem': interpretada, ...extras };
  const json = (await codigoDoNo('Montar linha de log')(nome => ({
    isExecuted: executados.includes(nome),
    first: () => ({ json: saidas[nome] ?? interpretada }),
  }), null, relogio))[0].json;
  return { ...json, atividade: JSON.parse(json.linha), conversa: json.conversa ? JSON.parse(json.conversa) : null };
};
const registroBase = { conversa: '123456789012345@lid', telefone: '5518991234567', nome: 'Ana', texto: 'TEXTO DO CLIENTE', midia: false };
const RESPONDIDA = ['Resolver conversa', 'Resposta final', 'Verificar limites', 'WAHA: enviar resposta'];

test('conversa registra texto recebido, resposta enviada, assunto e IA; o log de atividade continua sem texto', async () => {
  const interpretada = { ...mensagemBase('TEXTO DO CLIENTE'), evento: 'message.any', registro: registroBase };
  const final = { ...interpretada, intencao: 'ia', origem: 'ia', resposta: 'RESPOSTA ENVIADA', ia: { usar: true, resultado: 'respondeu' } };
  const r = await registrarConversa(interpretada, RESPONDIDA, { 'Resposta final': final, 'Resolver conversa': final });
  assert.equal(r.atividade.resultado, 'respondida');
  assert.doesNotMatch(r.linha, /TEXTO DO CLIENTE|RESPOSTA ENVIADA|5518991234567|Ana/, 'log de atividade sem texto, telefone ou nome');
  assert.deepEqual(r.conversa, {
    quando: '2026-11-10T19:30:00.000-03:00', de: 'contato', conversa: '123456789012345@lid', telefone: '5518991234567', nome: 'Ana',
    texto: 'TEXTO DO CLIENTE', resultado: 'respondida', motivo: 'ia', intencao: 'ia', ia: 'respondeu', resposta: 'RESPOSTA ENVIADA', msg: 'TEST0001',
  });
  assert.equal(r.falhaNoEnvio, false);
});

test('conversa registra o motivo do silêncio, a falha de envio e as mensagens da equipe', async () => {
  const interpretada = { ...mensagemBase('tem estacionamento?'), evento: 'message.any', registro: { ...registroBase, texto: 'tem estacionamento?' } };
  const silenciada = { ...interpretada, intencao: 'nao_entendi', origem: 'fallback_esgotado', silenciar: true, motivo: 'fallback_esgotado', resposta: '', ia: { usar: true, resultado: 'limite_por_contato' } };
  let r = await registrarConversa(interpretada, ['Resolver conversa', 'Resposta final', 'Verificar limites'], { 'Resposta final': silenciada, 'Resolver conversa': silenciada, 'Verificar limites': { motivo: 'fallback_esgotado' } });
  assert.equal(r.conversa.resultado, 'silenciada');
  assert.equal(r.conversa.motivo, 'fallback_esgotado');
  assert.equal(r.conversa.ia, 'limite_por_contato');
  assert.equal(r.conversa.resposta, undefined);

  const final = { ...interpretada, intencao: 'valores', origem: 'numero', resposta: 'Valores: R$ 40', ia: { usar: false } };
  r = await registrarConversa(interpretada, [...RESPONDIDA, 'Redis: liberar trava (erro no envio)'], { 'Resposta final': final, 'Resolver conversa': final });
  assert.equal(r.falhaNoEnvio, true);
  assert.equal(r.atividade.resultado, 'falha_no_envio', 'falha de envio não consta como respondida');
  assert.equal(r.conversa.resultado, 'falha_no_envio');
  assert.equal(r.conversa.resposta, 'Valores: R$ 40', 'mostra o que deveria ter sido enviado');

  const agrupada = await registrarConversa(interpretada, ['Redis: ler última mensagem'], { 'Verificar sequência e sessão': { motivo: 'agrupada_com_mensagem_seguinte' } });
  assert.equal(agrupada.conversa.motivo, 'agrupada_com_mensagem_seguinte');
  assert.equal(agrupada.conversa.texto, 'tem estacionamento?');

  const equipe = { evento: 'message.any', contato: '***2345', msg: 'TEST0002', acao: 'ignorar', motivo: 'enviada_pelo_atendente', registro: { ...registroBase, nome: '', texto: 'Oi, sou da equipe' } };
  r = await registrarConversa(equipe, []);
  assert.equal(r.conversa.de, 'atendente');
  assert.equal(r.conversa.texto, 'Oi, sou da equipe');
  assert.equal(r.conversa.nome, undefined);

  const pausa = { evento: 'message.any', contato: '***2345', msg: 'TEST0003', acao: 'pausar', registro: { ...registroBase, nome: '', texto: '#humano' } };
  r = await registrarConversa(pausa, []);
  assert.equal(r.conversa.de, 'atendente');
  assert.equal(r.conversa.resultado, 'robo_pausado');

  const automatica = { ...pausa, msg: 'TEST0005', motivo: 'atendente_respondeu', registro: { ...registroBase, nome: '', texto: 'Oi, sou da equipe' } };
  r = await registrarConversa(automatica, []);
  assert.equal(r.atividade.motivo, 'atendente_respondeu');
  assert.equal(r.conversa.resultado, 'robo_pausado');
  assert.equal(r.conversa.texto, 'Oi, sou da equipe');

  const reativar = { evento: 'message.any', contato: '***2345', msg: 'TEST0004', acao: 'reativar', resposta: 'Atendimento automático reativado.', registro: { ...registroBase, nome: '', texto: '#bot' } };
  r = await registrarConversa(reativar, ['WAHA: avisar reativação']);
  assert.equal(r.conversa.resultado, 'robo_reativado');
  assert.equal(r.conversa.resposta, 'Atendimento automático reativado.');
});

test('respostas do próprio robô, entregas repetidas e status do WhatsApp não entram nas conversas', async () => {
  const doRobo = { evento: 'message.any', contato: '***2345', msg: 'T1', acao: 'ignorar', motivo: 'enviada_pelo_robo', registro: { ...registroBase, texto: 'Olá! Menu…' } };
  assert.equal((await registrarConversa(doRobo, [])).conversa, null);
  const repetida = { ...mensagemBase('oi'), evento: 'message.any', registro: registroBase };
  assert.equal((await registrarConversa(repetida, ['Redis: deduplicar'], { 'Verificar duplicidade e pausa': { motivo: 'mensagem_duplicada' } })).conversa, null);
  const sessao = { evento: 'session.status', acao: 'sessao', detalhe: 'WORKING' };
  const r = await registrarConversa(sessao, ['Redis: registrar estado da sessão']);
  assert.equal(r.conversa, null);
  assert.equal(r.atividade.detalhe, 'WORKING', 'o status continua no log de atividade (o painel lê dali)');

  const montar = codigoDoNo('Montar linha da conversa');
  const com = (json) => nome => ({ first: () => ({ json: nome === 'Montar linha de log' ? json : {} }) });
  assert.deepEqual(await montar(com({ conversa: '', falhaNoEnvio: false })), [], 'sem conversa, o ramo termina');
  assert.deepEqual(await montar(com({ conversa: '{"a":1}\n', falhaNoEnvio: false })), [{ json: { linha: '{"a":1}\n' } }]);
  await assert.rejects(montar(com({ conversa: '', falhaNoEnvio: true })), /CHATBOT_FALHA_ENVIO_WAHA/, 'falha de envio nunca some, mesmo sem conversa');
});
