// Nó "Dividir em partes". Transforma a resposta final em um item por mensagem a enviar. Resposta pronta
// é uma mensagem só (espera configurada em atraso_resposta_segundos, como sempre). Com várias partes, a
// espera de "digitando" antes de cada uma é proporcional ao tamanho (cerca de 35 ms por caractere,
// entre 1 e 4 segundos).
const base = $('Interpretar mensagem').first().json;
const final = $('Resposta final').first().json;
const partes = (Array.isArray(final.partes) && final.partes.length ? final.partes : [final.resposta])
  .map((parte) => String(parte ?? '')).filter((parte) => parte.trim() !== '');
const lista = partes.length ? partes : [String(final.resposta ?? '')];
return lista.map((texto, indice) => ({ json: {
  texto,
  indice,
  total: lista.length,
  esperaSegundos: lista.length > 1 ? Math.round(Math.min(Math.max(texto.length * 0.035, 1), 4) * 10) / 10 : base.atrasoSegundos,
} }));
