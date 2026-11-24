'use strict';

// Repositório FALSO, em memória, com a mesma interface de painel/db/repositorio.js.
// Os testes unitários o injetam no servidor (criarServidor({ repositorio })), sem Postgres e sem o módulo pg.
// Os comportamentos que importam (último admin, troca de senha derrubando sessões, chave única
// arquivo+posição da ingestão) são reproduzidos aqui; o SQL real é testado na suíte Docker.

function erroHttp(status, mensagem) {
  const erro = new Error(mensagem);
  erro.status = status;
  return erro;
}

function erroBanco() {
  const erro = new Error('O banco de dados está indisponível no momento.');
  erro.status = 503;
  erro.bancoIndisponivel = true;
  erro.detalhes = { bancoIndisponivel: true };
  return erro;
}

function criarBancoFalso({ noAr = true } = {}) {
  const estado = {
    noAr,
    proximoUsuario: 1,
    proximaVersao: 1,
    proximaMensagem: 1,
    usuarios: [],
    sessoes: new Map(),
    versoes: [],
    mensagens: [],
    registros: [],
    erros: [],
    ingestao: new Map(),
    metricasChamadas: [],
    metricas: { totais: { recebidas: 0, contatos: 0, respondidas: 0, naoRespondidas: 0 }, porDia: [], porOrigem: [], porIntencao: [], ia: { consultas: 0, respostas: 0, falhas: [], porModelo: [], reservaPronta: 0, travas: { total: 0, porTipo: [] } }, porHora: [], duvidas: [] }
  };
  let gancho = null;
  const exigir = () => { if (!estado.noAr) throw erroBanco(); };
  const publico = (u) => ({ id: u.id, usuario: u.usuario, papel: u.papel, ativo: u.ativo, criadoEm: u.criadoEm, ultimoLogin: u.ultimoLogin });
  const nomeIgual = (a, b) => a.toLowerCase() === b.toLowerCase();
  const tabelas = { mensagens: estado.mensagens, registros: estado.registros, erros: estado.erros };

  const usuarios = {
    async contar() { exigir(); return estado.usuarios.length; },
    async listar() { exigir(); return estado.usuarios.map(publico); },
    async porNome(nome) { exigir(); const u = estado.usuarios.find((x) => nomeIgual(x.usuario, nome)); return u ? { ...publico(u), senhaHash: u.senhaHash } : null; },
    async porId(id) { exigir(); const u = estado.usuarios.find((x) => x.id === id); return u ? publico(u) : null; },
    async criar({ usuario, senhaHash, papel }) {
      exigir();
      if (estado.usuarios.some((x) => nomeIgual(x.usuario, usuario))) throw erroHttp(409, 'Já existe um usuário com esse nome.');
      const u = { id: estado.proximoUsuario++, usuario, senhaHash, papel, ativo: true, criadoEm: new Date().toISOString(), ultimoLogin: null };
      estado.usuarios.push(u);
      return publico(u);
    },
    async criarPrimeiroAdmin({ usuario, senhaHash }) {
      exigir();
      if (estado.usuarios.length) return false;
      await usuarios.criar({ usuario, senhaHash, papel: 'admin' });
      return true;
    },
    async atualizar(id, { papel, ativo }) {
      exigir();
      const u = estado.usuarios.find((x) => x.id === id);
      if (!u) return null;
      const novoPapel = papel ?? u.papel;
      const novoAtivo = ativo ?? u.ativo;
      if (u.papel === 'admin' && u.ativo && (novoPapel !== 'admin' || !novoAtivo) && !estado.usuarios.some((x) => x.id !== id && x.papel === 'admin' && x.ativo)) throw erroHttp(409, 'Não é possível remover ou rebaixar o último administrador.');
      const mudou = !novoAtivo || novoPapel !== u.papel;
      u.papel = novoPapel;
      u.ativo = novoAtivo;
      if (mudou) for (const [chave, s] of estado.sessoes) if (s.usuarioId === id) estado.sessoes.delete(chave);
      return publico(u);
    },
    async definirSenha(id, senhaHash) {
      exigir();
      const u = estado.usuarios.find((x) => x.id === id);
      if (!u) return false;
      u.senhaHash = senhaHash;
      for (const [chave, s] of estado.sessoes) if (s.usuarioId === id) estado.sessoes.delete(chave);
      return true;
    },
    async registrarLogin(id, quando = new Date()) { exigir(); const u = estado.usuarios.find((x) => x.id === id); if (u) u.ultimoLogin = quando.toISOString(); }
  };

  const sessoes = {
    async criar({ idHash, usuarioId, ip, criadaEm = new Date() }) { exigir(); estado.sessoes.set(idHash, { usuarioId, ip, criadaEm, ultimoUso: criadaEm }); },
    async buscar(idHash) {
      exigir();
      const s = estado.sessoes.get(idHash);
      const u = s && estado.usuarios.find((x) => x.id === s.usuarioId);
      return s && u ? { usuarioId: u.id, usuario: u.usuario, papel: u.papel, ativo: u.ativo, criadaEm: s.criadaEm, ultimoUso: s.ultimoUso } : null;
    },
    async tocar(idHash, quando = new Date()) { exigir(); const s = estado.sessoes.get(idHash); if (s) s.ultimoUso = quando; },
    async remover(idHash) { exigir(); estado.sessoes.delete(idHash); },
    async removerDoUsuario(usuarioId) { exigir(); for (const [chave, s] of estado.sessoes) if (s.usuarioId === usuarioId) estado.sessoes.delete(chave); },
    async limpar({ ociosasAntes, criadasAntes }) {
      exigir();
      let n = 0;
      for (const [chave, s] of estado.sessoes) if (s.ultimoUso < ociosasAntes || s.criadaEm < criadasAntes) { estado.sessoes.delete(chave); n++; }
      return n;
    }
  };

  const config = {
    async contarVersoes() { exigir(); return estado.versoes.length; },
    async listarVersoes(limite = 50) { exigir(); return estado.versoes.slice().reverse().slice(0, limite).map(({ id, criadoEm, autor, comentario }) => ({ id, criadoEm, autor, comentario })); },
    async versao(id) { exigir(); const v = estado.versoes.find((x) => x.id === id); return v ? { id: v.id, criadoEm: v.criadoEm, autor: v.autor, comentario: v.comentario, config: JSON.parse(JSON.stringify(v.conteudo)) } : null; },
    async inserirVersao({ autor, conteudo, revisao, comentario = null }) {
      exigir();
      const v = { id: estado.proximaVersao++, criadoEm: new Date().toISOString(), autor, conteudo: JSON.parse(JSON.stringify(conteudo)), revisao, comentario };
      estado.versoes.push(v);
      return v.id;
    }
  };

  const historico = {
    async listar({ inicio, fim, busca, conversa, limite = 50, deslocamento = 0 }) {
      exigir();
      const termo = busca ? busca.toLowerCase() : '';
      const achadas = estado.mensagens
        .filter((m) => (!inicio || new Date(m.quando) >= inicio) && (!fim || new Date(m.quando) < fim) && (!conversa || m.conversa === conversa))
        .filter((m) => !termo || [m.texto, m.resposta, m.nome, m.telefone].some((c) => String(c ?? '').toLowerCase().includes(termo)))
        .sort((a, b) => (a.quando < b.quando ? 1 : a.quando > b.quando ? -1 : b.id - a.id));
      return achadas.slice(deslocamento, deslocamento + limite).map(paraItem);
    },
    async conversa(conversa, limite = 2000) {
      exigir();
      return estado.mensagens.filter((m) => m.conversa === conversa).sort((a, b) => (a.quando < b.quando ? -1 : a.quando > b.quando ? 1 : a.id - b.id)).slice(-limite).map(paraItem);
    }
  };

  function paraItem(m) {
    return { id: m.id, quando: m.quando, sessao: m.sessao ?? null, conversa: m.conversa, telefone: m.telefone ?? null, nome: m.nome ?? null, de: m.de ?? null, texto: m.texto ?? null, resposta: m.resposta ?? null, resultado: m.resultado ?? null, motivo: m.motivo ?? null, intencao: m.intencao ?? null, ia: m.ia ?? null, iaModelo: m.ia_modelo ?? null };
  }

  const ingestao = {
    async estados() { exigir(); return new Map([...estado.ingestao].map(([k, v]) => [k, { ...v }])); },
    async gravarLote({ tabela, arquivo, geracao = 0, linhas, posicaoFinal }) {
      exigir();
      const chave = geracao > 0 ? arquivo + '#' + geracao : arquivo;
      for (const linha of linhas) {
        const lista = tabelas[tabela];
        if (lista.some((x) => x.arquivo === chave && x.posicao === linha.posicao)) continue; // ON CONFLICT DO NOTHING
        lista.push({ id: estado.proximaMensagem++, ...linha.valores, arquivo: chave, posicao: linha.posicao });
      }
      estado.ingestao.set(arquivo, { posicao: posicaoFinal, geracao });
    },
    async reiniciar(arquivo) {
      exigir();
      const atual = estado.ingestao.get(arquivo);
      const geracao = (atual ? atual.geracao : 0) + 1;
      estado.ingestao.set(arquivo, { posicao: 0, geracao });
      return geracao;
    },
    async esquecerAntigos() { exigir(); return 0; }
  };

  const retencao = {
    async limpar({ mensagensDias }) {
      exigir();
      const limite = Date.now() - mensagensDias * 86400000;
      const antes = estado.mensagens.length;
      estado.mensagens.splice(0, estado.mensagens.length, ...estado.mensagens.filter((m) => Date.parse(m.quando) >= limite));
      return { mensagens: antes - estado.mensagens.length, registros: 0, erros: 0 };
    }
  };

  return {
    estado,
    disponivel: () => estado.noAr,
    // Liga ou derruba o banco no meio do teste.
    // Ao voltar, repete o gancho de inicialização, como o repositório real faz na reconexão.
    async definirNoAr(valor) { const voltou = valor && !estado.noAr; estado.noAr = valor; if (voltou && gancho) await gancho(); },
    async iniciar({ aoConectar } = {}) { gancho = aoConectar || null; if (gancho && estado.noAr) await gancho(); },
    async parar() {},
    usuarios, sessoes, config, historico, ingestao, retencao,
    async metricas(periodo) { exigir(); estado.metricasChamadas.push(periodo); return estado.metricas; }
  };
}

module.exports = { criarBancoFalso, erroBanco };
