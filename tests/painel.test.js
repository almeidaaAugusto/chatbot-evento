'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { criarServidor } = require('../painel/server');
const { validarConfig } = require('../lib/configuracao');

function exemplo() {
  return {
    evento: { nome: 'Festival', local: 'Praça', instagram: '@festival' },
    mensagens: { menu: '1 - Local', nao_entendi: 'Procure {{instagram}}', reativado: 'Olá' },
    fallback: { mensagens: ['Escolha uma opção.', 'Reformule sua pergunta.', 'Fale com {{instagram}}.'], mensagem_midia: 'Escreva sua dúvida.' },
    opcoes: [{ id: 'local', titulo: 'Local do evento', palavras_exatas: ['1'], palavras_chave: ['local'], perguntas: ['Onde acontece o festival?'], resposta: 'Estamos na {{local}}.' }],
    protecoes: { max_mensagens_por_hora: 40 },
    avancado: { manter: true }
  };
}

async function ambiente(t) {
  const pasta = await fs.mkdtemp(path.join(os.tmpdir(), 'chatbot-painel-'));
  const configPath = path.join(pasta, 'chatbot.json');
  await fs.writeFile(configPath, JSON.stringify(exemplo(), null, 2));
  const server = criarServidor({ configPath });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const url = 'http://127.0.0.1:' + server.address().port;
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await fs.rm(pasta, { recursive: true, force: true }); });
  return { pasta, configPath, server, url };
}

function requisicao(url, rota, { metodo = 'GET', corpo, headers = {}, chunked = false } = {}) {
  return new Promise((resolve, reject) => {
    const raw = corpo === undefined ? undefined : typeof corpo === 'string' ? corpo : JSON.stringify(corpo);
    const req = http.request(url + rota, { method: metodo, headers: { ...(raw === undefined ? {} : { 'Content-Type': 'application/json', ...(chunked ? { 'Transfer-Encoding': 'chunked' } : { 'Content-Length': Buffer.byteLength(raw) }) }), ...headers } }, res => {
      let texto = '';
      res.setEncoding('utf8');
      res.on('data', parte => { texto += parte; });
      res.on('end', () => { let dados; try { dados = JSON.parse(texto); } catch {} resolve({ status: res.statusCode, dados, texto, headers: res.headers }); });
    });
    req.on('error', reject);
    req.end(raw);
  });
}

test('validação rejeita estruturas inválidas, IDs inseguros e campos novos incorretos', () => {
  for (const cfg of [null, [], 'texto', { ...exemplo(), opcoes: [null] }]) assert.ok(validarConfig(cfg).erros.length);
  const cfg = exemplo();
  cfg.opcoes[0].id = '../local';
  cfg.opcoes[0].perguntas = [''];
  cfg.fallback.mensagens = ['igual', 'igual', ''];
  assert.ok(validarConfig(cfg).erros.length >= 3);
  assert.deepEqual(validarConfig(exemplo()).erros, []);
});

test('validação permite marcador reservado de opções e rejeita marcador desconhecido', () => {
  const cfg = exemplo();
  cfg.fallback.mensagens[0] = 'Escolha uma das opções: {{opcoes}}';
  assert.deepEqual(validarConfig(cfg).erros, []);
  cfg.fallback.mensagens[0] = 'Escolha {{marcador_inexistente}}';
  assert.ok(validarConfig(cfg).erros.some(erro => erro.includes('marcador_inexistente')));
});

test('porta pública configurada permite mapeamento Docker sem liberar hosts estrangeiros', async t => {
  const { configPath } = await ambiente(t);
  const server = criarServidor({ configPath, publicPort: 9090 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = 'http://127.0.0.1:' + server.address().port;
  const res = await requisicao(url, '/api/config', { headers: { Host: '127.0.0.1:9090', Origin: 'http://127.0.0.1:9090' } });
  assert.equal(res.status, 200);
  assert.equal((await requisicao(url, '/api/config', { headers: { Host: 'estrangeiro.example:9090' } })).status, 403);
});

test('GET entrega configuração e revisão e serve o painel com proteção de conteúdo', async t => {
  const { url } = await ambiente(t);
  const res = await requisicao(url, '/api/config');
  assert.equal(res.status, 200);
  assert.equal(res.dados.config.evento.nome, 'Festival');
  assert.match(res.dados.revisao, /^[a-f0-9]{64}$/);
  assert.deepEqual(res.dados.avisos, []);
  const saude = await requisicao(url, '/api/health');
  assert.equal(saude.status, 200);
  assert.equal(saude.dados.ok, true);
  const pagina = await requisicao(url, '/');
  assert.equal(pagina.status, 200);
  assert.match(pagina.headers['content-type'], /text\/html/);
  assert.match(pagina.headers['content-security-policy'], /default-src 'self'/);
});

test('PUT salva atomicamente, guarda versão anterior e preserva campos avançados', async t => {
  const { url, pasta, configPath } = await ambiente(t);
  const anterior = await fs.readFile(configPath, 'utf8');
  const { dados } = await requisicao(url, '/api/config');
  dados.config.evento.nome = 'Festival novo';
  const salvo = await requisicao(url, '/api/config', { metodo: 'PUT', corpo: dados });
  assert.equal(salvo.status, 200);
  assert.notEqual(salvo.dados.revisao, dados.revisao);
  const atual = JSON.parse(await fs.readFile(configPath, 'utf8'));
  assert.equal(atual.evento.nome, 'Festival novo');
  assert.deepEqual(atual.avancado, { manter: true });
  assert.equal(await fs.readFile(configPath + '.bak', 'utf8'), anterior);
  assert.deepEqual((await fs.readdir(pasta)).sort(), ['chatbot.json', 'chatbot.json.bak']);
});

test('PUT rejeita dados inválidos e revisão antiga sem mudar arquivo ou backup', async t => {
  const { url, configPath } = await ambiente(t);
  const { dados } = await requisicao(url, '/api/config');
  const original = await fs.readFile(configPath, 'utf8');
  const invalida = structuredClone(dados);
  invalida.config.opcoes[0].resposta = '';
  assert.equal((await requisicao(url, '/api/config', { metodo: 'PUT', corpo: invalida })).status, 422);
  assert.equal(await fs.readFile(configPath, 'utf8'), original);
  dados.config.evento.nome = 'Edição A';
  assert.equal((await requisicao(url, '/api/config', { metodo: 'PUT', corpo: dados })).status, 200);
  dados.config.evento.nome = 'Edição antiga';
  assert.equal((await requisicao(url, '/api/config', { metodo: 'PUT', corpo: dados })).status, 409);
  assert.equal(JSON.parse(await fs.readFile(configPath, 'utf8')).evento.nome, 'Edição A');
  assert.equal(await fs.readFile(configPath + '.bak', 'utf8'), original);
});

test('duas gravações simultâneas da mesma revisão só aceitam uma edição', async t => {
  const { url, configPath } = await ambiente(t);
  const { dados } = await requisicao(url, '/api/config');
  const outra = structuredClone(dados);
  dados.config.evento.nome = 'Edição A';
  outra.config.evento.nome = 'Edição B';
  const respostas = await Promise.all([dados, outra].map(corpo => requisicao(url, '/api/config', { metodo: 'PUT', corpo })));
  assert.deepEqual(respostas.map(res => res.status).sort(), [200, 409]);
  assert.ok(['Edição A', 'Edição B'].includes(JSON.parse(await fs.readFile(configPath, 'utf8')).evento.nome));
});

test('Host e Origin estrangeiros, corpo excessivo e tipo incorreto são recusados', async t => {
  const { url } = await ambiente(t);
  const { dados } = await requisicao(url, '/api/config');
  for (const rota of ['/api/config', '/api/simular']) {
    const metodo = rota.endsWith('config') ? 'PUT' : 'POST';
    assert.equal((await requisicao(url, rota, { metodo, corpo: dados, headers: { Origin: 'https://estrangeiro.example' } })).status, 403);
    assert.equal((await requisicao(url, rota, { metodo, corpo: dados, headers: { Host: 'estrangeiro.example' } })).status, 403);
    assert.equal((await requisicao(url, rota, { metodo, corpo: dados, headers: { 'Content-Type': 'text/plain' } })).status, 415);
  }
  assert.equal((await requisicao(url, '/api/config', { metodo: 'PUT', corpo: '{' })).status, 400);
  assert.equal((await requisicao(url, '/api/config', { metodo: 'PUT', corpo: ' '.repeat(1024 * 1024 + 1) })).status, 413);
  assert.equal((await requisicao(url, '/api/config', { metodo: 'PUT', corpo: ' '.repeat(1024 * 1024 + 1), chunked: true })).status, 413);
  assert.equal((await requisicao(url, '/api/config', { headers: { Host: 'estrangeiro.example' } })).status, 403);
});

test('simulador usa edição sem salvar e devolve o contexto da conversa', async t => {
  const { url, configPath } = await ambiente(t);
  const original = await fs.readFile(configPath, 'utf8');
  const cfg = exemplo();
  cfg.evento.local = 'Parque da simulação';
  const res = await requisicao(url, '/api/simular', { metodo: 'POST', corpo: { config: cfg, texto: '1', estado: {} } });
  assert.equal(res.status, 200);
  assert.match(res.dados.resposta, /Parque da simulação/);
  assert.equal(typeof res.dados.estado, 'object');
  assert.equal(await fs.readFile(configPath, 'utf8'), original);
});

// ---------- IA no simulador ----------

async function ambienteComIA(t, { chaveIA = 'gsk_chave_secreta_de_teste', conteudo = 'A **feira** abre às 10h.' } = {}) {
  const { configPath } = await ambiente(t);
  const pedidos = [];
  const fetchIA = async (url, opcoes) => {
    pedidos.push({ url, opcoes });
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: conteudo }, finish_reason: 'stop' }] }) };
  };
  const server = criarServidor({ configPath, chaveIA, fetchIA });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { url: 'http://127.0.0.1:' + server.address().port, pedidos };
}
const comIA = (extra = {}) => ({ ...exemplo(), ia: { ativa: true, max_usos_por_contato: 2, conhecimento: 'A feira abre às 10h.', ...extra } });
const simular = (url, corpo) => requisicao(url, '/api/simular', { metodo: 'POST', corpo });

test('status da IA informa só se há chave e o provedor, nunca a chave', async t => {
  const { url } = await ambienteComIA(t);
  const res = await requisicao(url, '/api/ia');
  assert.equal(res.status, 200);
  assert.deepEqual(res.dados, { chaveConfigurada: true, provedorDaChave: 'groq' });
  assert.doesNotMatch(res.texto, /chave_secreta/);
  const { url: semChave } = await ambienteComIA(t, { chaveIA: '' });
  assert.deepEqual((await requisicao(semChave, '/api/ia')).dados, { chaveConfigurada: false });
});

test('simulador consulta a IA para dúvida não reconhecida e respeita o limite por contato', async t => {
  const { url, pedidos } = await ambienteComIA(t);
  const primeira = await simular(url, { config: comIA(), texto: 'a feira abre que horas?', estado: {}, usosIA: 0 });
  assert.equal(primeira.status, 200);
  assert.equal(primeira.dados.intencao, 'ia');
  assert.equal(primeira.dados.resposta, 'A *feira* abre às 10h.');
  assert.equal(primeira.dados.usosIA, 1);
  assert.equal(primeira.dados.estado.falhas, 0);
  assert.equal(pedidos.length, 1);
  assert.equal(pedidos[0].opcoes.headers.Authorization, 'Bearer gsk_chave_secreta_de_teste');
  assert.doesNotMatch(primeira.texto, /chave_secreta/);

  const reconhecida = await simular(url, { config: comIA(), texto: '1', estado: {}, usosIA: 1 });
  assert.equal(reconhecida.dados.intencao, 'local');
  assert.equal(pedidos.length, 1, 'opção reconhecida não chama a IA');

  const esgotada = await simular(url, { config: comIA(), texto: 'a feira abre que horas?', estado: {}, usosIA: 2 });
  assert.equal(esgotada.dados.intencao, 'nao_entendi');
  assert.deepEqual(esgotada.dados.ia, { resultado: 'limite_por_contato' });
  assert.equal(pedidos.length, 1, 'acima do limite a IA não é chamada');

  const desligada = await simular(url, { config: comIA({ ativa: false }), texto: 'a feira abre que horas?', estado: {} });
  assert.equal(desligada.dados.intencao, 'nao_entendi');
  assert.equal(desligada.dados.ia, undefined);
  assert.equal(pedidos.length, 1);
});

test('simulador sem chave ou com resposta inventada mostra a orientação normal e o motivo', async t => {
  const { url: semChave } = await ambienteComIA(t, { chaveIA: '' });
  const res = await simular(semChave, { config: comIA(), texto: 'a feira abre que horas?', estado: {} });
  assert.equal(res.dados.intencao, 'nao_entendi');
  assert.deepEqual(res.dados.ia, { resultado: 'sem_chave' });
  const { url, pedidos } = await ambienteComIA(t, { conteudo: 'Compre em https://golpe.example/ingresso' });
  const inventada = await simular(url, { config: comIA(), texto: 'a feira abre que horas?', estado: {}, usosIA: 0 });
  assert.equal(inventada.dados.intencao, 'nao_entendi');
  assert.deepEqual(inventada.dados.ia, { resultado: 'link_nao_confirmado' });
  assert.equal(inventada.dados.usosIA, 1, 'a tentativa conta no limite, como no atendimento real');
  assert.equal(pedidos.length, 1);
  assert.equal((await simular(url, { config: comIA(), texto: 'x', estado: {}, usosIA: 'muitos' })).status, 400);
});

test('validação da seção de IA aponta valores fora do formato', () => {
  assert.deepEqual(validarConfig(comIA()).erros, []);
  const erros = validarConfig(comIA({ ativa: 'sim', provedor: 'outro', max_usos_por_contato: '3', janela_horas: 0, url: 'ftp://x', parametros: [] })).erros;
  for (const trecho of ['ia.ativa', 'ia.provedor', 'ia.max_usos_por_contato', 'ia.janela_horas', 'ia.url', 'ia.parametros']) {
    assert.ok(erros.some(erro => erro.includes(trecho)), trecho);
  }
  assert.ok(validarConfig(comIA({ conhecimento: 'Veja {{inexistente}}' })).erros.some(erro => erro.includes('inexistente')));
  assert.ok(validarConfig(comIA({ max_usos_por_dia: 0 })).avisos.some(aviso => aviso.includes('nunca será consultada')));
});

// ---------- página "Conversas" (registros gravados pelo n8n) ----------

const AGORA = () => new Date(2026, 10, 11, 10, 0, 0); // 11/11/2026, 10h (horário local)
const linhaJson = (dados) => JSON.stringify(dados) + '\n';

async function ambienteComLogs(t, { retencao = 7, fetchWaha, wahaUrl = 'http://waha-de-teste:3000', semPasta = false } = {}) {
  const pasta = await fs.mkdtemp(path.join(os.tmpdir(), 'chatbot-registros-'));
  const logs = path.join(pasta, 'logs');
  await fs.mkdir(logs);
  const configPath = path.join(pasta, 'chatbot.json');
  await fs.writeFile(configPath, JSON.stringify(exemplo(), null, 2));
  const server = criarServidor({
    configPath, logsDir: semPasta ? '' : logs, retencaoConversasDias: retencao, agora: AGORA,
    wahaUrl, fetchWaha: fetchWaha || (async () => ({ ok: true })),
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const url = 'http://127.0.0.1:' + server.address().port;
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await fs.rm(pasta, { recursive: true, force: true }); });
  return { logs, server, url };
}

test('conversas: lê o dia a partir da posição, espera a linha incompleta e respeita a retenção', async t => {
  const { logs, url } = await ambienteComLogs(t);
  const arquivo = path.join(logs, 'conversas-2026-11-11.log');
  const primeira = { quando: '2026-11-11T09:00:00-03:00', de: 'contato', conversa: '123@lid', telefone: '5518991234567', nome: 'Ana', texto: 'oi <b>teste</b>', resultado: 'respondida', intencao: 'menu', resposta: 'Olá! Escolha uma opção.' };
  const segunda = { quando: '2026-11-11T09:01:00-03:00', de: 'contato', conversa: '123@lid', texto: 'tem estacionamento?', resultado: 'silenciada', motivo: 'fallback_esgotado', ia: 'limite_por_contato' };
  await fs.writeFile(arquivo, linhaJson(primeira) + linhaJson(segunda) + '{"quando":"2026-11-11T09:02');

  let r = await requisicao(url, '/api/conversas?dia=2026-11-11');
  assert.equal(r.status, 200);
  assert.deepEqual(r.dados.registros.map(x => x.texto), ['oi <b>teste</b>', 'tem estacionamento?']);
  assert.equal(r.dados.fim, true, 'linha ainda sendo gravada não faz o navegador ler de novo em laço');
  const ate = r.dados.ate;
  assert.equal(ate, Buffer.byteLength(linhaJson(primeira) + linhaJson(segunda)));

  await fs.appendFile(arquivo, ':00-03:00","de":"atendente","conversa":"123@lid","texto":"#humano","resultado":"robo_pausado"}\nlixo que não é JSON\n');
  r = await requisicao(url, '/api/conversas?dia=2026-11-11&de=' + ate);
  assert.equal(r.dados.registros.length, 1, 'só a linha completada; linha inválida é ignorada');
  assert.equal(r.dados.registros[0].resultado, 'robo_pausado');

  r = await requisicao(url, '/api/conversas?dia=2026-11-11&de=999999');
  assert.equal(r.dados.reiniciado, true, 'arquivo menor que a posição (recriado): recomeça do início');
  assert.equal(r.dados.registros.length, 3);

  assert.equal((await requisicao(url, '/api/conversas?dia=2026-11-05')).status, 200, 'sexto dia anterior ainda está na retenção de 7 dias');
  assert.deepEqual((await requisicao(url, '/api/conversas?dia=2026-11-05')).dados.registros, []);
  assert.equal((await requisicao(url, '/api/conversas?dia=2026-11-04')).status, 404, 'fora da retenção');
  assert.equal((await requisicao(url, '/api/conversas?dia=2026-11-12')).status, 404, 'dia futuro');
  assert.equal((await requisicao(url, '/api/conversas?dia=../../etc/passwd')).status, 400);
  assert.equal((await requisicao(url, '/api/conversas?dia=2026-11-11&de=-1')).status, 400);
  assert.equal((await requisicao(url, '/api/conversas?dia=2026-11-11', { headers: { Host: 'evil.example' } })).status, 403, 'mesma proteção de origem do editor');
});

test('situação: status do WhatsApp vem do log de atividade e o serviço fora do ar é informado', async t => {
  const { logs, url } = await ambienteComLogs(t);
  await fs.writeFile(path.join(logs, 'chatbot-2026-11-10.log'), linhaJson({ quando: '2026-11-10T20:00:00.000-03:00', resultado: 'ignorada', motivo: 'status_da_sessao', evento: 'session.status', detalhe: 'WORKING' }));
  await fs.writeFile(path.join(logs, 'chatbot-2026-11-11.log'), linhaJson({ quando: '2026-11-11T08:00:00.000-03:00', resultado: 'respondida', evento: 'message.any', contato: '***4567' }));
  await fs.writeFile(path.join(logs, 'conversas-2026-11-10.log'), '');
  await fs.writeFile(path.join(logs, 'conversas-2026-11-01.log'), '');

  let r = await requisicao(url, '/api/situacao');
  assert.equal(r.status, 200);
  assert.equal(r.dados.registros, true);
  assert.equal(r.dados.hoje, '2026-11-11');
  assert.equal(r.dados.retencaoDias, 7);
  assert.deepEqual(r.dados.dias, ['2026-11-10'], 'só dias dentro da retenção');
  assert.deepEqual(r.dados.whatsapp, { status: 'WORKING', quando: '2026-11-10T20:00:00.000-03:00', servicoNoAr: true }, 'busca o último status nos dias anteriores');

  await fs.appendFile(path.join(logs, 'chatbot-2026-11-11.log'), linhaJson({ quando: '2026-11-11T09:36:15.677-03:00', resultado: 'ignorada', motivo: 'status_da_sessao', evento: 'session.status', detalhe: 'STOPPED' }));
  r = await requisicao(url, '/api/situacao');
  assert.equal(r.dados.whatsapp.status, 'STOPPED', 'o arquivo do dia é relido a partir de onde parou');
  assert.equal(r.dados.whatsapp.quando, '2026-11-11T09:36:15.677-03:00');

  // Uma resposta entregue depois do STOPPED prova que o WhatsApp voltou.
  await fs.appendFile(path.join(logs, 'chatbot-2026-11-11.log'), linhaJson({ quando: '2026-11-11T09:40:00.000-03:00', resultado: 'respondida', evento: 'message.any' }));
  r = await requisicao(url, '/api/situacao');
  assert.deepEqual([r.dados.whatsapp.status, r.dados.whatsapp.quando], ['WORKING', '2026-11-11T09:40:00.000-03:00']);

  // Visto com o número real: ao reconectar, WORKING e STARTING gravados fora de ordem (83 ms).
  const status = (quando, detalhe) => linhaJson({ quando, resultado: 'ignorada', motivo: 'status_da_sessao', evento: 'session.status', detalhe });
  await fs.appendFile(path.join(logs, 'chatbot-2026-11-11.log'), status('2026-11-11T10:13:28.087-03:00', 'WORKING') + status('2026-11-11T10:13:28.170-03:00', 'STARTING'));
  r = await requisicao(url, '/api/situacao');
  assert.deepEqual([r.dados.whatsapp.status, r.dados.whatsapp.quando], ['WORKING', '2026-11-11T10:13:28.087-03:00'], 'STARTING logo após WORKING não derruba o status');

  // Um STARTING bem depois é uma reconexão de verdade.
  await fs.appendFile(path.join(logs, 'chatbot-2026-11-11.log'), status('2026-11-11T10:30:00.000-03:00', 'STARTING'));
  r = await requisicao(url, '/api/situacao');
  assert.equal(r.dados.whatsapp.status, 'STARTING');

  // Visto com o número real: desligamento abrupto deixou bytes nulos antes da linha seguinte.
  await fs.appendFile(path.join(logs, 'chatbot-2026-11-11.log'), '\u0000'.repeat(84) + status('2026-11-11T10:31:00.000-03:00', 'WORKING'));
  r = await requisicao(url, '/api/situacao');
  assert.deepEqual([r.dados.whatsapp.status, r.dados.whatsapp.quando], ['WORKING', '2026-11-11T10:31:00.000-03:00'], 'bytes nulos não escondem a linha');

  const foraDoAr = await ambienteComLogs(t, { fetchWaha: async () => { throw new Error('ECONNREFUSED'); } });
  r = await requisicao(foraDoAr.url, '/api/situacao');
  assert.equal(r.dados.whatsapp.servicoNoAr, false);
  assert.equal(r.dados.whatsapp.status, undefined, 'sem nenhum status registrado');
});

test('erros: últimos dias da retenção, do mais recente para o mais antigo', async t => {
  const { logs, url } = await ambienteComLogs(t);
  await fs.writeFile(path.join(logs, 'erros-2026-11-01.log'), linhaJson({ quando: '2026-11-01T10:00:00-03:00', no: 'antigo', erro: 'fora do período' }));
  await fs.writeFile(path.join(logs, 'erros-2026-11-10.log'), linhaJson({ quando: '2026-11-10T14:49:08-03:00', no: 'WAHA: enviar resposta', erro: 'Your request is invalid', descricao: 'Session status is not as expected', http: 422 }));
  await fs.writeFile(path.join(logs, 'erros-2026-11-11.log'), linhaJson({ quando: '2026-11-11T08:00:00-03:00', no: 'WAHA: enviar resposta', erro: 'Não foi possível enviar a resposta pelo WhatsApp.' }) + 'linha quebrada\n');
  const r = await requisicao(url, '/api/erros');
  assert.equal(r.status, 200);
  assert.deepEqual(r.dados.erros.map(e => e.quando), ['2026-11-11T08:00:00-03:00', '2026-11-10T14:49:08-03:00']);
  assert.equal(r.dados.erros[1].http, 422);
});

test('limpeza apaga só as conversas fora da retenção, ao iniciar e a cada hora', async t => {
  const { logs, server } = await ambienteComLogs(t, { retencao: 3 });
  for (const nome of ['conversas-2026-11-08.log', 'conversas-2026-11-09.log', 'conversas-2026-11-11.log', 'chatbot-2026-11-01.log', 'erros-2026-11-01.log', 'conversas-rascunho.log']) {
    await fs.writeFile(path.join(logs, nome), linhaJson({ quando: 'x' }));
  }
  // A limpeza feita ao iniciar pode ter corrido junto; o resultado final é o mesmo.
  await server.registros.limpar();
  assert.deepEqual((await fs.readdir(logs)).sort(), ['chatbot-2026-11-01.log', 'conversas-2026-11-09.log', 'conversas-2026-11-11.log', 'conversas-rascunho.log', 'erros-2026-11-01.log']);
  assert.deepEqual(await server.registros.limpar(), [], 'nada mais a apagar');
});

test('sem pasta de registros a página avisa, e as páginas do painel são servidas com as abas', async t => {
  const { url } = await ambienteComLogs(t, { semPasta: true });
  const situacao = await requisicao(url, '/api/situacao');
  assert.equal(situacao.status, 200);
  assert.equal(situacao.dados.registros, false);
  const conversas = await requisicao(url, '/api/conversas?dia=2026-11-11');
  assert.equal(conversas.status, 503);
  assert.match(conversas.dados.erro, /docker compose up -d/);
  const pagina = await requisicao(url, '/conversas');
  assert.equal(pagina.status, 200);
  assert.match(pagina.headers['content-type'], /text\/html/);
  assert.match(pagina.texto, /src="\/conversas\.js"/);
  assert.match(pagina.headers['content-security-policy'], /script-src 'self'/);
  const script = await requisicao(url, '/conversas.js');
  assert.match(script.headers['content-type'], /javascript/);
  assert.doesNotMatch(script.texto, /innerHTML|insertAdjacentHTML|outerHTML/, 'texto do WhatsApp nunca entra como HTML');
  assert.match((await requisicao(url, '/')).texto, /href="\/conversas"/);
});

// ---------- configuração v2 (vários eventos) ----------

function exemploV2() {
  const opcao = { id: 'local', titulo: 'Local do evento', palavras_exatas: ['1'], palavras_chave: ['local'], perguntas: ['Onde acontece o evento?'], resposta: 'Estamos na {{local}}.' };
  return {
    versao: 2,
    produtora: { nome: 'Produtora Teste', instagram: '@produtora', email: 'contato@produtora.example', linktree: 'https://produtora.example/links' },
    mensagens: { reativado: 'Olá de novo!', agradecimento: 'Obrigado!', nao_entendi: 'Não entendi sua mensagem.', sem_eventos: 'No momento não há eventos.', escolher_evento: 'Escolha um evento:\n{{eventos}}' },
    fallback: { mensagens: ['Escolha uma opção.', 'Reformule sua pergunta.', 'Fale com a produtora.'], mensagem_midia: 'Escreva sua dúvida.' },
    eventos: [
      { id: 'festa-a', status: 'ativo', gatilhos: ['requebra'], evento: { nome: 'Festa A', data: '2026-12-05', local: 'Praça Central' }, mensagens: { menu: 'Menu da Festa A: digite 1 para o local.' }, opcoes: [structuredClone(opcao)] },
      { id: 'festa-b', status: 'ativo', gatilhos: ['samba'], evento: { nome: 'Festa B', data: '2026-12-12', local: 'Parque B' }, mensagens: { menu: 'Menu da Festa B: digite 1 para o local.' }, opcoes: [structuredClone(opcao)] },
      { id: 'festa-c', status: 'rascunho', gatilhos: ['cometa'], evento: { nome: 'Festa Cometa', data: '2027-01-09', local: 'Galpão C' }, mensagens: { menu: 'Menu da Cometa: digite 1 para o local.' }, opcoes: [structuredClone(opcao)] }
    ]
  };
}

test('simulador v2: contato novo recebe o menu de eventos e "1" escolhe o primeiro evento ativo', async t => {
  const { url } = await ambiente(t);
  const cfg = exemploV2();
  const menu = await simular(url, { config: cfg, texto: 'oi', estado: {} });
  assert.equal(menu.status, 200);
  assert.equal(menu.dados.intencao, 'escolher_evento');
  assert.equal(menu.dados.estado.escolhendoEvento, true);

  const escolha = await simular(url, { config: cfg, texto: '1', estado: menu.dados.estado });
  assert.equal(escolha.status, 200);
  assert.equal(escolha.dados.intencao, 'menu');
  assert.equal(escolha.dados.estado.evento, 'festa-a');
  assert.match(escolha.dados.resposta, /Menu da Festa A/);
});

test('simulador v2: eventoId força rascunho; sem ele o rascunho só entra no menu com incluirRascunhos', async t => {
  const { url } = await ambiente(t);
  const cfg = exemploV2();

  const forcado = await simular(url, { config: cfg, texto: 'oi', estado: {}, eventoId: 'festa-c' });
  assert.equal(forcado.status, 200);
  assert.equal(forcado.dados.intencao, 'menu');
  assert.equal(forcado.dados.estado.evento, 'festa-c');
  assert.match(forcado.dados.resposta, /Menu da Cometa/);

  const padrao = await simular(url, { config: cfg, texto: 'oi', estado: {} });
  assert.equal(padrao.dados.intencao, 'escolher_evento');
  assert.doesNotMatch(padrao.dados.resposta, /Cometa/, 'rascunho fora da lista padrão');

  const comRascunhos = await simular(url, { config: cfg, texto: 'oi', estado: {}, incluirRascunhos: true });
  assert.equal(comRascunhos.dados.intencao, 'escolher_evento');
  assert.match(comRascunhos.dados.resposta, /Cometa/, 'rascunho entra com incluirRascunhos:true');
});

test('PUT v2 com rascunho inválido salva com 200 e devolve avisos', async t => {
  const { url, configPath } = await ambiente(t);
  await fs.writeFile(configPath, JSON.stringify(exemploV2(), null, 2));
  const { dados } = await requisicao(url, '/api/config');
  dados.config.eventos.find(evento => evento.id === 'festa-c').mensagens.menu = '';
  const salvo = await requisicao(url, '/api/config', { metodo: 'PUT', corpo: dados });
  assert.equal(salvo.status, 200);
  assert.ok(Array.isArray(salvo.dados.avisos) && salvo.dados.avisos.length > 0);
  const gravado = JSON.parse(await fs.readFile(configPath, 'utf8'));
  assert.equal(gravado.eventos.find(evento => evento.id === 'festa-c').mensagens.menu, '');
});

test('PUT v2 com evento ativo inválido devolve 422 e não muda o arquivo', async t => {
  const { url, configPath } = await ambiente(t);
  await fs.writeFile(configPath, JSON.stringify(exemploV2(), null, 2));
  const original = await fs.readFile(configPath, 'utf8');
  const { dados } = await requisicao(url, '/api/config');
  dados.config.eventos.find(evento => evento.id === 'festa-a').mensagens.menu = '';
  const res = await requisicao(url, '/api/config', { metodo: 'PUT', corpo: dados });
  assert.equal(res.status, 422);
  assert.equal(await fs.readFile(configPath, 'utf8'), original);
  await assert.rejects(fs.access(configPath + '.bak'), 'nenhum backup é criado quando a gravação é recusada');
});
