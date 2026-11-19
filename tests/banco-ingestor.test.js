'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { criarIngestor } = require('../painel/ingestor.js');
const { criarBancoFalso } = require('./banco-falso.js');

const CONVERSA = 'conversas-2026-05-10.log';
const CHATBOT = 'chatbot-2026-05-10.log';
const ERROS = 'erros-2026-05-10.log';

const pastasCriadas = [];

after(async () => {
  for (const pasta of pastasCriadas) await fs.rm(pasta, { recursive: true, force: true });
});

async function prepararCenario(opcoes = {}) {
  const pasta = await fs.mkdtemp(path.join(os.tmpdir(), 'ingestor-teste-'));
  pastasCriadas.push(pasta);
  const repositorio = criarBancoFalso();
  const log = [];
  const ingestor = criarIngestor({ pasta, repositorio, registrar: (mensagem) => log.push(mensagem), ...opcoes });
  return { pasta, repositorio, ingestor, log, caminho: (nome) => path.join(pasta, nome) };
}

const linha = (objeto) => JSON.stringify(objeto) + '\n';

function conversa(extra = {}) {
  return { quando: '2026-05-10T12:00:00.000Z', conversa: 'c1', texto: 'oi', ...extra };
}

test('ingere conversa, chatbot e erros e mapeia os campos', async () => {
  const { repositorio, ingestor, log, caminho } = await prepararCenario();
  await fs.writeFile(caminho(CONVERSA), linha({
    quando: '2026-05-10T12:00:00.000Z', sessao: 's1', conversa: 'c1', telefone: '5511', nome: 'Ana', de: 'cliente',
    texto: 'oi', resultado: 'ok', motivo: 'm', intencao: 'saudacao', resposta: 'olá', evento: 'ev1', ia: 'groq',
    iaModelo: 'llama', msg: 'm1', campoNovo: 42
  }));
  await fs.writeFile(caminho(CHATBOT), linha({
    quando: '2026-05-10T12:01:00.000Z', resultado: 'ok', motivo: 'mm', evento: 'entrada', detalhe: 'd', intencao: 'i',
    ia: 'groq', iaModelo: 'llama', iaTentativas: 2, sessao: 's1', extraX: 'y'
  }));
  await fs.writeFile(caminho(ERROS), linha({
    quando: '2026-05-10T12:02:00.000Z', workflow: 'wf', no: 'HTTP', erro: 'boom', descricao: 'desc', http: 500,
    execucao: '123', modo: 'manual', outro: true
  }));

  assert.equal(await ingestor.ciclo(), true);

  assert.equal(repositorio.estado.mensagens.length, 1);
  const [msg] = repositorio.estado.mensagens;
  assert.equal(msg.quando, '2026-05-10T12:00:00.000Z');
  assert.equal(msg.sessao, 's1');
  assert.equal(msg.conversa, 'c1');
  assert.equal(msg.telefone, '5511');
  assert.equal(msg.nome, 'Ana');
  assert.equal(msg.de, 'cliente');
  assert.equal(msg.texto, 'oi');
  assert.equal(msg.resultado, 'ok');
  assert.equal(msg.intencao, 'saudacao');
  assert.equal(msg.resposta, 'olá');
  assert.equal(msg.evento_id, 'ev1');
  assert.equal(msg.ia, 'groq');
  assert.equal(msg.ia_modelo, 'llama');
  assert.equal(msg.msg, 'm1');
  assert.deepEqual(JSON.parse(msg.extra), { campoNovo: 42 });
  assert.equal(msg.arquivo, CONVERSA);
  assert.equal(msg.posicao, 0);

  assert.equal(repositorio.estado.registros.length, 1);
  const [reg] = repositorio.estado.registros;
  assert.equal(reg.quando, '2026-05-10T12:01:00.000Z');
  assert.equal(reg.evento, 'entrada');
  assert.equal(reg.detalhe, 'd');
  assert.equal(reg.ia_modelo, 'llama');
  assert.equal(reg.ia_tentativas, 2);
  assert.equal(reg.sessao, 's1');
  assert.deepEqual(JSON.parse(reg.extra), { extraX: 'y' });

  assert.equal(repositorio.estado.erros.length, 1);
  const [erro] = repositorio.estado.erros;
  assert.equal(erro.workflow, 'wf');
  assert.equal(erro.no, 'HTTP');
  assert.equal(erro.erro, 'boom');
  assert.equal(erro.descricao, 'desc');
  assert.equal(erro.http, 500);
  assert.equal(erro.execucao, '123');
  assert.equal(erro.modo, 'manual');
  assert.deepEqual(JSON.parse(erro.extra), { outro: true });

  assert.deepEqual(log, []);
});

test('rodar o ciclo duas vezes não duplica nenhuma linha', async () => {
  const { repositorio, ingestor, caminho } = await prepararCenario();
  await fs.writeFile(caminho(CONVERSA), linha(conversa({ texto: 'a' })) + linha(conversa({ texto: 'b' })));
  await fs.writeFile(caminho(CHATBOT), linha({ quando: '2026-05-10T12:00:00.000Z', resultado: 'ok' }));
  await fs.writeFile(caminho(ERROS), linha({ quando: '2026-05-10T12:00:00.000Z', erro: 'x' }));

  await ingestor.ciclo();
  await ingestor.ciclo();

  assert.equal(repositorio.estado.mensagens.length, 2);
  assert.equal(repositorio.estado.registros.length, 1);
  assert.equal(repositorio.estado.erros.length, 1);
});

test('ciclo incremental insere apenas as linhas acrescentadas', async () => {
  const { repositorio, ingestor, caminho } = await prepararCenario();
  await fs.writeFile(caminho(CONVERSA), linha(conversa({ texto: 'a' })));
  await ingestor.ciclo();
  assert.equal(repositorio.estado.mensagens.length, 1);

  await fs.appendFile(caminho(CONVERSA), linha(conversa({ texto: 'b' })) + linha(conversa({ texto: 'c' })));
  await ingestor.ciclo();

  assert.deepEqual(repositorio.estado.mensagens.map((m) => m.texto), ['a', 'b', 'c']);
  assert.equal(new Set(repositorio.estado.mensagens.map((m) => m.posicao)).size, 3);
});

test('linha final sem quebra de linha só entra depois de completada, sem duplicar', async () => {
  const { repositorio, ingestor, caminho } = await prepararCenario();
  const completa = linha(conversa({ texto: 'primeira' }));
  const json = JSON.stringify(conversa({ texto: 'segunda' }));
  await fs.writeFile(caminho(CONVERSA), completa + json.slice(0, 20));

  await ingestor.ciclo();
  assert.deepEqual(repositorio.estado.mensagens.map((m) => m.texto), ['primeira']);
  assert.equal(repositorio.estado.ingestao.get(CONVERSA).posicao, Buffer.byteLength(completa));

  await fs.appendFile(caminho(CONVERSA), json.slice(20) + '\n');
  await ingestor.ciclo();
  await ingestor.ciclo();

  assert.deepEqual(repositorio.estado.mensagens.map((m) => m.texto), ['primeira', 'segunda']);
  assert.deepEqual(repositorio.estado.mensagens.map((m) => m.posicao), [0, Buffer.byteLength(completa)]);
});

test('ignora linha corrompida e linha que é array sem travar o ciclo nem as seguintes', async () => {
  const { repositorio, ingestor, log, caminho } = await prepararCenario();
  await fs.writeFile(caminho(CONVERSA),
    linha(conversa({ texto: 'um' })) +
    'isto não é json\n' +
    '[1,2,3]\n' +
    '"texto solto"\n' +
    '\n' +
    linha({ quando: 'não é data', conversa: 'c1' }) +
    linha({ quando: '2026-05-10T12:00:00.000Z', texto: 'sem conversa' }) +
    linha(conversa({ texto: 'dois' })));
  await fs.writeFile(caminho(CHATBOT), linha({ quando: 'lixo' }) + linha({ quando: '2026-05-10T12:00:00.000Z', resultado: 'ok' }));

  assert.equal(await ingestor.ciclo(), true);

  assert.deepEqual(repositorio.estado.mensagens.map((m) => m.texto), ['um', 'dois']);
  assert.equal(repositorio.estado.registros.length, 1);
  assert.deepEqual(log, []);
});

test('zerar a posição guardada e reingerir não duplica (chave arquivo+posição)', async () => {
  const { repositorio, ingestor, caminho } = await prepararCenario();
  await fs.writeFile(caminho(CONVERSA), linha(conversa({ texto: 'a' })) + linha(conversa({ texto: 'b' })));
  await ingestor.ciclo();
  assert.equal(repositorio.estado.mensagens.length, 2);

  repositorio.estado.ingestao.clear();
  await ingestor.ciclo();

  assert.equal(repositorio.estado.mensagens.length, 2);
  assert.equal(repositorio.estado.ingestao.get(CONVERSA).posicao, Buffer.byteLength(linha(conversa({ texto: 'a' })) + linha(conversa({ texto: 'b' }))));
});

test('arquivo truncado é reingerido numa nova geração', async () => {
  const { repositorio, ingestor, caminho } = await prepararCenario();
  await fs.writeFile(caminho(CONVERSA), linha(conversa({ texto: 'a' })) + linha(conversa({ texto: 'b' })));
  await ingestor.ciclo();
  assert.equal(repositorio.estado.mensagens.length, 2);

  await fs.writeFile(caminho(CONVERSA), linha(conversa({ texto: 'novo' })));
  assert.equal(await ingestor.ciclo(), true);

  assert.equal(repositorio.estado.mensagens.length, 3);
  const novo = repositorio.estado.mensagens.find((m) => m.texto === 'novo');
  assert.equal(novo.arquivo, CONVERSA + '#1');
  assert.equal(novo.posicao, 0);
  assert.equal(repositorio.estado.ingestao.get(CONVERSA).geracao, 1);
});

test('arquivo substituído por outro maior, sem \\n antes da posição guardada, é tratado como recriado', async () => {
  const { repositorio, ingestor, caminho } = await prepararCenario();
  const original = linha(conversa({ texto: 'antigo' }));
  await fs.writeFile(caminho(CONVERSA), original);
  await ingestor.ciclo();
  const L = Buffer.byteLength(original);
  assert.equal(repositorio.estado.ingestao.get(CONVERSA).posicao, L);

  const substituto = linha(conversa({ texto: 'novo', obs: 'z'.repeat(L + 20) }));
  assert.ok(Buffer.byteLength(substituto) > L);
  assert.notEqual(Buffer.from(substituto)[L - 1], 0x0a);
  await fs.writeFile(caminho(CONVERSA), substituto);
  await ingestor.ciclo();

  const novo = repositorio.estado.mensagens.find((m) => m.texto === 'novo');
  assert.ok(novo, 'a linha do arquivo substituído deveria ter sido ingerida');
  assert.equal(novo.arquivo, CONVERSA + '#1');
  assert.equal(novo.posicao, 0);
  assert.equal(repositorio.estado.ingestao.get(CONVERSA).geracao, 1);
  assert.equal(repositorio.estado.mensagens.length, 2);
});

test('arquivo apagado entre ciclos não dá erro e nada é apagado do banco', async () => {
  const { repositorio, ingestor, log, caminho } = await prepararCenario();
  await fs.writeFile(caminho(CONVERSA), linha(conversa({ texto: 'a' })));
  await ingestor.ciclo();
  assert.equal(repositorio.estado.mensagens.length, 1);

  await fs.rm(caminho(CONVERSA));

  assert.equal(await ingestor.ciclo(), true);
  assert.equal(repositorio.estado.mensagens.length, 1);
  assert.deepEqual(log, []);
});

test('com o banco fora do ar o ciclo devolve false sem ler nada e depois ingere o pendente', async () => {
  const { repositorio, ingestor, caminho } = await prepararCenario();
  await fs.writeFile(caminho(CONVERSA), linha(conversa({ texto: 'a' })));
  await repositorio.definirNoAr(false);

  assert.equal(await ingestor.ciclo(), false);
  await fs.appendFile(caminho(CONVERSA), linha(conversa({ texto: 'b' })));
  assert.equal(await ingestor.ciclo(), false);
  assert.equal(repositorio.estado.mensagens.length, 0);
  assert.equal(repositorio.estado.ingestao.size, 0);

  await repositorio.definirNoAr(true);
  assert.equal(await ingestor.ciclo(), true);
  assert.deepEqual(repositorio.estado.mensagens.map((m) => m.texto), ['a', 'b']);
});

test('atrasoSegundos é null antes do primeiro ciclo bem-sucedido e um número depois', async () => {
  let agoraMs = 1_000_000;
  const { repositorio, ingestor } = await prepararCenario({ agora: () => agoraMs });
  assert.equal(ingestor.atrasoSegundos(), null);

  await repositorio.definirNoAr(false);
  await ingestor.ciclo();
  assert.equal(ingestor.atrasoSegundos(), null);

  await repositorio.definirNoAr(true);
  await ingestor.ciclo();
  assert.equal(ingestor.atrasoSegundos(), 0);

  agoraMs += 42_000;
  assert.equal(ingestor.atrasoSegundos(), 42);
});

test('caracteres multibyte (acentos e emoji) não quebram as posições em bytes', async () => {
  const { repositorio, ingestor, caminho } = await prepararCenario();
  const primeira = linha(conversa({ texto: 'José disse: não, 🎉' }));
  const segunda = linha(conversa({ texto: 'Ação concluída ✅' }));
  await fs.writeFile(caminho(CONVERSA), primeira + segunda);

  await ingestor.ciclo();
  await ingestor.ciclo();

  assert.equal(repositorio.estado.mensagens.length, 2);
  assert.deepEqual(repositorio.estado.mensagens.map((m) => m.texto), ['José disse: não, 🎉', 'Ação concluída ✅']);
  assert.deepEqual(repositorio.estado.mensagens.map((m) => m.posicao), [0, Buffer.byteLength(primeira)]);
  assert.equal(repositorio.estado.ingestao.get(CONVERSA).posicao, Buffer.byteLength(primeira + segunda));
});

test('o caractere nulo \\u0000 é removido do texto', async () => {
  const { repositorio, ingestor, caminho } = await prepararCenario();
  await fs.writeFile(caminho(CONVERSA), linha(conversa({ texto: 'a\u0000b', resposta: '\u0000', obs: 'x\u0000y' })));

  await ingestor.ciclo();

  const [msg] = repositorio.estado.mensagens;
  assert.equal(msg.texto, 'ab');
  assert.equal(msg.resposta, '');
  assert.ok(!msg.extra.includes('\\u0000'));
  assert.deepEqual(JSON.parse(msg.extra), { obs: 'xy' });
});

test('rodarAgora() chamado duas vezes ao mesmo tempo devolve a mesma promise', async () => {
  const { repositorio, ingestor, caminho } = await prepararCenario();
  await fs.writeFile(caminho(CONVERSA), linha(conversa({ texto: 'a' })));

  const estadosOriginal = repositorio.ingestao.estados;
  let chamadas = 0;
  repositorio.ingestao.estados = async () => { chamadas++; return estadosOriginal(); };

  const primeira = ingestor.rodarAgora();
  const segunda = ingestor.rodarAgora();
  assert.equal(primeira, segunda);
  await Promise.all([primeira, segunda]);

  assert.equal(chamadas, 1);
  assert.equal(repositorio.estado.mensagens.length, 1);

  assert.equal(await ingestor.rodarAgora(), true);
  assert.equal(chamadas, 2);
});
