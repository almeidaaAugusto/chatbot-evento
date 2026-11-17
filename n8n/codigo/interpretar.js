// Nó "Interpretar mensagem".
// Lê o evento enviado pelo WAHA e a configuração (config/chatbot.json) e decide
// o que fazer: ignorar, processar (responder), pausar ou reativar o robô.
// Para mudar respostas e palavras-chave, edite config/chatbot.json, não este código.

const corpo = $('Webhook WAHA').first().json.body ?? {};

let cfg;
try {
  const bruto = String($('Extrair configuração').first().json.data ?? '').replace(/^﻿/, '');
  cfg = JSON.parse(bruto);
} catch (e) {
  throw new Error('config/chatbot.json inválido ou ilegível: ' + e.message);
}

// No v2 os campos {{...}} das mensagens gerais vêm de "produtora"; no v1, de "evento".
const evento = cfg.produtora ?? cfg.evento ?? {};
const mensagens = cfg.mensagens ?? {};
const humano = cfg.atendimento_humano ?? {};
const prot = cfg.protecoes ?? {};

// ---------- utilitários ----------

const numero = (valor, padrao) => {
  const n = Number(valor);
  return valor === null || valor === undefined || valor === '' || !Number.isFinite(n) ? padrao : n;
};

// Minúsculas, sem acentos, sem pontuação, espaços simples. "#" é mantido para os comandos.
const normalizar = (texto) =>
  String(texto ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9#]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');

// Troca {{campo}} pelo valor de mesmo nome em "evento".
const preencher = (texto) =>
  String(texto ?? '').replace(/\{\{\s*([\w-]+)\s*\}\}/g, (original, chave) => {
    const valor = evento[chave] ?? evento[chave.toLowerCase()];
    return valor === undefined || valor === null || typeof valor === 'object' ? original : String(valor);
  });

// Nos logs o contato aparece só pelos 4 últimos dígitos.
const mascarar = (id) => {
  const digitos = String(id ?? '').split('@')[0].replace(/\D/g, '');
  return digitos ? '***' + digitos.slice(-4) : 'desconhecido';
};

// Final do identificador da mensagem (não contém o telefone).
const finalDoId = (id) => {
  const partes = String(id ?? '').split('_');
  const chave = partes.length >= 3 ? partes[2] : partes[partes.length - 1];
  return chave.replace(/[^A-Za-z0-9]/g, '').slice(-8) || 'sem-id';
};

const base = {
  evento: String(corpo.event ?? ''),
  sessao: String(corpo.session ?? 'default'),
};
const ignorar = (motivo, extra = {}) => [{ json: { ...base, ...extra, acao: 'ignorar', motivo } }];

// ---------- estado da sessão ----------
// O Redis guarda "<momento em ms>|<status>" do último evento de status do WhatsApp
// (STARTING, WORKING, STOPPED...). Esse momento marca quando o robô foi ligado pela
// última vez: o que foi enviado antes disso é mensagem pendente e não é respondido.

const estadoGuardado = String(($('Redis: estado da sessão').first().json ?? {}).sessao ?? '');
const ultimoStatusMs = Number(estadoGuardado.split('|')[0]) || 0;

if (base.evento === 'session.status') {
  const status = String(corpo.payload?.status ?? '');
  const informado = numero(corpo.timestamp, Date.now());
  const momentoMs = Math.min(informado < 1e12 ? informado * 1000 : informado, Date.now());
  // Eventos atrasados (reenviados pelo WAHA) não podem voltar o relógio.
  if (momentoMs < ultimoStatusMs) return ignorar('status_da_sessao', { detalhe: status });
  return [
    {
      json: {
        ...base,
        acao: 'sessao',
        detalhe: status,
        chaveSessao: 'sessao:' + base.sessao,
        valorSessao: Math.round(momentoMs) + '|' + status,
      },
    },
  ];
}

// ---------- filtros ----------

if (base.evento !== 'message' && base.evento !== 'message.any') {
  return ignorar('evento_nao_tratado');
}

const p = corpo.payload;
if (!p || typeof p !== 'object') {
  return ignorar('payload_ausente');
}

const de = String(p.from ?? '');
const para = String(p.to ?? '');
const doProprioNumero = p.fromMe === true;
// Em mensagens enviadas pelo próprio número, a conversa é o destinatário.
const chatId = doProprioNumero ? para || de : de;
const idMensagem = String(p.id ?? corpo.id ?? '');
const info = { contato: mascarar(chatId), msg: finalDoId(idMensagem) };

if (!chatId) return ignorar('remetente_ausente', info);
if (/@g\.us$/i.test(chatId) || /@g\.us$/i.test(de)) return ignorar('grupo', info);
if (/@newsletter$/i.test(chatId)) return ignorar('canal', info);
if (/@broadcast$/i.test(chatId)) return ignorar('status_ou_lista_de_transmissao', info);
if (!/@(c\.us|lid|s\.whatsapp\.net)$/i.test(chatId)) return ignorar('tipo_de_conversa_nao_suportado', info);

const texto = typeof p.body === 'string' ? p.body : '';

// Dados para a tela "Conversas" do painel. Ficam só no arquivo conversas-AAAA-MM-DD.log,
// apagado depois de alguns dias (CONVERSAS_RETENCAO_DIAS); o log de atividade não os recebe.
// No WAHA GOWS o contato costuma chegar como @lid; o telefone vem em _data.Info.SenderAlt
// (mensagens recebidas) ou RecipientAlt (mensagens do próprio número).
const infoWhatsApp = (p._data && typeof p._data === 'object' && p._data.Info && typeof p._data.Info === 'object') ? p._data.Info : {};
const telefoneDe = (id) => {
  const [usuario, dominio] = String(id ?? '').split('@');
  const digitos = String(usuario ?? '').split(':')[0].replace(/\D/g, '');
  return /^(c\.us|s\.whatsapp\.net)$/i.test(dominio ?? '') && digitos.length >= 8 ? digitos : '';
};
info.registro = {
  sessao: base.sessao,
  conversa: chatId,
  telefone: telefoneDe(chatId) || telefoneDe(doProprioNumero ? infoWhatsApp.RecipientAlt : infoWhatsApp.SenderAlt),
  // Nas mensagens do próprio número o PushName é o do atendente, não o do contato.
  nome: doProprioNumero ? '' : String(infoWhatsApp.PushName ?? p.notifyName ?? '').trim().slice(0, 80),
  texto: texto.slice(0, 4000),
  midia: p.hasMedia === true,
};
const normalizado = normalizar(texto);

const chavePausa = 'pausa:' + base.sessao + ':' + chatId;
const horasPausa = Math.max(numero(humano.horas_pausa, 24), 0.25);
const ttlPausa = Math.round(horasPausa * 3600);
const agoraIso = new Date().toISOString();

// Enviadas pela API são as respostas do próprio robô: nunca responder (evita laço).
if (doProprioNumero && String(p.source ?? '').toLowerCase() === 'api') return ignorar('enviada_pelo_robo', info);

// Mensagens antigas (por exemplo, as que o WhatsApp entrega de uma vez ao reconectar) não
// são tratadas, sejam do contato ou comandos do atendente.
const carimbo = numero(p.timestamp, 0);
const carimboSegundos = carimbo > 1e12 ? carimbo / 1000 : carimbo;
const idadeMaxima = numero(prot.idade_maxima_mensagem_segundos, 120);
if (carimboSegundos > 0 && idadeMaxima > 0 && Date.now() / 1000 - carimboSegundos > idadeMaxima) {
  return ignorar('mensagem_antiga', info);
}

// Mensagens enviadas enquanto o robô estava desligado ("conversas em aberto") chegam todas
// de uma vez quando ele é ligado. Não são respondidas, a menos que a configuração peça.
// A folga de 2 segundos cobre o arredondamento do horário informado pelo WhatsApp.
const responderPendentes = prot.responder_mensagens_recebidas_offline === true;
if (!responderPendentes && ultimoStatusMs > 0 && carimboSegundos > 0 && (carimboSegundos + 2) * 1000 < ultimoStatusMs) {
  return ignorar('recebida_com_o_robo_desligado', info);
}

// ---------- mensagens enviadas pelo próprio número ----------

if (doProprioNumero) {
  // Digitadas no celular pelo atendente: só interessam os comandos.
  const comandoReativar = normalizar(humano.comando_reativar ?? '#bot');
  const comandoPausar = normalizar(humano.comando_pausar ?? '#humano');
  const comum = { ...base, ...info, chatId, chavePausa };

  if (normalizado && normalizado === comandoReativar) {
    const aviso = preencher(mensagens.reativado).trim() || 'O atendimento automático foi reativado. Digite menu para ver as opções.';
    return [{ json: { ...comum, acao: 'reativar', resposta: aviso } }];
  }
  if (normalizado && normalizado === comandoPausar) {
    return [{ json: { ...comum, acao: 'pausar', ttlPausa, valorPausa: agoraIso + '|operador' } }];
  }
  // Qualquer outra mensagem digitada no celular (texto, foto, áudio) significa que uma pessoa
  // assumiu a conversa: o robô para de responder a esse contato, como no comando de pausa.
  // As respostas do próprio robô saem pela API e já foram descartadas acima.
  if (humano.pausar_quando_atendente_responder !== false) {
    return [{ json: { ...comum, acao: 'pausar', motivo: 'atendente_respondeu', ttlPausa, valorPausa: agoraIso + '|atendente_respondeu' } }];
  }
  return ignorar('enviada_pelo_atendente', info);
}

// ---------- mensagens recebidas ----------

if (!texto.trim()) {
  const responderMidia = p.hasMedia === true && prot.responder_midia_com_menu !== false;
  if (!responderMidia) return ignorar('sem_texto', info);
}

// "opção 2", "numero 3" etc. valem como "2", "3".
let alvo = normalizado.replace(/#/g, ' ').trim().replace(/\s+/g, ' ');
const comPrefixo = alvo.match(/^(?:opcao|numero|item|op)\s+(\d{1,2})$/);
if (comPrefixo) alvo = comPrefixo[1];

const lista = (valores) => (Array.isArray(valores) ? valores : []).map(normalizar).filter(Boolean);

// A escolha da resposta ocorre depois da deduplicação, da pausa e do agrupamento.
// Assim o fallback usa o contexto atualizado e mensagens descartadas não o avançam.

const atraso = prot.atraso_resposta_segundos ?? {};
const atrasoMinimo = Math.max(numero(atraso.min, 1), 0);
const atrasoMaximo = Math.max(numero(atraso.max, 3), atrasoMinimo);
const atrasoSegundos = Math.round((atrasoMinimo + Math.random() * (atrasoMaximo - atrasoMinimo)) * 10) / 10;

// Várias mensagens seguidas do mesmo contato recebem UMA resposta: espera-se este tempo e
// só a última mensagem da sequência é respondida.
const agruparSegundos = Math.min(Math.max(numero(prot.agrupar_mensagens_segundos, 4), 0), 30);

// Palavras com que o próprio contato sai do atendimento humano e volta ao robô.
const voltar = Boolean(alvo) && lista(humano.palavras_para_voltar ?? ['menu']).includes(alvo);

const chaveMensagem = idMensagem || chatId + ':' + carimbo;

return [
  {
    json: {
      ...base,
      ...info,
      acao: 'processar',
      chatId,
      config: cfg,
      texto,
      midia: !texto.trim() && p.hasMedia === true,
      chaveConversa: 'conversa:' + base.sessao + ':' + chatId,
      atrasoSegundos,
      agruparSegundos,
      voltar,
      chaveMensagem,
      carimboSegundos,
      responderPendentes,
      chavePausa,
      ttlPausa,
      valorPausa: agoraIso + '|cliente',
      chaves: {
        dedupe: 'dedupe:' + chaveMensagem,
        ultima: 'ultima:' + base.sessao + ':' + chatId,
        porHora: 'taxa:' + chatId,
      },
      ttl: {
        dedupe: 86400,
        ultima: 120,
        porHora: 3600,
        iguais: Math.max(Math.round(numero(prot.janela_respostas_iguais_minutos, 10) * 60), 60),
      },
      limites: {
        mensagensPorHora: Math.max(numero(prot.max_mensagens_por_hora, 40), 1),
        respostasIguais: Math.max(numero(prot.max_respostas_iguais, 3), 1),
      },
    },
  },
];
