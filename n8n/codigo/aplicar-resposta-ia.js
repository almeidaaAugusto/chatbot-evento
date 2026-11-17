// Nó "Aplicar resposta da IA". O gerador embute aqui o assistente de IA (IA).
// Se a IA respondeu algo aproveitável, essa passa a ser a resposta e a sequência de
// "não entendi" recomeça. Caso contrário (erro, tempo esgotado, limite da API, resposta
// vazia ou com dado não confirmado) vale a orientação normal que o motor já escolheu.

const base = $('Verificar limites da IA').first().json;
const lida = IA.interpretarResposta(base.config, $input.first().json ?? {});

if (!lida.ok) {
  return [{ json: { ...base, ia: { ...base.ia, resultado: lida.motivo } } }];
}

const marca = IA.assinatura(lida.texto);
const estado = { falhas: 0, ultimaIntencao: 'ia', ultimaResposta: marca, pendentes: [] };
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
  chaves: { ...base.chaves, iguais: 'rep:' + base.chatId + ':ia:' + marca },
  ia: { ...base.ia, resultado: 'respondeu' },
} }];
