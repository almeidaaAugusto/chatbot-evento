// Nó "Montar linha de log".
// Uma linha JSON por evento tratado, sem telefone completo e sem o texto da mensagem
// (log de atividade, guardado por LOG_RETENCAO_DIAS). Prepara também a linha da conversa,
// com o texto recebido e a resposta enviada, para a tela "Conversas" do painel; ela é gravada
// pelos nós seguintes em conversas-AAAA-MM-DD.log e apagada após CONVERSAS_RETENCAO_DIAS.

const executou = (no) => {
  try {
    return $(no).isExecuted === true;
  } catch (e) {
    return false;
  }
};
const saida = (no) => {
  try {
    return $(no).first().json ?? {};
  } catch (e) {
    return {};
  }
};

const interpretada = saida('Interpretar mensagem');
const base = executou('Resposta final')
  ? saida('Resposta final')
  : executou('Resolver conversa')
    ? saida('Resolver conversa')
    : interpretada;

let resultado;
let motivo = '';
let detalhe = base.detalhe;
// A saída de erro do envio passa por aqui antes de a falha ser propagada ao registro de erros.
const falhaNoEnvio = executou('Redis: liberar trava (erro no envio)');

if (base.acao === 'ignorar') {
  resultado = 'ignorada';
  motivo = base.motivo;
} else if (base.acao === 'sessao') {
  // Mudança de status do WhatsApp (o momento foi guardado no Redis).
  resultado = 'ignorada';
  motivo = 'status_da_sessao';
} else if (base.acao === 'reativar') {
  resultado = 'robo_reativado';
  motivo = 'comando_do_atendente';
} else if (base.acao === 'pausar') {
  resultado = 'robo_pausado';
  motivo = base.motivo === 'atendente_respondeu' ? 'atendente_respondeu' : 'comando_do_atendente';
} else if (falhaNoEnvio) {
  resultado = 'falha_no_envio';
  motivo = 'erro_no_whatsapp';
} else if (executou('WAHA: enviar resposta')) {
  resultado = 'respondida';
  motivo = base.transferir ? 'transferida_para_atendimento_humano' : base.origem;
} else if (executou('Verificar limites')) {
  resultado = 'silenciada';
  motivo = saida('Verificar limites').motivo;
} else if (executou('Verificar proteções após trava') && saida('Verificar proteções após trava').seguir === false) {
  motivo = saida('Verificar proteções após trava').motivo;
  resultado = motivo === 'recebida_com_o_robo_desligado' ? 'ignorada' : 'silenciada';
} else if (executou('Redis: ler última mensagem')) {
  // Parou na espera: chegou outra mensagem do mesmo contato logo em seguida (só a última é
  // respondida) ou a mensagem era uma pendência de quando o robô estava desligado.
  motivo = saida('Verificar sequência e sessão').motivo || 'agrupada_com_mensagem_seguinte';
  resultado = motivo === 'recebida_com_o_robo_desligado' ? 'ignorada' : 'silenciada';
} else {
  resultado = 'silenciada';
  motivo = saida('Verificar duplicidade e pausa').motivo;
}

if (executou('Redis: sair do atendimento humano')) {
  detalhe = 'contato_voltou_do_atendimento_humano';
}

const quando = $now.toISO();
const ia = (base.ia && base.ia.resultado) || undefined;
const registro = {
  quando,
  resultado,
  motivo: motivo || undefined,
  evento: base.evento || undefined,
  intencao: base.intencao,
  // Como a IA participou: respondeu, sem_resposta, limite_por_contato, limite_do_dia, erro_429...
  ia,
  contato: base.contato,
  msg: base.msg,
  detalhe: detalhe || undefined,
};

// ---------- linha da conversa (com texto) ----------
// Não entram: as respostas do robô que voltam como evento (já registradas junto da mensagem
// que as originou), entregas repetidas da mesma mensagem e eventos sem conversa (status do
// WhatsApp, grupos, canais). Também ficam de fora as mensagens antigas que o WhatsApp entrega
// de uma vez ao reconectar (todas as conversas do celular enquanto o robô esteve desligado):
// não são respondidas e só ocupariam a tela "Conversas" com conversas pessoais.
const NAO_REGISTRAR = ['enviada_pelo_robo', 'mensagem_duplicada', 'mensagem_antiga', 'recebida_com_o_robo_desligado'];
const dados = interpretada.registro;
let conversa = '';
if (dados && typeof dados === 'object' && !NAO_REGISTRAR.includes(motivo)) {
  const doAtendente = ['reativar', 'pausar'].includes(interpretada.acao) || motivo === 'enviada_pelo_atendente';
  let resposta;
  if (resultado === 'respondida' || resultado === 'falha_no_envio') resposta = saida('Resposta final').resposta;
  else if (resultado === 'robo_reativado') resposta = interpretada.resposta;
  conversa = JSON.stringify({
    quando,
    de: doAtendente ? 'atendente' : 'contato',
    conversa: dados.conversa,
    telefone: dados.telefone || undefined,
    nome: dados.nome || undefined,
    texto: dados.texto,
    midia: dados.midia || undefined,
    resultado,
    motivo: motivo || undefined,
    intencao: doAtendente ? undefined : base.intencao,
    ia,
    resposta: typeof resposta === 'string' && resposta ? resposta : undefined,
    transferida: base.transferir === true && resultado === 'respondida' ? true : undefined,
    voltou_do_atendimento: detalhe === 'contato_voltou_do_atendimento_humano' ? true : undefined,
    msg: base.msg,
  }) + '\n';
}

return [{ json: { linha: JSON.stringify(registro) + '\n', conversa, falhaNoEnvio } }];
