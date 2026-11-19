'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { criarConexao } = require('../painel/db/conexao.js');
const { aplicarMigracoes, PASTA_PADRAO } = require('../painel/db/migrar.js');

const URL_FALSA = 'postgres://x';
const SQL_LOCK = 'SELECT pg_advisory_xact_lock($1)';
const SQL_CRIAR_CONTROLE = 'CREATE TABLE IF NOT EXISTS migracoes_aplicadas';
const SQL_LER_APLICADAS = 'SELECT nome FROM migracoes_aplicadas';
const SQL_REGISTRAR = 'INSERT INTO migracoes_aplicadas (nome) VALUES ($1)';

const pastasCriadas = [];

after(async () => {
  for (const pasta of pastasCriadas) await fs.rm(pasta, { recursive: true, force: true });
});

function erroComCodigo(codigo, mensagem = 'erro de teste') {
  const erro = new Error(mensagem);
  erro.code = codigo;
  return erro;
}

// Pool falso: query/connect/on/end sem rede.
function criarPoolFalso() {
  const pool = {
    consultas: [],
    clientes: [],
    ouvintes: {},
    encerrado: 0,
    falhaQuery: null,
    falhaConexao: null,
    async query(sql, parametros = []) {
      pool.consultas.push({ sql, parametros });
      if (pool.falhaQuery) throw pool.falhaQuery;
      return { rows: [], rowCount: 0 };
    },
    async connect() {
      if (pool.falhaConexao) throw pool.falhaConexao;
      const cliente = {
        consultas: [],
        liberacoes: [],
        async query(sql) { cliente.consultas.push(sql); return { rows: [] }; },
        release(...argumentos) { cliente.liberacoes.push(argumentos); }
      };
      pool.clientes.push(cliente);
      return cliente;
    },
    on(evento, funcao) { pool.ouvintes[evento] = funcao; },
    async end() { pool.encerrado++; }
  };
  return pool;
}

// Conexão de transação falsa: registra os SQL e responde a lista de aplicadas e, opcionalmente, falha em um SQL.
function conexaoDeTransacaoFalsa({ aplicadasAntes = [], falharEm = null } = {}) {
  const tx = {
    consultas: [],
    async consultar(sql, parametros) {
      tx.consultas.push({ sql, parametros });
      if (sql === falharEm) throw new Error('erro simulado na migração');
      if (sql === SQL_LER_APLICADAS) return { rows: aplicadasAntes.map((nome) => ({ nome })) };
      return { rows: [] };
    }
  };
  return { tx, conexao: { transacao: async (tarefa) => tarefa(tx) } };
}

async function criarPastaTemporaria() {
  const pasta = await fs.mkdtemp(path.join(os.tmpdir(), 'conexao-teste-'));
  pastasCriadas.push(pasta);
  return pasta;
}

// Leva a conexão a "disponível" (uma consulta bem-sucedida) e depois faz a consulta falhar com o erro dado.
async function quedaVira503(erroDoPool) {
  const pool = criarPoolFalso();
  const mudancas = [];
  const conexao = criarConexao({ url: URL_FALSA, criarPool: () => pool, aoMudar: (valor) => mudancas.push(valor) });
  await conexao.consultar('SELECT 1');
  pool.falhaQuery = erroDoPool;

  await assert.rejects(() => conexao.consultar('SELECT 2'), (erro) => erro.status === 503 && erro.bancoIndisponivel === true);
  assert.equal(conexao.disponivel(), false);
  assert.deepEqual(mudancas, [true, false]);
}

test('sem URL, consultar lança erro 503 de banco indisponível e disponivel() é false', async () => {
  const conexao = criarConexao({});

  assert.equal(conexao.configurado, false);
  await assert.rejects(() => conexao.consultar('SELECT 1'), (erro) => erro.status === 503 && erro.bancoIndisponivel === true);
  assert.equal(conexao.disponivel(), false);
});

test('consulta bem-sucedida marca disponível e avisa uma única vez', async () => {
  const pool = criarPoolFalso();
  const mudancas = [];
  const conexao = criarConexao({ url: URL_FALSA, criarPool: () => pool, aoMudar: (valor) => mudancas.push(valor) });

  const resultado = await conexao.consultar('SELECT 1', [7]);
  await conexao.consultar('SELECT 2');

  assert.deepEqual(resultado, { rows: [], rowCount: 0 });
  assert.equal(conexao.disponivel(), true);
  assert.deepEqual(mudancas, [true]);
  assert.deepEqual(pool.consultas, [{ sql: 'SELECT 1', parametros: [7] }, { sql: 'SELECT 2', parametros: [] }]);
});

test('erro ECONNREFUSED vira 503 de banco indisponível e marca indisponível', async () => {
  await quedaVira503(erroComCodigo('ECONNREFUSED'));
});

test('erro com mensagem "Connection terminated unexpectedly" vira 503 de banco indisponível', async () => {
  await quedaVira503(new Error('Connection terminated unexpectedly'));
});

test('AggregateError com erro ECONNREFUSED interno vira 503 de banco indisponível', async () => {
  await quedaVira503(new AggregateError([{ code: 'ECONNREFUSED' }], 'falhas de conexão'));
});

test('erro de SQL comum (23505) não vira indisponibilidade e é relançado como está', async () => {
  const pool = criarPoolFalso();
  const mudancas = [];
  const conexao = criarConexao({ url: URL_FALSA, criarPool: () => pool, aoMudar: (valor) => mudancas.push(valor) });
  await conexao.consultar('SELECT 1');

  const erro = erroComCodigo('23505', 'duplicate key value violates unique constraint');
  pool.falhaQuery = erro;

  await assert.rejects(() => conexao.consultar('INSERT INTO t VALUES (1)'), (relancado) => {
    assert.equal(relancado, erro);
    assert.equal(relancado.bancoIndisponivel, undefined);
    assert.equal(relancado.status, undefined);
    return true;
  });
  assert.equal(conexao.disponivel(), true);
  assert.deepEqual(mudancas, [true]);
});

test('ouvinte pool.on("error") é registrado e, ao disparar, marca indisponível', async () => {
  const pool = criarPoolFalso();
  const mudancas = [];
  const conexao = criarConexao({ url: URL_FALSA, criarPool: () => pool, aoMudar: (valor) => mudancas.push(valor) });
  await conexao.consultar('SELECT 1');

  assert.equal(typeof pool.ouvintes.error, 'function');
  pool.ouvintes.error(new Error('servidor reiniciou'));

  assert.equal(conexao.disponivel(), false);
  assert.deepEqual(mudancas, [true, false]);
});

test('transacao com sucesso executa BEGIN, a tarefa e COMMIT na ordem', async () => {
  const pool = criarPoolFalso();
  const conexao = criarConexao({ url: URL_FALSA, criarPool: () => pool });

  const resultado = await conexao.transacao(async ({ consultar }) => {
    await consultar('INSERT INTO t VALUES ($1)', [1]);
    return 'feito';
  });

  assert.equal(resultado, 'feito');
  const [cliente] = pool.clientes;
  assert.deepEqual(cliente.consultas, ['BEGIN', 'INSERT INTO t VALUES ($1)', 'COMMIT']);
  assert.equal(cliente.liberacoes.length, 1);
});

test('erro dentro da tarefa executa ROLLBACK e relança o erro', async () => {
  const pool = criarPoolFalso();
  const conexao = criarConexao({ url: URL_FALSA, criarPool: () => pool });

  await assert.rejects(
    () => conexao.transacao(async ({ consultar }) => {
      await consultar('UPDATE t SET x = 1');
      throw new Error('falha na tarefa');
    }),
    { message: 'falha na tarefa' }
  );

  const [cliente] = pool.clientes;
  assert.deepEqual(cliente.consultas, ['BEGIN', 'UPDATE t SET x = 1', 'ROLLBACK']);
  assert.equal(cliente.liberacoes.length, 1);
});

test('connect() falhando por rede numa transação vira 503', async () => {
  const pool = criarPoolFalso();
  pool.falhaConexao = erroComCodigo('ECONNREFUSED');
  const conexao = criarConexao({ url: URL_FALSA, criarPool: () => pool });

  await assert.rejects(
    () => conexao.transacao(async () => 'nunca'),
    (erro) => erro.status === 503 && erro.bancoIndisponivel === true
  );
  assert.equal(conexao.disponivel(), false);
});

test('verificar() detecta a queda e, quando o pool volta, passa a disponível; parar() encerra o pool', async () => {
  const pool = criarPoolFalso();
  pool.falhaQuery = erroComCodigo('ECONNREFUSED');
  const conexao = criarConexao({ url: URL_FALSA, criarPool: () => pool, intervaloMs: 60_000 });

  await conexao.iniciar();
  assert.equal(conexao.disponivel(), false);

  pool.falhaQuery = null;
  assert.equal(await conexao.verificar(), true);
  assert.equal(conexao.disponivel(), true);

  await conexao.parar();
  assert.equal(pool.encerrado, 1);
  assert.equal(conexao.disponivel(), false);
});

test('aplicarMigracoes: primeiro SQL é o bloqueio consultivo, depois a tabela de controle e a leitura', async () => {
  const { tx, conexao } = conexaoDeTransacaoFalsa();

  await aplicarMigracoes(conexao);

  assert.deepEqual(tx.consultas[0], { sql: SQL_LOCK, parametros: [7421001] });
  assert.ok(tx.consultas[1].sql.startsWith(SQL_CRIAR_CONTROLE));
  assert.equal(tx.consultas[2].sql, SQL_LER_APLICADAS);
});

test('aplicarMigracoes com lista vazia aplica 001_inicial.sql e registra o nome com parâmetro', async () => {
  const { tx, conexao } = conexaoDeTransacaoFalsa();
  const sqlArquivo = await fs.readFile(path.join(PASTA_PADRAO, '001_inicial.sql'), 'utf8');

  const aplicadas = await aplicarMigracoes(conexao);

  assert.deepEqual(aplicadas, ['001_inicial.sql']);
  assert.equal(tx.consultas[3].sql, sqlArquivo);
  assert.deepEqual(tx.consultas[4], { sql: SQL_REGISTRAR, parametros: ['001_inicial.sql'] });
  assert.equal(tx.consultas.length, 5);
});

test('aplicarMigracoes com 001_inicial.sql já aplicada não executa nada e devolve []', async () => {
  const { tx, conexao } = conexaoDeTransacaoFalsa({ aplicadasAntes: ['001_inicial.sql'] });

  assert.deepEqual(await aplicarMigracoes(conexao), []);
  assert.equal(tx.consultas[0].sql, SQL_LOCK);
  assert.equal(tx.consultas[2].sql, SQL_LER_APLICADAS);
  assert.equal(tx.consultas.length, 3);
});

test('aplicarMigracoes aplica em ordem numérica e ignora arquivos com nomes fora do padrão', async () => {
  const pasta = await criarPastaTemporaria();
  await fs.writeFile(path.join(pasta, '002_b.sql'), 'CREATE TABLE b ();');
  await fs.writeFile(path.join(pasta, '001_a.sql'), 'CREATE TABLE a ();');
  await fs.writeFile(path.join(pasta, 'leia.txt'), 'não é migração');
  await fs.writeFile(path.join(pasta, '2_x.sql'), 'SELECT 1;');
  const { tx, conexao } = conexaoDeTransacaoFalsa();

  assert.deepEqual(await aplicarMigracoes(conexao, pasta), ['001_a.sql', '002_b.sql']);

  assert.deepEqual(tx.consultas.map((consulta) => consulta.sql), [
    SQL_LOCK,
    tx.consultas[1].sql,
    SQL_LER_APLICADAS,
    'CREATE TABLE a ();',
    SQL_REGISTRAR,
    'CREATE TABLE b ();',
    SQL_REGISTRAR
  ]);
  assert.deepEqual(tx.consultas[4].parametros, ['001_a.sql']);
  assert.deepEqual(tx.consultas[6].parametros, ['002_b.sql']);
});

test('se a segunda migração falhar, o erro propaga e a última não é registrada', async () => {
  const pasta = await criarPastaTemporaria();
  await fs.writeFile(path.join(pasta, '001_a.sql'), 'CREATE TABLE a ();');
  await fs.writeFile(path.join(pasta, '002_b.sql'), 'QUEBRADA;');
  const { tx, conexao } = conexaoDeTransacaoFalsa({ falharEm: 'QUEBRADA;' });

  await assert.rejects(() => aplicarMigracoes(conexao, pasta), { message: 'erro simulado na migração' });

  assert.ok(!tx.consultas.some((consulta) => consulta.parametros && consulta.parametros[0] === '002_b.sql'));
});
