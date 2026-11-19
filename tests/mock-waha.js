// WAHA simulado para os testes: aceita as mesmas rotas que o workflow usa,
// confere a chave da API e guarda tudo o que recebeu para o executor de testes conferir.
// Não fala com o WhatsApp. Também simula a API de IA (não fala com nenhum serviço externo).

const http = require('http');

const CHAVE = process.env.MOCK_API_KEY || '';
// Conversas cujo ID começa com este prefixo simulam falha no envio (HTTP 500).
const PREFIXO_FALHA = process.env.MOCK_PREFIXO_FALHA || '5599000500';
const ROTAS = ['/api/sendText', '/api/sendSeen', '/api/startTyping', '/api/stopTyping'];
// A mesma porta também simula a API de IA (formato "chat completions"), com chave própria.
const CHAVE_IA = process.env.MOCK_IA_KEY || '';
const ROTA_IA = '/ia/v1/chat/completions';

let recebidas = [];
let pedidosIA = [];
const enviosRetidos = new Map();
const falhasRestantes = new Map();

const MODELO_CLASSIFICADOR = 'meta-llama/llama-prompt-guard-2-86m';

// Classificador de ataque simulado (Prompt Guard): devolve só um número no content, como o real.
// 'zzataque' na mensagem dá nota alta, 'zzclasserro' dá erro 500; o resto, nota baixa.
function responderComoClassificador(res, corpo) {
  const texto = String(corpo?.messages?.[0]?.content ?? '').toLowerCase();
  if (texto.includes('zzclasserro')) return responder(res, 500, { error: { message: 'falha simulada do classificador' } });
  const nota = texto.includes('zzataque') ? '0.9995' : '0.0004';
  return responder(res, 200, {
    id: 'chatcmpl-guarda', object: 'chat.completion', model: corpo.model,
    choices: [{ index: 0, message: { role: 'assistant', content: nota }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
  });
}

// O comportamento da IA simulada depende do começo da mensagem do cliente. Com a conversa natural o
// cliente vem entre « e » e, no modo redigir, a mensagem traz a resposta oficial; vários trechos
// separados por --- viram várias mensagens.
function responderComoIA(res, corpo) {
  const mensagens = Array.isArray(corpo?.messages) ? corpo.messages : [];
  const ultima = String(mensagens[mensagens.length - 1]?.content ?? '');
  const cliente = ultima.split('Mensagem do cliente:').pop().replace(/[«»]/g, '').trim().toLowerCase();
  const conteudo = (texto) => responder(res, 200, {
    id: 'chatcmpl-teste', object: 'chat.completion', model: corpo.model,
    choices: [{ index: 0, message: { role: 'assistant', content: texto }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
  // Falhas por modelo: o principal é o "modelo" da configuração de teste e há duas reservas.
  const principal = corpo.model === 'modelo-de-teste';
  const reserva2 = corpo.model === 'reserva-2-de-teste';
  const limite = () => responder(res, 429, { error: { message: 'Rate limit reached (simulado) para ' + corpo.model } });
  const certa = () => conteudo('**Resposta de teste da IA** para o pedido ' + cliente.split(' ').pop() + '.');
  if (cliente.startsWith('natural duas partes')) return conteudo('Primeira parte da resposta.\n---\nSegunda parte da resposta com a marca ' + cliente.split(' ').pop() + '.');
  if (cliente.startsWith('natural vaza texto')) return conteudo('Claro! INFORMAÇÕES OFICIAIS e REGRAS (siga todas) são estas: ...');
  if (cliente.startsWith('natural palavrao')) return conteudo('Que merda de pergunta, mas vou responder mesmo assim.');
  if (cliente.startsWith('natural codigo')) return conteudo('Aqui está:\n```js\nconsole.log(1)\n```');
  if (cliente.startsWith('ia principal limite')) return principal ? limite() : certa();
  if (cliente.startsWith('ia duas limite')) return reserva2 ? certa() : limite();
  if (cliente.startsWith('ia responde')) return conteudo('**Resposta de teste da IA** para o pedido ' + cliente.split(' ').pop() + '.');
  if (cliente.startsWith('ia inventa')) return conteudo('Compre agora em https://exemplo.invalid/ingresso-falso');
  if (cliente.startsWith('ia erro')) return responder(res, 500, { error: { message: 'falha simulada da IA' } });
  if (cliente.startsWith('ia limite')) return responder(res, 429, { error: { message: 'Rate limit reached (simulado)' } });
  if (cliente.startsWith('ia lenta')) return setTimeout(() => conteudo('Resposta que chegou tarde demais.'), 6000);
  return conteudo('[[SEM_RESPOSTA]]');
}

function responder(res, status, corpo) {
  const texto = JSON.stringify(corpo);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(texto) });
  res.end(texto);
}

const servidor = http.createServer((req, res) => {
  const rota = (req.url || '').split('?')[0];

  if (req.method === 'GET' && rota === '/ping') return responder(res, 200, { message: 'pong' });
  if (req.method === 'GET' && rota === '/__mock/requests') return responder(res, 200, recebidas);
  if (req.method === 'DELETE' && rota === '/__mock/requests') {
    recebidas = [];
    pedidosIA = [];
    return responder(res, 200, { ok: true });
  }
  if (req.method === 'GET' && rota === '/__mock/ia') return responder(res, 200, pedidosIA);
  if (req.method === 'POST' && rota === ROTA_IA) {
    const partes = [];
    req.on('data', (parte) => partes.push(parte));
    req.on('end', () => {
      let corpo = null;
      try {
        corpo = JSON.parse(Buffer.concat(partes).toString('utf8'));
      } catch (e) {
        corpo = null;
      }
      const chaveOk = CHAVE_IA !== '' && req.headers.authorization === 'Bearer ' + CHAVE_IA;
      const classificador = corpo?.model === MODELO_CLASSIFICADOR;
      pedidosIA.push({ corpo, chaveOk, quando: Date.now(), classificador });
      if (!chaveOk) return responder(res, 401, { error: { message: 'Invalid API Key' } });
      if (!corpo || !corpo.model || !Array.isArray(corpo.messages)) return responder(res, 400, { error: { message: 'pedido inválido' } });
      return classificador ? responderComoClassificador(res, corpo) : responderComoIA(res, corpo);
    });
    return;
  }
  // Controles usados apenas pelos testes de concorrência e recuperação de falhas.
  // A retenção é explícita, para que o teste libere o envio depois de criar a disputa.
  if (req.method === 'POST' && ['/__mock/hold', '/__mock/release', '/__mock/fail-next'].includes(rota)) {
    const partes = [];
    req.on('data', parte => partes.push(parte));
    req.on('end', () => {
      let dados;
      try { dados = JSON.parse(Buffer.concat(partes).toString('utf8')); }
      catch { return responder(res, 400, { message: 'controle inválido' }); }
      if (!dados || typeof dados.chatId !== 'string') return responder(res, 400, { message: 'chatId obrigatório' });
      if (rota === '/__mock/hold') {
        if (enviosRetidos.has(dados.chatId)) return responder(res, 409, { message: 'envio já retido' });
        enviosRetidos.set(dados.chatId, { liberar: null });
      } else if (rota === '/__mock/release') {
        const retido = enviosRetidos.get(dados.chatId);
        enviosRetidos.delete(dados.chatId);
        if (retido?.liberar) retido.liberar();
      } else {
        falhasRestantes.set(dados.chatId, Math.max(1, Math.min(5, Number(dados.quantidade) || 2)));
      }
      responder(res, 200, { ok: true });
    });
    return;
  }

  if (req.method === 'POST' && ROTAS.includes(rota)) {
    const partes = [];
    req.on('data', (parte) => partes.push(parte));
    req.on('end', () => {
      let corpo = null;
      try {
        corpo = JSON.parse(Buffer.concat(partes).toString('utf8'));
      } catch (e) {
        corpo = null;
      }
      const chaveOk = CHAVE !== '' && req.headers['x-api-key'] === CHAVE;
      recebidas.push({ rota, corpo, chaveOk, quando: Date.now() });

      if (!chaveOk) return responder(res, 401, { message: 'Unauthorized', statusCode: 401 });
      if (!corpo || !corpo.chatId || !corpo.session) return responder(res, 422, { message: 'corpo inválido' });
      if (rota === '/api/sendText' && String(corpo.chatId).startsWith(PREFIXO_FALHA)) {
        return responder(res, 500, { message: 'falha simulada ao enviar para ' + corpo.chatId });
      }
      if (rota === '/api/sendText' && (falhasRestantes.get(corpo.chatId) || 0) > 0) {
        falhasRestantes.set(corpo.chatId, falhasRestantes.get(corpo.chatId) - 1);
        return responder(res, 500, { message: 'falha transitória simulada' });
      }
      const retido = rota === '/api/sendText' && enviosRetidos.get(corpo.chatId);
      if (retido && !retido.liberar) {
        const id = 'true_' + corpo.chatId + '_MOCK' + recebidas.length;
        retido.liberar = () => responder(res, 201, { id });
        return;
      }
      return responder(res, 201, { id: 'true_' + corpo.chatId + '_MOCK' + recebidas.length });
    });
    return;
  }

  responder(res, 404, { message: 'rota não simulada: ' + req.method + ' ' + rota });
});

servidor.listen(3000, '0.0.0.0', () => console.log('WAHA simulado ouvindo na porta 3000'));
process.on('SIGTERM', () => servidor.close(() => process.exit(0)));
