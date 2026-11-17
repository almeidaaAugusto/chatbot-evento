// Motor compartilhado pelo n8n e pelo simulador. Sem acesso a arquivos ou rede.
// O estado contém somente contadores, IDs e a assinatura da última resposta.

function normalizar(texto) {
  return String(texto ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9#]+/g, ' ').trim().replace(/\s+/g, ' ');
}

const SINONIMOS = {
  compro: 'comprar', comprando: 'comprar', compra: 'comprar', adquirir: 'comprar',
  ingresso: 'ingresso', ingressos: 'ingresso', ingreco: 'ingresso', ingrecos: 'ingresso', precos: 'preco', valores: 'valor',
  horarios: 'horario', enderecos: 'endereco', informacoes: 'informacao',
};
const VAZIAS = new Set(('a o as os um uma uns umas de do da dos das no na nos nas em e ou para pra pro por ' +
  'que qual quais eu voce voces meu minha meus minhas seu sua seus suas favor pfv pf ' +
  'preciso pode podem poderia quero queria gostaria saber dizer me mim com uma ser esta ta vai').split(' '));
// Palavras que aparecem em qualquer assunto e por isso não identificam nenhum sozinhas.
const GENERICAS = new Set(['ingresso', 'evento', 'ajuda', 'informacao', 'link', 'onde', 'como', 'funciona',
  'baile', 'bailes', 'festa', 'festas', 'show', 'role', 'oficial', 'nao']);
const MOLDURA_PERGUNTA = new Set(('posso podemos consigo encontro encontrar acesso acessar ver vejo ' +
  'esta estao sera serao quando quanto custa custam acontecer acontece faco faz fazer levar levo ' +
  'falar falo tenho tem ter permitido permitida permitidos permitidas').split(' '));
const lista = (valor) => Array.isArray(valor) ? valor.filter((v) => typeof v === 'string' && v.trim()) : [];
const canonico = (texto) => normalizar(texto).split(' ').map((p) => SINONIMOS[p] || p).join(' ');
const termos = (texto) => [...new Set(canonico(texto).split(' ').filter((p) => p && !VAZIAS.has(p)))];
const especificos = (texto) => termos(texto).filter((p) => !GENERICAS.has(p) && !/^\d+$/.test(p));
const contem = (texto, frase) => frase && (' ' + texto + ' ').includes(' ' + frase + ' ');

function assinatura(texto) {
  let valor = 2166136261;
  for (let i = 0; i < texto.length; i += 1) valor = Math.imul(valor ^ texto.charCodeAt(i), 16777619);
  return (valor >>> 0).toString(16);
}

function numeroDaOpcao(opcao) {
  return lista(opcao.palavras_exatas).map(normalizar).find((p) => /^\d{1,2}$/.test(p)) || '';
}

function tituloDaOpcao(opcao) {
  return String(opcao.titulo || opcao.id || 'Opção').replace(/[\r\n]+/g, ' ').trim();
}

function pontuar(opcao, texto) {
  const frase = canonico(texto);
  let valor = 0;
  let origem = 'palavra_chave';
  const melhorar = (pontos, tipo) => {
    if (pontos > valor) { valor = pontos; origem = tipo; }
  };

  for (const palavra of lista(opcao.palavras_exatas)) {
    if (canonico(palavra) === frase) melhorar(280, 'palavra_chave');
  }
  for (const palavra of lista(opcao.palavras_chave)) {
    const chave = canonico(palavra);
    if (frase === chave) melhorar(260, 'palavra_chave');
    else if (contem(frase, chave)) {
      if (especificos(chave).length) melhorar(100, 'palavra_chave');
      // "ajuda" e "ingresso" isolados podem ser úteis; dentro de outra pergunta
      // não são evidência suficiente para substituir o assunto principal.
      else if (termos(frase).length === 1) melhorar(80, 'palavra_chave');
    }
  }

  const termosDaFrase = new Set(termos(frase));
  for (const pergunta of lista(opcao.perguntas)) {
    const exemplo = canonico(pergunta);
    if (frase === exemplo) melhorar(300, 'pergunta');
    else if (contem(frase, exemplo) && especificos(exemplo).length) melhorar(200, 'pergunta');
    else {
      // O mesmo verbo pode aparecer em dúvidas sobre assuntos diferentes.
      // Só aproximar exemplos quando o assunto completo continua presente.
      const assunto = especificos(exemplo).filter((p) => !MOLDURA_PERGUNTA.has(p));
      if (assunto.length && assunto.every((p) => termosDaFrase.has(p))) {
        melhorar(75 + Math.min(assunto.length, 3) * 10, 'pergunta');
      }
    }
  }

  const titulo = especificos(opcao.titulo).filter((p) => !MOLDURA_PERGUNTA.has(p));
  if (titulo.some((p) => termosDaFrase.has(p))) melhorar(80, 'titulo');
  return { opcao, valor, origem };
}

// Uma inserção, remoção, substituição ou troca de letras vizinhas. Aplicada
// somente a termos com pelo menos seis letras e correção única no vocabulário.
function erroPequeno(a, b) {
  if (a === b || Math.abs(a.length - b.length) > 1) return false;
  if (a.length === b.length) {
    const diferentes = [];
    for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) diferentes.push(i);
    return diferentes.length === 1 || (diferentes.length === 2 &&
      diferentes[1] === diferentes[0] + 1 && a[diferentes[0]] === b[diferentes[1]] && a[diferentes[1]] === b[diferentes[0]]);
  }
  const menor = a.length < b.length ? a : b;
  const maior = a.length < b.length ? b : a;
  let i = 0;
  while (i < menor.length && menor[i] === maior[i]) i += 1;
  return menor.slice(i) === maior.slice(i + 1);
}

function corrigir(texto, opcoes) {
  const vocabulario = [...new Set(opcoes.flatMap((opcao) =>
    [...lista(opcao.palavras_exatas), ...lista(opcao.palavras_chave), ...lista(opcao.perguntas), opcao.titulo || '']
      .flatMap(especificos)))].filter((p) => p.length >= 6);
  const conhecidos = new Set(vocabulario);
  return canonico(texto).split(' ').map((palavra) => {
    if (palavra.length < 6 || conhecidos.has(palavra)) return palavra;
    const candidatos = vocabulario.filter((v) => erroPequeno(palavra, v));
    return candidatos.length === 1 ? candidatos[0] : palavra;
  }).join(' ');
}

function ehSaudacao(texto, cfg) {
  const saudacoes = lista(cfg.saudacoes).length ? lista(cfg.saudacoes) : ['oi', 'ola', 'bom dia', 'boa tarde', 'boa noite', 'menu', 'inicio'];
  let restante = normalizar(texto);
  let encontrou = false;
  for (const palavra of saudacoes.map(normalizar).sort((a, b) => b.length - a.length)) {
    if (contem(restante, palavra)) {
      encontrou = true;
      restante = (' ' + restante + ' ').split(' ' + palavra + ' ').join(' ').trim();
    }
  }
  const cortesia = new Set(('tudo bem td bom com voce voces por favor pfv pf me manda mande enviar mostre mostra ' +
    'o a um uma eu quero queria gostaria de saber informacao informacoes ver').split(' '));
  return encontrou && restante.split(' ').every((p) => !p || cortesia.has(p));
}

function ehAgradecimento(texto) {
  const palavras = normalizar(texto).split(' ');
  const agradece = new Set(['obrigado', 'obrigada', 'obg', 'valeu', 'agradeco']);
  const cortesia = new Set(['muito', 'muitissimo', 'ok', 'okay', 'certo', 'ta', 'bom', 'sim', 'pela', 'ajuda', 'por', 'tudo']);
  return palavras.some((p) => agradece.has(p)) && palavras.every((p) => agradece.has(p) || cortesia.has(p));
}

function resolver(configuracao, texto, estado = {}, contexto = {}) {
  const cfg = configuracao && typeof configuracao === 'object' ? configuracao : {};
  const opcoes = (Array.isArray(cfg.opcoes) ? cfg.opcoes : []).filter((o) => o && typeof o === 'object' && typeof o.id === 'string');
  const evento = cfg.evento && typeof cfg.evento === 'object' ? cfg.evento : {};
  const mensagens = cfg.mensagens || {};
  const anterior = estado && typeof estado === 'object' ? estado : {};
  const contador = Number(anterior.falhas);
  const atual = {
    falhas: Number.isFinite(contador) ? Math.max(0, Math.min(3, Math.floor(contador))) : 0,
    ultimaIntencao: typeof anterior.ultimaIntencao === 'string' ? anterior.ultimaIntencao.slice(0, 80) : '',
    ultimaResposta: typeof anterior.ultimaResposta === 'string' && /^[a-f0-9]{1,8}$/.test(anterior.ultimaResposta) ? anterior.ultimaResposta : '',
    pendentes: lista(anterior.pendentes).filter((id) => opcoes.some((o) => o.id === id)).slice(0, 5),
  };
  const listaDeOpcoes = (selecionadas = opcoes) => selecionadas.map((o) => {
    const numero = numeroDaOpcao(o);
    return (numero ? numero + ' - ' : '') + tituloDaOpcao(o);
  }).join('\n');
  const preencher = (valor) => String(valor ?? '').replace(/\{\{\s*([\w-]+)\s*\}\}/g, (original, chave) => {
    // Opções com "mostrar_no_menu": false continuam sendo reconhecidas, só não entram na lista.
    if (chave === 'opcoes') return listaDeOpcoes(opcoes.filter((o) => o.mostrar_no_menu !== false));
    const dado = evento[chave] ?? evento[chave.toLowerCase()];
    return dado === undefined || dado === null || typeof dado === 'object' ? original : String(dado);
  }).trim();
  const finalizar = (intencao, origem, resposta, transferir = false, extras = {}) => {
    const saida = preencher(resposta);
    const proximo = { ...atual, ultimaIntencao: intencao, ultimaResposta: saida ? assinatura(saida) : atual.ultimaResposta };
    return { intencao, origem, resposta: saida, transferir, estado: proximo, ...extras };
  };
  const responderOpcao = (opcao, origem) => {
    atual.falhas = 0;
    atual.pendentes = [];
    return finalizar(opcao.id, origem, opcao.resposta, opcao.transferir_para_humano === true);
  };

  // O número sempre seleciona a opção global, inclusive após uma desambiguação.
  const entrada = normalizar(texto).slice(0, 2000);
  const numero = entrada.match(/^(?:eu )?(?:(?:quero|gostaria|pode ser) )?(?:a |o |da |de )?(?:(?:opcao|numero|item|op) )?(\d{1,2})(?: por favor| pfv| pf| obrigado| obrigada)?$/);
  if (numero) {
    const opcao = opcoes.find((o) => lista(o.palavras_exatas).some((palavra) => normalizar(palavra) === numero[1]));
    if (opcao) return responderOpcao(opcao, 'numero');
  }

  let candidatos = opcoes.map((o) => pontuar(o, entrada)).filter((c) => c.valor >= 70);
  let aproximacao = false;
  if (!candidatos.length && entrada) {
    const corrigida = corrigir(entrada, opcoes);
    if (corrigida !== canonico(entrada)) {
      candidatos = opcoes.map((o) => pontuar(o, corrigida)).filter((c) => c.valor >= 70);
      aproximacao = candidatos.length > 0;
    }
  }
  // Uma pergunta completa ensinada pelo operador tem prioridade sobre termos
  // soltos. Empates entre perguntas completas continuam pedindo esclarecimento.
  const maiorPontuacao = Math.max(0, ...candidatos.map((c) => c.valor));
  if (maiorPontuacao >= 260) candidatos = candidatos.filter((c) => c.valor === maiorPontuacao);
  if (candidatos.length === 1) return responderOpcao(candidatos[0].opcao, aproximacao ? 'aproximacao' : candidatos[0].origem);
  if (candidatos.length > 1) {
    const selecionadas = candidatos.slice(0, 5).map((c) => c.opcao);
    atual.falhas = 0;
    atual.pendentes = selecionadas.map((o) => o.id);
    return finalizar('esclarecer', 'desambiguacao', 'Encontrei mais de um assunto na sua mensagem. Sobre qual você quer saber primeiro?\n\n' +
      listaDeOpcoes(selecionadas) + '\n\nDigite o número da opção desejada.');
  }

  if (entrada && ehSaudacao(entrada, cfg)) {
    atual.falhas = 0;
    atual.pendentes = [];
    return finalizar('menu', 'saudacao', mensagens.menu || 'Como posso ajudar?\n\n{{opcoes}}');
  }
  if (entrada && ehAgradecimento(entrada)) {
    atual.falhas = 0;
    atual.pendentes = [];
    return finalizar('agradecimento', 'agradecimento', mensagens.agradecimento || 'Por nada! Se precisar de mais alguma coisa, é só escrever.');
  }

  if (atual.falhas >= 3) {
    return finalizar('nao_entendi', 'fallback_esgotado', '', false, { silenciar: true, motivo: 'fallback_esgotado' });
  }
  const fase = atual.falhas;
  const fallback = cfg.fallback && typeof cfg.fallback === 'object' ? cfg.fallback : {};
  const padroes = [
    'Ainda não consegui identificar sua dúvida. Posso ajudar com estas opções:\n\n{{opcoes}}\n\nDigite o número ou escreva uma pergunta sobre um desses assuntos.',
    'Pode reformular sua dúvida com uma pergunta curta? Se preferir, digite o número de uma opção do menu.',
    mensagens.nao_entendi || (evento.instagram ? 'Para esclarecer essa dúvida, fale com a equipe pelo Instagram: {{instagram}}.' : 'Para esclarecer essa dúvida, procure a equipe de atendimento do evento. Digite menu para consultar as opções disponíveis.'),
  ];
  const midia = !entrada && contexto?.midia === true && fase === 0;
  const configuradas = Array.isArray(fallback.mensagens) ? fallback.mensagens : [];
  const etapas = [];
  for (let i = 0; i < 3; i += 1) {
    const configurada = typeof configuradas[i] === 'string' && configuradas[i].trim() ? configuradas[i] : padroes[i];
    let candidata = preencher(configurada);
    if (etapas.includes(candidata)) candidata = preencher(padroes[i]);
    while (etapas.includes(candidata)) candidata = 'Para seguir com o atendimento: ' + candidata;
    etapas.push(candidata);
  }
  let resposta = midia
    ? preencher(fallback.mensagem_midia || 'Não consigo interpretar áudio ou imagem por aqui. Escreva sua dúvida em uma mensagem de texto, por favor.')
    : etapas[fase];
  // Configurações com mensagens iguais também não devem repetir a última orientação.
  if (assinatura(resposta) === atual.ultimaResposta) resposta = 'Para seguir com o atendimento: ' + preencher(padroes[fase]);
  atual.falhas += 1;
  atual.pendentes = [];
  return finalizar('nao_entendi', midia ? 'midia_sem_texto' : 'nao_reconhecida', resposta);
}

module.exports = { normalizar, resolver };
