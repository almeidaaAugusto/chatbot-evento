// Gera os arquivos importáveis do n8n em n8n/workflows/ a partir do código em n8n/codigo/.
// Uso (na raiz do projeto):  node n8n/montar-workflows.js
// Só é preciso rodar de novo se você alterar este arquivo ou os .js de n8n/codigo/.

const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const SAIDA = path.join(DIR, 'workflows');

const ID_PRINCIPAL = 'ChatbotEvento001';
const ID_ERROS = 'ChatbotEventoErr';

const CRED_WAHA = { httpHeaderAuth: { id: 'ChatbotWahaApi01', name: 'WAHA - chave da API' } };
const CRED_WEBHOOK = { httpHeaderAuth: { id: 'ChatbotWebhook01', name: 'Webhook - token do WAHA' } };
const CRED_REDIS = { redis: { id: 'ChatbotRedis0001', name: 'Redis - estado do chatbot' } };
const CRED_IA = { httpHeaderAuth: { id: 'ChatbotIaApi0001', name: 'IA - chave da API' } };

const WAHA = 'http://waha:3000';
const BASE = "$('Interpretar mensagem').first().json";
// Resposta escolhida pelo motor de regras ou, quando ele não entende, pela IA.
const RESOLVIDO = "$('Resposta final').first().json";
// Pedido preparado para a IA (endereço, corpo, limites e chaves dos contadores).
const PLANO_IA = "$('Resolver conversa').first().json.ia";
const CHAVE_TRAVA = "={{ " + BASE + ".chaveConversa + ':trava' }}";
// Deslocamento, na tela do n8n, dos nós que vêm depois do ramo da IA.
const DX = 2200;

// Bibliotecas de lib/ embutidas nos nós de código que as utilizam (o n8n não lê arquivos).
const BIBLIOTECAS = {
  'resolver-conversa.js': [['Chatbot', 'conversa.js'], ['Eventos', 'eventos.js'], ['IA', 'ia.js']],
  'aplicar-resposta-ia.js': [['IA', 'ia.js']],
};

// ---------- utilitários ----------

function codigo(arquivo) {
  let fonte = fs.readFileSync(path.join(DIR, 'codigo', arquivo), 'utf8').replace(/\r\n/g, '\n');
  const embutidas = (BIBLIOTECAS[arquivo] || []).map(([nome, biblioteca]) => {
    const corpo = fs.readFileSync(path.join(DIR, '../lib', biblioteca), 'utf8').replace(/\r\n/g, '\n');
    return 'const ' + nome + ' = (() => { const module = { exports: {} };\n' + corpo + '\nreturn module.exports; })();\n';
  });
  fonte = embutidas.join('') + fonte;
  // Confere a sintaxe do mesmo jeito que o n8n executa (dentro de uma função assíncrona).
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  try {
    new AsyncFunction('$', '$input', '$now', fonte);
  } catch (e) {
    throw new Error('Erro de sintaxe em codigo/' + arquivo + ': ' + e.message);
  }
  return fonte;
}

let contador = 0;
function uuid() {
  contador += 1;
  return 'c0de0000-0000-4000-8000-' + String(contador).padStart(12, '0');
}

function no(nome, tipo, versao, posicao, parametros, extras = {}) {
  return { parameters: parametros, id: uuid(), name: nome, type: tipo, typeVersion: versao, position: posicao, ...extras };
}

const noCodigo = (nome, posicao, arquivo) =>
  no(nome, 'n8n-nodes-base.code', 2, posicao, { mode: 'runOnceForAllItems', jsCode: codigo(arquivo) });

function condicoes(lista) {
  return {
    options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
    conditions: lista.map((c) => ({ id: uuid(), ...c })),
    combinator: 'and',
  };
}

const ehVerdadeiro = (expressao) =>
  condicoes([{ leftValue: expressao, rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }]);

const ehIgual = (expressao, valor) =>
  condicoes([{ leftValue: expressao, rightValue: valor, operator: { type: 'string', operation: 'equals' } }]);

const noSe = (nome, posicao, expressao) =>
  no(nome, 'n8n-nodes-base.if', 2.2, posicao, { conditions: ehVerdadeiro(expressao), options: {} });

function noWaha(nome, posicao, rota, corpo, extras = {}) {
  return no(
    nome,
    'n8n-nodes-base.httpRequest',
    4.2,
    posicao,
    {
      method: 'POST',
      url: WAHA + rota,
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendBody: true,
      specifyBody: 'json',
      jsonBody: '={{ JSON.stringify(' + corpo + ') }}',
      options: { timeout: 15000 },
    },
    { credentials: CRED_WAHA, ...extras },
  );
}

const noRedis = (nome, posicao, parametros, extras = {}) =>
  no(nome, 'n8n-nodes-base.redis', 1, posicao, parametros, { credentials: CRED_REDIS, ...extras });

// Etapas opcionais (visto, digitando): se falharem, a resposta é enviada mesmo assim.
const OPCIONAL = { onError: 'continueRegularOutput' };

const conversa = '{ session: ' + BASE + '.sessao, chatId: ' + BASE + '.chatId }';
const mensagem = '{ session: ' + BASE + '.sessao, chatId: ' + BASE + '.chatId, text: ' + RESOLVIDO + '.resposta }';
const avisoReativacao = '{ session: ' + BASE + '.sessao, chatId: ' + BASE + '.chatId, text: ' + BASE + '.resposta }';

function ligar(conexoes, origem, destino, saida = 0) {
  conexoes[origem] ??= { main: [] };
  const principal = conexoes[origem].main;
  while (principal.length <= saida) principal.push([]);
  principal[saida].push({ node: destino, type: 'main', index: 0 });
}

function cadeiaDeLog(prefixoArquivo, x, y, arquivoCodigo, nomeCodigo) {
  return [
    noCodigo(nomeCodigo, [x, y], arquivoCodigo),
    no('Converter em arquivo', 'n8n-nodes-base.convertToFile', 1.1, [x + 220, y], {
      operation: 'toText',
      sourceProperty: 'linha',
      binaryPropertyName: 'data',
      options: { fileName: prefixoArquivo + '.log' },
    }),
    no('Gravar no arquivo de log', 'n8n-nodes-base.readWriteFile', 1, [x + 440, y], {
      operation: 'write',
      fileName: "=/files/logs/" + prefixoArquivo + "-{{ $now.toFormat('yyyy-LL-dd') }}.log",
      dataPropertyName: 'data',
      options: { append: true },
    }),
  ];
}

const CONFIGURACOES = {
  executionOrder: 'v1',
  saveDataSuccessExecution: 'none',
  saveDataErrorExecution: 'all',
  saveManualExecutions: true,
  saveExecutionProgress: false,
  executionTimeout: 120,
};

// ---------- workflow principal ----------

function workflowPrincipal() {
  const nos = [
    no(
      'Webhook WAHA',
      'n8n-nodes-base.webhook',
      2,
      [0, 300],
      { httpMethod: 'POST', path: 'waha-evento', authentication: 'headerAuth', responseMode: 'onReceived', options: {} },
      { webhookId: 'c0de0000-0000-4000-9000-000000000001', credentials: CRED_WEBHOOK },
    ),
    // Momento do último evento de status do WhatsApp (quando o robô foi ligado).
    noRedis('Redis: estado da sessão', [110, 480], {
      operation: 'get',
      propertyName: 'sessao',
      key: "={{ 'sessao:' + (($json.body || {}).session || 'default') }}",
      keyType: 'string',
      options: {},
    }),
    no(
      'Ler configuração',
      'n8n-nodes-base.readWriteFile',
      1,
      [220, 300],
      { operation: 'read', fileSelector: '/files/config/chatbot.json', options: { dataPropertyName: 'data' } },
      { alwaysOutputData: true },
    ),
    no('Extrair configuração', 'n8n-nodes-base.extractFromFile', 1, [440, 300], {
      operation: 'text',
      binaryPropertyName: 'data',
      destinationKey: 'data',
      options: {},
    }),
    noCodigo('Interpretar mensagem', [660, 300], 'interpretar.js'),
    no('Qual ação?', 'n8n-nodes-base.switch', 3.2, [880, 300], {
      rules: {
        values: ['processar', 'reativar', 'pausar', 'sessao'].map((acao) => ({
          conditions: ehIgual('={{ $json.acao }}', acao),
          renameOutput: true,
          outputKey: acao,
        })),
      },
      options: { fallbackOutput: 'extra', renameFallbackOutput: 'ignorar' },
    }),

    // --- ramo "processar": mensagem recebida de um contato ---
    noRedis('Redis: deduplicar', [1120, 0], {
      operation: 'incr',
      key: '={{ ' + BASE + '.chaves.dedupe }}',
      expire: true,
      ttl: '={{ ' + BASE + '.ttl.dedupe }}',
    }),
    noRedis('Redis: contato em atendimento?', [1340, 0], {
      operation: 'get',
      propertyName: 'pausa',
      key: '={{ ' + BASE + '.chavePausa }}',
      keyType: 'string',
      options: {},
    }),
    noCodigo('Verificar duplicidade e pausa', [1560, 0], 'verificar-duplicidade.js'),
    no('Segue o atendimento?', 'n8n-nodes-base.switch', 3.2, [1780, 0], {
      rules: {
        values: ['seguir', 'voltar'].map((rota) => ({
          conditions: ehIgual('={{ $json.rota }}', rota),
          renameOutput: true,
          outputKey: rota,
        })),
      },
      options: { fallbackOutput: 'extra', renameFallbackOutput: 'parar' },
    }),
    // O contato estava em atendimento humano e digitou a palavra para voltar ao robô.
    noRedis('Redis: sair do atendimento humano', [2020, -260], { operation: 'delete', key: '={{ ' + BASE + '.chavePausa }}' }),
    // Mensagens em sequência do mesmo contato: só a última recebe resposta.
    noRedis('Redis: marcar última mensagem', [2260, -100], {
      operation: 'set',
      key: '={{ ' + BASE + '.chaves.ultima }}',
      value: '={{ ' + BASE + '.chaveMensagem }}',
      keyType: 'string',
      expire: true,
      ttl: '={{ ' + BASE + '.ttl.ultima }}',
    }),
    no(
      'Aguardar mensagens em sequência',
      'n8n-nodes-base.wait',
      1.1,
      [2480, -100],
      { amount: '={{ ' + BASE + '.agruparSegundos }}', unit: 'seconds' },
      { webhookId: 'c0de0000-0000-4000-9000-000000000003' },
    ),
    noRedis('Redis: ler última mensagem', [2700, -100], {
      operation: 'get',
      propertyName: 'ultima',
      key: '={{ ' + BASE + '.chaves.ultima }}',
      keyType: 'string',
      options: {},
    }),
    // Confere de novo o momento em que o robô foi ligado (pode ter sido registrado durante a espera).
    noRedis('Redis: reler estado da sessão', [2700, 80], {
      operation: 'get',
      propertyName: 'sessao',
      key: "={{ 'sessao:' + " + BASE + ".sessao }}",
      keyType: 'string',
      options: {},
    }),
    noCodigo('Verificar sequência e sessão', [2920, 80], 'verificar-sequencia.js'),
    noSe('É a última da sequência?', [3140, -100], '={{ $json.seguir }}'),
    // A leitura, o envio e a gravação do contexto são serializados por contato.
    // A lease supera o timeout da execução: uma execução expirada não libera a
    // trava de outra. O polling usa GET, sem prolongar uma trava abandonada.
    noRedis('Redis: adquirir trava da conversa', [3220, -620], {
      operation: 'incr', key: CHAVE_TRAVA, expire: true, ttl: 150,
    }),
    noSe('Trava da conversa adquirida?', [3440, -620], '={{ Number(Object.values($json ?? {})[0]) === 1 }}'),
    no('Aguardar liberação da conversa', 'n8n-nodes-base.wait', 1.1, [3440, -880], {
      amount: 1, unit: 'seconds',
    }, { webhookId: 'c0de0000-0000-4000-9000-000000000004' }),
    noRedis('Redis: consultar trava da conversa', [3660, -880], {
      operation: 'get', propertyName: 'trava', key: CHAVE_TRAVA, keyType: 'string', options: {},
    }),
    noSe('Trava da conversa livre?', [3880, -880], '={{ !$json.trava }}'),
    // Outra mensagem pode ter chegado enquanto esta aguardava sua vez.
    noRedis('Redis: conferir última após trava', [3660, -620], {
      operation: 'get', propertyName: 'ultima', key: '={{ ' + BASE + '.chaves.ultima }}',
      keyType: 'string', options: {},
    }),
    noRedis('Redis: conferir pausa após trava', [3880, -620], {
      operation: 'get', propertyName: 'pausa', key: '={{ ' + BASE + '.chavePausa }}',
      keyType: 'string', options: {},
    }),
    noRedis('Redis: conferir sessão após trava', [4100, -620], {
      operation: 'get', propertyName: 'sessao', key: "={{ 'sessao:' + " + BASE + '.sessao }}',
      keyType: 'string', options: {},
    }),
    noCodigo('Verificar proteções após trava', [4320, -620], 'verificar-protecoes-apos-trava.js'),
    noSe('Última mensagem após a trava?', [4540, -620], '={{ $json.seguir }}'),
    noRedis('Redis: liberar trava (superada)', [4760, -620], { operation: 'delete', key: CHAVE_TRAVA }),
    noRedis('Redis: ler conversa', [3220, -300], {
      operation: 'get', propertyName: 'conversa',
      key: '={{ ' + BASE + '.chaveConversa }}', keyType: 'string', options: {},
    }),
    noCodigo('Resolver conversa', [3380, -300], 'resolver-conversa.js'),
    noRedis('Redis: contador por hora', [3380, -100], {
      operation: 'incr',
      key: '={{ ' + BASE + '.chaves.porHora }}',
      expire: true,
      ttl: '={{ ' + BASE + '.ttl.porHora }}',
    }),

    // --- IA: só quando o motor de regras não entendeu o texto e a IA está ligada ---
    noSe('Consultar a IA?', [3600, -100], '={{ ' + PLANO_IA + '.usar }}'),
    noRedis('Redis: usos da IA (contato)', [3820, -300], {
      operation: 'get', propertyName: 'usosContato',
      key: '={{ ' + PLANO_IA + '.chaves.contato }}', keyType: 'string', options: {},
    }),
    noRedis('Redis: usos da IA (dia)', [4040, -300], {
      operation: 'get', propertyName: 'usosDia',
      key: '={{ ' + PLANO_IA + '.chaves.dia }}', keyType: 'string', options: {},
    }),
    noCodigo('Verificar limites da IA', [4260, -300], 'verificar-limites-ia.js'),
    noSe('IA dentro do limite?', [4480, -300], '={{ $json.ia.liberada }}'),
    // O uso é contado antes da chamada: tentativas que falham também gastam a cota.
    noRedis('Redis: contar uso da IA (contato)', [4700, -300], {
      operation: 'incr', key: '={{ ' + PLANO_IA + '.chaves.contato }}',
      expire: true, ttl: '={{ ' + PLANO_IA + '.ttl.contato }}',
    }),
    noRedis('Redis: contar uso da IA (dia)', [4920, -300], {
      operation: 'incr', key: '={{ ' + PLANO_IA + '.chaves.dia }}',
      expire: true, ttl: '={{ ' + PLANO_IA + '.ttl.dia }}',
    }),
    // Uma tentativa, com tempo limite curto. Se falhar, o atendimento segue sem a IA.
    no(
      'IA: gerar resposta',
      'n8n-nodes-base.httpRequest',
      4.2,
      [5140, -300],
      {
        method: 'POST',
        url: '={{ ' + PLANO_IA + '.url }}',
        authentication: 'genericCredentialType',
        genericAuthType: 'httpHeaderAuth',
        sendBody: true,
        specifyBody: 'json',
        jsonBody: '={{ JSON.stringify(' + PLANO_IA + '.corpo) }}',
        options: { timeout: '={{ ' + PLANO_IA + '.tempoLimiteMs }}' },
      },
      { credentials: CRED_IA, onError: 'continueRegularOutput' },
    ),
    noCodigo('Aplicar resposta da IA', [5360, -300], 'aplicar-resposta-ia.js'),
    noCodigo('Resposta final', [5580, -100], 'resposta-final.js'),

    noRedis('Redis: contador de respostas iguais', [3600 + DX, -100], {
      operation: 'incr',
      key: '={{ ' + RESOLVIDO + '.chaves.iguais }}',
      expire: true,
      ttl: '={{ ' + BASE + '.ttl.iguais }}',
    }),
    noCodigo('Verificar limites', [3820 + DX, -100], 'verificar-limites.js'),
    noSe('Deve responder?', [4040 + DX, -100], '={{ $json.responder }}'),
    noSe('Pediu atendente?', [4280 + DX, -200], '={{ $json.transferir }}'),
    noRedis('Redis: pausar contato', [4500 + DX, -300], {
      operation: 'set',
      key: '={{ ' + BASE + '.chavePausa }}',
      value: '={{ ' + BASE + '.valorPausa }}',
      keyType: 'string',
      expire: true,
      ttl: '={{ ' + BASE + '.ttlPausa }}',
    }),
    noWaha('WAHA: marcar como lida', [4740 + DX, -200], '/api/sendSeen', conversa, OPCIONAL),
    noWaha('WAHA: digitando', [4960 + DX, -200], '/api/startTyping', conversa, OPCIONAL),
    no(
      'Aguardar',
      'n8n-nodes-base.wait',
      1.1,
      [5180 + DX, -200],
      { amount: '={{ ' + BASE + '.atrasoSegundos }}', unit: 'seconds' },
      { webhookId: 'c0de0000-0000-4000-9000-000000000002' },
    ),
    noWaha('WAHA: parar de digitar', [5400 + DX, -200], '/api/stopTyping', conversa, OPCIONAL),
    noWaha('WAHA: enviar resposta', [5620 + DX, -200], '/api/sendText', mensagem, {
      retryOnFail: true,
      maxTries: 2,
      waitBetweenTries: 1500,
      onError: 'continueErrorOutput',
    }),
    // O fallback só avança quando o envio ao WhatsApp realmente teve sucesso.
    noRedis('Redis: guardar conversa', [5800 + DX, -100], {
      operation: 'set', key: '={{ ' + BASE + '.chaveConversa }}',
      value: '={{ ' + RESOLVIDO + '.valorConversa }}', keyType: 'string', expire: true,
      ttl: '={{ ' + RESOLVIDO + '.ttlConversa }}',
    }),
    noRedis('Redis: liberar trava (sucesso)', [6020 + DX, -100], { operation: 'delete', key: CHAVE_TRAVA }),
    noRedis('Redis: liberar trava (sem resposta)', [4280 + DX, 80], { operation: 'delete', key: CHAVE_TRAVA }),
    noRedis('Redis: liberar trava (erro no envio)', [5800 + DX, -440], { operation: 'delete', key: CHAVE_TRAVA }),

    // --- ramo "reativar": atendente digitou o comando de reativação na conversa ---
    noRedis('Redis: reativar contato', [1120, 300], { operation: 'delete', key: '={{ ' + BASE + '.chavePausa }}' }),
    noWaha('WAHA: avisar reativação', [1340, 300], '/api/sendText', avisoReativacao, {
      retryOnFail: true,
      maxTries: 2,
      waitBetweenTries: 1500,
    }),

    // --- ramo "pausar": atendente digitou o comando de pausa na conversa ---
    noRedis('Redis: pausar contato (atendente)', [1120, 500], {
      operation: 'set',
      key: '={{ ' + BASE + '.chavePausa }}',
      value: '={{ ' + BASE + '.valorPausa }}',
      keyType: 'string',
      expire: true,
      ttl: '={{ ' + BASE + '.ttlPausa }}',
    }),

    // --- ramo "sessao": o WhatsApp mudou de status; guarda o momento ---
    noRedis('Redis: registrar estado da sessão', [1120, 700], {
      operation: 'set',
      key: '={{ ' + BASE + '.chaveSessao }}',
      value: '={{ ' + BASE + '.valorSessao }}',
      keyType: 'string',
      expire: false,
    }),

    // --- registro de diagnóstico (todos os ramos terminam aqui) ---
    ...cadeiaDeLog('chatbot', 5880 + DX, 300, 'registrar-log.js', 'Montar linha de log'),
    // Conversa com texto (tela "Conversas" do painel), num arquivo próprio e de retenção curta.
    noCodigo('Montar linha da conversa', [6540 + DX, 300], 'registrar-conversa.js'),
    no('Converter conversa em arquivo', 'n8n-nodes-base.convertToFile', 1.1, [6760 + DX, 300], {
      operation: 'toText',
      sourceProperty: 'linha',
      binaryPropertyName: 'data',
      options: { fileName: 'conversas.log' },
    }),
    no('Gravar no arquivo de conversas', 'n8n-nodes-base.readWriteFile', 1, [6980 + DX, 300], {
      operation: 'write',
      fileName: "=/files/logs/conversas-{{ $now.toFormat('yyyy-LL-dd') }}.log",
      dataPropertyName: 'data',
      options: { append: true },
    }),
    // Falha no envio: depois de registrada nos logs, marca a execução como erro.
    noCodigo('Propagar falha de envio', [7200 + DX, 300], 'propagar-falha-envio.js'),
  ];

  const c = {};
  ligar(c, 'Webhook WAHA', 'Redis: estado da sessão');
  ligar(c, 'Redis: estado da sessão', 'Ler configuração');
  ligar(c, 'Ler configuração', 'Extrair configuração');
  ligar(c, 'Extrair configuração', 'Interpretar mensagem');
  ligar(c, 'Interpretar mensagem', 'Qual ação?');

  ligar(c, 'Qual ação?', 'Redis: deduplicar', 0);
  ligar(c, 'Qual ação?', 'Redis: reativar contato', 1);
  ligar(c, 'Qual ação?', 'Redis: pausar contato (atendente)', 2);
  ligar(c, 'Qual ação?', 'Redis: registrar estado da sessão', 3);
  ligar(c, 'Qual ação?', 'Montar linha de log', 4);
  ligar(c, 'Redis: registrar estado da sessão', 'Montar linha de log');

  ligar(c, 'Redis: deduplicar', 'Redis: contato em atendimento?');
  ligar(c, 'Redis: contato em atendimento?', 'Verificar duplicidade e pausa');
  ligar(c, 'Verificar duplicidade e pausa', 'Segue o atendimento?');
  ligar(c, 'Segue o atendimento?', 'Redis: marcar última mensagem', 0);
  ligar(c, 'Segue o atendimento?', 'Redis: sair do atendimento humano', 1);
  ligar(c, 'Segue o atendimento?', 'Montar linha de log', 2);
  ligar(c, 'Redis: sair do atendimento humano', 'Redis: marcar última mensagem');
  ligar(c, 'Redis: marcar última mensagem', 'Aguardar mensagens em sequência');
  ligar(c, 'Aguardar mensagens em sequência', 'Redis: ler última mensagem');
  ligar(c, 'Redis: ler última mensagem', 'Redis: reler estado da sessão');
  ligar(c, 'Redis: reler estado da sessão', 'Verificar sequência e sessão');
  ligar(c, 'Verificar sequência e sessão', 'É a última da sequência?');
  ligar(c, 'É a última da sequência?', 'Redis: adquirir trava da conversa', 0);
  ligar(c, 'Redis: adquirir trava da conversa', 'Trava da conversa adquirida?');
  ligar(c, 'Trava da conversa adquirida?', 'Redis: conferir última após trava', 0);
  ligar(c, 'Trava da conversa adquirida?', 'Aguardar liberação da conversa', 1);
  ligar(c, 'Aguardar liberação da conversa', 'Redis: consultar trava da conversa');
  ligar(c, 'Redis: consultar trava da conversa', 'Trava da conversa livre?');
  ligar(c, 'Trava da conversa livre?', 'Redis: adquirir trava da conversa', 0);
  ligar(c, 'Trava da conversa livre?', 'Aguardar liberação da conversa', 1);
  ligar(c, 'Redis: conferir última após trava', 'Redis: conferir pausa após trava');
  ligar(c, 'Redis: conferir pausa após trava', 'Redis: conferir sessão após trava');
  ligar(c, 'Redis: conferir sessão após trava', 'Verificar proteções após trava');
  ligar(c, 'Verificar proteções após trava', 'Última mensagem após a trava?');
  ligar(c, 'Última mensagem após a trava?', 'Redis: ler conversa', 0);
  ligar(c, 'Última mensagem após a trava?', 'Redis: liberar trava (superada)', 1);
  ligar(c, 'Redis: liberar trava (superada)', 'Montar linha de log');
  ligar(c, 'Redis: ler conversa', 'Resolver conversa');
  ligar(c, 'Resolver conversa', 'Redis: contador por hora');
  ligar(c, 'É a última da sequência?', 'Montar linha de log', 1);
  // Três caminhos até "Resposta final": sem IA, IA barrada pelo limite e IA consultada.
  ligar(c, 'Redis: contador por hora', 'Consultar a IA?');
  ligar(c, 'Consultar a IA?', 'Redis: usos da IA (contato)', 0);
  ligar(c, 'Consultar a IA?', 'Resposta final', 1);
  ligar(c, 'Redis: usos da IA (contato)', 'Redis: usos da IA (dia)');
  ligar(c, 'Redis: usos da IA (dia)', 'Verificar limites da IA');
  ligar(c, 'Verificar limites da IA', 'IA dentro do limite?');
  ligar(c, 'IA dentro do limite?', 'Redis: contar uso da IA (contato)', 0);
  ligar(c, 'IA dentro do limite?', 'Resposta final', 1);
  ligar(c, 'Redis: contar uso da IA (contato)', 'Redis: contar uso da IA (dia)');
  ligar(c, 'Redis: contar uso da IA (dia)', 'IA: gerar resposta');
  ligar(c, 'IA: gerar resposta', 'Aplicar resposta da IA');
  ligar(c, 'Aplicar resposta da IA', 'Resposta final');
  ligar(c, 'Resposta final', 'Redis: contador de respostas iguais');
  ligar(c, 'Redis: contador de respostas iguais', 'Verificar limites');
  ligar(c, 'Verificar limites', 'Deve responder?');
  ligar(c, 'Deve responder?', 'Pediu atendente?', 0);
  ligar(c, 'Deve responder?', 'Redis: liberar trava (sem resposta)', 1);
  ligar(c, 'Redis: liberar trava (sem resposta)', 'Montar linha de log');
  // O contato é marcado como "em atendimento" ANTES de receber a confirmação.
  ligar(c, 'Pediu atendente?', 'Redis: pausar contato', 0);
  ligar(c, 'Pediu atendente?', 'WAHA: marcar como lida', 1);
  ligar(c, 'Redis: pausar contato', 'WAHA: marcar como lida');
  ligar(c, 'WAHA: marcar como lida', 'WAHA: digitando');
  ligar(c, 'WAHA: digitando', 'Aguardar');
  ligar(c, 'Aguardar', 'WAHA: parar de digitar');
  ligar(c, 'WAHA: parar de digitar', 'WAHA: enviar resposta');
  ligar(c, 'WAHA: enviar resposta', 'Redis: guardar conversa');
  ligar(c, 'Redis: guardar conversa', 'Redis: liberar trava (sucesso)');
  ligar(c, 'Redis: liberar trava (sucesso)', 'Montar linha de log');
  ligar(c, 'WAHA: enviar resposta', 'Redis: liberar trava (erro no envio)', 1);
  // A falha também é registrada (log e conversa) antes de ser propagada.
  ligar(c, 'Redis: liberar trava (erro no envio)', 'Montar linha de log');

  ligar(c, 'Redis: reativar contato', 'WAHA: avisar reativação');
  ligar(c, 'WAHA: avisar reativação', 'Montar linha de log');
  ligar(c, 'Redis: pausar contato (atendente)', 'Montar linha de log');

  ligar(c, 'Montar linha de log', 'Converter em arquivo');
  ligar(c, 'Converter em arquivo', 'Gravar no arquivo de log');
  ligar(c, 'Gravar no arquivo de log', 'Montar linha da conversa');
  ligar(c, 'Montar linha da conversa', 'Converter conversa em arquivo');
  ligar(c, 'Converter conversa em arquivo', 'Gravar no arquivo de conversas');
  ligar(c, 'Gravar no arquivo de conversas', 'Propagar falha de envio');

  return {
    id: ID_PRINCIPAL,
    name: 'Chatbot Evento - Atendimento WhatsApp',
    active: false,
    nodes: nos,
    connections: c,
    settings: { ...CONFIGURACOES, errorWorkflow: ID_ERROS },
    pinData: {},
    tags: [],
  };
}

// ---------- workflow de erros ----------

function workflowErros() {
  const nos = [
    no('Quando um workflow falhar', 'n8n-nodes-base.errorTrigger', 1, [0, 0], {}),
    ...cadeiaDeLog('erros', 240, 0, 'registrar-erro.js', 'Montar linha de erro'),
  ];
  const c = {};
  ligar(c, 'Quando um workflow falhar', 'Montar linha de erro');
  ligar(c, 'Montar linha de erro', 'Converter em arquivo');
  ligar(c, 'Converter em arquivo', 'Gravar no arquivo de log');

  return {
    id: ID_ERROS,
    name: 'Chatbot Evento - Registro de erros',
    active: false,
    nodes: nos,
    connections: c,
    settings: { ...CONFIGURACOES },
    pinData: {},
    tags: [],
  };
}

// ---------- gravação ----------

fs.mkdirSync(SAIDA, { recursive: true });
for (const [arquivo, workflow] of [
  ['chatbot-evento.json', workflowPrincipal()],
  ['chatbot-evento-erros.json', workflowErros()],
]) {
  const nomes = workflow.nodes.map((n) => n.name);
  const repetidos = nomes.filter((n, i) => nomes.indexOf(n) !== i);
  if (repetidos.length) throw new Error(arquivo + ': nomes de nó repetidos: ' + repetidos.join(', '));
  for (const [origem, saidas] of Object.entries(workflow.connections)) {
    if (!nomes.includes(origem)) throw new Error(arquivo + ': conexão a partir de nó inexistente: ' + origem);
    for (const destino of saidas.main.flat()) {
      if (!nomes.includes(destino.node)) throw new Error(arquivo + ': conexão para nó inexistente: ' + destino.node);
    }
  }
  fs.writeFileSync(path.join(SAIDA, arquivo), JSON.stringify(workflow, null, 2) + '\n', 'utf8');
  console.log('Gerado n8n/workflows/' + arquivo + ' (' + workflow.nodes.length + ' nós)');
}
