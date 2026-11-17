// Último nó do atendimento. Quando o envio ao WhatsApp falhou, a saída de erro do HTTP
// passou antes pelo Redis (libera a conversa) e pelos logs; aqui a execução é marcada como
// falha para o workflow "Registro de erros". Propaga só um identificador fixo, sem corpo,
// telefone ou texto recebido.
if ($('Montar linha de log').first().json.falhaNoEnvio === true) {
  throw new Error('CHATBOT_FALHA_ENVIO_WAHA: não foi possível enviar a resposta pelo WhatsApp.');
}
return [];
