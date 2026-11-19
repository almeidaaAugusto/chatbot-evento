// Nó "Resposta final".
// Ponto único por onde passam os três caminhos: sem IA, IA barrada pelo limite e IA
// consultada. Os nós seguintes (limites, envio, contexto e log) leem a resposta daqui.

const executou = (no) => {
  try {
    return $(no).isExecuted === true;
  } catch (e) {
    return false;
  }
};

// O último "Aplicar" executado vale: reserva 2, reserva 1, principal.
let final;
if (executou('Aplicar resposta da IA (reserva 2)')) final = $('Aplicar resposta da IA (reserva 2)').first().json;
else if (executou('Aplicar resposta da IA (reserva 1)')) final = $('Aplicar resposta da IA (reserva 1)').first().json;
else if (executou('Aplicar resposta da IA')) final = $('Aplicar resposta da IA').first().json;
else if (executou('Verificar limites da IA')) final = $('Verificar limites da IA').first().json;
else final = $('Resolver conversa').first().json;

// O pedido enviado à IA contém a mensagem do contato: não segue adiante.
const { corpo, pedidos, url, ...ia } = final.ia ?? {};
return [{ json: { ...final, ia } }];
