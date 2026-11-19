'use strict';

// Administração de usuários pela linha de comando, rodada DENTRO do contêiner do painel.
// A senha ou o hash entram sempre pela entrada padrão (nunca por argumento de linha de comando).
//   node painel/usuario.js definir-hash NOME   < arquivo-com-o-hash   (hash gerado por painel/senha.js)
//   node painel/usuario.js definir-senha NOME  < arquivo-com-a-senha
// Códigos de saída: 0 atualizado; 1 entrada inválida; 2 banco indisponível; 3 usuário não existe no banco
// (nada a fazer: vale só o .env). Atualizar a senha encerra as sessões do usuário.

const { lerHash, gerarHash, MINIMO_SENHA } = require('./autenticacao');
const { criarRepositorioDeUrl } = require('./db/repositorio');

function lerEntrada(entrada) {
  return new Promise((resolve, reject) => {
    let dados = '';
    entrada.setEncoding('utf8');
    entrada.on('data', (pedaco) => { dados += pedaco; });
    entrada.on('end', () => resolve(dados));
    entrada.on('error', reject);
  });
}

async function executar({ argv = process.argv.slice(2), entrada = process.stdin, saida = process.stdout, erros = process.stderr, ambiente = process.env, repositorio } = {}) {
  const [comando, nome] = argv;
  if (!['definir-hash', 'definir-senha'].includes(comando) || !nome) {
    erros.write('Uso: node painel/usuario.js definir-hash|definir-senha NOME  (valor pela entrada padrão)\n');
    return 1;
  }
  const bruto = (await lerEntrada(entrada)).replace(/^﻿/, '').replace(/\r?\n$/, '');
  let hash;
  if (comando === 'definir-hash') {
    hash = bruto.trim();
    if (!lerHash(hash)) { erros.write('O hash informado está em formato inválido.\n'); return 1; }
  } else {
    if (bruto.length < MINIMO_SENHA || bruto.length > 200) { erros.write('A senha precisa ter de ' + MINIMO_SENHA + ' a 200 caracteres.\n'); return 1; }
    hash = gerarHash(bruto);
  }
  const url = ambiente.DATABASE_URL;
  if (!repositorio && !url) { erros.write('DATABASE_URL não está definida: sem banco, vale só o .env.\n'); return 2; }
  const repo = repositorio || criarRepositorioDeUrl(url);
  try {
    if (!repositorio) {
      await repo.iniciar();
      if (!repo.disponivel()) { erros.write('Não foi possível conectar ao banco de dados.\n'); return 2; }
    }
    const usuario = await repo.usuarios.porNome(nome);
    if (!usuario) { saida.write('O usuário não existe no banco; nada a atualizar.\n'); return 3; }
    await repo.usuarios.definirSenha(usuario.id, hash);
    saida.write('Senha do usuário atualizada no banco; as sessões dele foram encerradas.\n');
    return 0;
  } catch (erro) {
    erros.write(erro && erro.bancoIndisponivel ? 'O banco de dados está indisponível.\n' : 'Não foi possível atualizar o usuário.\n');
    return 2;
  } finally {
    if (!repositorio) await repo.parar().catch(() => {});
  }
}

if (require.main === module) {
  executar().then((codigo) => { process.exitCode = codigo; }, () => { process.stderr.write('Não foi possível ler a entrada.\n'); process.exitCode = 1; });
}

module.exports = { executar };
