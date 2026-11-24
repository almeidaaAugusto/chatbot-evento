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
// Transcrição de áudio (API de IA, formato da OpenAI): a mesma chave da IA.
const ROTA_TRANSCRICAO = '/ia/v1/audio/transcriptions';
const MODOS_AUDIO = ['ok', 'erro_download', 'erro_transcricao', 'vazio'];

let recebidas = [];
let pedidosIA = [];
let transcricoes = [];
let downloads = [];
// Áudios simulados: o que cada conversa fará quando o áudio for baixado e transcrito.
const audios = new Map();
const audiosPorToken = new Map();
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

// Token do áudio de uma conversa: só letras e dígitos (sem @ nem pontuação), com prefixo 'aud'.
function tokenDoChat(chatId) {
  return 'aud' + String(chatId).replace(/[^A-Za-z0-9]/g, '');
}

// Bytes FICTÍCIOS de um áudio: não é áudio de verdade, só um cabeçalho e um marcador para os testes acharem.
function audioFicticio(token) {
  return Buffer.concat([Buffer.from('OggS'), Buffer.from([0, 2, 19, 55, 66, 77, 88, 99]), Buffer.from('ZZAUDIO:' + token)]);
}

function lerCorpoBruto(req, quando) {
  const partes = [];
  req.on('data', (parte) => partes.push(parte));
  req.on('end', () => quando(Buffer.concat(partes)));
}

const servidor = http.createServer((req, res) => {
  const rota = (req.url || '').split('?')[0];

  if (req.method === 'GET' && rota === '/ping') return responder(res, 200, { message: 'pong' });
  if (req.method === 'GET' && rota === '/__mock/requests') return responder(res, 200, recebidas);
  if (req.method === 'DELETE' && rota === '/__mock/requests') {
    recebidas = [];
    pedidosIA = [];
    transcricoes = [];
    downloads = [];
    audios.clear();
    audiosPorToken.clear();
    return responder(res, 200, { ok: true });
  }
  if (req.method === 'GET' && rota === '/__mock/ia') return responder(res, 200, pedidosIA);
  if (req.method === 'GET' && rota === '/__mock/audio') return responder(res, 200, { transcricoes, downloads });
  // Define o que o áudio da conversa fará: 'ok', 'erro_download', 'erro_transcricao' ou 'vazio'.
  if (req.method === 'POST' && rota === '/__mock/audio') {
    return lerCorpoBruto(req, (bruto) => {
      let dados;
      try { dados = JSON.parse(bruto.toString('utf8')); }
      catch { return responder(res, 400, { message: 'controle inválido' }); }
      if (!dados || typeof dados.chatId !== 'string') return responder(res, 400, { message: 'chatId obrigatório' });
      const modo = dados.modo ?? 'ok';
      if (!MODOS_AUDIO.includes(modo)) return responder(res, 400, { message: 'modo inválido: ' + modo });
      const token = tokenDoChat(dados.chatId);
      const registro = { chatId: dados.chatId, token, texto: String(dados.texto ?? ''), modo };
      audios.set(dados.chatId, registro);
      audiosPorToken.set(token, registro);
      return responder(res, 200, { ok: true });
    });
  }
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

  // Áudio: o WAHA devolve a mensagem com a mídia (GET da mensagem)...
  const mensagemAudio = rota.match(/^\/api\/([^/]+)\/chats\/([^/]+)\/messages\/([^/]+)$/);
  if (req.method === 'GET' && mensagemAudio) {
    let chatId;
    let id;
    try {
      chatId = decodeURIComponent(mensagemAudio[2]);
      id = decodeURIComponent(mensagemAudio[3]);
    } catch (e) {
      return responder(res, 400, { message: 'identificador inválido' });
    }
    const chaveOk = CHAVE !== '' && req.headers['x-api-key'] === CHAVE;
    downloads.push({ tipo: 'mensagem', chatId, id, chaveOk, quando: Date.now() });
    if (!chaveOk) return responder(res, 401, { message: 'Unauthorized', statusCode: 401 });
    const registro = audios.get(chatId);
    if (!registro) return responder(res, 404, { message: 'conversa sem áudio simulado' });
    if (registro.modo === 'erro_download') return responder(res, 404, { message: 'mensagem não encontrada (simulado)' });
    return responder(res, 200, {
      id, hasMedia: true,
      media: { url: 'http://localhost:3000/api/files/' + registro.token + '.oga', mimetype: 'audio/ogg; codecs=opus', filename: null },
    });
  }
  // ...e o arquivo (GET do media.url), com bytes fictícios.
  const arquivoAudio = rota.match(/^\/api\/files\/([A-Za-z0-9]+)\.oga$/);
  if (req.method === 'GET' && arquivoAudio) {
    const token = arquivoAudio[1];
    const chaveOk = CHAVE !== '' && req.headers['x-api-key'] === CHAVE;
    const registro = audiosPorToken.get(token);
    downloads.push({ tipo: 'arquivo', chatId: registro ? registro.chatId : null, token, chaveOk, quando: Date.now() });
    if (!chaveOk) return responder(res, 401, { message: 'Unauthorized', statusCode: 401 });
    if (!registro) return responder(res, 404, { message: 'arquivo sem áudio simulado' });
    const conteudo = audioFicticio(token);
    res.writeHead(200, { 'Content-Type': 'audio/ogg', 'Content-Length': conteudo.length });
    return res.end(conteudo);
  }
  // Transcrição (multipart/form-data): os campos são lidos de forma simples, sem biblioteca.
  if (req.method === 'POST' && rota === ROTA_TRANSCRICAO) {
    return lerCorpoBruto(req, (bruto) => {
      const corpo = bruto.toString('latin1');
      const campo = (nome) => (corpo.match(new RegExp('name="' + nome + '"\\r?\\n\\r?\\n([^\\r\\n]*)')) || [])[1] ?? null;
      const arquivo = (corpo.match(/filename="([^"]*)"/) || [])[1] ?? null;
      const token = (corpo.match(/ZZAUDIO:(aud[A-Za-z0-9]+)/) || [])[1] ?? null;
      const chaveOk = CHAVE_IA !== '' && req.headers.authorization === 'Bearer ' + CHAVE_IA;
      transcricoes.push({
        chaveOk, modelo: campo('model'), idioma: campo('language'), formato: campo('response_format'),
        arquivo, temArquivo: /name="file"/.test(corpo) && token !== null, token, quando: Date.now(),
      });
      if (!chaveOk) return responder(res, 401, { error: { message: 'Invalid API Key' } });
      const registro = token ? audiosPorToken.get(token) : undefined;
      if (!registro) return responder(res, 400, { error: { message: 'áudio simulado não encontrado' } });
      if (registro.modo === 'erro_transcricao') return responder(res, 500, { error: { message: 'falha simulada da transcrição' } });
      if (registro.modo === 'vazio') return responder(res, 200, { text: '' });
      return responder(res, 200, { text: registro.texto });
    });
  }

  responder(res, 404, { message: 'rota não simulada: ' + req.method + ' ' + rota });
});

servidor.listen(3000, '0.0.0.0', () => console.log('WAHA simulado ouvindo na porta 3000'));
process.on('SIGTERM', () => servidor.close(() => process.exit(0)));
