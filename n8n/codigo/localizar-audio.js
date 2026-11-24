// Nó "Localizar arquivo do áudio".
// A resposta do WAHA (mensagem com downloadMedia=true) traz media.url apontando para o próprio WAHA
// (por exemplo http://localhost:3000/api/files/<id>.oga). O endereço é reescrito: só o caminho
// /api/files/... é aproveitado e o servidor é sempre o WAHA da rede interna do Docker.
let resposta = {};
try {
  resposta = $('WAHA: obter áudio').first().json ?? {};
} catch (e) {
  resposta = {};
}
const url = String(resposta.media?.url ?? '');
const achado = url.match(/\/api\/files\/[^?#\s]+/);
return [{ json: { rotaArquivo: achado ? achado[0] : '', erro: achado ? '' : 'sem_url_da_midia' } }];
