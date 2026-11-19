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
const lida = IA.interpretarResposta(base.config, $input.first().json ?? {});

if (!lida.ok) {
  const tentativas = [...falhas, { modelo, motivo: lida.motivo }];
  const tentarReserva = IA.deveTentarReserva(lida.motivo) && Array.isArray(base.ia.pedidos) && Boolean(base.ia.pedidos[TENTATIVA + 1]);
  return [{ json: { ...base, ia: { ...base.ia, resultado: lida.motivo, tentativas, tentarReserva } } }];
}

const marca = IA.assinatura(lida.texto);
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
  chaves: { ...base.chaves, iguais: 'rep:' + base.sessao + ':' + base.chatId + ':ia:' + marca },
  ia: { ...base.ia, resultado: 'respondeu', modelo, tentativas: falhas, tentarReserva: false },
} }];
