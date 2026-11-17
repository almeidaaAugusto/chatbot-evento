// A espera pela conversa também pode ter sido atravessada por uma pausa do
// operador ou por uma mudança de sessão. Confere os valores relidos sob a trava.
const base = $('Interpretar mensagem').first().json;
const ultima = ($('Redis: conferir última após trava').first().json ?? {}).ultima;
const pausa = ($('Redis: conferir pausa após trava').first().json ?? {}).pausa;
const sessao = String(($('Redis: conferir sessão após trava').first().json ?? {}).sessao ?? '');
const ultimoStatusMs = Number(sessao.split('|')[0]) || 0;
let motivo = '';

if (ultima && ultima !== base.chaveMensagem) {
  motivo = 'agrupada_com_mensagem_seguinte';
} else if (pausa !== null && pausa !== undefined && pausa !== '') {
  // Mesmo um menu recebido antes da nova pausa respeita a ação posterior do operador.
  motivo = 'em_atendimento_humano';
} else if (
  !base.responderPendentes && ultimoStatusMs > 0 && base.carimboSegundos > 0 &&
  (base.carimboSegundos + 2) * 1000 < ultimoStatusMs
) {
  motivo = 'recebida_com_o_robo_desligado';
}

return [{ json: { ...base, seguir: !motivo, motivo } }];
