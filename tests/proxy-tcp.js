'use strict';

// Repassador TCP controlável, só para os testes: fica entre o painel e o Postgres e permite
// "derrubar" o banco no meio do teste (sem precisar de acesso ao Docker) e depois religá-lo.
//   DESTINO=postgres:5432  PORTA=5432  CONTROLE=9000
//   POST /parar  -> fecha as conexões abertas e passa a recusar novas
//   POST /ligar  -> volta a aceitar
//   GET  /estado -> { ligado }

const net = require('node:net');
const http = require('node:http');

const [hostDestino, portaDestino] = (process.env.DESTINO || 'postgres:5432').split(':');
const PORTA = Number(process.env.PORTA || 5432);
const CONTROLE = Number(process.env.CONTROLE || 9000);
const conexoes = new Set();
let ligado = true;
let servidor = null;

function abrir() {
  servidor = net.createServer((cliente) => {
    const destino = net.connect(Number(portaDestino), hostDestino);
    const par = [cliente, destino];
    for (const s of par) conexoes.add(s);
    const fechar = () => { for (const s of par) { conexoes.delete(s); s.destroy(); } };
    cliente.on('error', fechar);
    destino.on('error', fechar);
    cliente.on('close', fechar);
    destino.on('close', fechar);
    cliente.pipe(destino);
    destino.pipe(cliente);
  });
  servidor.listen(PORTA, '0.0.0.0');
}

function fechar() {
  return new Promise((resolve) => {
    for (const s of conexoes) s.destroy();
    conexoes.clear();
    if (!servidor) return resolve();
    servidor.close(() => resolve());
    servidor = null;
  });
}

abrir();
http.createServer(async (req, res) => {
  const responder = (status, corpo) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(corpo)); };
  if (req.method === 'POST' && req.url === '/parar') { if (ligado) { ligado = false; await fechar(); } return responder(200, { ligado }); }
  if (req.method === 'POST' && req.url === '/ligar') { if (!ligado) { ligado = true; abrir(); } return responder(200, { ligado }); }
  if (req.method === 'GET' && (req.url === '/estado' || req.url === '/ping')) return responder(200, { ligado });
  return responder(404, { erro: 'rota desconhecida' });
}).listen(CONTROLE, '0.0.0.0');
