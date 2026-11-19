'use strict';

const $ = (seletor) => document.querySelector(seletor);

const PAPEIS = { admin: 'Administrador', editor: 'Editor', leitor: 'Leitor' };
const MIN_SENHA = 12;
const MSG_SENHA_CURTA = 'A senha precisa ter pelo menos 12 caracteres.';

let usuarioLogado = null; // nome do usuário com a sessão atual
let alvoSenha = null; // usuário cuja senha está sendo redefinida

function criar(tag, classe, texto) {
  const el = document.createElement(tag);
  if (classe) el.className = classe;
  if (texto !== undefined && texto !== null) el.textContent = texto;
  return el;
}

async function api(rota, metodo = 'GET', corpo) {
  let res;
  try {
    res = await fetch(rota, {
      method: metodo,
      headers: corpo === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: corpo === undefined ? undefined : JSON.stringify(corpo)
    });
  } catch { throw new Error('Não foi possível conectar ao painel. Confira a internet e tente de novo.'); }
  if (res.status === 401) { location.href = '/login'; throw new Error('Sessão expirada. Entre novamente.'); }
  let dados = {};
  try { dados = await res.json(); } catch { dados = {}; }
  if (!res.ok) {
    let mensagem = dados.erro || 'O painel não respondeu (HTTP ' + res.status + ').';
    if (res.status === 403) mensagem = 'Você não tem permissão para gerenciar usuários.';
    if (res.status === 503 && dados.bancoIndisponivel) mensagem = 'Usuários indisponíveis: banco de dados fora do ar. O login de reserva do arquivo .env continua funcionando.';
    const erro = new Error(mensagem);
    erro.status = res.status;
    throw erro;
  }
  return dados;
}

function mostrarAviso(mensagem) {
  const caixa = $('#aviso');
  caixa.textContent = mensagem;
  caixa.hidden = !mensagem;
}

function mostrarOk(mensagem) {
  const caixa = $('#ok');
  caixa.textContent = mensagem;
  caixa.hidden = !mensagem;
}

function formatarData(valor) {
  if (!valor) return '';
  const data = new Date(valor);
  return isNaN(data) ? '–' : data.toLocaleString('pt-BR');
}

// ---------- lista de usuários ----------

function criarLinha(u) {
  const euMesmo = u.usuario === usuarioLogado;
  const linha = criar('li', 'usuario-linha');

  const info = criar('div', 'usuario-info');
  const nome = criar('strong', null, u.usuario);
  if (euMesmo) nome.append(' ', criar('span', 'selo', 'você'));
  const papel = criar('span', 'selo-papel', PAPEIS[u.papel] || u.papel);
  const situacao = criar('span', 'selo-status', u.ativo ? 'Ativo' : 'Desativado');
  situacao.dataset.situacao = u.ativo ? 'ok' : 'neutro';
  const datas = criar('small', null, 'Criado em ' + (formatarData(u.criadoEm) || '–') + ' · Último acesso: ' + (u.ultimoLogin ? formatarData(u.ultimoLogin) : 'nunca'));
  info.append(nome, papel, situacao, datas);

  const acoes = criar('div', 'usuario-acoes');
  const rotuloPapel = criar('label', 'campo');
  rotuloPapel.append(criar('span', null, 'Papel'));
  const seletor = criar('select');
  for (const [valor, texto] of Object.entries(PAPEIS)) {
    const opcao = criar('option', null, texto);
    opcao.value = valor;
    seletor.append(opcao);
  }
  seletor.value = u.papel;
  seletor.disabled = euMesmo;
  seletor.addEventListener('change', () => alterarPapel(u, seletor));
  rotuloPapel.append(seletor);

  const botaoSenha = criar('button', 'botao botao-secundario botao-pequeno', 'Redefinir senha');
  botaoSenha.type = 'button';
  botaoSenha.addEventListener('click', () => abrirDialogoSenha(u));
  acoes.append(rotuloPapel, botaoSenha);

  if (!euMesmo) {
    const botaoAtivo = criar('button', u.ativo ? 'botao botao-perigo-suave botao-pequeno' : 'botao botao-secundario botao-pequeno', u.ativo ? 'Desativar' : 'Reativar');
    botaoAtivo.type = 'button';
    botaoAtivo.addEventListener('click', () => pedirAlteracaoAtivo(u));
    acoes.append(botaoAtivo);
  }

  linha.append(info, acoes);
  return linha;
}

async function carregarUsuarios() {
  try {
    const { usuarios = [] } = await api('/api/usuarios');
    const lista = $('#lista-usuarios');
    lista.replaceChildren(...usuarios.map(criarLinha));
    $('#vazio').hidden = usuarios.length > 0;
  } catch (erro) {
    mostrarAviso(erro.message);
  }
}

// ---------- ações ----------

async function alterarPapel(u, seletor) {
  const novoPapel = seletor.value;
  seletor.disabled = true;
  try {
    await api('/api/usuarios/' + encodeURIComponent(u.id), 'PATCH', { papel: novoPapel });
    mostrarAviso('');
    mostrarOk('Papel de "' + u.usuario + '" alterado para ' + PAPEIS[novoPapel] + '.');
    await carregarUsuarios();
  } catch (erro) {
    mostrarOk('');
    mostrarAviso(erro.message);
    seletor.value = u.papel; // desfaz a escolha que o servidor recusou
    seletor.disabled = false;
  }
}

function pedirAlteracaoAtivo(u) {
  const desativar = u.ativo;
  confirmarAcao(
    desativar ? 'Desativar usuário?' : 'Reativar usuário?',
    desativar
      ? '"' + u.usuario + '" não vai mais conseguir entrar no painel até ser reativado.'
      : '"' + u.usuario + '" volta a poder entrar no painel.',
    desativar ? 'Desativar' : 'Reativar',
    desativar,
    () => alterarAtivo(u, !u.ativo)
  );
}

async function alterarAtivo(u, ativo) {
  try {
    await api('/api/usuarios/' + encodeURIComponent(u.id), 'PATCH', { ativo });
    mostrarAviso('');
    mostrarOk('"' + u.usuario + '" ' + (ativo ? 'reativado.' : 'desativado.'));
  } catch (erro) {
    mostrarOk('');
    mostrarAviso(erro.message);
  }
  await carregarUsuarios();
}

// Dialog genérico de confirmação: título e texto entram por textContent.
function confirmarAcao(titulo, texto, rotulo, perigoso, acao) {
  const dialogo = $('#dialogo-confirmar');
  $('#titulo-confirmar').textContent = titulo;
  $('#texto-confirmar').textContent = texto;
  const botao = $('#botao-confirmar');
  botao.textContent = rotulo;
  botao.className = 'botao ' + (perigoso ? 'botao-perigo' : 'botao-primario');
  dialogo.returnValue = 'cancelar';
  dialogo.addEventListener('close', () => {
    if (dialogo.returnValue === 'confirmar') acao();
  }, { once: true });
  dialogo.showModal();
}

// ---------- redefinir senha ----------

function abrirDialogoSenha(u) {
  alvoSenha = u;
  $('#texto-senha').textContent = 'Nova senha para "' + u.usuario + '". Depois de salva, a senha antiga deixa de valer.';
  $('#erro-senha').hidden = true;
  $('#nova-senha').value = '';
  $('#dialogo-senha').showModal();
  $('#nova-senha').focus();
}

async function redefinirSenha(u, senha) {
  try {
    await api('/api/usuarios/' + encodeURIComponent(u.id) + '/senha', 'POST', { senha });
    mostrarAviso('');
    mostrarOk('Senha de "' + u.usuario + '" redefinida. Avise a pessoa para usar a nova senha.');
  } catch (erro) {
    mostrarOk('');
    mostrarAviso(erro.message);
  }
}

// ---------- formulário de novo usuário ----------

async function criarUsuario(evento) {
  evento.preventDefault();
  const campoUsuario = $('#novo-usuario');
  const campoSenha = $('#novo-senha');
  const usuario = campoUsuario.value.trim();
  const papel = $('#novo-papel').value;
  const senha = campoSenha.value;
  const botao = evento.target.querySelector('button[type="submit"]');

  if (!usuario) { mostrarOk(''); mostrarAviso('Informe o nome do usuário.'); campoUsuario.focus(); return; }
  if (senha.length < MIN_SENHA) { mostrarOk(''); mostrarAviso(MSG_SENHA_CURTA); campoSenha.focus(); return; }

  botao.disabled = true;
  try {
    await api('/api/usuarios', 'POST', { usuario, papel, senha });
    evento.target.reset(); // limpa usuário, senha e volta o papel ao padrão
    mostrarAviso('');
    mostrarOk('Usuário "' + usuario + '" criado como ' + PAPEIS[papel] + '.');
    await carregarUsuarios();
  } catch (erro) {
    mostrarOk('');
    mostrarAviso(erro.message);
    campoSenha.value = ''; // a senha nunca fica na tela depois de enviada
  } finally {
    botao.disabled = false;
  }
}

// ---------- Sair ----------

async function prepararSair() {
  const botao = $('#botao-sair');
  try {
    const r = await fetch('/api/sessao', { headers: { Accept: 'application/json' } });
    const s = await r.json();
    if (!s.loginObrigatorio) return;
    botao.hidden = false;
    botao.addEventListener('click', async () => {
      botao.disabled = true;
      try { await fetch('/api/logout', { method: 'POST' }); } catch { /* segue para o login mesmo assim */ }
      location.href = '/login';
    });
  } catch { /* sem sessão ou painel fora: o botão fica escondido */ }
}

// ---------- inicialização ----------

async function iniciar() {
  let sessao;
  try {
    sessao = await api('/api/sessao');
  } catch (erro) {
    mostrarAviso(erro.message);
    return;
  }
  // Sem login obrigatório, quem acessa é administrador.
  const papel = sessao.papel || (sessao.loginObrigatorio ? null : 'admin');
  if (papel === 'editor' || papel === 'leitor') { location.replace('/'); return; }
  usuarioLogado = sessao.usuario || null;
  await carregarUsuarios();
}

$('#form-novo').addEventListener('submit', criarUsuario);

// Só "salvar" redefine a senha; "cancelar" deixa o dialog fechar sozinho.
$('#form-senha').addEventListener('submit', (evento) => {
  if (!evento.submitter || evento.submitter.value !== 'salvar') return;
  evento.preventDefault();
  const campo = $('#nova-senha');
  const senha = campo.value;
  if (senha.length < MIN_SENHA) {
    $('#erro-senha').textContent = MSG_SENHA_CURTA;
    $('#erro-senha').hidden = false;
    campo.focus();
    return;
  }
  const alvo = alvoSenha;
  campo.value = '';
  $('#dialogo-senha').close('salvar');
  if (alvo) redefinirSenha(alvo, senha);
});

// Fechou por qualquer caminho (Esc, cancelar, salvar): a senha sai do campo.
$('#dialogo-senha').addEventListener('close', () => {
  $('#nova-senha').value = '';
  $('#erro-senha').hidden = true;
});

prepararSair();
iniciar();
