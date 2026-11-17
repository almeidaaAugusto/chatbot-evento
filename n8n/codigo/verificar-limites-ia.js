// Nó "Verificar limites da IA".
// A API gratuita tem cota: cada contato pode usar a IA poucas vezes por janela e existe
// um teto diário para todos os contatos. Os contadores são lidos aqui e só aumentam
// quando a chamada é liberada (nós "Redis: contar uso da IA").

const base = $('Resolver conversa').first().json;
const lido = (no, campo) => Number(($(no).first().json ?? {})[campo]) || 0;
const usosDoContato = lido('Redis: usos da IA (contato)', 'usosContato');
const usosDoDia = lido('Redis: usos da IA (dia)', 'usosDia');
const naHora = Number(Object.values($('Redis: contador por hora').first().json ?? {})[0]) || 0;

let resultado;
let liberada = false;
if (naHora > base.limites.mensagensPorHora) {
  // A mensagem já vai ser silenciada pelo limite por hora: não gasta a cota da IA.
  resultado = undefined;
} else if (usosDoContato >= base.ia.limites.porContato) {
  resultado = 'limite_por_contato';
} else if (usosDoDia >= base.ia.limites.porDia) {
  resultado = 'limite_do_dia';
} else {
  liberada = true;
}

return [{ json: { ...base, ia: { ...base.ia, liberada, resultado } } }];
