const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../lib/eventos');
const { validarConfig } = require('../lib/configuracao');
const v1Teste = require('./config/chatbot.json');
const arquivoReal = require('../config/chatbot.json');

const opcao = (id, numero, palavra, resposta) => ({ id, titulo: 'Local', palavras_exatas: [numero], palavras_chave: [palavra], resposta });
const evento = (id, status, nome, gatilhos, extra = {}) => ({
  id, status, gatilhos,
  evento: { nome, data: '20/12', local: 'Arena ' + nome },
  mensagens: { menu: 'Menu ' + nome + '\n\n{{opcoes}}' },
  opcoes: [opcao('local-' + id, '1', 'estacionamento', 'Local: {{local}}')],
  ...extra,
});
const base = () => ({
  versao: 2,
  produtora: { nome: 'Produtora', instagram: '@prod' },
  mensagens: { reativado: 'Voltei.', agradecimento: 'Por nada.', nao_entendi: 'Fale com {{instagram}}' },
  saudacoes: ['oi', 'menu'],
  ia: { ativa: true, conhecimento: 'Geral' },
  eventos: [
    evento('alfa', 'ativo', 'Alfa', ['alfa festival']),
    evento('beta', 'ativo', 'Beta', ['beta']),
    evento('gama', 'rascunho', 'Gama', ['gama']),
    evento('velho', 'encerrado', 'Velho', ['velho']),
  ],
});

test('v1 continua igual e devolve a própria configuração', () => {
  const cfg = v1Teste;
  assert.equal(E.ehMultiEvento(cfg), false);
  assert.equal(E.configDoEvento(cfg, 'x'), cfg);
  const s = E.resolver(cfg, 'menu', {});
  assert.equal(s.config, cfg);
  assert.equal(s.eventoId, null);
  assert.equal(s.intencao, 'menu');
  assert.equal('evento' in s.estado, false);
});

test('eventosDisponiveis respeita o status e a ordem', () => {
  const cfg = base();
  assert.deepEqual(E.eventosDisponiveis(cfg).map((e) => e.id), ['alfa', 'beta']);
  assert.deepEqual(E.eventosDisponiveis(cfg, { incluirRascunhos: true }).map((e) => e.id), ['alfa', 'beta', 'gama']);
});

test('configDoEvento junta produtora, mensagens, fallback e conhecimento', () => {
  const cfg = base();
  cfg.fallback = { mensagem_midia: 'Só texto.' };
  cfg.eventos[0].fallback = { mensagens: ['a', 'b', 'c'] };
  cfg.eventos[0].ia = { conhecimento: 'Do evento' };
  const v1 = E.configDoEvento(cfg, 'alfa');
  assert.equal(v1.evento.nome, 'Alfa');
  assert.equal(v1.evento.instagram, '@prod');
  assert.equal(v1.mensagens.reativado, 'Voltei.');
  assert.match(v1.mensagens.menu, /Menu Alfa/);
  assert.deepEqual(v1.fallback, { mensagem_midia: 'Só texto.', mensagens: ['a', 'b', 'c'] });
  assert.equal(v1.ia.conhecimento, 'Geral\n\nDo evento');
  assert.equal(v1.ia.ativa, true);
  assert.deepEqual(v1.saudacoes, ['oi', 'menu']);
  const sem = E.configDoEvento(cfg, 'nao-existe');
  assert.deepEqual(sem.evento, cfg.produtora);
  assert.deepEqual(sem.opcoes, []);
  assert.equal(sem.ia.ativa, false);
  assert.deepEqual(E.configDoEvento(cfg, null).opcoes, []);
});

test('regra 2: eventoId força o evento, até rascunho', () => {
  const s = E.resolver(base(), 'oi', {}, { eventoId: 'gama' });
  assert.equal(s.eventoId, 'gama');
  assert.match(s.resposta, /Menu Gama/);
  assert.equal(s.estado.evento, 'gama');
  assert.equal(E.resolver(base(), 'oi', {}, { eventoId: 'velho' }).eventoId, 'velho');
});

test('regras 3 e 7: menu de eventos lista só os disponíveis, e o comando troca de evento', () => {
  const s = E.resolver(base(), 'oi', {});
  assert.equal(s.intencao, 'escolher_evento');
  assert.equal(s.estado.escolhendoEvento, true);
  assert.match(s.resposta, /1 - Alfa \(20\/12\)\n2 - Beta \(20\/12\)/);
  assert.doesNotMatch(s.resposta, /Gama|Velho/);
  const troca = E.resolver(base(), 'Trocar evento', { evento: 'alfa' });
  assert.equal(troca.intencao, 'escolher_evento');
  assert.equal(troca.estado.evento, 'alfa');
  assert.equal(troca.estado.escolhendoEvento, true);
  const rasc = E.resolver(base(), 'eventos', {}, { incluirRascunhos: true });
  assert.match(rasc.resposta, /3 - Gama/);
  const cfg = base();
  delete cfg.eventos[0].evento.data;
  assert.match(E.resolver(cfg, 'eventos', {}).resposta, /\n1 - Alfa\n2 - Beta \(20\/12\)/);
});

test('regra 4: escolher pelo número abre o menu do evento', () => {
  const s = E.resolver(base(), '2', { escolhendoEvento: true });
  assert.equal(s.intencao, 'menu');
  assert.equal(s.origem, 'escolha_evento');
  assert.equal(s.eventoId, 'beta');
  assert.match(s.resposta, /Menu Beta/);
  assert.equal(s.estado.evento, 'beta');
  assert.equal(s.estado.escolhendoEvento, false);
  const fora = E.resolver(base(), '9', { escolhendoEvento: true });
  assert.equal(fora.intencao, 'escolher_evento');
});

test('regra 5: gatilho seleciona o evento; sem pergunta reconhecida mostra o menu dele', () => {
  const so = E.resolver(base(), 'Quero saber do ALFA festival!', { evento: 'beta' });
  assert.equal(so.eventoId, 'alfa');
  assert.equal(so.intencao, 'menu');
  assert.equal(so.origem, 'gatilho');
  assert.equal(so.estado.falhas, 0);
  const com = E.resolver(base(), 'beta estacionamento', {});
  assert.equal(com.eventoId, 'beta');
  assert.equal(com.intencao, 'local-beta');
  assert.equal(com.resposta, 'Local: Arena Beta');
  const dois = E.resolver(base(), 'alfa festival ou beta?', {});
  assert.equal(dois.intencao, 'escolher_evento');
  assert.equal(E.resolver(base(), 'gama', {}).eventoId, null);
  assert.equal(E.resolver(base(), 'gama', {}, { incluirRascunhos: true }).eventoId, 'gama');
  assert.equal(E.resolver(base(), 'velho', {}).intencao, 'escolher_evento');
});

test('regra 6: evento lembrado, único evento ativo e nenhum evento', () => {
  const lembrado = E.resolver(base(), 'estacionamento', { evento: 'beta' });
  assert.equal(lembrado.eventoId, 'beta');
  assert.equal(lembrado.intencao, 'local-beta');
  assert.equal(lembrado.estado.evento, 'beta');

  const unico = base();
  unico.eventos[1].status = 'encerrado';
  const u = E.resolver(unico, 'oi', {});
  assert.equal(u.eventoId, 'alfa');
  assert.match(u.resposta, /Menu Alfa/);

  const nenhum = base();
  nenhum.eventos.forEach((e) => { e.status = 'encerrado'; });
  nenhum.mensagens.sem_eventos = 'Sem eventos. Veja {{instagram}}';
  const n = E.resolver(nenhum, 'oi', { evento: 'alfa' });
  assert.equal(n.intencao, 'sem_eventos');
  assert.equal(n.origem, 'sem_eventos');
  assert.equal(n.resposta, 'Sem eventos. Veja @prod');
  assert.equal(n.eventoId, null);
  assert.equal(n.config.ia.ativa, false);
  assert.equal(E.resolver(nenhum, 'obrigado', {}).intencao, 'agradecimento');
  delete nenhum.mensagens.sem_eventos;
  assert.match(E.resolver(nenhum, 'qualquer coisa', {}).resposta, /Acompanhe as novidades no nosso Instagram: @prod/);
});

test('regra 8: o motor roda no evento e o estado preserva evento e escolhendoEvento', () => {
  const cfg = base();
  let s = E.resolver(cfg, 'oi', {});
  s = E.resolver(cfg, '1', s.estado);
  assert.equal(s.eventoId, 'alfa');
  assert.match(s.resposta, /Menu Alfa/);
  const dep = E.resolver(cfg, 'asdfgh qwerty', s.estado);
  assert.equal(dep.eventoId, 'alfa');
  assert.equal(dep.intencao, 'nao_entendi');
  assert.equal(dep.estado.evento, 'alfa');
  assert.equal(dep.estado.escolhendoEvento, false);
  assert.equal(dep.estado.falhas, 1);
  assert.equal(dep.config.evento.nome, 'Alfa');
});

test('migrarParaV2 converte a configuração de teste e a real', () => {
  const t = E.migrarParaV2(v1Teste, { id: 'teste', gatilhos: ['teste'] });
  assert.equal(t.versao, 2);
  assert.equal(t.produtora.instagram, v1Teste.evento.instagram);
  assert.equal(t.eventos[0].evento.instagram, undefined);
  assert.equal(t.eventos[0].ia.conhecimento, v1Teste.ia.conhecimento);
  assert.equal(t.ia.conhecimento, undefined);
  assert.equal(t.eventos[0].mensagens.reativado, undefined);
  assert.equal(t.mensagens.reativado, v1Teste.mensagens.reativado);
  assert.deepEqual(validarConfig(t).erros, []);
  assert.equal(E.resolver(t, 'menu', {}).intencao, 'menu');
});

test('config/chatbot.json real (v2) valida sem erros e o evento encerrado não é atendido', () => {
  const v = validarConfig(arquivoReal);
  assert.deepEqual(v.erros, []);
  assert.equal(E.ehMultiEvento(arquivoReal), true);
  // Roda a migração sobre o conteúdo do próprio evento, como em v1, e também precisa validar.
  const v1 = E.configDoEvento(arquivoReal, arquivoReal.eventos[0].id);
  const r = E.migrarParaV2(v1, { id: 'copia', status: 'ativo', produtora: 'Caixa Preta' });
  assert.deepEqual(validarConfig(r).erros, []);
  assert.equal(E.resolver(arquivoReal, 'oi', {}).intencao, 'sem_eventos');
  assert.equal(E.resolver(arquivoReal, 'oi', {}, { eventoId: arquivoReal.eventos[0].id }).intencao, 'menu');
});

test('validação v2: erro em ativo bloqueia, em rascunho vira aviso, gatilho repetido é erro', () => {
  assert.deepEqual(validarConfig(base()).erros, []);

  const ativo = base();
  delete ativo.eventos[0].mensagens.menu;
  const a = validarConfig(ativo);
  assert.ok(a.erros.some((e) => e.startsWith('eventos[0] (alfa): ') && e.includes('mensagens.menu')), a.erros.join('\n'));

  const rascunho = base();
  delete rascunho.eventos[2].mensagens.menu;
  rascunho.eventos[2].opcoes = [];
  const r = validarConfig(rascunho);
  assert.deepEqual(r.erros, []);
  assert.ok(r.avisos.some((x) => x.startsWith('eventos[2] (gama): ') && x.includes('mensagens.menu')));

  const repetido = base();
  repetido.eventos[1].gatilhos.push('Alfa  Festival');
  assert.ok(validarConfig(repetido).erros.some((e) => e.includes('gatilho')));
  const naoAtivo = base();
  naoAtivo.eventos[2].gatilhos = ['beta'];
  assert.deepEqual(validarConfig(naoAtivo).erros, []);

  const ruim = base();
  ruim.eventos[0].id = 'Alfa Ruim';
  ruim.eventos[1].id = 'alfa-2';
  ruim.eventos[2].status = 'pronto';
  ruim.eventos.push(evento('alfa-2', 'ativo', 'Dup', []));
  const e = validarConfig(ruim).erros.join('\n');
  assert.match(e, /"id" deve usar/);
  assert.match(e, /"id" repetido/);
  assert.match(e, /"status" precisa ser/);

  const raiz = base();
  raiz.mensagens.sem_eventos = '';
  raiz.mensagens.escolher_evento = 'Escolha {{eventos}} {{inexistente}}';
  const er = validarConfig(raiz).erros.join('\n');
  assert.match(er, /sem_eventos não pode ser vazia/);
  assert.match(er, /inexistente/);
  assert.doesNotMatch(er, /\{\{eventos\}\}/);
});

test('validação v2: sem evento ativo é aviso; lista vazia é permitida; menu na raiz não é exigido', () => {
  const cfg = base();
  cfg.eventos = [];
  const v = validarConfig(cfg);
  assert.deepEqual(v.erros, []);
  assert.ok(v.avisos.some((a) => a.includes('Nenhum evento está ativo')));
  cfg.eventos = { id: 'x' };
  assert.ok(validarConfig(cfg).erros.length > 0);
});
