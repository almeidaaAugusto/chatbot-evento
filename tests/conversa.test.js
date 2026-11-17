const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizar, resolver } = require('../lib/conversa');

const cfg = {
  evento: { local: 'Arena Central', data: '20/12', instagram: '@evento' },
  mensagens: {
    menu: '1 - QR Code\n2 - Valores\n3 - Local e data\n4 - Comprar\n5 - Atendimento',
    nao_entendi: 'A equipe pode ajudar pelo Instagram {{instagram}}.',
  },
  saudacoes: ['oi', 'olá', 'bom dia', 'boa tarde', 'boa noite', 'menu', 'início'],
  opcoes: [
    {
      id: 'qrcode', titulo: 'QR Code', palavras_exatas: ['1', 'ingresso'],
      palavras_chave: ['qr', 'qr code', 'qrcode', 'meu ingresso'],
      perguntas: ['Onde encontro meu ingresso?', 'Perdi meu QR Code', 'Como acesso o ingresso que comprei?'],
      resposta: 'Abra Meus Ingressos para encontrar o QR Code.',
    },
    {
      id: 'valores', titulo: 'Valores dos ingressos', palavras_exatas: ['2'],
      palavras_chave: ['preço', 'preços', 'valor', 'valores', 'quanto custa', 'lote'],
      perguntas: ['Quanto custa o ingresso?', 'Quanto tá o ingresso?'],
      resposta: 'Veja os preços no site oficial.',
    },
    {
      id: 'local', titulo: 'Local e data', palavras_exatas: ['3'],
      palavras_chave: ['local', 'endereço', 'onde fica', 'horário', 'que horas'],
      perguntas: ['Qual a data do evento?', 'Quando será o evento?'],
      resposta: 'Local: {{local}}. Data: {{data}}.',
    },
    {
      id: 'comprar', titulo: 'Comprar ingressos', palavras_exatas: ['4'],
      palavras_chave: ['comprar', 'compra', 'link'],
      perguntas: ['Onde compro ingresso?', 'Quero comprar ingresso'],
      resposta: 'Compre no site oficial.',
    },
    {
      id: 'atendente', titulo: 'Falar com a equipe', palavras_exatas: ['5'],
      palavras_chave: ['atendente', 'humano', 'suporte', 'ajuda', 'instagram'],
      perguntas: ['Quero falar com uma pessoa'], resposta: 'Equipe: {{instagram}}.',
    },
  ],
};

test('normalização preserva comandos e ignora acentos, caixa e pontuação', () => {
  assert.equal(normalizar('  OLÁ!!!  #BOT, opção 2. '), 'ola #bot opcao 2');
  assert.equal(normalizar(null), '');
});

for (const [texto, intencao] of [
  ['2', 'valores'], ['opção 2 por favor', 'valores'], ['Quero a opção 3', 'local'],
  ['QR CODE!!!', 'qrcode'], ['Qual a data do evento?', 'local'],
  ['Quanto tá o ingresso?', 'valores'], ['onde compro meu ingresso?', 'comprar'],
  ['Preciso de ajuda para comprar ingresso', 'comprar'],
  ['Onde encontro meu ingresso?', 'qrcode'], ['perdi meu QR Code', 'qrcode'],
  ['pode me dizer o endereço?', 'local'], ['Quero falar com uma pessoa', 'atendente'],
]) {
  test('interpreta a intenção em: ' + texto, () => {
    const saida = resolver(cfg, texto);
    assert.equal(saida.intencao, intencao);
    assert.equal(saida.estado.falhas, 0);
    assert.equal(saida.silenciar, undefined);
  });
}

test('frase de compra supera palavras genéricas mesmo sem novos campos na configuração', () => {
  const antiga = structuredClone(cfg);
  antiga.opcoes.forEach((opcao) => { delete opcao.titulo; delete opcao.perguntas; });
  assert.equal(resolver(antiga, 'onde compro meu ingresso?').intencao, 'comprar');
});

test('pergunta cadastrada pode ensinar um assunto sem palavra-chave', () => {
  const personalizada = structuredClone(cfg);
  personalizada.opcoes.push({ id: 'entrada', titulo: 'Entrada', palavras_exatas: ['6'], perguntas: ['Posso levar uma garrafa de água?'], resposta: 'Água é permitida.' });
  assert.equal(resolver(personalizada, 'oi, posso levar uma garrafa de água?').resposta, 'Água é permitida.');
});

test('verbos comuns de perguntas não identificam um assunto diferente', () => {
  const configurada = structuredClone(cfg);
  configurada.opcoes[0].perguntas.push('Como ver meus ingressos?');
  configurada.opcoes[1].perguntas.push('Quanto custa para entrar?');
  configurada.opcoes[2].perguntas.push('Onde será o evento?');
  configurada.opcoes[3].perguntas.push('Como faço para comprar ingresso?');
  for (const texto of ['onde encontro o banheiro?', 'como ver o estacionamento?',
    'queria saber onde será o estacionamento', 'como faço para cancelar ingresso?',
    'como falar com minha família?']) {
    assert.equal(resolver(configurada, texto).intencao, 'nao_entendi', texto);
  }
});

test('exemplo sobre água não autoriza responder sobre outros itens ou regras', () => {
  const personalizada = structuredClone(cfg);
  personalizada.opcoes.push({ id: 'agua', titulo: 'Água', perguntas: ['Posso levar uma garrafa de água?'], resposta: 'Água é permitida.' });
  for (const texto of ['posso levar comida?', 'posso levar cerveja?',
    'posso levar uma garrafa de cerveja?', 'eu posso ir embora e voltar?']) {
    assert.equal(resolver(personalizada, texto).intencao, 'nao_entendi', texto);
  }
  assert.equal(resolver(personalizada, 'Posso levar uma garrafa de água?').intencao, 'agua');
  assert.equal(resolver(personalizada, 'É permitido levar uma garrafa de água?').intencao, 'agua');
});

test('números selecionam apenas opções com palavra exata numérica cadastrada', () => {
  const personalizada = { ...cfg, opcoes: [
    { id: 'primeira', titulo: 'Primeira', palavras_chave: ['aqui'], resposta: 'A' },
    { id: 'segunda', titulo: 'Segunda', palavras_exatas: ['1', '7'], resposta: 'B' },
  ] };
  assert.equal(resolver(personalizada, '1').intencao, 'segunda');
  assert.equal(resolver(personalizada, 'opção 7').intencao, 'segunda');
  assert.equal(resolver(personalizada, '2').intencao, 'nao_entendi');
  const lista = resolver(personalizada, 'desconhecido').resposta;
  assert.match(lista, /\nPrimeira\n1 - Segunda\n/);
  assert.doesNotMatch(lista, /1 - Primeira/);
});

test('erros pequenos de digitação reconhecem termos específicos', () => {
  const saida = resolver(cfg, 'quero comrpar ingresso');
  assert.equal(saida.intencao, 'comprar');
  assert.equal(saida.origem, 'aproximacao');
  assert.equal(resolver(cfg, 'qual o enderco?').intencao, 'local');
});

test('erro fonético comum em ingresso preserva a opção exata sem ampliar a aproximação', () => {
  assert.equal(resolver(cfg, 'ingreço').intencao, 'qrcode');
  assert.equal(resolver(cfg, 'ingreços').intencao, 'qrcode');
  assert.equal(resolver(cfg, 'quero comprar ingreço').intencao, 'comprar');
});

test('aproximação não força uma opção para palavra curta ou assunto desconhecido', () => {
  for (const texto of ['ar', 'posso levar comida?', 'preciso cancelar o ingresso']) {
    assert.equal(resolver(cfg, texto).intencao, 'nao_entendi', texto);
  }
});

test('duas perguntas explícitas pedem esclarecimento com os números globais', () => {
  const saida = resolver(cfg, 'quais os valores e o endereço?');
  assert.equal(saida.intencao, 'esclarecer');
  assert.deepEqual(saida.estado.pendentes, ['valores', 'local']);
  assert.match(saida.resposta, /2\s*[-–]\s*Valores/);
  assert.match(saida.resposta, /3\s*[-–]\s*Local/);
  assert.equal(resolver(cfg, '1', saida.estado).intencao, 'qrcode');
  assert.equal(resolver(cfg, '3', saida.estado).intencao, 'local');
});

test('uma pergunta específica acompanhada de outra intenção não esconde a segunda', () => {
  assert.equal(resolver(cfg, 'onde compro ingresso e qual o endereço?').intencao, 'esclarecer');
});

test('empate entre perguntas de opções diferentes pede esclarecimento', () => {
  const ambigua = structuredClone(cfg);
  ambigua.opcoes[0].perguntas.push('Como funciona a entrada?');
  ambigua.opcoes[1].perguntas.push('Como funciona a entrada?');
  assert.equal(resolver(ambigua, 'como funciona a entrada?').intencao, 'esclarecer');
});

test('pergunta completa cadastrada tem prioridade sobre uma palavra genérica de outra opção', () => {
  const personalizada = structuredClone(cfg);
  personalizada.opcoes[0].perguntas.push('Quero ajuda');
  assert.equal(resolver(personalizada, 'quero ajuda').intencao, 'qrcode');
});

test('saudação isolada mostra menu e não mascara uma pergunta desconhecida', () => {
  assert.equal(resolver(cfg, 'Olá, tudo bem?').intencao, 'menu');
  const saida = resolver(cfg, 'Oi, pode levar bebida?');
  assert.equal(saida.intencao, 'nao_entendi');
  assert.equal(saida.estado.falhas, 1);
});

test('pedido explícito de menu mostra menu mesmo com texto de cortesia', () => {
  assert.equal(resolver(cfg, 'me manda o menu por favor').resposta, cfg.mensagens.menu);
});

test('agradecimentos curtos recebem uma resposta curta sem reenviar menu', () => {
  for (const texto of ['obrigado', 'Muito obrigada!', 'valeu', 'ok, obrigado', 'obrigado pela ajuda']) {
    const saida = resolver(cfg, texto);
    assert.equal(saida.intencao, 'agradecimento');
    assert.notEqual(saida.resposta, cfg.mensagens.menu);
    assert.equal(saida.estado.falhas, 0);
  }
  assert.equal(resolver(cfg, 'obrigado, mas qual a data?').intencao, 'local');
});

test('fallback customizado com campos vazios não troca a ordem das etapas', () => {
  const personalizada = { ...cfg, fallback: { mensagens: ['', 'Segunda tentativa.', 'Terceira tentativa.'] } };
  const a = resolver(personalizada, 'bebidas');
  const b = resolver(personalizada, 'bebidas', a.estado);
  const c = resolver(personalizada, 'bebidas', b.estado);
  assert.match(a.resposta, /2\s*[-–]\s*Valores/);
  assert.equal(b.resposta, 'Segunda tentativa.');
  assert.equal(c.resposta, 'Terceira tentativa.');
});

test('textos repetidos no fallback não fazem o bot enviar a mesma orientação', () => {
  const personalizada = { ...cfg, fallback: { mensagens: [cfg.mensagens.nao_entendi, cfg.mensagens.nao_entendi, cfg.mensagens.nao_entendi] } };
  const a = resolver(personalizada, 'bebidas');
  const b = resolver(personalizada, 'bebidas', a.estado);
  const c = resolver(personalizada, 'bebidas', b.estado);
  assert.equal(new Set([a.resposta, b.resposta, c.resposta]).size, 3);
});

test('fallback oferece ajuda, reformula, encaminha e para até reconhecer uma opção', () => {
  const primeira = resolver(cfg, 'posso levar bebida?');
  const segunda = resolver(cfg, 'ainda sobre bebidas', primeira.estado);
  const terceira = resolver(cfg, 'cerveja pode?', segunda.estado);
  const quarta = resolver(cfg, 'nao resolveu', terceira.estado);
  assert.match(primeira.resposta, /2\s*[-–]\s*Valores/);
  assert.equal(new Set([primeira.resposta, segunda.resposta, terceira.resposta]).size, 3);
  assert.equal(terceira.resposta, 'A equipe pode ajudar pelo Instagram @evento.');
  assert.equal(quarta.silenciar, true);
  assert.equal(quarta.motivo, 'fallback_esgotado');
  assert.equal(quarta.resposta, '');
  assert.equal(quarta.estado.falhas, 3);
  const reconhecida = resolver(cfg, '2', quarta.estado);
  assert.equal(reconhecida.estado.falhas, 0);
  assert.equal(resolver(cfg, 'bebidas?', reconhecida.estado).resposta, primeira.resposta);
});

test('fallback customizado preenche evento e lista de opções', () => {
  const personalizada = { ...cfg, fallback: { mensagens: ['Escolha: {{opcoes}}', 'Escreva uma pergunta sobre {{local}}.', 'Chame {{instagram}}.'] } };
  const a = resolver(personalizada, 'bebidas');
  const b = resolver(personalizada, 'bebidas', a.estado);
  const c = resolver(personalizada, 'bebidas', b.estado);
  assert.match(a.resposta, /4\s*[-–]\s*Comprar ingressos/);
  assert.equal(b.resposta, 'Escreva uma pergunta sobre Arena Central.');
  assert.equal(c.resposta, 'Chame @evento.');
});

test('configuração antiga sem fallback usa textos úteis e sem repetir o menu', () => {
  const antiga = { mensagens: { menu: 'Menu antigo' }, opcoes: [{ id: 'duvida', palavras_exatas: ['1'], resposta: 'Resposta antiga' }] };
  const a = resolver(antiga, 'desconhecido');
  const b = resolver(antiga, 'desconhecido', a.estado);
  const c = resolver(antiga, 'desconhecido', b.estado);
  assert.equal(new Set([a.resposta, b.resposta, c.resposta]).size, 3);
  assert.equal(resolver(antiga, '1', c.estado).resposta, 'Resposta antiga');
});

test('mídia sem legenda pede texto e não alega transcrever', () => {
  const saida = resolver(cfg, '', {}, { midia: true });
  assert.equal(saida.intencao, 'nao_entendi');
  assert.equal(saida.origem, 'midia_sem_texto');
  assert.match(saida.resposta, /escrev|texto/i);
  assert.doesNotMatch(saida.resposta, /transcrevi|ouvi|entendi o [aá]udio/i);
  assert.equal(resolver(cfg, '2', saida.estado, { midia: true }).intencao, 'valores');
});

test('mídias repetidas também avançam o fallback e param após a terceira tentativa', () => {
  const a = resolver(cfg, '', {}, { midia: true });
  const b = resolver(cfg, '', a.estado, { midia: true });
  const c = resolver(cfg, '', b.estado, { midia: true });
  const d = resolver(cfg, '', c.estado, { midia: true });
  assert.equal(new Set([a.resposta, b.resposta, c.resposta]).size, 3);
  assert.equal(d.silenciar, true);
});

test('uma opção de transferência mantém o sinal para o workflow', () => {
  const personalizada = structuredClone(cfg);
  personalizada.opcoes[4].transferir_para_humano = true;
  assert.equal(resolver(personalizada, '5').transferir, true);
  assert.equal(resolver(cfg, '5').transferir, false);
});

test('resolução não altera configuração ou estado e não armazena a mensagem recebida', () => {
  const estado = { falhas: 1, pendentes: [], texto: 'dado anterior que deve ser descartado', ultimaIntencao: 'privada 5511999999999' };
  const copiaCfg = structuredClone(cfg);
  const copiaEstado = structuredClone(estado);
  const texto = 'minha duvida privada 5511999999999';
  const saida = resolver(cfg, texto, estado);
  assert.deepEqual(cfg, copiaCfg);
  assert.deepEqual(estado, copiaEstado);
  assert.doesNotMatch(JSON.stringify(saida.estado), /privada|5511999999999|dado anterior|texto/);
  assert.ok(JSON.stringify(saida.estado).length < 1000);
});

test('estado inválido não impede reconhecimento nem produz contador inválido', () => {
  for (const estado of [null, { falhas: 'abc' }, { falhas: -2 }, { falhas: Infinity }, []]) {
    const saida = resolver(cfg, '2', estado);
    assert.equal(saida.estado.falhas, 0);
    assert.equal(saida.intencao, 'valores');
  }
});

test('opção marcada para não aparecer na lista continua reconhecida', () => {
  const personalizada = structuredClone(cfg);
  personalizada.opcoes.push({ id: 'sobre', titulo: 'Sobre a produtora', mostrar_no_menu: false, palavras_chave: ['produtora'], resposta: 'Somos a produtora.' });
  assert.equal(resolver(personalizada, 'quem é a produtora?').intencao, 'sobre');
  const lista = resolver(personalizada, 'desconhecido').resposta;
  assert.match(lista, /5\s*-\s*Falar com a equipe/);
  assert.doesNotMatch(lista, /Sobre a produtora/);
});
