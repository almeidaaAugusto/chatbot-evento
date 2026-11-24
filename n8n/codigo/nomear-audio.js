// Nó "Nomear áudio".
// A Groq decide o formato pela extensão do arquivo e não aceita ".oga". O áudio do WhatsApp é
// Ogg/Opus, então o arquivo é enviado como "audio.ogg". Sem arquivo baixado, só marca a falha
// (o nó seguinte falha sem ele e o resultado vira "erro_download" em "Aplicar transcrição").
const item = $input.first();
const binario = item.binary && item.binary.data;
if (!binario) return [{ json: { baixou: false } }];
const mime = String(binario.mimeType || '').toLowerCase();
const extensao = /mp4|m4a|aac/.test(mime) ? 'm4a' : /mpeg|mp3/.test(mime) ? 'mp3' : /wav/.test(mime) ? 'wav' : /webm/.test(mime) ? 'webm' : 'ogg';
return [{
  json: { baixou: true },
  binary: { data: { ...binario, fileName: 'audio.' + extensao, fileExtension: extensao, mimeType: extensao === 'ogg' ? 'audio/ogg' : binario.mimeType } },
}];
