// O gerador embute aqui o motor de regras (Chatbot) e o assistente de IA (IA), os
// mesmos que o simulador do painel utiliza.
const base = $('Interpretar mensagem').first().json;
let estado = {};
try {
  const guardado = $('Redis: ler conversa').first().json.conversa;
  if (guardado) estado = JSON.parse(String(guardado));
} catch (e) {
  // Um estado antigo ou inválido não interrompe o atendimento.
}
const resolvido = Chatbot.resolver(base.config, base.texto, estado, { midia: base.midia });
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
let ia = { usar: false };
if (IA.deveConsultar(base.config, resolvido, base.texto)) {
  const conf = IA.configuracao(base.config);
  const relogio = typeof $now !== 'undefined' && $now && typeof $now.toJSDate === 'function' ? $now : null;
  const pedido = IA.montarPedido(base.config, base.texto, {
    agora: relogio ? relogio.toJSDate() : new Date(),
    fuso: relogio ? relogio.zoneName : undefined,
    ultimaIntencao: estado && typeof estado.ultimaIntencao === 'string' ? estado.ultimaIntencao : '',
  });
  const dia = relogio ? relogio.toFormat('yyyy-LL-dd') : new Date().toISOString().slice(0, 10);
  ia = {
    usar: true,
    url: pedido.url,
    corpo: pedido.corpo,
    tempoLimiteMs: pedido.tempoLimiteMs,
    limites: { porContato: conf.maxUsosPorContato, porDia: conf.maxUsosPorDia },
    chaves: { contato: 'ia:contato:' + base.chatId, dia: 'ia:dia:' + dia },
    ttl: { contato: conf.janelaSegundos, dia: 172800 },
  };
}

return [{ json: {
  ...base,
  ...resolvido,
  ia,
  valorConversa: JSON.stringify(resolvido.estado),
  ttlConversa: 1800,
  chaves: { ...base.chaves, iguais: 'rep:' + base.chatId + ':' + identificador },
} }];
