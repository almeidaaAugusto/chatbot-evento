'use strict';

// Gera o hash de uma senha do painel a partir do STDIN, sem nunca receber a senha por argumento.
// Uso: node painel/senha.js < arquivo-com-a-senha
//      node painel/senha.js   (em terminal: pede a senha e lê uma linha)
// Saída: somente o hash, em uma linha, no stdout. A senha nunca é impressa.

const { gerarHash, MINIMO_SENHA } = require('./autenticacao');

// Mesmo limite que o verificador usa (autenticacao.js); senão o hash gerado nunca validaria.
const MAXIMO_SENHA = 200;

// Remove apenas a quebra de linha final; espaços internos e nas pontas fazem parte da senha.
function tirarQuebraFinal(texto) {
  return texto.replace(/\r?\n$/, '');
}

// Devolve a mensagem de erro para uma senha inválida, ou null se ela serve.
function problemaDaSenha(senha) {
  if (senha.length < MINIMO_SENHA) return 'A senha precisa ter no mínimo ' + MINIMO_SENHA + ' caracteres.';
  if (senha.length > MAXIMO_SENHA) return 'A senha precisa ter no máximo ' + MAXIMO_SENHA + ' caracteres.';
  return null;
}

// Gera o hash de uma senha já tirada da entrada. Lança erro se ela for inválida.
function gerar(senha) {
  const problema = problemaDaSenha(senha);
  if (problema) throw new Error(problema);
  return gerarHash(senha);
}

function lerTudo(entrada) {
  return new Promise((resolve, reject) => {
    let dados = '';
    entrada.setEncoding('utf8');
    entrada.on('data', (pedaco) => { dados += pedaco; });
    entrada.on('end', () => resolve(dados));
    entrada.on('error', reject);
  });
}

// Em terminal: lê até a primeira quebra de linha (ou o fim, se o terminal fechar).
function lerLinha(entrada) {
  return new Promise((resolve, reject) => {
    let dados = '';
    entrada.setEncoding('utf8');
    const aoDados = (pedaco) => {
      dados += pedaco;
      const fim = dados.indexOf('\n');
      if (fim !== -1) {
        limpar();
        resolve(dados.slice(0, fim + 1));
      }
    };
    const aoFim = () => { limpar(); resolve(dados); };
    const aoErro = (erro) => { limpar(); reject(erro); };
    function limpar() {
      entrada.removeListener('data', aoDados);
      entrada.removeListener('end', aoFim);
      entrada.removeListener('error', aoErro);
      entrada.pause();
    }
    entrada.on('data', aoDados);
    entrada.on('end', aoFim);
    entrada.on('error', aoErro);
  });
}

// Lê a senha, valida e escreve o hash. Devolve o código de saída (0 ou 1).
async function executar({ entrada = process.stdin, saida = process.stdout, erros = process.stderr } = {}) {
  if (entrada.isTTY) erros.write('Digite a senha e pressione Enter:\n');
  const texto = await (entrada.isTTY ? lerLinha(entrada) : lerTudo(entrada));
  const senha = tirarQuebraFinal(texto.replace(/^﻿/, ''));
  const problema = problemaDaSenha(senha);
  if (problema) {
    erros.write(problema + '\n');
    return 1;
  }
  saida.write(gerarHash(senha) + '\n');
  return 0;
}

if (require.main === module) {
  executar().then(
    (codigo) => { process.exitCode = codigo; },
    () => {
      process.stderr.write('Não foi possível ler a senha.\n');
      process.exitCode = 1;
    },
  );
}

module.exports = { executar, gerar, tirarQuebraFinal, problemaDaSenha, MAXIMO_SENHA };
