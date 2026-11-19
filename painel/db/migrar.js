'use strict';

// Aplica painel/db/migracoes/NNN_nome.sql em ordem, uma única vez cada, dentro de uma transação.
// O pg_advisory_xact_lock impede duas execuções em paralelo (dois painéis subindo juntos) e é
// solto sozinho no fim da transação. Se qualquer migração falhar, nenhuma é aplicada.

const fs = require('node:fs/promises');
const path = require('node:path');

const CHAVE_BLOQUEIO = 7421001;
const PADRAO = /^(\d{3})_[a-z0-9_]+\.sql$/;
const PASTA_PADRAO = path.join(__dirname, 'migracoes');

async function listarMigracoes(pasta = PASTA_PADRAO) {
  const nomes = await fs.readdir(pasta);
  return nomes.filter((nome) => PADRAO.test(nome)).sort();
}

// Devolve os nomes das migrações aplicadas agora.
async function aplicarMigracoes(conexao, pasta = PASTA_PADRAO) {
  const nomes = await listarMigracoes(pasta);
  const arquivos = new Map();
  for (const nome of nomes) arquivos.set(nome, await fs.readFile(path.join(pasta, nome), 'utf8'));
  return conexao.transacao(async (tx) => {
    await tx.consultar('SELECT pg_advisory_xact_lock($1)', [CHAVE_BLOQUEIO]);
    await tx.consultar('CREATE TABLE IF NOT EXISTS migracoes_aplicadas (nome text PRIMARY KEY, aplicada_em timestamptz NOT NULL DEFAULT now())');
    const { rows } = await tx.consultar('SELECT nome FROM migracoes_aplicadas');
    const feitas = new Set(rows.map((linha) => linha.nome));
    const aplicadas = [];
    for (const nome of nomes) {
      if (feitas.has(nome)) continue;
      await tx.consultar(arquivos.get(nome));
      await tx.consultar('INSERT INTO migracoes_aplicadas (nome) VALUES ($1)', [nome]);
      aplicadas.push(nome);
    }
    return aplicadas;
  });
}

module.exports = { aplicarMigracoes, listarMigracoes, PASTA_PADRAO, CHAVE_BLOQUEIO };
