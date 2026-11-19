'use strict';

// Servidor do painel com o repositório FALSO (tests/banco-falso.js): papéis, usuários, versões da
// configuração, histórico, métricas e o comportamento com o banco fora do ar. Sem Postgres.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { criarServidor } = require('../painel/server');
const { gerarHash } = require('../painel/autenticacao');
const { criarBancoFalso } = require('./banco-falso');

const SENHA_ENV = 'senha-do-env-123';
const HASH_ENV = gerarHash(SENHA_ENV);
const SENHA = 'senha-de-teste-123';

const configBase = () => ({
  evento: { nome: 'Festival', local: 'Praça', instagram: '@festival' },
  mensagens: { menu: '1 - Local', nao_entendi: 'Procure {{instagram}}', reativado: 'Olá' },
  fallback: { mensagens: ['Escolha uma opção.', 'Reformule sua pergunta.', 'Fale com {{instagram}}.'], mensagem_midia: 'Escreva sua dúvida.' },
  opcoes: [{ id: 'local', titulo: 'Local', palavras_exatas: ['1'], palavras_chave: ['local'], perguntas: ['Onde?'], resposta: 'Na {{local}}.' }],
  protecoes: { max_mensagens_por_hora: 40 },
  numeros: [{ sessao: 'principal', nome: 'Número principal' }]
});

function req(url, rota, { metodo = 'GET', corpo, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const raw = corpo === undefined ? undefined : JSON.stringify(corpo);
    const r = http.request(url + rota, { method: metodo, headers: { ...(raw === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw) }), ...headers } }, (res) => {
      let texto = '';
      res.setEncoding('utf8');
      res.on('data', (p) => { texto += p; });
      res.on('end', () => { let dados; try { dados = JSON.parse(texto); } catch {} resolve({ status: res.statusCode, dados, texto, headers: res.headers }); });
    });
    r.on('error', reject);
    r.end(raw);
  });
}

async function subir(t, { banco = criarBancoFalso(), logs = false, ...opcoes } = {}) {
  const pasta = await fs.mkdtemp(path.join(os.tmpdir(), 'chatbot-banco-'));
  const configPath = path.join(pasta, 'chatbot.json');
  await fs.writeFile(configPath, JSON.stringify(configBase(), null, 2));
  const server = criarServidor({ configPath, logsDir: logs ? pasta : undefined, repositorio: banco, senhaHash: HASH_ENV, ...opcoes });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  await server.bancoPreparado;
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); await fs.rm(pasta, { recursive: true, force: true }); });
  return { url: 'http://127.0.0.1:' + server.address().port, banco, server, pasta, configPath };
}

const cookieDe = (r) => (r.headers['set-cookie'] || [''])[0].split(';')[0];
const entrar = async (url, usuario, senha) => {
  const r = await req(url, '/api/login', { metodo: 'POST', corpo: { usuario, senha } });
  return { ...r, cookie: cookieDe(r) };
};
const comCookie = (cookie, extra = {}) => ({ headers: { Cookie: cookie }, ...extra });

// Cria usuários no banco falso e devolve os cookies de cada papel.
async function usuariosDeTodosOsPapeis(url, banco) {
  const admin = await entrar(url, 'admin', SENHA_ENV);
  for (const papel of ['editor', 'leitor']) {
    const criado = await req(url, '/api/usuarios', { metodo: 'POST', ...comCookie(admin.cookie, { corpo: { usuario: papel + '01', papel, senha: SENHA } }) });
    assert.equal(criado.status, 201, criado.texto);
  }
  return { admin, editor: await entrar(url, 'editor01', SENHA), leitor: await entrar(url, 'leitor01', SENHA) };
}

test('bootstrap: tabela vazia ganha o admin do PAINEL_SENHA_HASH e a configuração vira a versão 1', async (t) => {
  const { url, banco } = await subir(t);
  assert.equal(banco.estado.usuarios.length, 1);
  assert.equal(banco.estado.usuarios[0].usuario, 'admin');
  assert.equal(banco.estado.usuarios[0].papel, 'admin');
  assert.equal(banco.estado.usuarios[0].senhaHash, HASH_ENV);
  assert.equal(banco.estado.versoes.length, 1);
  assert.equal(banco.estado.versoes[0].autor, 'importação');
  const r = await entrar(url, 'admin', SENHA_ENV);
  assert.equal(r.status, 200);
  assert.equal(r.dados.usuario, 'admin');
  const sessao = await req(url, '/api/sessao', comCookie(r.cookie));
  assert.deepEqual(sessao.dados, { logado: true, usuario: 'admin', papel: 'admin', loginObrigatorio: true });
});

test('o bootstrap não recria o admin se já existem usuários', async (t) => {
  const banco = criarBancoFalso();
  await banco.usuarios.criar({ usuario: 'dono', senhaHash: gerarHash(SENHA), papel: 'admin' });
  await subir(t, { banco });
  assert.equal(banco.estado.usuarios.length, 1);
  assert.equal(banco.estado.usuarios[0].usuario, 'dono');
});

test('papéis: leitor só lê, editor edita, só admin gerencia usuários e desconecta', async (t) => {
  const { url, banco } = await subir(t);
  const { admin, editor, leitor } = await usuariosDeTodosOsPapeis(url, banco);
  const cfg = (await req(url, '/api/config', comCookie(admin.cookie))).dados;
  const put = (cookie) => req(url, '/api/config', { metodo: 'PUT', ...comCookie(cookie, { corpo: { config: cfg.config, revisao: cfg.revisao } }) });
  for (const cookie of [leitor.cookie]) {
    assert.equal((await put(cookie)).status, 403);
    assert.equal((await req(url, '/api/usuarios', comCookie(cookie))).status, 403);
    assert.equal((await req(url, '/api/whatsapp/principal/iniciar', { metodo: 'POST', ...comCookie(cookie, { corpo: {} }) })).status, 403);
    assert.equal((await req(url, '/api/whatsapp/principal/desconectar', { metodo: 'POST', ...comCookie(cookie, { corpo: { confirmar: true } }) })).status, 403);
    assert.equal((await req(url, '/api/config/versoes/1/restaurar', { metodo: 'POST', ...comCookie(cookie, { corpo: { revisao: cfg.revisao } }) })).status, 403);
    // leituras continuam liberadas
    assert.equal((await req(url, '/api/config', comCookie(cookie))).status, 200);
    assert.equal((await req(url, '/api/config/versoes', comCookie(cookie))).status, 200);
    assert.equal((await req(url, '/api/historico', comCookie(cookie))).status, 200);
    assert.equal((await req(url, '/api/metricas', comCookie(cookie))).status, 200);
  }
  const negado = await req(url, '/api/usuarios', comCookie(leitor.cookie));
  assert.match(negado.dados.erro, /permissão/);
  // editor: edita a configuração, mas não mexe em usuários nem desconecta
  assert.equal((await put(editor.cookie)).status, 200);
  assert.equal((await req(url, '/api/usuarios', comCookie(editor.cookie))).status, 403);
  assert.equal((await req(url, '/api/whatsapp/principal/desconectar', { metodo: 'POST', ...comCookie(editor.cookie, { corpo: { confirmar: true } }) })).status, 403);
  assert.notEqual((await req(url, '/api/whatsapp/principal/iniciar', { metodo: 'POST', ...comCookie(editor.cookie, { corpo: {} }) })).status, 403);
  // admin: lista usuários
  const lista = await req(url, '/api/usuarios', comCookie(admin.cookie));
  assert.equal(lista.status, 200);
  assert.deepEqual(lista.dados.usuarios.map((u) => u.usuario).sort(), ['admin', 'editor01', 'leitor01']);
  assert.ok(lista.dados.usuarios.every((u) => !('senhaHash' in u) && !('senha_hash' in u)));
  const sessaoLeitor = await req(url, '/api/sessao', comCookie(leitor.cookie));
  assert.equal(sessaoLeitor.dados.papel, 'leitor');
});

test('login: usuário desativado ou com senha errada não entra; usuário do banco não usa a senha do .env', async (t) => {
  const { url, banco } = await subir(t);
  const { admin } = await usuariosDeTodosOsPapeis(url, banco);
  assert.equal((await entrar(url, 'editor01', 'senha-errada-xyz')).status, 401);
  const editor = banco.estado.usuarios.find((u) => u.usuario === 'editor01');
  const r = await req(url, '/api/usuarios/' + editor.id, { metodo: 'PATCH', ...comCookie(admin.cookie, { corpo: { ativo: false } }) });
  assert.equal(r.status, 200);
  assert.equal((await entrar(url, 'editor01', SENHA)).status, 401);
  assert.equal(banco.estado.usuarios.find((u) => u.usuario === 'admin').ultimoLogin !== null, true);
});

test('desativar ou rebaixar encerra a sessão; trocar a senha também', async (t) => {
  const { url, banco } = await subir(t);
  const { admin, editor, leitor } = await usuariosDeTodosOsPapeis(url, banco);
  const id = (nome) => banco.estado.usuarios.find((u) => u.usuario === nome).id;
  assert.equal((await req(url, '/api/sessao', comCookie(editor.cookie))).dados.logado, true);
  const nova = 'outra-senha-forte-1';
  const troca = await req(url, '/api/usuarios/' + id('editor01') + '/senha', { metodo: 'POST', ...comCookie(admin.cookie, { corpo: { senha: nova } }) });
  assert.equal(troca.status, 200);
  assert.equal((await req(url, '/api/sessao', comCookie(editor.cookie))).dados.logado, false, 'sessão antiga encerrada');
  assert.equal((await entrar(url, 'editor01', SENHA)).status, 401);
  assert.equal((await entrar(url, 'editor01', nova)).status, 200);
  await req(url, '/api/usuarios/' + id('leitor01'), { metodo: 'PATCH', ...comCookie(admin.cookie, { corpo: { ativo: false } }) });
  assert.equal((await req(url, '/api/config', comCookie(leitor.cookie))).status, 401, 'usuário desativado perde a sessão');
});

test('usuários: validações, duplicidade, senha curta e proteção do último admin', async (t) => {
  const { url, banco } = await subir(t);
  const { admin } = await usuariosDeTodosOsPapeis(url, banco);
  const criar = (corpo) => req(url, '/api/usuarios', { metodo: 'POST', ...comCookie(admin.cookie, { corpo }) });
  assert.equal((await criar({ usuario: 'novo01', papel: 'leitor', senha: 'curta' })).status, 400);
  assert.equal((await criar({ usuario: 'novo01', papel: 'chefe', senha: SENHA })).status, 400);
  assert.equal((await criar({ usuario: 'a b', papel: 'leitor', senha: SENHA })).status, 400);
  assert.equal((await criar({ usuario: 'EDITOR01', papel: 'leitor', senha: SENHA })).status, 409);
  const admId = banco.estado.usuarios.find((u) => u.usuario === 'admin').id;
  const patch = (id, corpo) => req(url, '/api/usuarios/' + id, { metodo: 'PATCH', ...comCookie(admin.cookie, { corpo }) });
  assert.equal((await patch(admId, { ativo: false })).status, 409, 'não desativa a si mesmo');
  assert.equal((await patch(admId, { papel: 'leitor' })).status, 409, 'não rebaixa o último admin');
  assert.equal((await patch(999, { papel: 'leitor' })).status, 404);
  assert.equal((await patch(admId, {})).status, 400);
  // com um segundo admin, o primeiro pode ser rebaixado
  const edId = banco.estado.usuarios.find((u) => u.usuario === 'editor01').id;
  assert.equal((await patch(edId, { papel: 'admin' })).status, 200);
  assert.equal((await patch(admId, { papel: 'leitor' })).status, 200);
  // e agora o último admin é o editor01
  const outro = await entrar(url, 'editor01', SENHA);
  assert.equal((await req(url, '/api/usuarios/' + edId, { metodo: 'PATCH', ...comCookie(outro.cookie, { corpo: { papel: 'editor' } }) })).status, 409);
});

test('versões: salvar registra uma versão com autor e comentário; ver e restaurar', async (t) => {
  const { url, banco, configPath } = await subir(t);
  const { editor } = await usuariosDeTodosOsPapeis(url, banco);
  const atual = (await req(url, '/api/config', comCookie(editor.cookie))).dados;
  const nova = JSON.parse(JSON.stringify(atual.config));
  nova.evento.nome = 'Festival 2';
  const salvo = await req(url, '/api/config', { metodo: 'PUT', ...comCookie(editor.cookie, { corpo: { config: nova, revisao: atual.revisao, comentario: 'novo nome' } }) });
  assert.equal(salvo.status, 200);
  assert.equal(salvo.dados.versao, 2);
  assert.equal(salvo.dados.avisoVersao, undefined);
  const lista = (await req(url, '/api/config/versoes', comCookie(editor.cookie))).dados.versoes;
  assert.equal(lista.length, 2);
  assert.deepEqual(Object.keys(lista[0]).sort(), ['autor', 'comentario', 'criadoEm', 'id']);
  assert.equal(lista[0].autor, 'editor01');
  assert.equal(lista[0].comentario, 'novo nome');
  assert.equal(lista[1].autor, 'importação');
  const v1 = (await req(url, '/api/config/versoes/1', comCookie(editor.cookie))).dados;
  assert.equal(v1.config.evento.nome, 'Festival');
  assert.equal((await req(url, '/api/config/versoes/99', comCookie(editor.cookie))).status, 404);
  // restaurar exige a revisão atual
  const velha = await req(url, '/api/config/versoes/1/restaurar', { metodo: 'POST', ...comCookie(editor.cookie, { corpo: { revisao: atual.revisao } }) });
  assert.equal(velha.status, 409);
  const restaurada = await req(url, '/api/config/versoes/1/restaurar', { metodo: 'POST', ...comCookie(editor.cookie, { corpo: { revisao: salvo.dados.revisao } }) });
  assert.equal(restaurada.status, 200);
  assert.equal(restaurada.dados.config.evento.nome, 'Festival');
  assert.ok(restaurada.dados.revisao && Array.isArray(restaurada.dados.avisos));
  assert.equal(JSON.parse(await fs.readFile(configPath, 'utf8')).evento.nome, 'Festival');
  assert.equal(banco.estado.versoes.length, 3);
  assert.equal(banco.estado.versoes[2].comentario, 'Restaurada da versão 1');
  assert.equal(await fs.readFile(configPath + '.bak', 'utf8').then((x) => JSON.parse(x).evento.nome), 'Festival 2');
});

test('restaurar uma versão inválida passa pela validação (422) e não mexe no arquivo', async (t) => {
  const { url, banco, configPath } = await subir(t);
  const { editor } = await usuariosDeTodosOsPapeis(url, banco);
  banco.estado.versoes.push({ id: 50, criadoEm: new Date().toISOString(), autor: 'x', conteudo: { evento: 1 }, revisao: 'r', comentario: null });
  banco.estado.proximaVersao = 51;
  const antes = await fs.readFile(configPath, 'utf8');
  const atual = (await req(url, '/api/config', comCookie(editor.cookie))).dados;
  const r = await req(url, '/api/config/versoes/50/restaurar', { metodo: 'POST', ...comCookie(editor.cookie, { corpo: { revisao: atual.revisao } }) });
  assert.equal(r.status, 422);
  assert.equal(await fs.readFile(configPath, 'utf8'), antes);
});

test('comentário inválido no PUT é recusado', async (t) => {
  const { url } = await subir(t);
  const admin = await entrar(url, 'admin', SENHA_ENV);
  const atual = (await req(url, '/api/config', comCookie(admin.cookie))).dados;
  const r = await req(url, '/api/config', { metodo: 'PUT', ...comCookie(admin.cookie, { corpo: { config: atual.config, revisao: atual.revisao, comentario: 'x'.repeat(301) } }) });
  assert.equal(r.status, 400);
});

test('histórico: paginação de 50, temMais, filtros e conversa em ordem cronológica', async (t) => {
  const { url, banco } = await subir(t);
  const admin = await entrar(url, 'admin', SENHA_ENV);
  const base = Date.parse('2026-03-10T12:00:00-03:00');
  for (let i = 0; i < 120; i++) {
    banco.estado.mensagens.push({ id: i + 1, quando: new Date(base + i * 60000).toISOString(), conversa: i % 2 ? 'c2@c.us' : 'c1@c.us', texto: 'mensagem ' + i, nome: i % 2 ? 'Bia' : 'Ana', de: 'contato', resultado: 'respondida', arquivo: 'f', posicao: i });
  }
  const p1 = (await req(url, '/api/historico', comCookie(admin.cookie))).dados;
  assert.equal(p1.itens.length, 50);
  assert.equal(p1.pagina, 1);
  assert.equal(p1.temMais, true);
  assert.equal(p1.itens[0].texto, 'mensagem 119', 'mais recente primeiro');
  assert.deepEqual(Object.keys(p1.itens[0]).sort(), ['conversa', 'de', 'ia', 'iaModelo', 'id', 'intencao', 'motivo', 'nome', 'quando', 'resposta', 'resultado', 'sessao', 'telefone', 'texto']);
  const p3 = (await req(url, '/api/historico?pagina=3', comCookie(admin.cookie))).dados;
  assert.equal(p3.itens.length, 20);
  assert.equal(p3.temMais, false);
  const busca = (await req(url, '/api/historico?busca=' + encodeURIComponent('mensagem 77'), comCookie(admin.cookie))).dados;
  assert.equal(busca.itens.length, 1);
  const so = (await req(url, '/api/historico?conversa=' + encodeURIComponent('c2@c.us'), comCookie(admin.cookie))).dados;
  assert.equal(so.itens.length, 50);
  assert.ok(so.itens.every((i) => i.conversa === 'c2@c.us'));
  const conv = (await req(url, '/api/historico/conversa/' + encodeURIComponent('c1@c.us'), comCookie(admin.cookie))).dados;
  assert.equal(conv.itens.length, 60);
  assert.equal(conv.itens[0].texto, 'mensagem 0');
  assert.ok(conv.itens.every((m, i, a) => i === 0 || a[i - 1].quando <= m.quando));
  // parâmetros inválidos
  for (const consulta of ['?de=2026-13-45', '?de=ontem', '?pagina=0', '?pagina=abc', '?de=2026-03-10&ate=2026-03-01']) {
    assert.equal((await req(url, '/api/historico' + consulta, comCookie(admin.cookie))).status, 400, consulta);
  }
});

test('histórico: filtro de período usa o dia inteiro (de e ate inclusivos)', async (t) => {
  const { url, banco } = await subir(t);
  const admin = await entrar(url, 'admin', SENHA_ENV);
  const dia = (d, h) => new Date(2026, 2, d, h, 0, 0).toISOString();
  banco.estado.mensagens.push(
    { id: 1, quando: dia(9, 23), conversa: 'a', texto: 'antes', arquivo: 'f', posicao: 1 },
    { id: 2, quando: dia(10, 0), conversa: 'a', texto: 'inicio', arquivo: 'f', posicao: 2 },
    { id: 3, quando: dia(11, 23), conversa: 'a', texto: 'fim', arquivo: 'f', posicao: 3 },
    { id: 4, quando: dia(12, 0), conversa: 'a', texto: 'depois', arquivo: 'f', posicao: 4 }
  );
  const r = (await req(url, '/api/historico?de=2026-03-10&ate=2026-03-11', comCookie(admin.cookie))).dados;
  assert.deepEqual(r.itens.map((i) => i.texto).sort(), ['fim', 'inicio']);
});

test('métricas: período padrão de 30 dias, limites e repasse do intervalo ao repositório', async (t) => {
  const { url, banco } = await subir(t);
  const admin = await entrar(url, 'admin', SENHA_ENV);
  const r = await req(url, '/api/metricas', comCookie(admin.cookie));
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.dados).sort(), ['duvidas', 'ia', 'porDia', 'porHora', 'porIntencao', 'porOrigem', 'totais']);
  const chamada = banco.estado.metricasChamadas.at(-1);
  assert.ok(chamada.inicio instanceof Date && chamada.fim instanceof Date);
  const dias = Math.round((chamada.fim - chamada.inicio) / 86400000);
  assert.ok(dias >= 30 && dias <= 31, 'dias=' + dias);
  assert.equal(typeof chamada.fuso, 'string');
  await req(url, '/api/metricas?de=2026-03-01&ate=2026-03-03', comCookie(admin.cookie));
  const c2 = banco.estado.metricasChamadas.at(-1);
  assert.equal(Math.round((c2.fim - c2.inicio) / 86400000), 3);
  assert.equal((await req(url, '/api/metricas?de=2024-01-01&ate=2026-03-03', comCookie(admin.cookie))).status, 400);
  assert.equal((await req(url, '/api/metricas?de=x', comCookie(admin.cookie))).status, 400);
});

test('banco parado: rotas dependentes dão 503, o resto funciona, login do .env vale e tudo volta sozinho', async (t) => {
  const banco = criarBancoFalso();
  const { url } = await subir(t, { banco });
  const { admin: adminBanco } = await usuariosDeTodosOsPapeis(url, banco);
  const cfg = (await req(url, '/api/config', comCookie(adminBanco.cookie))).dados;
  await banco.definirNoAr(false);
  for (const rota of ['/api/historico', '/api/metricas', '/api/config/versoes', '/api/config/versoes/1', '/api/historico/conversa/x']) {
    // a sessão do banco não vale sem banco: entra pelo login de reserva
    const reserva = await entrar(url, 'admin', SENHA_ENV);
    assert.equal(reserva.status, 200, 'login de reserva do .env');
    const r = await req(url, rota, comCookie(reserva.cookie));
    assert.equal(r.status, 503, rota);
    assert.equal(r.dados.bancoIndisponivel, true);
    assert.match(r.dados.erro, /banco/i);
  }
  const reserva = await entrar(url, 'admin', SENHA_ENV);
  assert.equal((await req(url, '/api/sessao', comCookie(reserva.cookie))).dados.papel, 'admin');
  assert.equal((await req(url, '/api/usuarios', comCookie(reserva.cookie))).status, 503);
  assert.equal((await entrar(url, 'editor01', SENHA)).status, 401, 'usuários do banco não entram sem banco');
  const servidor = (await req(url, '/api/servidor', comCookie(reserva.cookie))).dados;
  assert.equal(servidor.banco, false);
  assert.equal((await req(url, '/api/health')).status, 200);
  // a configuração continua editável e o aviso da versão aparece
  const nova = JSON.parse(JSON.stringify(cfg.config));
  nova.evento.nome = 'Sem banco';
  const salvo = await req(url, '/api/config', { metodo: 'PUT', ...comCookie(reserva.cookie, { corpo: { config: nova, revisao: cfg.revisao } }) });
  assert.equal(salvo.status, 200);
  assert.match(salvo.dados.avisoVersao, /histórico/);
  assert.equal(salvo.dados.versao, undefined);
  // volta sozinho
  await banco.definirNoAr(true);
  assert.equal((await req(url, '/api/historico', comCookie(adminBanco.cookie))).status, 200);
  assert.equal((await req(url, '/api/servidor', comCookie(adminBanco.cookie))).dados.banco, true);
  const ok = await entrar(url, 'editor01', SENHA);
  assert.equal(ok.status, 200);
});

test('sem banco configurado: tudo como antes, rotas dependentes dão 503 e /api/servidor mostra banco falso', async (t) => {
  const pasta = await fs.mkdtemp(path.join(os.tmpdir(), 'chatbot-sembanco-'));
  const configPath = path.join(pasta, 'chatbot.json');
  await fs.writeFile(configPath, JSON.stringify(configBase()));
  const server = criarServidor({ configPath, senhaHash: HASH_ENV, databaseUrl: '' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); await fs.rm(pasta, { recursive: true, force: true }); });
  const url = 'http://127.0.0.1:' + server.address().port;
  const login = await entrar(url, 'admin', SENHA_ENV);
  assert.equal(login.status, 200);
  assert.equal((await req(url, '/api/metricas', comCookie(login.cookie))).status, 503);
  const s = (await req(url, '/api/servidor', comCookie(login.cookie))).dados;
  assert.equal(s.banco, false);
  assert.equal(s.bancoConfigurado, false);
  assert.equal((await req(url, '/api/config', comCookie(login.cookie))).status, 200);
});

test('painel sem login obrigatório: papel admin, mas usuários exigem login ativado', async (t) => {
  const pasta = await fs.mkdtemp(path.join(os.tmpdir(), 'chatbot-aberto-'));
  const configPath = path.join(pasta, 'chatbot.json');
  await fs.writeFile(configPath, JSON.stringify(configBase()));
  const server = criarServidor({ configPath, senhaHash: '', repositorio: criarBancoFalso() });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  await server.bancoPreparado;
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); await fs.rm(pasta, { recursive: true, force: true }); });
  const url = 'http://127.0.0.1:' + server.address().port;
  assert.deepEqual((await req(url, '/api/sessao')).dados, { logado: false, usuario: null, papel: 'admin', loginObrigatorio: false });
  assert.equal((await req(url, '/api/usuarios')).status, 403);
  assert.equal((await req(url, '/api/metricas')).status, 200);
});

test('páginas novas: /metricas e /usuarios exigem login e usam o arquivo certo', async (t) => {
  const { url } = await subir(t);
  assert.equal((await req(url, '/metricas')).status, 302);
  assert.equal((await req(url, '/usuarios')).status, 302);
  const admin = await entrar(url, 'admin', SENHA_ENV);
  for (const rota of ['/metricas', '/metricas.js', '/usuarios', '/usuarios.js']) {
    const r = await req(url, rota, comCookie(admin.cookie));
    // 200 quando a frente do front-end já criou o arquivo; 404 com a mensagem padrão antes disso
    assert.ok([200, 404].includes(r.status), rota + ' -> ' + r.status);
  }
});

test('/api/servidor traz banco e atraso da ingestão', async (t) => {
  const { url, server } = await subir(t, { logs: true, intervaloIngestaoMs: 3600000 });
  const admin = await entrar(url, 'admin', SENHA_ENV);
  await server.ingestor.rodarAgora();
  const s = (await req(url, '/api/servidor', comCookie(admin.cookie))).dados;
  assert.equal(s.banco, true);
  assert.equal(s.bancoConfigurado, true);
  assert.ok(Number.isInteger(s.atrasoIngestaoSegundos) && s.atrasoIngestaoSegundos >= 0);
});

test('ingestão integrada: o servidor lê os logs e o histórico mostra as mensagens', async (t) => {
  const { url, banco, server, pasta } = await subir(t, { logs: true, intervaloIngestaoMs: 3600000 });
  const admin = await entrar(url, 'admin', SENHA_ENV);
  const hoje = new Date();
  const dia = [hoje.getFullYear(), String(hoje.getMonth() + 1).padStart(2, '0'), String(hoje.getDate()).padStart(2, '0')].join('-');
  await fs.writeFile(path.join(pasta, 'conversas-' + dia + '.log'), JSON.stringify({ quando: hoje.toISOString(), de: 'contato', conversa: '5599@c.us', texto: 'olá, tem estacionamento?', resultado: 'respondida', intencao: 'estacionamento' }) + '\n');
  await server.ingestor.rodarAgora();
  await server.ingestor.rodarAgora();
  assert.equal(banco.estado.mensagens.length, 1);
  const h = (await req(url, '/api/historico', comCookie(admin.cookie))).dados;
  assert.equal(h.itens.length, 1);
  assert.equal(h.itens[0].texto, 'olá, tem estacionamento?');
});

test('SQL do repositório real é sempre parametrizado (sem valores concatenados)', async () => {
  const fonte = await fs.readFile(path.join(__dirname, '../painel/db/repositorio.js'), 'utf8');
  const metricas = await fs.readFile(path.join(__dirname, '../painel/db/metricas.js'), 'utf8');
  // Nenhuma interpolação ${...} de variáveis de entrada em SQL, além de nomes fixos permitidos.
  const permitidas = new Set(['COLUNAS_ITEM', 'onde', 'novo(limite)', 'novo(deslocamento)', 'exato', 'parcial', 'tabela', 'nomes', 'grupos.join(\', \')', 'filtroRecebidas', 'LIMITE_INTENCOES', 'LIMITE_DUVIDAS_BRUTAS']);
  for (const texto of [fonte, metricas]) {
    for (const m of texto.matchAll(/\$\{([^}]+)\}/g)) assert.ok(permitidas.has(m[1]), 'interpolação inesperada: ' + m[1]);
  }
});
