'use strict';

// Ponte entre o painel e o WAHA, o serviço que mantém a sessão do WhatsApp.
// Tudo passa pela API REST do WAHA, com a chave no cabeçalho X-Api-Key.
// Os erros entregues ao painel trazem só o status HTTP e uma mensagem em português: nunca
// a chave, a URL, o corpo da resposta do WAHA nem a mensagem original da exceção.

const NOME_VALIDO = /^[a-zA-Z0-9_-]{1,54}$/;
const BASE64 = /^[A-Za-z0-9+/=]+$/;
const TEMPO_LIMITE_MS = 5000;

const MSG_INDISPONIVEL = 'O WhatsApp não está disponível: serviço ou chave do WAHA não configurados.';
const MSG_NAO_RESPONDEU = 'O serviço do WhatsApp não respondeu. Tente de novo em instantes.';
const MSG_CHAVE_RECUSADA = 'O painel não conseguiu autenticar no serviço do WhatsApp (chave recusada).';
const MSG_NAO_ENCONTRADO = 'Número não encontrado no WhatsApp.';
const MSG_ESTADO = 'O número não está em um estado que permita essa ação.';
const MSG_NOME_INVALIDO = 'Nome de número inválido.';

function erroHttp(status, mensagem) {
  const erro = new Error(mensagem);
  erro.status = status;
  return erro;
}

// Traduz o status de uma resposta de erro do WAHA para um erro seguro para o painel.
function erroDeStatus(status) {
  if (status === 401 || status === 403) return erroHttp(503, MSG_CHAVE_RECUSADA);
  if (status === 404) return erroHttp(404, MSG_NAO_ENCONTRADO);
  if (status >= 400 && status < 500) return erroHttp(409, MSG_ESTADO);
  return erroHttp(503, MSG_NAO_RESPONDEU);
}

// Telefone a partir do id da sessão: '5511999990000:12@c.us' -> '5511999990000'.
function telefoneDe(me) {
  if (!me || typeof me.id !== 'string') return '';
  return me.id.split('@')[0].split(':')[0].replace(/\D/g, '');
}

function criarWhatsApp({ wahaUrl, chave, fetch = globalThis.fetch } = {}) {
  const base = typeof wahaUrl === 'string' ? wahaUrl.trim().replace(/\/+$/, '') : '';
  const disponivel = base !== '' && typeof chave === 'string' && chave.trim() !== '';

  function exigirDisponivel() {
    if (!disponivel) throw erroHttp(503, MSG_INDISPONIVEL);
  }

  // Confere o nome antes de montar qualquer URL e devolve a versão segura para a rota.
  function validarNome(nome) {
    if (typeof nome !== 'string' || !NOME_VALIDO.test(nome)) throw erroHttp(400, MSG_NOME_INVALIDO);
    return encodeURIComponent(nome);
  }

  // Uma chamada ao WAHA. Devolve a resposta quando ela é de sucesso e lança erro seguro caso contrário.
  async function requisitar(rota, metodo, corpo) {
    const opcoes = {
      method: metodo,
      headers: { 'X-Api-Key': chave, Accept: 'application/json' },
      signal: AbortSignal.timeout(TEMPO_LIMITE_MS),
    };
    if (metodo === 'POST') {
      opcoes.headers['Content-Type'] = 'application/json';
      opcoes.body = JSON.stringify(corpo);
    }
    let resposta;
    try {
      resposta = await fetch(base + rota, opcoes);
    } catch {
      // Falha de rede ou timeout: a mensagem original pode conter a URL ou a chave, então não é usada.
      throw erroHttp(503, MSG_NAO_RESPONDEU);
    }
    if (!resposta.ok) throw erroDeStatus(resposta.status);
    return resposta;
  }

  // Chamada que espera um JSON na resposta.
  async function obterJson(rota) {
    const resposta = await requisitar(rota, 'GET');
    try {
      return await resposta.json();
    } catch {
      throw erroHttp(503, MSG_NAO_RESPONDEU);
    }
  }

  // Chamada de ação (POST), sem resposta útil além do sucesso.
  async function enviar(rota, corpo = {}) {
    await requisitar(rota, 'POST', corpo);
  }

  async function listar() {
    exigirDisponivel();
    const sessoes = await obterJson('/api/sessions?all=true');
    if (!Array.isArray(sessoes)) throw erroHttp(503, MSG_NAO_RESPONDEU);
    return sessoes.map((sessao) => {
      const s = sessao || {};
      return {
        nome: s.name,
        status: s.status,
        telefone: telefoneDe(s.me),
        nomePerfil: s.me?.pushName || '',
      };
    });
  }

  // Liga a sessão conforme o estado atual: cria, inicia, reinicia ou deixa como está.
  async function iniciar(nome) {
    exigirDisponivel();
    const id = validarNome(nome);
    let sessao;
    try {
      sessao = await obterJson(`/api/sessions/${id}`);
    } catch (erro) {
      if (erro.status !== 404) throw erro;
      await enviar('/api/sessions', { name: nome, start: true });
      return { acao: 'criada' };
    }
    const status = sessao?.status;
    if (status === 'STOPPED') {
      await enviar(`/api/sessions/${id}/start`);
      return { acao: 'iniciada' };
    }
    if (status === 'FAILED') {
      await enviar(`/api/sessions/${id}/restart`);
      return { acao: 'reiniciada' };
    }
    // STARTING, SCAN_QR_CODE e WORKING: a sessão já está em andamento ou conectada.
    return { acao: 'ja_ativa' };
  }

  async function parar(nome) {
    exigirDisponivel();
    await enviar(`/api/sessions/${validarNome(nome)}/stop`);
    return { ok: true };
  }

  async function desconectar(nome) {
    exigirDisponivel();
    await enviar(`/api/sessions/${validarNome(nome)}/logout`);
    return { ok: true };
  }

  // QR code de pareamento, em base64. Só aceita uma imagem com dados base64 válidos.
  async function qr(nome) {
    exigirDisponivel();
    const dados = await obterJson(`/api/${validarNome(nome)}/auth/qr?format=image`);
    const valido = dados && typeof dados.mimetype === 'string' && dados.mimetype.startsWith('image/') &&
      typeof dados.data === 'string' && dados.data !== '' && BASE64.test(dados.data);
    if (!valido) throw erroHttp(503, MSG_NAO_RESPONDEU);
    return { mimetype: dados.mimetype, data: dados.data };
  }

  return { disponivel, listar, iniciar, parar, desconectar, qr };
}

module.exports = { criarWhatsApp };
