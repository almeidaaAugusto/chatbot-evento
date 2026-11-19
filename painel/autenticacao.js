'use strict';

// Login do painel: senha com hash scrypt, sessões em memória e proteção contra força bruta.
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

function criarAutenticacao({ usuario = 'admin', senhaHash = '', dominio = '', agora = () => Date.now(), atrasar = dormir } = {}) {
  senhaHash = String(senhaHash || '').trim();
  dominio = String(dominio || '').trim().toLowerCase();
  usuario = String(usuario || 'admin').trim() || 'admin';
  if (dominio && !/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(dominio)) throw new Error('PAINEL_DOMINIO precisa ser só o nome do domínio, sem https:// nem porta nem barras.');
  if (dominio && !senhaHash) throw new Error('PAINEL_DOMINIO está definida mas PAINEL_SENHA_HASH não. O painel não sobe aberto na internet sem senha. Gere o hash com: node painel/senha.js');
  if (senhaHash && !lerHash(senhaHash)) throw new Error('PAINEL_SENHA_HASH está em formato inválido. Gere de novo com: node painel/senha.js');
  const obrigatorio = Boolean(senhaHash);
  const sessoes = new Map(); // sha256(token) em hex -> { usuario, criada, ultimoUso }
  const falhasPorIp = new Map(); // ip -> { falhas: [momentos], bloqueadoAte }
  let falhasGlobais = [];

  const chaveDe = (token) => sha256(token).toString('hex');

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

  // Resultado: { ok: true, token } | { ok: false, status: 401 } | { ok: false, status: 429, esperarSegundos }
  async function entrar({ usuario: informado, senha, ip }) {
    ip = String(ip || 'desconhecido');
    limparFalhas();
    const registro = falhasPorIp.get(ip);
    if (registro && registro.bloqueadoAte > agora()) return { ok: false, status: 429, esperarSegundos: Math.ceil((registro.bloqueadoAte - agora()) / 1000) };
    if (falhasGlobais.length >= FALHAS_GLOBAIS) await atrasar(ATRASO_GLOBAL_MS);
    const usuarioCerto = textosIguais(informado, usuario);
    // A senha é sempre conferida (contra o hash falso se o usuário errou), para o tempo ser parecido.
    const senhaCerta = verificarSenha(senha, usuarioCerto ? senhaHash : HASH_FALSO);
    if (!usuarioCerto || !senhaCerta) {
      registrarFalha(ip);
      return { ok: false, status: 401 };
    }
    falhasPorIp.delete(ip);
    limparSessoes();
    if (sessoes.size >= LIMITE_SESSOES) sessoes.delete(sessoes.keys().next().value);
    const token = crypto.randomBytes(32).toString('hex');
    const agoraMs = agora();
    sessoes.set(chaveDe(token), { usuario, criada: agoraMs, ultimoUso: agoraMs });
    return { ok: true, token, usuario };
  }

  // Devolve { usuario } se o cookie traz uma sessão válida (e renova o uso); senão null.
  function sessaoDe(cabecalhoCookie) {
    const token = lerCookie(cabecalhoCookie);
    if (!/^[0-9a-f]{64}$/.test(token)) return null;
    const chave = chaveDe(token);
    const s = sessoes.get(chave);
    if (!s) return null;
    const agoraMs = agora();
    if (agoraMs - s.ultimoUso > OCIOSIDADE_MS || agoraMs - s.criada > TETO_SESSAO_MS) { sessoes.delete(chave); return null; }
    s.ultimoUso = agoraMs;
    return { usuario: s.usuario };
  }

  function sair(cabecalhoCookie) {
    const token = lerCookie(cabecalhoCookie);
    if (/^[0-9a-f]{64}$/.test(token)) sessoes.delete(chaveDe(token));
  }

  // Cookie de sessão. "seguro" = o pedido chegou por HTTPS (ou há domínio configurado).
  function cookie(token, { seguro = false, apagar = false } = {}) {
    const partes = [NOME_COOKIE + '=' + (apagar ? '' : token), 'HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=' + (apagar ? 0 : TETO_SESSAO_MS / 1000)];
    if (seguro || dominio) partes.push('Secure');
    return partes.join('; ');
  }

  return { obrigatorio, usuario, dominio, entrar, sessaoDe, sair, cookie, tamanhoSessoes: () => sessoes.size };
}

module.exports = { criarAutenticacao, gerarHash, verificarSenha, lerHash, lerCookie, textosIguais, MINIMO_SENHA, NOME_COOKIE };
