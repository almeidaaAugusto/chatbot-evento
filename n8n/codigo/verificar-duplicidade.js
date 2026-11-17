// Nó "Verificar duplicidade e pausa".
// Decide o caminho da mensagem:
//   parar  - já foi vista (mesmo ID) ou o contato está em atendimento humano;
//   voltar - o contato está em atendimento humano e digitou a palavra para voltar ao robô;
//   seguir - atendimento normal.

const base = $('Interpretar mensagem').first().json;

const contador = Number(Object.values($('Redis: deduplicar').first().json ?? {})[0]) || 0;
const pausa = ($('Redis: contato em atendimento?').first().json ?? {}).pausa;
const emAtendimentoHumano = pausa !== null && pausa !== undefined && pausa !== '';

let rota = 'seguir';
let motivo = '';

if (contador > 1) {
  rota = 'parar';
  motivo = 'mensagem_duplicada';
} else if (emAtendimentoHumano && base.voltar) {
  rota = 'voltar';
} else if (emAtendimentoHumano) {
  rota = 'parar';
  motivo = 'em_atendimento_humano';
}

return [{ json: { ...base, rota, motivo } }];
