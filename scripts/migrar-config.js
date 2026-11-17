'use strict';
// Converte config/chatbot.json do formato v1 (um evento) para o v2 (vários eventos).
// Uso: node scripts/migrar-config.js <arquivo> [--id slug] [--status ativo|rascunho|encerrado]
//                                    [--gatilhos "termo 1,termo 2"] [--produtora "Nome"]
// O original é guardado em <arquivo>.v1.bak. Nada é gravado se o resultado tiver erros.

const fs = require('node:fs');
const { migrarParaV2, ehMultiEvento } = require('../lib/eventos.js');
const { validarConfig } = require('../lib/configuracao.js');

function slug(texto) {
  return String(texto ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'evento';
}

function main(argumentos = process.argv.slice(2)) {
  const opcoes = {};
  let caminho = '';
  for (let i = 0; i < argumentos.length; i += 1) {
    if (argumentos[i].startsWith('--')) opcoes[argumentos[i].slice(2)] = argumentos[++i];
    else caminho = argumentos[i];
  }
  if (!caminho) {
    console.log('Uso: node scripts/migrar-config.js <arquivo> [--id slug] [--status ativo|rascunho|encerrado] [--gatilhos "a,b"] [--produtora "Nome"]');
    return 1;
  }
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(caminho, 'utf8').replace(/^﻿/, ''));
  } catch {
    console.log('ERRO: não foi possível ler um JSON válido em ' + caminho);
    return 1;
  }
  if (ehMultiEvento(cfg)) {
    console.log('O arquivo já está no formato de vários eventos. Nada a fazer.');
    return 0;
  }
  const id = opcoes.id || slug(cfg.evento?.nome);
  const gatilhos = String(opcoes.gatilhos ?? '').split(',').map((g) => g.trim()).filter(Boolean);
  const novo = migrarParaV2(cfg, { id, status: opcoes.status || 'ativo', gatilhos, produtora: opcoes.produtora });
  const { erros, avisos } = validarConfig(novo);
  for (const aviso of avisos) console.log('AVISO: ' + aviso);
  for (const erro of erros) console.log('ERRO:  ' + erro);
  if (erros.length) {
    console.log('\nA conversão gerou erros: o arquivo não foi alterado.');
    return 1;
  }
  fs.writeFileSync(caminho + '.v1.bak', fs.readFileSync(caminho));
  fs.writeFileSync(caminho, JSON.stringify(novo, null, 2) + '\n');
  console.log('\nConvertido para o formato de vários eventos (evento "' + id + '"). Original em ' + caminho + '.v1.bak');
  return 0;
}

if (require.main === module) process.exitCode = main();
module.exports = { main, slug };
