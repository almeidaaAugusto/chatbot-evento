// Nó "Aplicar transcrição".
// Junta o resultado da Groq à mensagem. Com a transcrição, o texto passa a ser o texto da mensagem
// (travas, regras e conversa natural tratam como se tivesse sido digitado). Sem ela (falha no
// download, na Groq ou áudio sem fala), o texto continua vazio e vale a resposta de mídia de sempre.
// O áudio em si não é guardado: só o texto transcrito segue adiante.
const base = $('Interpretar mensagem').first().json;
const lerSaida = (no) => {
  try {
    return $(no).first().json ?? {};
  } catch (e) {
    return {};
  }
};
const baixou = lerSaida('Nomear áudio').baixou === true;
const resposta = lerSaida('IA: transcrever áudio');
const transcrito = typeof resposta.text === 'string' ? resposta.text.replace(/\s+/g, ' ').trim().slice(0, 1000) : '';
const transcricao = transcrito ? 'ok' : !baixou ? 'erro_download' : resposta.error ? 'erro_transcricao' : 'erro_vazio';
const audio = { ...(base.audio ?? {}), transcricao };
const registro = { ...(base.registro ?? {}), audio: true, transcricao };
if (transcrito) {
  registro.texto = transcrito;
  return [{ json: { audio, texto: transcrito, midia: false, registro } }];
}
return [{ json: { audio, texto: '', midia: true, registro } }];
