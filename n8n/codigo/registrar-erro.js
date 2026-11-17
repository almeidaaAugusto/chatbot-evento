// Nó "Montar linha de erro" (workflow de erros).
// Registra falhas do chatbot sem telefones, e-mails ou conteúdo de mensagens.

const dados = $input.first().json ?? {};
const execucao = dados.execution ?? {};
const erro = execucao.error ?? dados.trigger?.error ?? {};
// A falha de envio é propagada com um identificador fixo depois de registrada nos logs.
const falhaEnvio = String(erro.message ?? '').includes('CHATBOT_FALHA_ENVIO_WAHA');

// Remove sequências longas de dígitos (telefones) e identificadores com "@".
const limpar = (texto) =>
  String(texto ?? '')
    .replace(/\d{6,}/g, '***')
    .replace(/[\w.+*-]+@[\w.-]+/g, '***')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);

const registro = {
  quando: $now.toISO(),
  workflow: dados.workflow?.name,
  no: falhaEnvio ? 'WAHA: enviar resposta' : execucao.lastNodeExecuted ?? erro.node?.name,
  erro: falhaEnvio ? 'Não foi possível enviar a resposta pelo WhatsApp.' : limpar(erro.message) || 'erro sem mensagem',
  descricao: falhaEnvio ? undefined : limpar(erro.description) || undefined,
  http: erro.httpCode ?? undefined,
  execucao: execucao.id,
  modo: execucao.mode,
};

return [{ json: { linha: JSON.stringify(registro) + '\n' } }];
