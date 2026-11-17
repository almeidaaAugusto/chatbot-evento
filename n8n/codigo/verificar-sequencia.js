// Nó "Verificar sequência e sessão" (roda depois da espera por mensagens em sequência).
// Só deixa seguir a última mensagem de uma sequência do mesmo contato e confere DE NOVO se
// a mensagem não é uma pendência de quando o robô estava desligado. A segunda conferência
// cobre o caso de a mensagem pendente ter sido lida antes de o robô registrar que foi ligado.

const base = $('Interpretar mensagem').first().json;

const ultima = ($('Redis: ler última mensagem').first().json ?? {}).ultima;
const estado = String(($('Redis: reler estado da sessão').first().json ?? {}).sessao ?? '');
const ultimoStatusMs = Number(estado.split('|')[0]) || 0;

let seguir = true;
let motivo = '';

if (ultima && ultima !== base.chaveMensagem) {
  seguir = false;
  motivo = 'agrupada_com_mensagem_seguinte';
} else if (
  !base.responderPendentes &&
  ultimoStatusMs > 0 &&
  base.carimboSegundos > 0 &&
  (base.carimboSegundos + 2) * 1000 < ultimoStatusMs
) {
  seguir = false;
  motivo = 'recebida_com_o_robo_desligado';
}

return [{ json: { ...base, seguir, motivo } }];
