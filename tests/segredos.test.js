'use strict';

// Guarda de segredos: varre os arquivos versionados (ou, sem git, a árvore do projeto) procurando
// chaves, hashes, IPs públicos e identificadores reais que não podem ir para o repositório.
// Falhas listam arquivo:linha e o TIPO do padrão, nunca o valor encontrado.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const ESTE_ARQUIVO = 'tests/segredos.test.js';
const TAMANHO_MAXIMO = 2 * 1024 * 1024;
const EXTENSOES_BINARIAS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.bmp', '.pdf', '.zip', '.gz', '.tgz', '.tar', '.7z', '.rar', '.woff', '.woff2', '.ttf', '.otf', '.eot', '.mp3', '.mp4', '.exe', '.dll', '.so', '.bin']);
const PASTAS_IGNORADAS = new Set(['.git', 'node_modules', 'logs', 'backups', 'data', 'dados', 'volumes', '.claude']);
const IPV4 = /(?<![\d.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\d.]*\d)/g;

function ocorrencias(linha, regex) {
  return [...linha.matchAll(regex)];
}

function ipv4EhPermitido([a, b, c, d]) {
  if (a === 10 || a === 127 || a === 255) return true;
  if (a === 0 && b === 0 && c === 0 && d === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 192 && b === 0 && c === 2) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  return false;
}

function sslipEhPermitido(dominio) {
  return dominio === '203-0-113-10.sslip.io' || /^(192-0-2|198-51-100)-\d+\.sslip\.io$/.test(dominio);
}

// Cada detector recebe uma linha e o caminho relativo do arquivo e devolve a lista de tipos achados.
const DETECTORES = [
  {
    categoria: 'chave-groq-xai',
    detectar: linha => [
      ...ocorrencias(linha, /gsk_[A-Za-z0-9]{20,}/g).map(() => 'chave Groq (gsk_)'),
      ...ocorrencias(linha, /xai-[A-Za-z0-9]{20,}/g).map(() => 'chave xAI (xai-)')
    ]
  },
  {
    categoria: 'chave-privada',
    detectar: linha => ocorrencias(linha, /-----BEGIN [A-Z ]*PRIVATE KEY/g).map(() => 'bloco de chave privada PEM')
  },
  {
    categoria: 'ocid',
    detectar: linha => ocorrencias(linha, /ocid1\./g).map(() => 'OCID da Oracle Cloud')
  },
  {
    categoria: 'hash-scrypt',
    detectar: (linha, rel) => rel.startsWith('tests/')
      ? []
      : ocorrencias(linha, /scrypt:\d+:\d+:\d+:[0-9a-f]{32}:[0-9a-f]{128}/g).map(() => 'hash scrypt de senha')
  },
  {
    categoria: 'ipv4-publico',
    detectar: linha => ocorrencias(linha, IPV4)
      .filter(m => { const o = m.slice(1, 5).map(Number); return o.every(x => x <= 255) && !ipv4EhPermitido(o); })
      .map(() => 'IPv4 publico')
  },
  {
    categoria: 'sslip',
    detectar: linha => ocorrencias(linha, /\d+-\d+-\d+-\d+\.sslip\.io/g)
      .filter(m => !sslipEhPermitido(m[0]))
      .map(() => 'dominio sslip.io com IP publico')
  },
  {
    categoria: 'wa-me',
    detectar: (linha, rel) => rel.startsWith('tests/')
      ? []
      : ocorrencias(linha, /wa\.me\/(\d+)/g)
        .filter(m => !/^55(0{9,})\d{0,2}$/.test(m[1]))
        .map(() => 'link wa.me com numero real')
  }
];

function achadosDaLinha(linha, rel) {
  const achados = [];
  for (const d of DETECTORES) {
    for (const tipo of d.detectar(linha, rel)) achados.push({ categoria: d.categoria, tipo });
  }
  return achados;
}

function normalizar(caminho) {
  return caminho.replace(/\\/g, '/');
}

// Padrões simples do .gitignore (sem glob): nome exato ou prefixo de pasta.
function padroesGitignoreSimples() {
  let texto;
  try {
    texto = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  } catch {
    return [];
  }
  return texto.split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#') && !l.startsWith('!') && !/[*?[\]]/.test(l))
    .map(l => l.replace(/^\/+/, '').replace(/\/+$/, ''))
    .filter(Boolean);
}

function ignoradoNoGitignore(rel, padroes) {
  const partes = rel.split('/');
  return padroes.some(p => rel === p || rel.startsWith(p + '/') || (!p.includes('/') && partes.includes(p)));
}

function listarArvore() {
  const padroes = padroesGitignoreSimples();
  const arquivos = [];
  const percorrer = (absDir, rel) => {
    for (const entrada of fs.readdirSync(absDir, { withFileTypes: true })) {
      const nome = entrada.name;
      const relFilho = rel ? rel + '/' + nome : nome;
      if (ignoradoNoGitignore(relFilho, padroes)) continue;
      if (entrada.isDirectory()) {
        if (PASTAS_IGNORADAS.has(nome)) continue;
        percorrer(path.join(absDir, nome), relFilho);
      } else if (entrada.isFile()) {
        if (nome === '.env') continue;
        if (relFilho.startsWith('config/') && nome.endsWith('.bak')) continue;
        arquivos.push(relFilho);
      }
    }
  };
  percorrer(ROOT, '');
  return arquivos;
}

function listarArquivos() {
  try {
    const saida = execFileSync('git', ['ls-files', '-z'], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true
    });
    return { modo: 'git', arquivos: saida.split('\0').filter(Boolean).map(normalizar) };
  } catch {
    return { modo: 'arvore', arquivos: listarArvore() };
  }
}

function ehEscaneavel(rel) {
  if (EXTENSOES_BINARIAS.has(path.extname(rel).toLowerCase())) return false;
  try {
    return fs.statSync(path.join(ROOT, rel)).size <= TAMANHO_MAXIMO;
  } catch {
    return false;
  }
}

// Lê cada arquivo uma única vez e guarda o resultado; todos os test() usam a mesma varredura.
let varredura = null;
function varrer() {
  if (varredura) return varredura;
  const { modo, arquivos } = listarArquivos();
  const achados = [];
  for (const rel of arquivos) {
    if (rel === '.env' || rel.endsWith('/.env')) {
      achados.push({ categoria: 'env-versionado', arquivo: rel, linha: 0, tipo: 'arquivo .env' });
    }
    if (rel === 'config/chatbot.json') {
      achados.push({ categoria: 'config-versionado', arquivo: rel, linha: 0, tipo: 'config/chatbot.json (usar config/chatbot.exemplo.json)' });
    }
    // Documentação interna (docs/ e CLAUDE.md) vive no repositório privado chatbot-evento-docs.
    if (rel === 'CLAUDE.md' || rel.startsWith('docs/')) {
      achados.push({ categoria: 'docs-versionado', arquivo: rel, linha: 0, tipo: 'documentação interna (vai no repositório privado de docs)' });
    }
    if (rel === ESTE_ARQUIVO || !ehEscaneavel(rel)) continue;
    let texto;
    try {
      texto = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    } catch {
      continue;
    }
    texto.split(/\r?\n/).forEach((linha, i) => {
      for (const achado of achadosDaLinha(linha, rel)) {
        achados.push({ ...achado, arquivo: rel, linha: i + 1 });
      }
    });
  }
  varredura = { modo, total: arquivos.length, achados };
  return varredura;
}

function afirmarSemAchados(categoria, titulo) {
  const { modo, total, achados } = varrer();
  const lista = achados.filter(a => a.categoria === categoria);
  const detalhe = lista.map(a => `  ${a.arquivo}:${a.linha || '(caminho)'} - ${a.tipo}`).join('\n');
  assert.equal(lista.length, 0, `${titulo} (modo ${modo}, ${total} arquivos):\n${detalhe}`);
}

test('a varredura encontra arquivos para analisar', () => {
  const { total } = varrer();
  assert.ok(total > 0, 'nenhum arquivo listado para a varredura');
});

test('nenhuma chave de API Groq (gsk_) ou xAI (xai-) em arquivos versionados', () => {
  afirmarSemAchados('chave-groq-xai', 'chave de API encontrada');
});

test('nenhum bloco de chave privada PEM em arquivos versionados', () => {
  afirmarSemAchados('chave-privada', 'chave privada encontrada');
});

test('nenhum OCID da Oracle Cloud em arquivos versionados', () => {
  afirmarSemAchados('ocid', 'OCID encontrado');
});

test('hash scrypt de senha so aparece dentro de tests/', () => {
  afirmarSemAchados('hash-scrypt', 'hash scrypt fora de tests/');
});

test('nenhum IPv4 publico em arquivos versionados (privados, loopback, mascaras e documentacao sao aceitos)', () => {
  afirmarSemAchados('ipv4-publico', 'IPv4 publico encontrado');
});

test('dominios sslip.io so com IP de documentacao', () => {
  afirmarSemAchados('sslip', 'dominio sslip.io com IP real');
});

test('links wa.me so com numero ficticio (ou dentro de tests/)', () => {
  afirmarSemAchados('wa-me', 'link wa.me com numero real');
});

test('arquivo .env nao esta versionado', () => {
  afirmarSemAchados('env-versionado', '.env versionado');
});

test('config/chatbot.json nao esta versionado', () => {
  afirmarSemAchados('config-versionado', 'config/chatbot.json versionado');
});

test('documentacao interna (docs/ e CLAUDE.md) nao esta versionada no repositorio publico', () => {
  afirmarSemAchados('docs-versionado', 'documentação interna versionada');
});

test('padroes de deteccao acertam e erram nos casos sinteticos', () => {
  // Valores montados por concatenacao para que este arquivo nao acione o proprio guarda.
  const ipv4 = (s, rel = 'docs/exemplo.md') => achadosDaLinha(s, rel).filter(a => a.categoria === 'ipv4-publico').length;
  assert.equal(ipv4(['203', '0', '113', '10'].join('.')), 0);
  assert.equal(ipv4(['8', '8', '8', '8'].join('.')), 1);
  assert.equal(ipv4(['11', '0', '0', '1'].join('.')), 1);
  assert.equal(ipv4(['203', '0', '114', '1'].join('.')), 1);
  assert.equal(ipv4(['172', '32', '0', '1'].join('.')), 1);
  assert.equal(ipv4(['1', '2', '3'].join('.')), 0);
  assert.equal(ipv4(['1', '2', '3', '4', '5'].join('.')), 0);
  assert.equal(ipv4(['300', '1', '1', '1'].join('.')), 0);
  for (const octetos of [['10', '0', '0', '1'], ['172', '16', '0', '1'], ['172', '31', '9', '9'], ['192', '168', '0', '1'], ['127', '0', '0', '1'], ['0', '0', '0', '0'], ['169', '254', '1', '1'], ['192', '0', '2', '7'], ['198', '51', '100', '7'], ['203', '0', '113', '5'], ['255', '255', '255', '0']]) {
    assert.equal(ipv4(octetos.join('.')), 0, 'faixa permitida acusada: ' + octetos.join('.'));
  }

  const wa = (numero, rel = 'docs/exemplo.md') => achadosDaLinha('https://wa' + '.me/' + numero, rel).filter(a => a.categoria === 'wa-me').length;
  assert.equal(wa('55' + '18999990000'), 1);
  assert.equal(wa('5500000000001'), 0);
  assert.equal(wa('5500000000012'), 0);
  assert.equal(wa('55' + '18999990000', 'tests/exemplo.js'), 0);

  const scrypt = (hash, rel) => achadosDaLinha(hash, rel).filter(a => a.categoria === 'hash-scrypt').length;
  const hashValido = 'scrypt:16384:8:1:' + 'a'.repeat(32) + ':' + 'b'.repeat(128);
  assert.equal(scrypt(hashValido, 'painel/exemplo.js'), 1);
  assert.equal(scrypt(hashValido, 'tests/exemplo.yml'), 0);
  assert.equal(scrypt('scrypt:16384:8:1:' + 'a'.repeat(32) + ':' + 'b'.repeat(127), 'painel/exemplo.js'), 0);

  const groq = (chave) => achadosDaLinha(chave, 'docs/exemplo.md').filter(a => a.categoria === 'chave-groq-xai').length;
  assert.equal(groq('gsk' + '_' + 'A'.repeat(20)), 1);
  assert.equal(groq('gsk' + '_' + 'A'.repeat(19)), 0);
  assert.equal(groq('xai' + '-' + 'z'.repeat(20)), 1);

  const sslip = (dominio) => achadosDaLinha(dominio + '.sslip' + '.io', 'docs/exemplo.md').filter(a => a.categoria === 'sslip').length;
  assert.equal(sslip(['203', '0', '113', '10'].join('-')), 0);
  assert.equal(sslip(['192', '0', '2', '14'].join('-')), 0);
  assert.equal(sslip(['198', '51', '100', '9'].join('-')), 0);
  assert.equal(sslip(['8', '8', '8', '8'].join('-')), 1);

  assert.equal(achadosDaLinha('ocid1' + '.tenancy', 'docs/exemplo.md').filter(a => a.categoria === 'ocid').length, 1);
  assert.equal(achadosDaLinha('-----BEGIN ' + 'RSA ' + 'PRIVATE KEY-----', 'docs/exemplo.md').filter(a => a.categoria === 'chave-privada').length, 1);
});
