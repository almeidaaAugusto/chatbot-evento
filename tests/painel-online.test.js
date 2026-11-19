'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { criarServidor } = require('../painel/server');
const { gerarHash, verificarSenha } = require('../painel/autenticacao');

const SENHA = 'senha-de-teste-123';
const HASH = gerarHash(SENHA);
const CHAVE_WAHA = 'CHAVE-WAHA-SECRETA-999';

const configBase = () => ({
  evento: { nome: 'Festival', local: 'Praça', instagram: '@festival' },
  mensagens: { menu: '1 - Local', nao_entendi: 'Procure {{instagram}}', reativado: 'Olá' },
  fallback: { mensagens: ['Escolha uma opção.', 'Reformule sua pergunta.', 'Fale com {{instagram}}.'], mensagem_midia: 'Escreva sua dúvida.' },
  opcoes: [{ id: 'local', titulo: 'Local', palavras_exatas: ['1'], palavras_chave: ['local'], perguntas: ['Onde?'], resposta: 'Na {{local}}.' }],
  protecoes: { max_mensagens_por_hora: 40 },
  numeros: [{ sessao: 'principal', nome: 'Número principal' }, { sessao: 'so-no-painel', nome: 'Só no painel' }]
});

// WAHA falso: sessions = { nome: {status, me} }; registra chamadas.
function wahaFalso(sessions = {}, { fora = false } = {}) {
  const chamadas = [];
  const fetch = async (url, opcoes = {}) => {
    chamadas.push({ url, metodo: opcoes.method || 'GET', chave: opcoes.headers?.['X-Api-Key'], corpo: opcoes.body });
    const resposta = (status, corpo) => ({ ok: status < 400, status, json: async () => corpo });
    if (fora) throw new Error('ECONNREFUSED ' + CHAVE_WAHA);
    const { pathname } = new URL(url);
    if (url.endsWith('/ping')) return resposta(200, 'pong');
    if (url.endsWith('/healthz')) return resposta(200, { status: 'ok' });
    if (pathname === '/api/sessions') {
      if ((opcoes.method || 'GET') === 'POST') { const { name } = JSON.parse(opcoes.body); sessions[name] = { status: 'STARTING' }; return resposta(201, {}); }
      return resposta(200, Object.entries(sessions).map(([name, s]) => ({ name, ...s })));
    }
    const m = /^\/api\/sessions\/([^/]+)(\/(\w+))?$/.exec(pathname);
    if (m) {
      const s = sessions[m[1]];
      if (!s) return resposta(404, {});
      if (!m[3]) return resposta(200, { name: m[1], ...s });
      return resposta(201, {});
    }
    if (/^\/api\/[^/]+\/auth\/qr$/.test(pathname)) return resposta(200, { mimetype: 'image/png', data: 'aGVsbG8=' });
    return resposta(404, {});
  };
  return { fetch, chamadas };
}

async function subir(t, opcoes = {}) {
  const pasta = await fs.mkdtemp(path.join(os.tmpdir(), 'chatbot-online-'));
  const configPath = path.join(pasta, 'chatbot.json');
  await fs.writeFile(configPath, JSON.stringify(configBase(), null, 2));
  const server = criarServidor({ configPath, logsDir: pasta, ...opcoes });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await fs.rm(pasta, { recursive: true, force: true }); });
  return 'http://127.0.0.1:' + server.address().port;
}

function req(url, rota, { metodo = 'GET', corpo, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const raw = corpo === undefined ? undefined : JSON.stringify(corpo);
    const r = http.request(url + rota, { method: metodo, headers: { ...(raw === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw) }), ...headers } }, res => {
      let texto = '';
      res.setEncoding('utf8');
      res.on('data', p => { texto += p; });
      res.on('end', () => { let dados; try { dados = JSON.parse(texto); } catch {} resolve({ status: res.statusCode, dados, texto, headers: res.headers }); });
    });
    r.on('error', reject);
    r.end(raw);
  });
}

const login = (url, extra = {}) => req(url, '/api/login', { metodo: 'POST', corpo: { usuario: 'admin', senha: SENHA }, ...extra });
const cookieDe = (r) => (r.headers['set-cookie'] || [''])[0].split(';')[0];

test('sem hash e sem domínio o painel segue aberto, como antes', async (t) => {
  const url = await subir(t, { senhaHash: '', dominio: '' });
  assert.equal((await req(url, '/api/config')).status, 200);
  assert.deepEqual((await req(url, '/api/sessao')).dados, { logado: false, usuario: null, papel: 'admin', loginObrigatorio: false });
  assert.equal((await req(url, '/api/login', { metodo: 'POST', corpo: { usuario: 'admin', senha: SENHA } })).status, 400);
});

test('painel recusa subir com domínio e sem hash, e com hash em formato inválido', () => {
  assert.throws(() => criarServidor({ dominio: 'exemplo.com', senhaHash: '' }), /PAINEL_SENHA_HASH/);
  assert.throws(() => criarServidor({ senhaHash: 'scrypt$16384$8$1$aa$bb' }), /formato inválido/);
  assert.throws(() => criarServidor({ dominio: 'https://exemplo.com', senhaHash: HASH }), /PAINEL_DOMINIO/);
});

test('hash gerado é verificável e não contém $', () => {
  assert.match(HASH, /^scrypt:16384:8:1:[0-9a-f]{32}:[0-9a-f]{128}$/);
  assert.equal(verificarSenha(SENHA, HASH), true);
  assert.equal(verificarSenha(SENHA + 'x', HASH), false);
  assert.equal(verificarSenha(SENHA, 'lixo'), false);
});

test('com login: 401 nas APIs, 302 nas páginas e rotas públicas liberadas', async (t) => {
  const url = await subir(t, { senhaHash: HASH });
  for (const rota of ['/api/config', '/api/ia', '/api/situacao', '/api/conversas', '/api/erros', '/api/servidor', '/api/whatsapp', '/api/whatsapp/principal/qr']) {
    const r = await req(url, rota);
    assert.equal(r.status, 401, rota);
  }
  assert.equal((await req(url, '/api/logout', { metodo: 'POST', corpo: {} })).status, 401);
  assert.equal((await req(url, '/api/simular', { metodo: 'POST', corpo: {} })).status, 401);
  for (const rota of ['/', '/conversas', '/whatsapp', '/app.js', '/qualquer-coisa']) {
    const r = await req(url, rota);
    assert.equal(r.status, 302, rota);
    assert.equal(r.headers.location, '/login');
  }
  assert.equal((await req(url, '/api/health')).status, 200);
  assert.equal((await req(url, '/style.css')).status, 200);
  assert.deepEqual((await req(url, '/api/sessao')).dados, { logado: false, usuario: null, papel: null, loginObrigatorio: true });
  // As páginas novas da frente B podem ainda não existir: 200 ou 404, nunca redirecionamento nem erro.
  for (const rota of ['/login', '/login.js']) assert.ok([200, 404].includes((await req(url, rota)).status), rota);
});

test('login certo cria sessão com cookie HttpOnly e SameSite, e logout encerra', async (t) => {
  const url = await subir(t, { senhaHash: HASH });
  const r = await login(url);
  assert.equal(r.status, 200);
  assert.deepEqual(r.dados, { ok: true, usuario: 'admin' });
  const setCookie = r.headers['set-cookie'][0];
  assert.match(setCookie, /^painel_sessao=[0-9a-f]{64}; /);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.match(setCookie, /Path=\//);
  assert.doesNotMatch(setCookie, /Secure/); // HTTP puro e sem domínio
  const cookie = cookieDe(r);
  assert.equal((await req(url, '/api/config', { headers: { Cookie: cookie } })).status, 200);
  assert.deepEqual((await req(url, '/api/sessao', { headers: { Cookie: cookie } })).dados, { logado: true, usuario: 'admin', papel: 'admin', loginObrigatorio: true });
  const saida = await req(url, '/api/logout', { metodo: 'POST', corpo: {}, headers: { Cookie: cookie } });
  assert.equal(saida.status, 200);
  assert.match(saida.headers['set-cookie'][0], /Max-Age=0/);
  assert.equal((await req(url, '/api/config', { headers: { Cookie: cookie } })).status, 401);
});

test('cookie leva Secure com X-Forwarded-Proto https e com domínio configurado', async (t) => {
  const url = await subir(t, { senhaHash: HASH });
  const r = await login(url, { headers: { 'X-Forwarded-Proto': 'https' } });
  assert.match(r.headers['set-cookie'][0], /; Secure/);
  const urlDominio = await subir(t, { senhaHash: HASH, dominio: 'painel.exemplo.com' });
  const d = await login(urlDominio, { headers: { Host: 'painel.exemplo.com' } });
  assert.equal(d.status, 200);
  assert.match(d.headers['set-cookie'][0], /; Secure/);
});

test('usuário errado e senha errada dão a mesma resposta 401, sem cookie', async (t) => {
  const url = await subir(t, { senhaHash: HASH });
  const a = await req(url, '/api/login', { metodo: 'POST', corpo: { usuario: 'outro', senha: SENHA } });
  const b = await req(url, '/api/login', { metodo: 'POST', corpo: { usuario: 'admin', senha: 'errada-errada-1' } });
  assert.equal(a.status, 401);
  assert.equal(b.status, 401);
  assert.equal(a.texto, b.texto);
  assert.equal(a.headers['set-cookie'], undefined);
  assert.equal((await req(url, '/api/login', { metodo: 'POST', corpo: { usuario: 1 } })).status, 400);
});

test('5 falhas bloqueiam o IP por 15 minutos (429), mesmo com a senha certa', async (t) => {
  const url = await subir(t, { senhaHash: HASH });
  for (let i = 0; i < 5; i++) assert.equal((await req(url, '/api/login', { metodo: 'POST', corpo: { usuario: 'admin', senha: 'errada-errada-1' } })).status, 401);
  const bloqueado = await login(url);
  assert.equal(bloqueado.status, 429);
  assert.ok(bloqueado.dados.esperarSegundos > 800 && bloqueado.dados.esperarSegundos <= 900);
  assert.ok(Number(bloqueado.headers['retry-after']) > 0);
});

test('X-Forwarded-For só vale com PAINEL_CONFIAR_PROXY', async (t) => {
  const errado = (url, ip) => req(url, '/api/login', { metodo: 'POST', corpo: { usuario: 'admin', senha: 'errada-errada-1' }, headers: { 'X-Forwarded-For': ip } });
  // Sem confiar: variar o cabeçalho não escapa do bloqueio.
  const semProxy = await subir(t, { senhaHash: HASH, confiarProxy: false });
  for (let i = 0; i < 5; i++) await errado(semProxy, '10.0.0.' + i);
  assert.equal((await errado(semProxy, '10.0.0.99')).status, 429);
  // Confiando: cada IP do cabeçalho tem a sua contagem.
  const comProxy = await subir(t, { senhaHash: HASH, confiarProxy: true });
  for (let i = 0; i < 5; i++) await errado(comProxy, '10.0.0.1');
  assert.equal((await errado(comProxy, '10.0.0.1')).status, 429);
  assert.equal((await errado(comProxy, '10.0.0.2')).status, 401);
  assert.equal((await login(comProxy, { headers: { 'X-Forwarded-For': '10.0.0.3' } })).status, 200);
});

test('30 falhas no total atrasam todos os logins (atraso global)', async (t) => {
  const atrasos = [];
  const url = await subir(t, { senhaHash: HASH, confiarProxy: true, atrasar: async (ms) => { atrasos.push(ms); } });
  for (let i = 0; i < 30; i++) await req(url, '/api/login', { metodo: 'POST', corpo: { usuario: 'x', senha: 'y' }, headers: { 'X-Forwarded-For': '10.1.' + Math.floor(i / 4) + '.' + (i % 4) } });
  assert.equal(atrasos.length, 0);
  assert.equal((await login(url, { headers: { 'X-Forwarded-For': '10.9.9.9' } })).status, 200);
  assert.deepEqual(atrasos, [1000]);
});

test('sessão expira por ociosidade (12 h) e pelo teto de 7 dias', async (t) => {
  let agora = 1_000_000;
  const url = await subir(t, { senhaHash: HASH, agoraMs: () => agora });
  const cookie = cookieDe(await login(url));
  agora += 11 * 3600 * 1000;
  assert.equal((await req(url, '/api/config', { headers: { Cookie: cookie } })).status, 200); // renova o uso
  agora += 11 * 3600 * 1000;
  assert.equal((await req(url, '/api/config', { headers: { Cookie: cookie } })).status, 200);
  agora += 13 * 3600 * 1000;
  assert.equal((await req(url, '/api/config', { headers: { Cookie: cookie } })).status, 401);
  // Teto absoluto: usando sempre, ainda cai aos 7 dias.
  const cookie2 = cookieDe(await login(url));
  for (let i = 0; i < 15; i++) { agora += 11 * 3600 * 1000; assert.equal((await req(url, '/api/config', { headers: { Cookie: cookie2 } })).status, 200); }
  agora += 11 * 3600 * 1000;
  assert.equal((await req(url, '/api/config', { headers: { Cookie: cookie2 } })).status, 401);
});

test('Host do domínio é aceito e host estranho é recusado', async (t) => {
  const url = await subir(t, { senhaHash: HASH, dominio: 'painel.exemplo.com' });
  assert.equal((await req(url, '/api/health', { headers: { Host: 'painel.exemplo.com' } })).status, 200);
  assert.equal((await req(url, '/api/health', { headers: { Host: 'painel.exemplo.com:443' } })).status, 200);
  assert.equal((await req(url, '/api/health', { headers: { Host: 'PAINEL.exemplo.com', Origin: 'https://painel.exemplo.com' } })).status, 200);
  assert.equal((await req(url, '/api/health', { headers: { Host: 'painel.exemplo.com:8080' } })).status, 403);
  assert.equal((await req(url, '/api/health', { headers: { Host: 'mal.exemplo.com' } })).status, 403);
  assert.equal((await req(url, '/api/health', { headers: { Host: 'painel.exemplo.com', Origin: 'https://mal.exemplo.com' } })).status, 403);
  assert.equal((await req(url, '/api/health', { headers: { Host: 'painel.exemplo.com', Origin: 'http://painel.exemplo.com' } })).status, 403);
  assert.equal((await req(url, '/api/health', { headers: { Host: 'painel.exemplo.com', 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await req(url, '/api/health')).status, 200); // localhost continua valendo (healthcheck)
  const semDominio = await subir(t, {});
  assert.equal((await req(semDominio, '/api/health', { headers: { Host: 'painel.exemplo.com' } })).status, 403);
});

async function logado(t, opcoes) {
  const url = await subir(t, { senhaHash: HASH, wahaChave: CHAVE_WAHA, wahaUrl: 'http://waha:3000', ...opcoes });
  return { url, h: { Cookie: cookieDe(await login(url)) } };
}

test('/api/whatsapp junta números cadastrados e sessões do WAHA, sem vazar a chave', async (t) => {
  const waha = wahaFalso({ principal: { status: 'WORKING', me: { id: '5511999990000:12@c.us', pushName: 'Maria' } }, extra: { status: 'STOPPED' } });
  const { url, h } = await logado(t, { fetchWaha: waha.fetch });
  const r = await req(url, '/api/whatsapp', { headers: h });
  assert.equal(r.status, 200);
  assert.deepEqual(r.dados.numeros, [
    { nome: 'principal', nomeAmigavel: 'Número principal', status: 'WORKING', telefone: '5511999990000', nomePerfil: 'Maria', cadastrado: true, noWaha: true },
    { nome: 'so-no-painel', nomeAmigavel: 'Só no painel', status: null, telefone: '', nomePerfil: '', cadastrado: true, noWaha: false },
    { nome: 'extra', nomeAmigavel: 'extra', status: 'STOPPED', telefone: '', nomePerfil: '', cadastrado: false, noWaha: true }
  ]);
  assert.ok(!r.texto.includes(CHAVE_WAHA));
  assert.ok(waha.chamadas.every(c => !c.url.endsWith('/ping') ? c.chave === CHAVE_WAHA : true));
});

test('iniciar, parar, qr e desconectar (com confirmação obrigatória)', async (t) => {
  const waha = wahaFalso({ parada: { status: 'STOPPED' }, boa: { status: 'WORKING' } });
  const { url, h } = await logado(t, { fetchWaha: waha.fetch });
  assert.deepEqual((await req(url, '/api/whatsapp/parada/iniciar', { metodo: 'POST', corpo: {}, headers: h })).dados, { ok: true, acao: 'iniciada' });
  assert.deepEqual((await req(url, '/api/whatsapp/nova/iniciar', { metodo: 'POST', corpo: {}, headers: h })).dados, { ok: true, acao: 'criada' });
  assert.deepEqual((await req(url, '/api/whatsapp/boa/parar', { metodo: 'POST', corpo: {}, headers: h })).dados, { ok: true });
  assert.deepEqual((await req(url, '/api/whatsapp/boa/qr', { headers: h })).dados, { mimetype: 'image/png', data: 'aGVsbG8=' });
  const antes = waha.chamadas.length;
  assert.equal((await req(url, '/api/whatsapp/boa/desconectar', { metodo: 'POST', corpo: {}, headers: h })).status, 400);
  assert.equal((await req(url, '/api/whatsapp/boa/desconectar', { metodo: 'POST', corpo: { confirmar: 'sim' }, headers: h })).status, 400);
  assert.equal(waha.chamadas.length, antes);
  assert.deepEqual((await req(url, '/api/whatsapp/boa/desconectar', { metodo: 'POST', corpo: { confirmar: true }, headers: h })).dados, { ok: true });
  assert.ok(waha.chamadas.some(c => c.metodo === 'POST' && c.url.endsWith('/api/sessions/boa/logout')));
  // método errado não chega ao WAHA
  assert.equal((await req(url, '/api/whatsapp/boa/qr', { metodo: 'POST', corpo: {}, headers: h })).status, 404);
});

test('nome de sessão inválido é recusado antes de falar com o WAHA', async (t) => {
  const waha = wahaFalso({});
  const { url, h } = await logado(t, { fetchWaha: waha.fetch });
  const antes = waha.chamadas.length;
  for (const nome of ['..%2Fx', 'a%20b', '%00', '%E0%A4%A', 'a'.repeat(55)]) {
    for (const [metodo, acao] of [['POST', 'iniciar'], ['POST', 'parar'], ['POST', 'desconectar'], ['GET', 'qr']]) {
      const r = await req(url, '/api/whatsapp/' + nome + '/' + acao, { metodo, corpo: metodo === 'POST' ? { confirmar: true } : undefined, headers: h });
      assert.equal(r.status, 400, nome + ' ' + acao);
    }
  }
  assert.equal(waha.chamadas.length, antes);
});

test('WAHA fora ou chave ausente respondem 503 em português, sem vazar a chave', async (t) => {
  const fora = await logado(t, { fetchWaha: wahaFalso({}, { fora: true }).fetch });
  for (const [metodo, rota] of [['GET', '/api/whatsapp'], ['POST', '/api/whatsapp/boa/iniciar'], ['GET', '/api/whatsapp/boa/qr']]) {
    const r = await req(fora.url, rota, { metodo, corpo: metodo === 'POST' ? {} : undefined, headers: fora.h });
    assert.equal(r.status, 503, rota);
    assert.match(r.dados.erro, /WhatsApp/);
    assert.ok(!r.texto.includes(CHAVE_WAHA));
  }
  const semChave = await logado(t, { wahaChave: '', fetchWaha: wahaFalso({}).fetch });
  assert.equal((await req(semChave.url, '/api/whatsapp', { headers: semChave.h })).status, 503);
});

test('/api/servidor devolve situação do servidor', async (t) => {
  const waha = wahaFalso({});
  const { url, h } = await logado(t, { fetchWaha: waha.fetch, n8nUrl: 'http://n8n:5678' });
  const r = await req(url, '/api/servidor', { headers: h });
  assert.equal(r.status, 200);
  assert.equal(r.dados.whatsapp, true);
  assert.equal(r.dados.n8n, true);
  assert.ok(r.dados.memoria.totalMB > 0 && r.dados.memoria.livreMB >= 0);
  assert.ok(r.dados.disco.totalGB > 0 && r.dados.disco.livreGB >= 0);
  assert.ok(r.dados.ligadoHa > 0);
  const fora = await logado(t, { fetchWaha: wahaFalso({}, { fora: true }).fetch, n8nUrl: 'http://n8n:5678' });
  const f = (await req(fora.url, '/api/servidor', { headers: fora.h })).dados;
  assert.equal(f.whatsapp, false);
  assert.equal(f.n8n, false);
});
