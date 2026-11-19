// Nó "Consolidar envio". Roda UMA vez, no ramo "done" do laço de envio (todas as partes foram enviadas).
// Prepara a memória da conversa (lista dos últimos turnos, no Redis) e indica se houve bloqueio por
// alguma trava da IA (para o contador de ataques). Mensagens bloqueadas nunca entram na memória.
const base = $('Interpretar mensagem').first().json;
const final = $('Resposta final').first().json;
const ia = final.ia ?? {};
const memoria = final.memoria ?? {};
const partes = (Array.isArray(final.partes) && final.partes.length ? final.partes : [final.resposta])
  .map((parte) => String(parte ?? '')).filter((parte) => parte.trim() !== '');
const textoDoContato = String(base.texto ?? '').trim();

let valorHistorico = '';
const guardarMemoria = memoria.ativa === true && Number(memoria.max) > 0 && !ia.trava && textoDoContato !== '' && partes.length > 0;
if (guardarMemoria) {
  let antigo = [];
  try {
    const bruto = ($('Redis: ler histórico').first().json ?? {}).historico;
    if (bruto) antigo = JSON.parse(String(bruto));
  } catch (e) {
    antigo = [];
  }
  const quando = new Date().toISOString();
  const novos = [
    { de: 'contato', texto: textoDoContato.slice(0, 300), quando },
    { de: 'bot', texto: partes.join('\n').slice(0, 300), quando },
  ];
  const maximo = Math.max(Number(memoria.max) || 0, 0);
  const valido = (item) => item && ['contato', 'bot'].includes(item.de) && typeof item.texto === 'string';
  valorHistorico = JSON.stringify([...(Array.isArray(antigo) ? antigo.filter(valido) : []), ...novos].slice(-maximo));
}

return [{ json: {
  enviadas: partes.length,
  guardarMemoria: guardarMemoria && valorHistorico !== '[]',
  valorHistorico,
  ttlHistorico: 86400,
  bloqueio: ['entrada', 'classificador', 'saida'].includes(ia.trava),
} }];
