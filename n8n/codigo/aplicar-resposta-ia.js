// Nós "Aplicar resposta da IA", "(reserva 1)" e "(reserva 2)". O gerador embute aqui o
// assistente de IA (IA) e define antes deste código a constante TENTATIVA (0, 1 ou 2).
// Se a IA respondeu algo aproveitável, essa passa a ser a resposta e a sequência de
// "não entendi" recomeça. Caso contrário (erro, tempo esgotado, limite da API, resposta
// vazia ou com dado não confirmado) vale a orientação normal que o motor já escolheu, ou
// a próxima tentativa com um modelo reserva, quando a falha é do tipo que outro modelo resolve.

const NOMES = ['Aplicar resposta da IA', 'Aplicar resposta da IA (reserva 1)', 'Aplicar resposta da IA (reserva 2)'];
const base = $('Verificar limites da IA').first().json;
const anterior = TENTATIVA > 0 ? $(NOMES[TENTATIVA - 1]).first().json : base;
const falhas = Array.isArray(anterior.ia && anterior.ia.tentativas) ? anterior.ia.tentativas : [];
const modelo = Array.isArray(base.ia.modelos) ? base.ia.modelos[TENTATIVA] : undefined;
const redigir = base.ia.modo === 'redigir';
// Nota do classificador (se rodou), para o log.
let score;
try {
  score = $('Aplicar classificador').first().json.ia.score;
} catch (e) {
  score = undefined;
}
const lida = IA.interpretarResposta(base.config, $input.first().json ?? {}, redigir ? { opcao: base.ia.opcao } : {});

if (!lida.ok) {
  const tentativas = [...falhas, { modelo, motivo: lida.motivo }];
  const tentarReserva = IA.deveTentarReserva(lida.motivo) && Array.isArray(base.ia.pedidos) && Boolean(base.ia.pedidos[TENTATIVA + 1]);
  const saida = { ...base, ia: { ...base.ia, resultado: lida.motivo, tentativas, tentarReserva, ...(lida.trava ? { trava: lida.trava } : {}), ...(score === undefined ? {} : { score }) } };
  // Resposta barrada pelo filtro de saída num texto que as regras não entenderam: mensagem fixa.
  if (lida.trava && base.ia.modo && !redigir && base.origem === 'nao_reconhecida') {
    saida.resposta = IA.foraDoAssunto(base.config);
    saida.origem = 'fora_do_assunto';
    saida.chaves = { ...base.chaves, iguais: 'rep:' + base.sessao + ':' + base.chatId + ':fora_do_assunto' };
  }
  return [{ json: saida }];
}

const marca = IA.assinatura(lida.texto);
if (redigir) {
  // O assunto continua sendo o reconhecido pelas regras: estado, intenção e contador de respostas iguais
  // seguem como o motor definiu; só o texto (e as partes) vêm da IA.
  return [{ json: {
    ...base,
    origem: 'ia_redigida',
    resposta: lida.texto,
    partes: lida.partes,
    ia: { ...base.ia, resultado: 'respondeu', modelo, tentativas: falhas, tentarReserva: false, ...(score === undefined ? {} : { score }) },
  } }];
}
// Preserva a escolha de evento da conversa (só existe no formato v2).
const estado = { falhas: 0, ultimaIntencao: 'ia', ultimaResposta: marca, pendentes: [] };
if (base.estado && 'evento' in base.estado) estado.evento = base.estado.evento;
if (base.estado && 'escolhendoEvento' in base.estado) estado.escolhendoEvento = base.estado.escolhendoEvento === true;
return [{ json: {
  ...base,
  intencao: 'ia',
  origem: 'ia',
  resposta: lida.texto,
  transferir: false,
  silenciar: false,
  motivo: undefined,
  estado,
  valorConversa: JSON.stringify(estado),
  partes: lida.partes,
  chaves: { ...base.chaves, iguais: 'rep:' + base.sessao + ':' + base.chatId + ':ia:' + marca },
  ia: { ...base.ia, resultado: 'respondeu', modelo, tentativas: falhas, tentarReserva: false, ...(score === undefined ? {} : { score }) },
} }];
