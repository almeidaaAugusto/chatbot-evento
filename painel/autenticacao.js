'use strict';

// Login do painel: senha com hash scrypt e proteção contra força bruta (em memória).
// Com banco disponível, usuários e sessões ficam no Postgres. Sem banco, vale o usuário do .env
// (PAINEL_USUARIO/PAINEL_SENHA_HASH) como reserva, com sessões em memória e papel admin.
// Formato do hash (sem "$", que o docker compose interpolaria no .env):
//   scrypt:N:r:p:salHex:hashHex   (N=16384, r=8, p=1, sal de 16 bytes, hash de 64 bytes)

const crypto = require('node:crypto');

const PARAMETROS = { N: 16384, r: 8, p: 1 };
const TAMANHO_SAL = 16;
const TAMANHO_HASH = 64;
const MINIMO_SENHA = 12;
const MAXIMO_SENHA = 200;
const OCIOSIDADE_MS = 12 * 3600 * 1000;
const TETO_SESSAO_MS = 7 * 24 * 3600 * 1000;
const JANELA_MS = 15 * 60 * 1000;
const FALHAS_POR_IP = 5;
const FALHAS_GLOBAIS = 30;
const ATRASO_GLOBAL_MS = 1000;
const LIMITE_IPS_RASTREADOS = 10000;
const LIMITE_SESSOES = 1000;
const NOME_COOKIE = 'painel_sessao';

const sha256 = (valor) => crypto.createHash('sha256').update(valor).digest();
const dormir = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Compara dois textos em tempo constante (compara os SHA-256, que têm sempre o mesmo tamanho).
function textosIguais(a, b) {
  return crypto.timingSafeEqual(sha256(String(a)), sha256(String(b)));
}

function gerarHash(senha) {
  if (typeof senha !== 'string' || senha.length < MINIMO_SENHA) throw new Error('A senha precisa ter no mínimo ' + MINIMO_SENHA + ' caracteres.');
  const sal = crypto.randomBytes(TAMANHO_SAL);
  const hash = crypto.scryptSync(senha, sal, TAMANHO_HASH, PARAMETROS);
  return ['scrypt', PARAMETROS.N, PARAMETROS.r, PARAMETROS.p, sal.toString('hex'), hash.toString('hex')].join(':');
}

// Lê e valida o texto do hash. Devolve null se o formato não for o esperado.
function lerHash(texto) {
  if (typeof texto !== 'string') return null;
  const partes = texto.trim().split(':');
  if (partes.length !== 6 || partes[0] !== 'scrypt') return null;
  const [N, r, p] = partes.slice(1, 4).map((valor) => (/^\d{1,8}$/.test(valor) ? Number(valor) : NaN));
  if (!Number.isInteger(N) || N < 2 || (N & (N - 1)) !== 0 || N > 1 << 20 || !Number.isInteger(r) || r < 1 || r > 32 || !Number.isInteger(p) || p < 1 || p > 16) return null;
  if (!/^[0-9a-f]{32}$/i.test(partes[4]) || !/^[0-9a-f]{128}$/i.test(partes[5])) return null;
  return { N, r, p, sal: Buffer.from(partes[4], 'hex'), hash: Buffer.from(partes[5], 'hex') };
}

function verificarSenha(senha, texto) {
  const lido = lerHash(texto);
  if (!lido || typeof senha !== 'string' || senha.length > MAXIMO_SENHA) return false;
  let calculado;
  try { calculado = crypto.scryptSync(senha, lido.sal, lido.hash.length, { N: lido.N, r: lido.r, p: lido.p, maxmem: 256 * lido.N * lido.r }); }
  catch { return false; }
  return crypto.timingSafeEqual(calculado, lido.hash);
}

// Hash descartável usado quando o usuário não existe, para o tempo ser parecido com o de senha errada.
const HASH_FALSO = gerarHash('senha-descartavel-para-igualar-o-tempo');

function lerCookie(cabecalho, nome = NOME_COOKIE) {
  for (const parte of String(cabecalho || '').split(';')) {
    const indice = parte.indexOf('=');
    if (indice > 0 && parte.slice(0, indice).trim() === nome) return parte.slice(indice + 1).trim();
  }
  return '';
}

// "repositorio" é opcional: objeto com disponivel(), usuarios e sessoes (ver painel/db/repositorio.js).
function criarAutenticacao({ usuario = 'admin', senhaHash = '', dominio = '', agora = () => Date.now(), atrasar = dormir, repositorio = null } = {}) {
  senhaHash = String(senhaHash || '').trim();
  dominio = String(dominio || '').trim().toLowerCase();
  usuario = String(usuario || 'admin').trim() || 'admin';
  if (dominio && !/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(dominio)) throw new Error('PAINEL_DOMINIO precisa ser só o nome do domínio, sem https:// nem porta nem barras.');
  if (dominio && !senhaHash) throw new Error('PAINEL_DOMINIO está definida mas PAINEL_SENHA_HASH não. O painel não sobe aberto na internet sem senha. Gere o hash com: node painel/senha.js');
  if (senhaHash && !lerHash(senhaHash)) throw new Error('PAINEL_SENHA_HASH está em formato inválido. Gere de novo com: node painel/senha.js');
  const obrigatorio = Boolean(senhaHash);
  const sessoes = new Map(); // reserva em memória: sha256(token) em hex -> { usuario, criada, ultimoUso }
  const falhasPorIp = new Map(); // ip -> { falhas: [momentos], bloqueadoAte }
  let falhasGlobais = [];

  const chaveDe = (token) => sha256(token).toString('hex');
  const comBanco = () => Boolean(repositorio) && repositorio.disponivel();
  // Falha de banco no meio de uma operação vira "sem banco" (usa a reserva); outros erros sobem.
  const tolerar = (erro) => { if (erro && erro.bancoIndisponivel) return null; throw erro; };

  function limparSessoes() {
    const agoraMs = agora();
    for (const [chave, s] of sessoes) if (agoraMs - s.ultimoUso > OCIOSIDADE_MS || agoraMs - s.criada > TETO_SESSAO_MS) sessoes.delete(chave);
  }

  function limparFalhas() {
    const agoraMs = agora();
    falhasGlobais = falhasGlobais.filter((m) => agoraMs - m < JANELA_MS);
    for (const [ip, e] of falhasPorIp) {
      e.falhas = e.falhas.filter((m) => agoraMs - m < JANELA_MS);
      if (!e.falhas.length && e.bloqueadoAte <= agoraMs) falhasPorIp.delete(ip);
    }
  }

  function registrarFalha(ip) {
    const agoraMs = agora();
    limparFalhas();
    falhasGlobais.push(agoraMs);
    if (!falhasPorIp.has(ip) && falhasPorIp.size >= LIMITE_IPS_RASTREADOS) falhasPorIp.delete(falhasPorIp.keys().next().value);
    const e = falhasPorIp.get(ip) || { falhas: [], bloqueadoAte: 0 };
    e.falhas.push(agoraMs);
    if (e.falhas.length >= FALHAS_POR_IP) e.bloqueadoAte = agoraMs + JANELA_MS;
    falhasPorIp.set(ip, e);
  }

  // Procura o usuário no banco. Devolve { usado: false } se o banco não puder decidir (fora do ar
  // ou ainda sem nenhum usuário), caso em que vale o login do .env.
  async function buscarNoBanco(informado) {
    if (!comBanco()) return { usado: false };
    try {
      const conta = await repositorio.usuarios.porNome(informado);
      if (!conta && (await repositorio.usuarios.contar()) === 0) return { usado: false };
      return { usado: true, conta };
    } catch (erro) { tolerar(erro); return { usado: false }; }
  }

  // Resultado: { ok: true, token, usuario, papel } | { ok: false, status: 401 } | { ok: false, status: 429, esperarSegundos }
  async function entrar({ usuario: informado, senha, ip }) {
    ip = String(ip || 'desconhecido');
    limparFalhas();
    const registro = falhasPorIp.get(ip);
    if (registro && registro.bloqueadoAte > agora()) return { ok: false, status: 429, esperarSegundos: Math.ceil((registro.bloqueadoAte - agora()) / 1000) };
    if (falhasGlobais.length >= FALHAS_GLOBAIS) await atrasar(ATRASO_GLOBAL_MS);
    const noBanco = await buscarNoBanco(informado);
    const token = crypto.randomBytes(32).toString('hex');
    const agoraMs = agora();
    if (noBanco.usado) {
      const conta = noBanco.conta && noBanco.conta.ativo ? noBanco.conta : null;
      // A senha é sempre conferida (contra o hash falso se o usuário não vale), para o tempo ser parecido.
      const senhaCerta = verificarSenha(senha, conta ? conta.senhaHash : HASH_FALSO);
      if (!conta || !senhaCerta) {
        registrarFalha(ip);
        return { ok: false, status: 401 };
      }
      try {
        await repositorio.sessoes.criar({ idHash: chaveDe(token), usuarioId: conta.id, ip, criadaEm: new Date(agoraMs) });
        await repositorio.usuarios.registrarLogin(conta.id, new Date(agoraMs));
      } catch (erro) {
        if (erro && erro.bancoIndisponivel) return { ok: false, status: 503, erro: erro.message };
        throw erro;
      }
      falhasPorIp.delete(ip);
      return { ok: true, token, usuario: conta.usuario, papel: conta.papel };
    }
    // Reserva: usuário e hash do .env, sessão em memória, papel admin.
    const usuarioCerto = textosIguais(informado, usuario);
    const senhaCerta = verificarSenha(senha, usuarioCerto ? senhaHash : HASH_FALSO);
    if (!usuarioCerto || !senhaCerta) {
      registrarFalha(ip);
      return { ok: false, status: 401 };
    }
    falhasPorIp.delete(ip);
    limparSessoes();
    if (sessoes.size >= LIMITE_SESSOES) sessoes.delete(sessoes.keys().next().value);
    sessoes.set(chaveDe(token), { usuario, criada: agoraMs, ultimoUso: agoraMs });
    return { ok: true, token, usuario, papel: 'admin' };
  }

  // Devolve { usuario, papel, usuarioId } se o cookie traz uma sessão válida (e renova o uso); senão null.
  async function sessaoDe(cabecalhoCookie) {
    const token = lerCookie(cabecalhoCookie);
    if (!/^[0-9a-f]{64}$/.test(token)) return null;
    const chave = chaveDe(token);
    const agoraMs = agora();
    const s = sessoes.get(chave);
    if (s) {
      if (agoraMs - s.ultimoUso > OCIOSIDADE_MS || agoraMs - s.criada > TETO_SESSAO_MS) { sessoes.delete(chave); return null; }
      s.ultimoUso = agoraMs;
      return { usuario: s.usuario, papel: 'admin', usuarioId: null };
    }
    if (!comBanco()) return null;
    try {
      const d = await repositorio.sessoes.buscar(chave);
      if (!d || !d.ativo) return null;
      const criada = new Date(d.criadaEm).getTime();
      const ultimo = new Date(d.ultimoUso).getTime();
      if (agoraMs - ultimo > OCIOSIDADE_MS || agoraMs - criada > TETO_SESSAO_MS) { await repositorio.sessoes.remover(chave); return null; }
      // Só grava o novo "último uso" a cada minuto, para não escrever no banco a cada requisição.
      if (agoraMs - ultimo > 60 * 1000) await repositorio.sessoes.tocar(chave, new Date(agoraMs));
      return { usuario: d.usuario, papel: d.papel, usuarioId: d.usuarioId };
    } catch (erro) { return tolerar(erro); }
  }

  async function sair(cabecalhoCookie) {
    const token = lerCookie(cabecalhoCookie);
    if (!/^[0-9a-f]{64}$/.test(token)) return;
    const chave = chaveDe(token);
    sessoes.delete(chave);
    if (!comBanco()) return;
    try { await repositorio.sessoes.remover(chave); } catch (erro) { tolerar(erro); }
  }

  // Apaga do banco as sessões vencidas (chamado de tempos em tempos pelo servidor).
  async function limparSessoesDoBanco() {
    if (!comBanco()) return 0;
    const agoraMs = agora();
    try { return await repositorio.sessoes.limpar({ ociosasAntes: new Date(agoraMs - OCIOSIDADE_MS), criadasAntes: new Date(agoraMs - TETO_SESSAO_MS) }); }
    catch (erro) { tolerar(erro); return 0; }
  }

  // Cookie de sessão. "seguro" = o pedido chegou por HTTPS (ou há domínio configurado).
  function cookie(token, { seguro = false, apagar = false } = {}) {
    const partes = [NOME_COOKIE + '=' + (apagar ? '' : token), 'HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=' + (apagar ? 0 : TETO_SESSAO_MS / 1000)];
    if (seguro || dominio) partes.push('Secure');
    return partes.join('; ');
  }

  return { obrigatorio, usuario, dominio, entrar, sessaoDe, sair, cookie, limparSessoesDoBanco, tamanhoSessoes: () => sessoes.size };
}

module.exports = { criarAutenticacao, gerarHash, verificarSenha, lerHash, lerCookie, textosIguais, MINIMO_SENHA, NOME_COOKIE };
