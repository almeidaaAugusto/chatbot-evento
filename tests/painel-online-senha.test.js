'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { verificarSenha } = require('../painel/autenticacao');

const RAIZ = path.join(__dirname, '..');
const FORMATO_HASH = /^scrypt:16384:8:1:[0-9a-f]{32}:[0-9a-f]{128}$/;
const SENHA = 'senha-forte-2026';

function rodarSenha(input, args = []) {
  return spawnSync(process.execPath, ['painel/senha.js', ...args], { input, cwd: RAIZ, encoding: 'utf8' });
}

test('senha válida gera um hash verificável, em uma única linha', () => {
  const r = rodarSenha(SENHA + '\n');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /\n$/);
  const linhas = r.stdout.split('\n');
  assert.equal(linhas.length, 2, 'deve haver uma única linha com \\n final');
  const hash = linhas[0];
  assert.match(hash, FORMATO_HASH);
  assert.equal(verificarSenha(SENHA, hash), true);
  assert.equal(verificarSenha('outra-senha-errada', hash), false);
});

test('a senha não aparece na saída', () => {
  const r = rodarSenha(SENHA + '\n');
  assert.equal(r.stdout.includes(SENHA), false);
  assert.equal(r.stderr.includes(SENHA), false);
});

test('duas execuções com a mesma senha geram hashes diferentes (sal aleatório)', () => {
  const a = rodarSenha(SENHA + '\n').stdout.trim();
  const b = rodarSenha(SENHA + '\n').stdout.trim();
  assert.match(a, FORMATO_HASH);
  assert.match(b, FORMATO_HASH);
  assert.notEqual(a, b);
  assert.equal(verificarSenha(SENHA, b), true);
});

test('quebra de linha final \\r\\n é removida e a senha continua válida', () => {
  const r = rodarSenha(SENHA + '\r\n');
  assert.equal(r.status, 0);
  assert.equal(verificarSenha(SENHA, r.stdout.trim()), true);
});

test('espaços nas pontas e no meio fazem parte da senha', () => {
  const comEspacos = '  senha com espacos  ';
  const r = rodarSenha(comEspacos + '\n');
  assert.equal(r.status, 0);
  const hash = r.stdout.trim();
  assert.equal(verificarSenha(comEspacos, hash), true);
  assert.equal(verificarSenha('senha com espacos', hash), false);
});

test('senha curta sai com código 1, sem nada no stdout e sem expor a senha', () => {
  const curta = 'curta-123';
  const r = rodarSenha(curta + '\n');
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /A senha precisa ter no mínimo 12 caracteres\./);
  assert.equal(r.stderr.includes(curta), false);
});

test('stdin vazio sai com código 1', () => {
  const r = rodarSenha('');
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /mínimo 12 caracteres/);
});

test('argumentos extras na linha de comando são ignorados e não viram senha', () => {
  const argumento = 'senha-vinda-por-argumento-123';
  const r = rodarSenha(SENHA + '\n', [argumento]);
  assert.equal(r.status, 0);
  const hash = r.stdout.trim();
  assert.equal(verificarSenha(SENHA, hash), true);
  assert.equal(verificarSenha(argumento, hash), false);
  assert.equal(r.stdout.includes(argumento), false);
});
