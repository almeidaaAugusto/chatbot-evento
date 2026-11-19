'use strict';

const $ = (seletor) => document.querySelector(seletor);

function mostrarErro(mensagem) {
  const caixa = $('#login-erro');
  caixa.textContent = mensagem;
  caixa.hidden = !mensagem;
}

// Quem já está logado (ou não precisa de login) vai direto para o painel.
async function conferirSessao() {
  try {
    const r = await fetch('/api/sessao', { headers: { Accept: 'application/json' } });
    const s = await r.json();
    if (s.logado || s.loginObrigatorio === false) location.replace('/');
  } catch { /* painel fora do ar: o formulário continua disponível */ }
}

$('#form-login').addEventListener('submit', async (evento) => {
  evento.preventDefault();
  const usuario = $('#usuario').value.trim();
  const senha = $('#senha').value;
  if (!usuario || !senha) { mostrarErro('Informe o usuário e a senha.'); return; }
  const botao = $('#entrar');
  botao.disabled = true;
  mostrarErro('');
  try {
    const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ usuario, senha }) });
    let dados = {};
    try { dados = await r.json(); } catch { dados = {}; }
    if (r.ok) { location.replace('/'); return; }
    $('#senha').value = '';
    if (r.status === 429) mostrarErro(dados.erro || 'Muitas tentativas. Aguarde alguns minutos e tente de novo.');
    else if (r.status === 401) mostrarErro(dados.erro || 'Usuário ou senha incorretos.');
    else mostrarErro(dados.erro || 'Não foi possível entrar agora. Tente novamente.');
  } catch {
    mostrarErro('Não foi possível conectar ao painel. Confira a internet e tente de novo.');
  } finally {
    botao.disabled = false;
  }
});

conferirSessao();
