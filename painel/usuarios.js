'use strict';

// Regras de negócio dos usuários do painel (validação, papéis e proteções), sobre o repositório.
// A garantia final de "nunca ficar sem administrador" está no repositório (transação com trava).

const { gerarHash, lerHash, MINIMO_SENHA } = require('./autenticacao');

const PAPEIS = ['admin', 'editor', 'leitor'];
const FORMATO_USUARIO = /^[a-zA-Z0-9._-]{3,40}$/;
const MAXIMO_SENHA = 200;

function erroHttp(status, mensagem) {
  const erro = new Error(mensagem);
  erro.status = status;
  return erro;
}

function validarSenha(senha) {
  if (typeof senha !== 'string' || senha.length < MINIMO_SENHA) throw erroHttp(400, 'A senha precisa ter no mínimo ' + MINIMO_SENHA + ' caracteres.');
  if (senha.length > MAXIMO_SENHA) throw erroHttp(400, 'A senha precisa ter no máximo ' + MAXIMO_SENHA + ' caracteres.');
}

function validarPapel(papel) {
  if (!PAPEIS.includes(papel)) throw erroHttp(400, 'Papel inválido. Use admin, editor ou leitor.');
}

function criarServicoUsuarios({ repositorio, gerar = gerarHash } = {}) {
  const repo = () => repositorio.usuarios;

  async function criar({ usuario, papel, senha }) {
    if (typeof usuario !== 'string' || !FORMATO_USUARIO.test(usuario)) throw erroHttp(400, 'O usuário precisa ter de 3 a 40 caracteres: letras, números, ponto, hífen ou sublinhado.');
    validarPapel(papel);
    validarSenha(senha);
    return repo().criar({ usuario, papel, senhaHash: gerar(senha) });
  }

  // "atorId": id do usuário logado, para impedir que ele desative a si mesmo.
  async function atualizar(id, { papel, ativo }, atorId = null) {
    if (papel === undefined && ativo === undefined) throw erroHttp(400, 'Informe o papel e/ou o campo ativo.');
    if (papel !== undefined) validarPapel(papel);
    if (ativo !== undefined && typeof ativo !== 'boolean') throw erroHttp(400, 'O campo ativo precisa ser verdadeiro ou falso.');
    if (ativo === false && atorId !== null && Number(atorId) === Number(id)) throw erroHttp(409, 'Você não pode desativar a sua própria conta.');
    const resultado = await repo().atualizar(id, { papel, ativo });
    if (!resultado) throw erroHttp(404, 'Usuário não encontrado.');
    return resultado;
  }

  // Troca a senha e encerra as sessões do usuário (o repositório faz as duas coisas juntas).
  async function definirSenha(id, senha) {
    validarSenha(senha);
    if (!(await repo().definirSenha(id, gerar(senha)))) throw erroHttp(404, 'Usuário não encontrado.');
  }

  // Bootstrap: com a tabela vazia e um hash válido no ambiente, cria o admin inicial. Devolve true se criou.
  async function garantirAdminInicial({ usuario, senhaHash }) {
    const hash = String(senhaHash || '').trim();
    const nome = String(usuario || 'admin').trim() || 'admin';
    if (!hash || !lerHash(hash)) return false;
    return repo().criarPrimeiroAdmin({ usuario: nome, senhaHash: hash });
  }

  return { criar, atualizar, definirSenha, garantirAdminInicial, listar: () => repo().listar() };
}

module.exports = { criarServicoUsuarios, PAPEIS, FORMATO_USUARIO };
