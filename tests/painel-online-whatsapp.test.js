'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { criarWhatsApp } = require('../painel/whatsapp.js');

const URL_WAHA = 'http://waha.local:3000/';
const CHAVE = 'CHAVE-SECRETA-123';
const MSG_INDISPONIVEL = 'O WhatsApp não está disponível: serviço ou chave do WAHA não configurados.';
const MSG_NAO_RESPONDEU = 'O serviço do WhatsApp não respondeu. Tente de novo em instantes.';
const MSG_CHAVE_RECUSADA = 'O painel não conseguiu autenticar no serviço do WhatsApp (chave recusada).';

// Fetch falso: grava cada chamada e responde conforme `responder(url, opcoes)`.
// A resposta é { status, corpo } ou { status, texto } (texto que não é JSON); se `responder`
// lançar erro, a chamada falha como uma queda de rede.
function criarFetchFalso(responder) {
  const chamadas = [];
  const fetch = async (url, opcoes) => {
    chamadas.push({ url, metodo: opcoes.method, cabecalhos: opcoes.headers, corpo: opcoes.body, sinal: opcoes.signal });
    const resposta = (await responder(url, opcoes)) || {};
    const status = resposta.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => (resposta.texto !== undefined ? JSON.parse(resposta.texto) : resposta.corpo),
    };
  };
  return { fetch, chamadas };
}

function servico(responder) {
  const falso = criarFetchFalso(responder);
  const whatsapp = criarWhatsApp({ wahaUrl: URL_WAHA, chave: CHAVE, fetch: falso.fetch });
  return { ...whatsapp, chamadas: falso.chamadas };
}

// Validador de erro: confere status e mensagem, e garante que a chave não vaza na mensagem.
function erroEsperado(status, mensagem) {
  return (erro) => {
    assert.equal(erro.status, status);
    assert.equal(erro.message, mensagem);
    assert.ok(!erro.message.includes(CHAVE), 'a chave não pode aparecer na mensagem de erro');
    return true;
  };
}

// Resposta do WAHA para GET /api/sessions/loja com o status informado; POST recebe corpo vazio.
const sessaoCom = (status) => (url, opcoes) => (opcoes.method === 'GET' ? { corpo: { name: 'loja', status } } : { corpo: {} });

test('listar mapeia os campos de cada sessão e o telefone', async () => {
  const s = servico(() => ({
    corpo: [
      { name: 'principal', status: 'WORKING', me: { id: '5511999990000:12@c.us', pushName: 'Equipe' } },
      { name: 'reserva', status: 'STOPPED' },
    ],
  }));
  const sessoes = await s.listar();
  assert.deepEqual(sessoes, [
    { nome: 'principal', status: 'WORKING', telefone: '5511999990000', nomePerfil: 'Equipe' },
    { nome: 'reserva', status: 'STOPPED', telefone: '', nomePerfil: '' },
  ]);
  assert.equal(s.chamadas.length, 1);
  assert.equal(s.chamadas[0].url, 'http://waha.local:3000/api/sessions?all=true');
  assert.equal(s.chamadas[0].metodo, 'GET');
});

test('iniciar cria a sessão quando o WAHA responde 404', async () => {
  const s = servico((url, opcoes) => (opcoes.method === 'GET' ? { status: 404 } : { corpo: {} }));
  assert.deepEqual(await s.iniciar('loja'), { acao: 'criada' });
  assert.equal(s.chamadas.length, 2);
  assert.equal(s.chamadas[0].url, 'http://waha.local:3000/api/sessions/loja');
  assert.equal(s.chamadas[0].metodo, 'GET');
  assert.equal(s.chamadas[1].url, 'http://waha.local:3000/api/sessions');
  assert.equal(s.chamadas[1].metodo, 'POST');
  assert.deepEqual(JSON.parse(s.chamadas[1].corpo), { name: 'loja', start: true });
});

test('iniciar inicia a sessão parada (STOPPED)', async () => {
  const s = servico(sessaoCom('STOPPED'));
  assert.deepEqual(await s.iniciar('loja'), { acao: 'iniciada' });
  assert.equal(s.chamadas.length, 2);
  assert.equal(s.chamadas[1].url, 'http://waha.local:3000/api/sessions/loja/start');
  assert.equal(s.chamadas[1].metodo, 'POST');
});

test('iniciar reinicia a sessão com falha (FAILED)', async () => {
  const s = servico(sessaoCom('FAILED'));
  assert.deepEqual(await s.iniciar('loja'), { acao: 'reiniciada' });
  assert.equal(s.chamadas.length, 2);
  assert.equal(s.chamadas[1].url, 'http://waha.local:3000/api/sessions/loja/restart');
  assert.equal(s.chamadas[1].metodo, 'POST');
});

test('iniciar não mexe em sessão já ativa (STARTING, SCAN_QR_CODE, WORKING)', async () => {
  for (const status of ['STARTING', 'SCAN_QR_CODE', 'WORKING']) {
    const s = servico(sessaoCom(status));
    assert.deepEqual(await s.iniciar('loja'), { acao: 'ja_ativa' }, status);
    assert.equal(s.chamadas.length, 1, `só o GET deve ser chamado em ${status}`);
    assert.equal(s.chamadas[0].metodo, 'GET');
  }
});

test('parar chama o POST de stop e devolve ok', async () => {
  const s = servico(() => ({ corpo: {} }));
  assert.deepEqual(await s.parar('loja'), { ok: true });
  assert.equal(s.chamadas.length, 1);
  assert.equal(s.chamadas[0].url, 'http://waha.local:3000/api/sessions/loja/stop');
  assert.equal(s.chamadas[0].metodo, 'POST');
  assert.equal(s.chamadas[0].cabecalhos['Content-Type'], 'application/json');
});

test('desconectar chama o POST de logout e devolve ok', async () => {
  const s = servico(() => ({ corpo: {} }));
  assert.deepEqual(await s.desconectar('loja'), { ok: true });
  assert.equal(s.chamadas.length, 1);
  assert.equal(s.chamadas[0].url, 'http://waha.local:3000/api/sessions/loja/logout');
  assert.equal(s.chamadas[0].metodo, 'POST');
});

test('qr devolve mimetype e dados base64 de uma imagem', async () => {
  const s = servico(() => ({ corpo: { mimetype: 'image/png', data: 'iVBORw0KGgo=' } }));
  assert.deepEqual(await s.qr('loja'), { mimetype: 'image/png', data: 'iVBORw0KGgo=' });
  assert.equal(s.chamadas[0].url, 'http://waha.local:3000/api/loja/auth/qr?format=image');
  assert.equal(s.chamadas[0].metodo, 'GET');
});

test('qr com resposta inválida (não é imagem ou dados fora do base64) lança 503', async () => {
  const respostas = [
    { mimetype: 'text/plain', data: 'iVBORw0KGgo=' },
    { mimetype: 'image/png', data: 'não é base64!' },
    { mimetype: 'image/png', data: '' },
  ];
  for (const corpo of respostas) {
    const s = servico(() => ({ corpo }));
    await assert.rejects(s.qr('loja'), erroEsperado(503, MSG_NAO_RESPONDEU));
  }
});

test('nome inválido lança 400 e não chama o WAHA', async () => {
  const s = servico(() => ({ corpo: {} }));
  const nomes = ['../x', '', 'a b', 'a'.repeat(55)];
  for (const nome of nomes) {
    for (const acao of [s.iniciar, s.parar, s.desconectar, s.qr]) {
      await assert.rejects(acao(nome), erroEsperado(400, 'Nome de número inválido.'));
    }
  }
  assert.equal(s.chamadas.length, 0);
});

test('sem chave ou sem URL, toda função lança 503 e não chama o fetch', async () => {
  const configs = [
    { wahaUrl: '', chave: CHAVE },
    { wahaUrl: URL_WAHA, chave: '' },
    { wahaUrl: URL_WAHA, chave: undefined },
  ];
  for (const config of configs) {
    const falso = criarFetchFalso(() => ({ corpo: {} }));
    const w = criarWhatsApp({ ...config, fetch: falso.fetch });
    assert.equal(w.disponivel, false);
    const acoes = [() => w.listar(), () => w.iniciar('loja'), () => w.parar('loja'), () => w.desconectar('loja'), () => w.qr('loja')];
    for (const acao of acoes) {
      await assert.rejects(acao(), erroEsperado(503, MSG_INDISPONIVEL));
    }
    assert.equal(falso.chamadas.length, 0);
  }
});

test('401 do WAHA vira 503 com mensagem de chave recusada, sem a chave', async () => {
  const s = servico(() => ({ status: 401, corpo: { erro: CHAVE } }));
  await assert.rejects(s.listar(), erroEsperado(503, MSG_CHAVE_RECUSADA));
  const s403 = servico(() => ({ status: 403 }));
  await assert.rejects(s403.parar('loja'), erroEsperado(503, MSG_CHAVE_RECUSADA));
});

test('queda de rede e timeout viram 503, sem expor a mensagem original', async () => {
  const s = servico(() => {
    throw new Error(`connect ECONNREFUSED waha.local ${CHAVE}`);
  });
  await assert.rejects(s.listar(), erroEsperado(503, MSG_NAO_RESPONDEU));
  const timeout = servico(() => {
    throw Object.assign(new Error(`The operation was aborted due to timeout ${CHAVE}`), { name: 'TimeoutError' });
  });
  await assert.rejects(timeout.desconectar('loja'), erroEsperado(503, MSG_NAO_RESPONDEU));
});

test('outros erros do WAHA: 404 vira 404, 4xx vira 409 e 5xx vira 503', async () => {
  const casos = [
    [{ status: 404 }, 404, 'Número não encontrado no WhatsApp.'],
    [{ status: 422 }, 409, 'O número não está em um estado que permita essa ação.'],
    [{ status: 500, corpo: { erro: CHAVE } }, 503, MSG_NAO_RESPONDEU],
  ];
  for (const [resposta, status, mensagem] of casos) {
    const s = servico(() => resposta);
    await assert.rejects(s.parar('loja'), erroEsperado(status, mensagem));
  }
});

test('nunca vaza a chave na mensagem de erro, qualquer que seja a falha', async () => {
  const falhas = [
    () => ({ status: 401 }),
    () => ({ status: 500, texto: CHAVE }),
    () => ({ status: 404 }),
    () => {
      throw new Error(`falha ${CHAVE}`);
    },
  ];
  for (const falha of falhas) {
    const s = servico(falha);
    await assert.rejects(s.listar(), (erro) => {
      assert.ok(!erro.message.includes(CHAVE));
      return true;
    });
  }
});

test('resposta 2xx com JSON inválido onde se espera JSON lança 503', async () => {
  const s = servico(() => ({ texto: '<html>página de erro</html>' }));
  await assert.rejects(s.listar(), erroEsperado(503, MSG_NAO_RESPONDEU));
});

test('envia X-Api-Key, Accept e timeout em toda chamada', async () => {
  const s = servico(() => ({ corpo: [] }));
  await s.listar();
  const chamada = s.chamadas[0];
  assert.equal(chamada.cabecalhos['X-Api-Key'], CHAVE);
  assert.equal(chamada.cabecalhos.Accept, 'application/json');
  assert.ok(chamada.sinal instanceof AbortSignal);
  assert.equal(chamada.url, 'http://waha.local:3000/api/sessions?all=true');
});
