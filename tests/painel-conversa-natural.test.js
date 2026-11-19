'use strict';

// Frente C da conversa natural: validação dos campos novos, simulador do painel e métricas.
// Só dados fictícios. Não depende dos detalhes internos de lib/ia.js (prompt, filtros).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { criarServidor } = require('../painel/server');
const { validarConfig } = require('../lib/configuracao');
const { calcularMetricas } = require('../painel/db/metricas');

function base() {
  return {
    evento: { nome: 'Festival', local: 'Praça', instagram: '@festival' },
    mensagens: { menu: '1 - Local', nao_entendi: 'Procure {{instagram}}', reativado: 'Olá' },
    fallback: { mensagens: ['Escolha uma opção.', 'Reformule sua pergunta.', 'Fale com {{instagram}}.'], mensagem_midia: 'Escreva sua dúvida.' },
    opcoes: [{ id: 'local', titulo: 'Local do evento', palavras_exatas: ['1'], palavras_chave: ['local'], perguntas: ['Onde acontece o festival?'], resposta: 'Estamos na {{local}}.' }],
    protecoes: { max_mensagens_por_hora: 40 },
  };
}
const comIA = (ia = {}, extra = {}) => ({ ...base(), ia: { ativa: true, max_usos_por_contato: 0, conhecimento: 'A feira abre às 10h.', ...ia }, ...extra });

function v2(iaRaiz = {}, iaEvento = undefined) {
  return {
    versao: 2,
    produtora: { nome: 'Produtora', instagram: '@produtora' },
    mensagens: { sem_eventos: 'Sem eventos {{instagram}}' },
    ia: { ativa: true, ...iaRaiz },
    eventos: [{ id: 'festa', status: 'ativo', gatilhos: [], evento: { nome: 'Festa', local: 'Praça' }, mensagens: { menu: '1 - Local' }, opcoes: base().opcoes, ...(iaEvento ? { ia: iaEvento } : {}) }],
  };
}

const erros = (cfg) => validarConfig(cfg).erros;

// ---------- validação ----------

test('validação: campos novos válidos não geram erro', () => {
  const ia = {
    conversa_natural: true, persona: 'Fale como um promoter.', max_mensagens: 3, memoria_mensagens: 0,
    audio: { ativo: true, max_segundos: 120, modelo: 'whisper-large-v3-turbo' },
    travas: { limite_ataque: 0.5, termos_proibidos: ['termo'] },
  };
  assert.deepEqual(erros(comIA(ia)), []);
  assert.deepEqual(erros(v2(ia, { conversa_natural: false })), []);
});

test('validação: tipos e faixas da conversa natural, em pt-BR', () => {
  const casos = [
    [{ conversa_natural: 'sim' }, 'ia.conversa_natural'],
    [{ persona: 5 }, 'ia.persona'],
    [{ persona: 'x'.repeat(1501) }, 'ia.persona'],
    [{ max_mensagens: 0 }, 'ia.max_mensagens'],
    [{ max_mensagens: 5 }, 'ia.max_mensagens'],
    [{ max_mensagens: 2.5 }, 'ia.max_mensagens'],
    [{ memoria_mensagens: -1 }, 'ia.memoria_mensagens'],
    [{ memoria_mensagens: 21 }, 'ia.memoria_mensagens'],
    [{ memoria_mensagens: '6' }, 'ia.memoria_mensagens'],
    [{ audio: 'sim' }, 'ia.audio precisa'],
    [{ audio: { ativo: 'sim' } }, 'ia.audio.ativo'],
    [{ audio: { max_segundos: 9 } }, 'ia.audio.max_segundos'],
    [{ audio: { max_segundos: 601 } }, 'ia.audio.max_segundos'],
    [{ audio: { modelo: ' ' } }, 'ia.audio.modelo'],
    [{ travas: [] }, 'ia.travas precisa'],
    [{ travas: { limite_ataque: 0.05 } }, 'ia.travas.limite_ataque'],
    [{ travas: { limite_ataque: 1 } }, 'ia.travas.limite_ataque'],
    [{ travas: { limite_ataque: '0.5' } }, 'ia.travas.limite_ataque'],
    [{ travas: { termos_proibidos: 'a' } }, 'ia.travas.termos_proibidos'],
    [{ travas: { termos_proibidos: ['a', ''] } }, 'ia.travas.termos_proibidos'],
    [{ travas: { termos_proibidos: Array.from({ length: 201 }, (_, i) => 't' + i) } }, 'ia.travas.termos_proibidos'],
  ];
  for (const [ia, trecho] of casos) {
    assert.ok(erros(comIA(ia)).some((e) => e.includes(trecho)), JSON.stringify(ia).slice(0, 60));
  }
  assert.deepEqual(erros(comIA({ persona: 'x'.repeat(1500), max_mensagens: 4, memoria_mensagens: 20, audio: { max_segundos: 10 }, travas: { limite_ataque: 0.99 } })), []);
});

test('validação: mensagens.fora_do_assunto', () => {
  const cfg = comIA();
  cfg.mensagens.fora_do_assunto = 'Só ajudo com o evento. Digite *menu*.';
  assert.deepEqual(erros(cfg), []);
  cfg.mensagens.fora_do_assunto = '  ';
  assert.ok(erros(cfg).some((e) => e.includes('mensagens.fora_do_assunto')));
  cfg.mensagens.fora_do_assunto = 'Veja {{inexistente}}';
  assert.ok(erros(cfg).some((e) => e.includes('inexistente')));
  const dois = v2();
  dois.mensagens.fora_do_assunto = '';
  assert.equal(erros(dois).filter((e) => e.includes('fora_do_assunto')).length, 1, 'a raiz é conferida uma vez só');
});

test('validação v2: conversa natural por evento só aceita true ou false', () => {
  assert.deepEqual(erros(v2({ conversa_natural: true }, { conversa_natural: false })), []);
  const ruim = erros(v2({}, { conversa_natural: 'ligada' }));
  assert.ok(ruim.some((e) => e.includes('festa') && e.includes('ia.conversa_natural')), ruim.join('|'));
  // Campos da raiz inválidos aparecem uma vez só (não se repetem por evento).
  const raiz = erros(v2({ max_mensagens: 9 }, { conhecimento: 'extra' }));
  assert.equal(raiz.filter((e) => e.includes('ia.max_mensagens')).length, 1);
});

test('exemplo versionado valida sem erros e traz os campos novos', () => {
  const exemplo = JSON.parse(fsSync.readFileSync(path.join(__dirname, '..', 'config', 'chatbot.exemplo.json'), 'utf8'));
  assert.deepEqual(erros(exemplo), []);
  assert.equal(exemplo.ia.conversa_natural, false);
  assert.ok(exemplo.ia.persona.length > 100 && exemplo.ia.persona.length <= 1500);
  assert.equal(exemplo.ia.max_mensagens, 3);
  assert.equal(exemplo.ia.memoria_mensagens, 6);
  assert.equal(exemplo.ia.audio.ativo, true);
  assert.equal(exemplo.ia.travas.limite_ataque, 0.5);
  assert.deepEqual(exemplo.ia.travas.termos_proibidos, []);
  assert.match(exemplo.mensagens.fora_do_assunto, /menu/);
});

// ---------- simulador ----------

function requisicao(url, rota, corpo) {
  return new Promise((resolve, reject) => {
    const raw = JSON.stringify(corpo);
    const req = http.request(url + rota, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw) } }, (res) => {
      let texto = '';
      res.setEncoding('utf8');
      res.on('data', (p) => { texto += p; });
      res.on('end', () => { let dados; try { dados = JSON.parse(texto); } catch { /* corpo não JSON */ } resolve({ status: res.statusCode, dados }); });
    });
    req.on('error', reject);
    req.end(raw);
  });
}

async function subir(t, { status = 200, conteudo = 'Fica na Praça, bora!' } = {}) {
  const pasta = await fs.mkdtemp(path.join(os.tmpdir(), 'chatbot-natural-'));
  const configPath = path.join(pasta, 'chatbot.json');
  await fs.writeFile(configPath, JSON.stringify(base(), null, 2));
  const pedidos = [];
  const fetchIA = async (url, opcoes) => {
    const corpo = JSON.parse(opcoes.body);
    // Classificador de ataque (Prompt Guard): responde nota baixa e não entra na lista de pedidos da IA.
    if (corpo.model === 'meta-llama/llama-prompt-guard-2-86m') {
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '0.0004' }, finish_reason: 'stop' }] }) };
    }
    pedidos.push({ url, corpo });
    return { ok: status === 200, status, json: async () => ({ choices: [{ message: { content: conteudo }, finish_reason: 'stop' }] }) };
  };
  const server = criarServidor({ configPath, chaveIA: 'gsk_chave_ficticia_de_teste', fetchIA });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); await fs.rm(pasta, { recursive: true, force: true }); });
  return { url: 'http://127.0.0.1:' + server.address().port, pedidos };
}
const simular = (url, corpo) => requisicao(url, '/api/simular', { estado: {}, usosIA: 0, ...corpo });

test('simulador: atalho continua pronto e sem IA mesmo com a conversa natural ligada', async (t) => {
  const { url, pedidos } = await subir(t);
  const r = await simular(url, { config: comIA({ conversa_natural: true }), texto: '1', conversaNatural: true });
  assert.equal(r.status, 200);
  assert.equal(r.dados.intencao, 'local');
  assert.equal(r.dados.resposta, 'Estamos na Praça.');
  assert.equal(pedidos.length, 0);
});

test('simulador: texto livre reconhecido é redigido pela IA; sem o toggle fica como hoje', async (t) => {
  const { url, pedidos } = await subir(t);
  const natural = await simular(url, { config: comIA({ conversa_natural: true }), texto: 'onde acontece o festival?', conversaNatural: true });
  assert.equal(natural.status, 200);
  assert.equal(natural.dados.origem, 'ia_redigida');
  assert.equal(natural.dados.intencao, 'local');
  assert.match(natural.dados.resposta, /bora/);
  assert.ok(natural.dados.resposta.length > 0);
  assert.equal(natural.dados.ia.resultado, 'respondeu');
  assert.equal(pedidos.length, 1);
  const antes = pedidos.length;
  const pronta = await simular(url, { config: comIA({ conversa_natural: false }), texto: 'onde acontece o festival?', conversaNatural: false });
  assert.equal(pronta.dados.resposta, 'Estamos na Praça.');
  assert.equal(pedidos.length, antes, 'sem conversa natural o texto reconhecido não chama a IA');
});

test('simulador: chave por evento é respeitada quando o toggle não é enviado', async (t) => {
  const { url, pedidos } = await subir(t);
  const liga = await simular(url, { config: v2({ conversa_natural: false }, { conversa_natural: true }), texto: 'onde acontece o festival?', eventoId: 'festa' });
  assert.equal(liga.dados.origem, 'ia_redigida', JSON.stringify(liga.dados));
  assert.equal(pedidos.length, 1);
  const desliga = await simular(url, { config: v2({ conversa_natural: true }, { conversa_natural: false }), texto: 'onde acontece o festival?', eventoId: 'festa' });
  assert.equal(desliga.dados.resposta, 'Estamos na Praça.');
  assert.equal(pedidos.length, 1);
});

test('simulador: falha da IA no modo redigir cai na resposta pronta e avisa', async (t) => {
  const { url } = await subir(t, { status: 500 });
  const r = await simular(url, { config: comIA({ conversa_natural: true }), texto: 'onde acontece o festival?', conversaNatural: true });
  assert.equal(r.status, 200);
  assert.equal(r.dados.resposta, 'Estamos na Praça.');
  assert.equal(r.dados.ia.reservaPronta, true);
  assert.notEqual(r.dados.ia.resultado, 'respondeu');
});

test('simulador: texto não reconhecido usa a IA (modo responder) com histórico', async (t) => {
  const { url, pedidos } = await subir(t, { conteudo: 'A feira abre às 10h.' });
  const historico = [{ de: 'contato', texto: 'oi' }, { de: 'bot', texto: 'Salve!' }];
  const r = await simular(url, { config: comIA({ conversa_natural: true }), texto: 'a feira abre que horas?', conversaNatural: true, historico });
  assert.equal(r.status, 200);
  assert.equal(r.dados.intencao, 'ia');
  assert.equal(r.dados.origem, 'ia');
  assert.ok(Array.isArray(r.dados.partes) && r.dados.partes.length >= 1);
  assert.equal(pedidos.length, 1);
});

test('simulador: valida os campos novos do corpo', async (t) => {
  const { url } = await subir(t);
  for (const extra of [{ conversaNatural: 'sim' }, { historico: 'x' }, { historico: Array.from({ length: 41 }, () => ({ de: 'bot', texto: 'a' })) }, { nomeContato: 5 }]) {
    const r = await simular(url, { config: comIA(), texto: '1', ...extra });
    assert.equal(r.status, 400, JSON.stringify(extra).slice(0, 40));
  }
});

// ---------- métricas ----------

test('métricas: porOrigem separa ia_redigida; reserva pronta e travas vêm de extra', async () => {
  const sqls = [];
  const consultar = async (sql) => {
    sqls.push(sql);
    if (sql.includes("THEN 'ia_redigida'")) return { rows: [{ origem: 'ia_redigida', total: '4' }, { origem: 'ia', total: '2' }, { origem: 'menu_regras', total: '9' }, { origem: 'fallback', total: '1' }, { origem: 'atendimento_humano', total: '1' }] };
    if (sql.includes("extra->>'ia_reserva_pronta'")) return { rows: [{ total: '3' }] };
    if (sql.includes("extra->>'trava'")) return { rows: [{ tipo: 'entrada', total: '5' }, { tipo: 'classificador', total: '2' }] };
    return { rows: [] };
  };
  const m = await calcularMetricas(consultar, { inicio: new Date(0), fim: new Date(), fuso: 'America/Sao_Paulo' });
  assert.deepEqual(m.porOrigem.map((o) => o.origem), ['ia_redigida', 'ia', 'menu_regras', 'fallback', 'atendimento_humano']);
  assert.equal(m.porOrigem[0].total, 4);
  assert.equal(m.ia.reservaPronta, 3);
  assert.deepEqual(m.ia.travas, { total: 7, porTipo: [{ tipo: 'entrada', total: 5 }, { tipo: 'classificador', total: 2 }] });
  assert.ok(sqls.every((sql) => !sql.includes('$4')), 'só parâmetros do período');
});

test('métricas: sem dados, os contadores novos são zero', async () => {
  const m = await calcularMetricas(async () => ({ rows: [] }), { inicio: new Date(0), fim: new Date(), fuso: 'UTC' });
  assert.equal(m.ia.reservaPronta, 0);
  assert.deepEqual(m.ia.travas, { total: 0, porTipo: [] });
});
