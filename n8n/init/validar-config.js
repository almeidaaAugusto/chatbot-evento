'use strict';

const fs = require('node:fs');
const { validarConfig } = require(process.env.CHATBOT_CONFIG_LIB || '../../lib/configuracao.js');

function main(caminho = process.argv[2] || '/files/config/chatbot.json') {
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(caminho, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    console.log('ERRO: não foi possível ler um JSON válido no arquivo de configuração.');
    console.log('Dica: confira o caminho, vírgulas e aspas. Quebras de linha dentro de textos são escritas como \\n.');
    return 1;
  }
  const { erros, avisos } = validarConfig(cfg);
  for (const aviso of avisos) console.log('AVISO: ' + aviso);
  for (const erro of erros) console.log('ERRO:  ' + erro);
  console.log('');
  if (erros.length) {
    console.log('Configuração com ' + erros.length + ' erro(s). Corrija antes de usar: enquanto houver erro o chatbot pode ficar sem responder.');
    return 1;
  }
  const resumo = Array.isArray(cfg.eventos)
    ? cfg.eventos.length + ' evento(s), ' + cfg.eventos.filter((ev) => ev && ev.status === 'ativo').length + ' ativo(s)'
    : cfg.opcoes.length + ' opções';
  console.log('Configuração válida: ' + resumo + (avisos.length ? ', ' + avisos.length + ' aviso(s).' : '.'));
  return 0;
}

if (require.main === module) process.exitCode = main();
module.exports = { main, validarConfig };