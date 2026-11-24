// O gerador embute aqui o motor de regras (Chatbot), a camada de vários eventos (Eventos) e o
// assistente de IA (IA), os mesmos que o simulador do painel utiliza.
const base = $('Interpretar mensagem').first().json;
let estado = {};
try {
  const guardado = $('Redis: ler conversa').first().json.conversa;
  if (guardado) estado = JSON.parse(String(guardado));
} catch (e) {
  // Um estado antigo ou inválido não interrompe o atendimento.
}
// Com vários eventos o estado fica guardado por um dia, para lembrar o evento escolhido. A
// sequência de "não entendi" e o menu de eventos pendente continuam valendo só 30 minutos.
const multiEvento = Eventos.ehMultiEvento(base.config);
if (multiEvento && !(Date.now() - Number(estado.momento) <= 1800000)) {
  estado = typeof estado.evento === 'string' ? { evento: estado.evento } : {};
}
// Conversa natural: memória curta (Redis) e contador de bloqueios do contato. Leituras tolerantes:
// estado antigo ou ausente nunca interrompe o atendimento.
const lerCampo = (no, campo) => {
  try {
    return ($(no).first().json ?? {})[campo];
  } catch (e) {
    return undefined;
  }
};
const ataques = Number(lerCampo('Redis: ler ataques', 'ataques')) || 0;
let historico = [];
try {
  const guardado = lerCampo('Redis: ler histórico', 'historico');
  if (guardado) historico = JSON.parse(String(guardado));
} catch (e) {
  historico = [];
}

let resolvido = Eventos.resolver(base.config, base.texto, estado, { midia: base.midia, sessao: base.sessao });
// Quem responde: regras prontas, IA redigindo a resposta oficial ou IA respondendo. O filtro de entrada
// e o bloqueio do contato insistente são decididos aqui, sem chamar nenhuma IA.
const plano = IA.planejar(resolvido.config, resolvido, base.texto, { ataques });
if (plano.trava && plano.bloqueioDeEntendimento && resolvido.origem === 'nao_reconhecida') {
  // Mensagem bloqueada que as regras não entenderam: resposta fixa, em vez da orientação de fallback.
  resolvido = { ...resolvido, resposta: IA.foraDoAssunto(resolvido.config), origem: 'fora_do_assunto' };
}
if (!resolvido.silenciar && !String(resolvido.resposta ?? '').trim()) {
  throw new Error('Resposta vazia. Confira o conteúdo no painel do chatbot.');
}
// As três orientações de fallback são respostas diferentes. O limite de repetições
// continua valendo por texto, sem bloquear uma nova sequência depois da recuperação.
let identificador = resolvido.intencao;
if (['nao_entendi', 'esclarecer'].includes(resolvido.intencao)) {
  let hash = 2166136261;
  for (const caractere of String(resolvido.resposta ?? '')) {
    hash = Math.imul(hash ^ caractere.charCodeAt(0), 16777619);
  }
  identificador += ':' + (hash >>> 0).toString(16);
}

// Texto que o motor não reconheceu: prepara a consulta à IA. Os nós seguintes conferem
// os limites de uso e só então fazem a chamada; se ela não ajudar, vale a resposta acima.
const conf = IA.configuracao(resolvido.config);
let ia = { usar: false };
if (plano.trava) {
  ia = { usar: false, modo: plano.modoPrevisto, resultado: plano.resultado, trava: plano.trava };
} else if (plano.modo) {
  const natural = conf.conversaNatural;
  const relogio = typeof $now !== 'undefined' && $now && typeof $now.toJSDate === 'function' ? $now : null;
  const pedidos = IA.montarPedidos(resolvido.config, base.texto, {
    agora: relogio ? relogio.toJSDate() : new Date(),
    fuso: relogio ? relogio.zoneName : undefined,
    ultimaIntencao: estado && typeof estado.ultimaIntencao === 'string' ? estado.ultimaIntencao : '',
    // Só a conversa natural usa modo, histórico e nome; desligada, o pedido é o de sempre.
    ...(natural ? {
      modo: plano.modo,
      opcao: plano.modo === 'redigir' ? resolvido.intencao : undefined,
      historico,
      nomeContato: IA.primeiroNome(base.registro && base.registro.nome),
    } : {}),
  });
  const guarda = IA.pedidoClassificador(resolvido.config, base.texto);
  const dia = relogio ? relogio.toFormat('yyyy-LL-dd') : new Date().toISOString().slice(0, 10);
  ia = {
    usar: true,
    modo: plano.modo,
    // Sem histórico = primeira resposta da conversa (o rodapé só aparece nela, na conversa natural).
    primeira: !(natural && conf.memoriaMensagens > 0 && Array.isArray(historico) && historico.length > 0),
    // Só o id do assunto segue adiante; o texto oficial é relido da configuração.
    opcao: plano.modo === 'redigir' ? resolvido.intencao : undefined,
    classificador: guarda,
    url: pedidos[0].url,
    // Um corpo para o modelo principal e um para cada modelo reserva (mesma URL e chave).
    pedidos: pedidos.map((pedido) => pedido.corpo),
    modelos: pedidos.map((pedido) => pedido.corpo.model),
    tempoLimiteMs: pedidos[0].tempoLimiteMs,
    limites: { porContato: conf.maxUsosPorContato, porDia: conf.maxUsosPorDia },
    chaves: { contato: 'ia:contato:' + base.chatId, dia: 'ia:dia:' + dia },
    ttl: { contato: conf.janelaSegundos, dia: 172800 },
  };
}

return [{ json: {
  ...base,
  ...resolvido,
  config: resolvido.config,
  ia,
  // Memória: só com a conversa natural e memória maior que zero.
  memoria: { ativa: conf.conversaNatural && conf.memoriaMensagens > 0, max: conf.memoriaMensagens },
  valorConversa: JSON.stringify(multiEvento ? { ...resolvido.estado, momento: Date.now() } : resolvido.estado),
  ttlConversa: multiEvento ? 86400 : 1800,
  chaves: { ...base.chaves, iguais: 'rep:' + base.sessao + ':' + base.chatId + ':' + identificador },
} }];
