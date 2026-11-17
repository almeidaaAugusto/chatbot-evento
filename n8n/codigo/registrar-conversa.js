// Nó "Montar linha da conversa".
// Repassa a linha preparada em "Montar linha de log" (texto recebido e resposta enviada).
// Sem conversa a registrar (status do WhatsApp, respostas do próprio robô, entregas
// repetidas), não devolve nada e o ramo termina aqui.
const { conversa, falhaNoEnvio } = $('Montar linha de log').first().json;
if (conversa) return [{ json: { linha: conversa } }];
// A falha de envio ainda precisa chegar ao nó que a propaga ao registro de erros.
if (falhaNoEnvio) throw new Error('CHATBOT_FALHA_ENVIO_WAHA: não foi possível enviar a resposta pelo WhatsApp.');
return [];
