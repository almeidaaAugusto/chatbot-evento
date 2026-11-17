// Nó "Verificar limites".
// Proteção contra excesso de respostas e laços de mensagens:
//  - total de mensagens atendidas por contato por hora;
//  - mesma resposta repetida para o mesmo contato dentro da janela configurada.

const base = $('Resposta final').first().json;

const primeiroValor = (no) => Number(Object.values($(no).first().json ?? {})[0]) || 0;
const naHora = primeiroValor('Redis: contador por hora');
const iguais = primeiroValor('Redis: contador de respostas iguais');

let responder = true;
let motivo = '';

if (base.silenciar) {
  responder = false;
  motivo = base.motivo || 'fallback_esgotado';
} else if (naHora > base.limites.mensagensPorHora) {
  responder = false;
  motivo = 'limite_de_mensagens_por_hora';
} else if (iguais > base.limites.respostasIguais) {
  responder = false;
  motivo = 'resposta_repetida';
}

return [{ json: { ...base, responder, motivo } }];
