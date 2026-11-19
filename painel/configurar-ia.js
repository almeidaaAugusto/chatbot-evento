'use strict';

// Usado por scripts/configurar-ia.ps1, dentro do contêiner do painel (que recebe IA_API_KEY do .env).
//   node /app/painel/configurar-ia.js ligar     testa a chave com uma pergunta real e liga a IA
//   node /app/painel/configurar-ia.js desligar  desliga a IA (as orientações normais continuam)
//   node /app/painel/configurar-ia.js status    mostra a situação, sem chamar a API
// A chave nunca é impressa.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const IA = require('../lib/ia');
const { validarConfig } = require('../lib/configuracao');

const CAMINHO = process.env.CHATBOT_CONFIG || '/files/config/chatbot.json';
const PERGUNTA_DE_TESTE = 'Que horas começa e qual o valor do ingresso?';
const EXPLICACOES = {
  sem_chave: 'Nenhuma chave encontrada no .env (IA_API_KEY).',
  erro_401: 'A chave foi recusada. Confira se copiou a chave inteira e se ela não foi apagada no site do provedor.',
  erro_403: 'A chave não tem permissão para este modelo ou a conta está bloqueada.',
  erro_404: 'O modelo configurado não existe neste provedor. Confira "ia.modelo" (ou apague o campo para usar o padrão).',
  erro_400: 'O provedor recusou o pedido. Confira "ia.modelo" e "ia.parametros".',
  erro_429: 'A cota da API está esgotada no momento. Tente de novo mais tarde.',
  erro_de_rede: 'Não foi possível conectar à API. Confira a internet deste computador.',
  tempo_esgotado: 'A API demorou demais para responder. Tente de novo.',
  resposta_invalida: 'A API respondeu em um formato inesperado. Confira "ia.url".',
};

function ler() {
  return JSON.parse(fs.readFileSync(CAMINHO, 'utf8').replace(/^﻿/, ''));
}

// Mesma gravação do painel: arquivo temporário + troca, com cópia da versão anterior.
function gravar(cfg) {
  const { erros } = validarConfig(cfg);
  if (erros.length) throw new Error('A configuração ficaria inválida: ' + erros.join(' | '));
  const anterior = fs.readFileSync(CAMINHO, 'utf8');
  const temporario = path.join(path.dirname(CAMINHO), '.chatbot.json.' + crypto.randomBytes(8).toString('hex') + '.tmp');
  fs.writeFileSync(CAMINHO + '.bak', anterior, 'utf8');
  fs.writeFileSync(temporario, JSON.stringify(cfg, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporario, CAMINHO);
}

function situacao(cfg, chave) {
  const conf = IA.configuracao(cfg);
  console.log('IA ligada no chatbot: ' + (conf.ativa ? 'sim' : 'não'));
  console.log('Provedor: ' + IA.PROVEDORES[conf.provedor].nome + ' · modelo ' + conf.modelo);
  console.log('Chave no .env: ' + (chave ? 'sim (' + (IA.provedorDaChave(chave) || 'formato desconhecido') + ', termina em ' + chave.slice(-4) + ')' : 'não'));
  const sem = (n) => (n === 0 ? 'sem limite' : String(n));
  console.log('Limites: ' + sem(conf.maxUsosPorContato) + ' uso(s) por contato a cada ' + conf.janelaSegundos / 3600 + ' h; ' + sem(conf.maxUsosPorDia) + ' por dia no total.');
}

async function main(acao) {
  const chave = String(process.env.IA_API_KEY || '').trim();
  const cfg = ler();
  cfg.ia = cfg.ia && typeof cfg.ia === 'object' && !Array.isArray(cfg.ia) ? cfg.ia : {};

  if (acao === 'status') { situacao(cfg, chave); return 0; }
  if (acao === 'desligar') {
    cfg.ia.ativa = false;
    gravar(cfg);
    console.log('IA desligada. O robô volta a usar só as orientações normais a partir da próxima mensagem.');
    return 0;
  }
  if (acao !== 'ligar') { console.log('Use: ligar, desligar ou status.'); return 2; }

  const candidata = structuredClone(cfg);
  const detectado = IA.provedorDaChave(chave);
  if (detectado && detectado !== IA.configuracao(cfg).provedor) {
    // Chave de outro provedor: troca também o modelo para o padrão dele.
    candidata.ia.provedor = detectado;
    if (!candidata.ia.url) candidata.ia.modelo = IA.PROVEDORES[detectado].modelo;
  }
  candidata.ia.ativa = true;
  const conf = IA.configuracao(candidata);
  console.log('Testando a chave com ' + IA.PROVEDORES[conf.provedor].nome + ' (modelo ' + conf.modelo + ')...');
  console.log('Pergunta de teste: "' + PERGUNTA_DE_TESTE + '"');
  const resultado = await IA.consultar(candidata, PERGUNTA_DE_TESTE, { chave, fuso: process.env.TZ });

  // Qualquer resposta lida (mesmo "sem resposta" ou barrada pela conferência) prova que a conexão funciona.
  const conectou = resultado.ok || !(resultado.motivo in EXPLICACOES);
  if (!conectou) {
    console.log('FALHOU: ' + EXPLICACOES[resultado.motivo] + (resultado.detalhe ? '\nMensagem do provedor: ' + resultado.detalhe : ''));
    console.log('A configuração do chatbot não foi alterada.');
    return 1;
  }
  console.log(resultado.ok ? '\nResposta da IA:\n' + resultado.texto + '\n' : '\nA API respondeu (resultado: ' + resultado.motivo + ').\n');
  if (resultado.uso && resultado.uso.total_tokens) console.log('Tokens usados no teste: ' + resultado.uso.total_tokens);
  gravar(candidata);
  console.log('IA ligada em config/chatbot.json.');
  situacao(candidata, chave);
  return 0;
}

main(process.argv[2]).then((codigo) => { process.exitCode = codigo; }).catch((erro) => {
  console.log('ERRO: ' + erro.message);
  process.exitCode = 1;
});
