// Nó "Aplicar classificador". O gerador embute aqui o assistente de IA (IA).
// Lê a nota do classificador de ataque (Prompt Guard) devolvida pelo nó HTTP anterior. Nota igual ou
// acima do limite bloqueia a IA; erro, cota ou tempo esgotado fecham com segurança (a IA principal não é
// chamada e vale a resposta pronta). Só uma nota baixa libera "IA: gerar resposta".
const base = $('Verificar limites da IA').first().json;
const lida = IA.interpretarClassificador(base.config, $input.first().json ?? {});

// Mensagem bloqueada que as regras não entenderam: resposta fixa, em vez da orientação de fallback.
const foraDoAssunto = (saida) => {
  if (base.ia.modo === 'responder' && base.origem === 'nao_reconhecida') {
    return {
      ...saida,
      resposta: IA.foraDoAssunto(base.config),
      origem: 'fora_do_assunto',
      chaves: { ...base.chaves, iguais: 'rep:' + base.sessao + ':' + base.chatId + ':fora_do_assunto' },
    };
  }
  return saida;
};

if (!lida.ok) {
  return [{ json: { ...base, ia: { ...base.ia, resultado: 'classificador_erro', aprovado: false } } }];
}
const score = Math.round(lida.score * 100) / 100;
if (lida.bloqueia) {
  return [{ json: foraDoAssunto({ ...base, ia: { ...base.ia, resultado: 'bloqueada_classificador', trava: 'classificador', score, aprovado: false } }) }];
}
return [{ json: { ...base, ia: { ...base.ia, score, aprovado: true } } }];
