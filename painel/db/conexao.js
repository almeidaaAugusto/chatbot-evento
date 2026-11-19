'use strict';

// Conexão com o Postgres. O painel sobe e funciona sem banco: o pool é criado sob demanda,
// um monitor testa a conexão de tempos em tempos e avisa quando ela cai ou volta.
// Falhas de conexão viram ErroBanco (HTTP 503); erros de SQL seguem como estão.

const CODIGOS_DE_REDE = new Set(['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'EPIPE', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH']);

function erroBanco() {
  const erro = new Error('O banco de dados está indisponível no momento.');
  erro.status = 503;
  erro.bancoIndisponivel = true;
  erro.detalhes = { bancoIndisponivel: true };
  return erro;
}

// Reconhece falhas de conexão (rede, servidor reiniciando, pool esgotado) entre os erros do pg.
function ehErroDeConexao(erro) {
  if (!erro) return false;
  if (erro.bancoIndisponivel) return true;
  const codigo = String(erro.code || '');
  if (CODIGOS_DE_REDE.has(codigo) || codigo.startsWith('08') || codigo.startsWith('57P') || codigo === '53300') return true;
  if (Array.isArray(erro.errors) && erro.errors.some(ehErroDeConexao)) return true;
  return /connection terminated|timeout exceeded when trying to connect|connection error|connect ECONN|Client has encountered/i.test(String(erro.message || ''));
}

function criarConexao({ url, criarPool, intervaloMs = 5000, aoMudar = () => {} } = {}) {
  let pool = null;
  let ok = false;
  let monitor = null;
  let verificando = false;

  const marcar = (valor) => {
    if (ok === valor) return;
    ok = valor;
    try { aoMudar(valor); } catch { /* o aviso não pode derrubar a conexão */ }
  };

  function obterPool() {
    if (!url) throw erroBanco();
    if (!pool) {
      if (criarPool) pool = criarPool(url);
      else {
        const { Pool } = require('pg');
        pool = new Pool({ connectionString: url, max: 5, connectionTimeoutMillis: 3000, idleTimeoutMillis: 30000 });
      }
      // Erro em conexão ociosa (servidor reiniciou): sem este ouvinte o processo cairia.
      pool.on('error', () => marcar(false));
    }
    return pool;
  }

  async function consultar(sql, parametros = []) {
    try {
      const resultado = await obterPool().query(sql, parametros);
      marcar(true);
      return resultado;
    } catch (erro) {
      if (ehErroDeConexao(erro)) { marcar(false); throw erroBanco(); }
      throw erro;
    }
  }

  // Executa "tarefa" numa transação. A tarefa recebe { consultar } preso a uma única conexão.
  async function transacao(tarefa) {
    let cliente;
    try { cliente = await obterPool().connect(); }
    catch (erro) {
      if (ehErroDeConexao(erro)) { marcar(false); throw erroBanco(); }
      throw erro;
    }
    let destruir = false;
    try {
      await cliente.query('BEGIN');
      const resultado = await tarefa({ consultar: (sql, parametros = []) => cliente.query(sql, parametros) });
      await cliente.query('COMMIT');
      return resultado;
    } catch (erro) {
      try { await cliente.query('ROLLBACK'); } catch { destruir = true; }
      if (ehErroDeConexao(erro)) { marcar(false); destruir = true; throw erroBanco(); }
      throw erro;
    } finally {
      cliente.release(destruir || undefined);
    }
  }

  async function verificar() {
    if (!url || verificando) return ok;
    verificando = true;
    try { await obterPool().query('SELECT 1'); marcar(true); }
    catch { marcar(false); }
    finally { verificando = false; }
    return ok;
  }

  function iniciar() {
    if (!url || monitor) return verificar();
    monitor = setInterval(verificar, intervaloMs);
    monitor.unref();
    return verificar();
  }

  async function parar() {
    if (monitor) clearInterval(monitor);
    monitor = null;
    const atual = pool;
    pool = null;
    ok = false;
    if (atual) await atual.end().catch(() => {});
  }

  return { configurado: Boolean(url), disponivel: () => ok, consultar, transacao, verificar, iniciar, parar };
}

module.exports = { criarConexao, erroBanco, ehErroDeConexao };
