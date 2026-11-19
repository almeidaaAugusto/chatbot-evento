'use strict';

// Repositório: todas as consultas SQL do painel (sempre parametrizadas).
// O servidor só conversa com este objeto, o que permite trocar por um repositório falso nos testes.
// Toda chamada que precisa do banco lança ErroBanco (HTTP 503) se ele estiver fora do ar.

const { criarConexao, erroBanco } = require('./conexao');
const { aplicarMigracoes } = require('./migrar');
const { calcularMetricas } = require('./metricas');

// Colunas que o ingestor pode gravar em cada tabela (lista fixa: nomes nunca vêm de fora).
const COLUNAS = {
  mensagens: ['quando', 'sessao', 'conversa', 'telefone', 'nome', 'de', 'texto', 'resultado', 'motivo', 'intencao', 'resposta', 'evento_id', 'ia', 'ia_modelo', 'msg', 'extra'],
  registros: ['quando', 'resultado', 'motivo', 'evento', 'detalhe', 'intencao', 'ia', 'ia_modelo', 'ia_tentativas', 'sessao', 'extra'],
  erros: ['quando', 'workflow', 'no', 'erro', 'descricao', 'http', 'execucao', 'modo', 'extra']
};
const LOTE_MAXIMO = 200;
const RETENTAR_PREPARO_MS = 5000;
const iso = (data) => (data instanceof Date ? data.toISOString() : data ?? null);

function erroHttp(status, mensagem) {
  const erro = new Error(mensagem);
  erro.status = status;
  return erro;
}

const usuarioDe = (l) => ({ id: l.id, usuario: l.usuario, papel: l.papel, ativo: l.ativo, criadoEm: iso(l.criado_em), ultimoLogin: iso(l.ultimo_login) });
const itemDe = (l) => ({ id: Number(l.id), quando: iso(l.quando), sessao: l.sessao, conversa: l.conversa, telefone: l.telefone, nome: l.nome, de: l.de, texto: l.texto, resposta: l.resposta, resultado: l.resultado, motivo: l.motivo, intencao: l.intencao, ia: l.ia, iaModelo: l.ia_modelo });
const COLUNAS_ITEM = 'id, quando, sessao, conversa, telefone, nome, de, texto, resposta, resultado, motivo, intencao, ia, ia_modelo';

function escaparLike(texto) {
  return texto.replace(/[\\%_]/g, (c) => '\\' + c);
}

function criarRepositorio(conexao) {
  let migrado = false;
  let aoConectar = async () => {};
  let preparando = null;
  let repeticao = null;

  const disponivel = () => Boolean(conexao.configurado) && conexao.disponivel() && migrado;
  const exigir = () => { if (!disponivel()) throw erroBanco(); };
  const q = async (sql, parametros) => { exigir(); return conexao.consultar(sql, parametros); };
  const tx = async (tarefa) => { exigir(); return conexao.transacao(tarefa); };

  // Migra e executa o gancho de inicialização. Chamado quando o banco aparece ou volta.
  function preparar() {
    if (preparando) return preparando;
    preparando = (async () => {
      try {
        if (!migrado) {
          const aplicadas = await aplicarMigracoes(conexao);
          if (aplicadas.length) console.log('Migrações do banco aplicadas: ' + aplicadas.join(', '));
          migrado = true;
        }
        await aoConectar();
      } catch (erro) {
        if (!erro.bancoIndisponivel) console.error('Falha ao preparar o banco de dados: ' + erro.message);
        throw erro;
      } finally { preparando = null; }
    })();
    return preparando;
  }

  // O monitor da conexão avisa quando ela volta: roda de novo as migrações (idempotentes), que
  // recriam o esquema se o banco voltou vazio.
  function aoMudarConexao(estado) {
    if (!estado) return;
    migrado = false;
    preparar().catch(() => { /* a repetição abaixo tenta de novo */ });
  }

  async function iniciar({ aoConectar: gancho } = {}) {
    if (gancho) aoConectar = gancho;
    if (!conexao.configurado) return;
    await conexao.iniciar();
    if (conexao.disponivel()) await preparar().catch(() => {});
    if (!repeticao) {
      repeticao = setInterval(() => { if (conexao.disponivel() && !migrado && !preparando) preparar().catch(() => {}); }, RETENTAR_PREPARO_MS);
      repeticao.unref();
    }
  }

  async function parar() {
    if (repeticao) clearInterval(repeticao);
    repeticao = null;
    await conexao.parar();
  }

  const usuarios = {
    async contar() { return Number((await q('SELECT count(*) AS n FROM usuarios')).rows[0].n); },
    async listar() { return (await q('SELECT * FROM usuarios ORDER BY lower(usuario)')).rows.map(usuarioDe); },
    async porNome(nome) {
      const { rows } = await q('SELECT * FROM usuarios WHERE lower(usuario) = lower($1)', [nome]);
      return rows[0] ? { ...usuarioDe(rows[0]), senhaHash: rows[0].senha_hash } : null;
    },
    async porId(id) {
      const { rows } = await q('SELECT * FROM usuarios WHERE id = $1', [id]);
      return rows[0] ? usuarioDe(rows[0]) : null;
    },
    async criar({ usuario, senhaHash, papel }) {
      try {
        const { rows } = await q('INSERT INTO usuarios (usuario, senha_hash, papel) VALUES ($1, $2, $3) RETURNING *', [usuario, senhaHash, papel]);
        return usuarioDe(rows[0]);
      } catch (erro) {
        if (erro.code === '23505') throw erroHttp(409, 'Já existe um usuário com esse nome.');
        throw erro;
      }
    },
    // Cria o administrador inicial só se a tabela estiver vazia (atômico). Devolve true se criou.
    async criarPrimeiroAdmin({ usuario, senhaHash }) {
      const { rows } = await q("INSERT INTO usuarios (usuario, senha_hash, papel) SELECT $1, $2, 'admin' WHERE NOT EXISTS (SELECT 1 FROM usuarios) ON CONFLICT DO NOTHING RETURNING id", [usuario, senhaHash]);
      return rows.length > 0;
    },
    // Muda papel e/ou ativo. Nunca deixa o sistema sem administrador ativo.
    async atualizar(id, { papel, ativo }) {
      return tx(async (t) => {
        const { rows } = await t.consultar('SELECT * FROM usuarios WHERE id = $1 FOR UPDATE', [id]);
        const atual = rows[0];
        if (!atual) return null;
        const novoPapel = papel ?? atual.papel;
        const novoAtivo = ativo ?? atual.ativo;
        const eraAdminAtivo = atual.papel === 'admin' && atual.ativo;
        if (eraAdminAtivo && (novoPapel !== 'admin' || !novoAtivo)) {
          // Trava os outros administradores ativos para a contagem não correr junto com outra alteração.
          const outros = await t.consultar("SELECT id FROM usuarios WHERE papel = 'admin' AND ativo AND id <> $1 FOR UPDATE", [id]);
          if (outros.rows.length === 0) throw erroHttp(409, 'Não é possível remover ou rebaixar o último administrador.');
        }
        const resultado = await t.consultar('UPDATE usuarios SET papel = $2, ativo = $3 WHERE id = $1 RETURNING *', [id, novoPapel, novoAtivo]);
        if (!novoAtivo || novoPapel !== atual.papel) await t.consultar('DELETE FROM sessoes WHERE usuario_id = $1', [id]);
        return usuarioDe(resultado.rows[0]);
      });
    },
    // Troca o hash e encerra todas as sessões do usuário.
    async definirSenha(id, senhaHash) {
      return tx(async (t) => {
        const r = await t.consultar('UPDATE usuarios SET senha_hash = $2 WHERE id = $1 RETURNING id', [id, senhaHash]);
        if (!r.rows.length) return false;
        await t.consultar('DELETE FROM sessoes WHERE usuario_id = $1', [id]);
        return true;
      });
    },
    async registrarLogin(id, quando = new Date()) { await q('UPDATE usuarios SET ultimo_login = $2 WHERE id = $1', [id, quando]); }
  };

  const sessoes = {
    async criar({ idHash, usuarioId, ip, criadaEm = new Date() }) {
      await q('INSERT INTO sessoes (id_hash, usuario_id, criada_em, ultimo_uso, ip) VALUES ($1, $2, $3, $3, $4)', [idHash, usuarioId, criadaEm, ip ? String(ip).slice(0, 64) : null]);
    },
    async buscar(idHash) {
      const { rows } = await q('SELECT s.criada_em, s.ultimo_uso, u.id, u.usuario, u.papel, u.ativo FROM sessoes s JOIN usuarios u ON u.id = s.usuario_id WHERE s.id_hash = $1', [idHash]);
      const l = rows[0];
      return l ? { usuarioId: l.id, usuario: l.usuario, papel: l.papel, ativo: l.ativo, criadaEm: l.criada_em, ultimoUso: l.ultimo_uso } : null;
    },
    async tocar(idHash, quando = new Date()) { await q('UPDATE sessoes SET ultimo_uso = $2 WHERE id_hash = $1', [idHash, quando]); },
    async remover(idHash) { await q('DELETE FROM sessoes WHERE id_hash = $1', [idHash]); },
    async removerDoUsuario(usuarioId) { await q('DELETE FROM sessoes WHERE usuario_id = $1', [usuarioId]); },
    // Apaga sessões ociosas (ultimo_uso antes de "ociosasAntes") ou velhas demais (criada antes de "criadasAntes").
    async limpar({ ociosasAntes, criadasAntes }) {
      const r = await q('DELETE FROM sessoes WHERE ultimo_uso < $1 OR criada_em < $2', [ociosasAntes, criadasAntes]);
      return r.rowCount;
    }
  };

  const config = {
    async contarVersoes() { return Number((await q('SELECT count(*) AS n FROM config_versoes')).rows[0].n); },
    async listarVersoes(limite = 50) {
      const { rows } = await q('SELECT id, criado_em, autor, comentario FROM config_versoes ORDER BY id DESC LIMIT $1', [limite]);
      return rows.map((l) => ({ id: l.id, criadoEm: iso(l.criado_em), autor: l.autor, comentario: l.comentario }));
    },
    async versao(id) {
      const { rows } = await q('SELECT id, criado_em, autor, comentario, conteudo FROM config_versoes WHERE id = $1', [id]);
      const l = rows[0];
      return l ? { id: l.id, criadoEm: iso(l.criado_em), autor: l.autor, comentario: l.comentario, config: l.conteudo } : null;
    },
    async inserirVersao({ autor, conteudo, revisao, comentario = null }) {
      const { rows } = await q('INSERT INTO config_versoes (autor, conteudo, revisao, comentario) VALUES ($1, $2::jsonb, $3, $4) RETURNING id', [autor, JSON.stringify(conteudo), revisao, comentario]);
      return rows[0].id;
    }
  };

  const historico = {
    // Mais recentes primeiro. Filtros opcionais: inicio/fim (Date), busca (texto), conversa.
    async listar({ inicio, fim, busca, conversa, limite = 50, deslocamento = 0 }) {
      const condicoes = [];
      const parametros = [];
      const novo = (valor) => { parametros.push(valor); return '$' + parametros.length; };
      if (inicio) condicoes.push('quando >= ' + novo(inicio));
      if (fim) condicoes.push('quando < ' + novo(fim));
      if (conversa) condicoes.push('conversa = ' + novo(conversa));
      if (busca) {
        const exato = novo(busca);
        const parcial = novo('%' + escaparLike(busca) + '%');
        condicoes.push(`(to_tsvector('portuguese', coalesce(texto, '')) @@ websearch_to_tsquery('portuguese', ${exato}) OR texto ILIKE ${parcial} OR resposta ILIKE ${parcial} OR nome ILIKE ${parcial} OR telefone ILIKE ${parcial})`);
      }
      const onde = condicoes.length ? 'WHERE ' + condicoes.join(' AND ') : '';
      const sql = `SELECT ${COLUNAS_ITEM} FROM mensagens ${onde} ORDER BY quando DESC, id DESC LIMIT ${novo(limite)} OFFSET ${novo(deslocamento)}`;
      return (await q(sql, parametros)).rows.map(itemDe);
    },
    // Conversa inteira de um contato, em ordem cronológica.
    async conversa(conversa, limite = 2000) {
      const { rows } = await q(`SELECT ${COLUNAS_ITEM} FROM (SELECT ${COLUNAS_ITEM} FROM mensagens WHERE conversa = $1 ORDER BY quando DESC, id DESC LIMIT $2) t ORDER BY quando ASC, id ASC`, [conversa, limite]);
      return rows.map(itemDe);
    }
  };

  const ingestao = {
    // Mapa arquivo -> { posicao, geracao }.
    async estados() {
      const { rows } = await q('SELECT arquivo, posicao, geracao FROM ingestao');
      return new Map(rows.map((l) => [l.arquivo, { posicao: Number(l.posicao), geracao: l.geracao }]));
    },
    // Grava as linhas e avança a posição na MESMA transação (nunca uma sem a outra).
    // linhas: [{ posicao, valores }]. Reinserir a mesma (arquivo, posicao) é ignorado.
    async gravarLote({ tabela, arquivo, geracao = 0, linhas, posicaoFinal }) {
      const colunas = COLUNAS[tabela];
      if (!colunas) throw new Error('Tabela de ingestão desconhecida.');
      const chaveArquivo = geracao > 0 ? arquivo + '#' + geracao : arquivo;
      await tx(async (t) => {
        for (let i = 0; i < linhas.length; i += LOTE_MAXIMO) {
          const parte = linhas.slice(i, i + LOTE_MAXIMO);
          const parametros = [];
          const grupos = parte.map((linha) => {
            const marcas = [];
            for (const coluna of colunas) { parametros.push(linha.valores[coluna] ?? null); marcas.push('$' + parametros.length); }
            parametros.push(chaveArquivo, linha.posicao);
            marcas.push('$' + (parametros.length - 1), '$' + parametros.length);
            return '(' + marcas.join(', ') + ')';
          });
          const nomes = colunas.map((c) => '"' + c + '"').join(', ');
          await t.consultar(`INSERT INTO ${tabela} (${nomes}, arquivo, posicao) VALUES ${grupos.join(', ')} ON CONFLICT (arquivo, posicao) DO NOTHING`, parametros);
        }
        await t.consultar('INSERT INTO ingestao (arquivo, posicao, geracao, atualizado_em) VALUES ($1, $2, $3, now()) ON CONFLICT (arquivo) DO UPDATE SET posicao = EXCLUDED.posicao, geracao = EXCLUDED.geracao, atualizado_em = now()', [arquivo, posicaoFinal, geracao]);
      });
    },
    // Arquivo recriado ou truncado: começa de novo numa nova geração (as chaves antigas não colidem).
    async reiniciar(arquivo) {
      const { rows } = await q('INSERT INTO ingestao (arquivo, posicao, geracao, atualizado_em) VALUES ($1, 0, 1, now()) ON CONFLICT (arquivo) DO UPDATE SET posicao = 0, geracao = ingestao.geracao + 1, atualizado_em = now() RETURNING geracao', [arquivo]);
      return rows[0].geracao;
    },
    // Esquece o estado de arquivos que não existem mais e não foram tocados há "dias" dias.
    async esquecerAntigos(dias, existentes) {
      const r = await q('DELETE FROM ingestao WHERE atualizado_em < now() - make_interval(days => $1::int) AND NOT (arquivo = ANY($2::text[]))', [dias, existentes]);
      return r.rowCount;
    }
  };

  const retencao = {
    async limpar({ mensagensDias, registrosDias }) {
      const m = await q('DELETE FROM mensagens WHERE quando < now() - make_interval(days => $1::int)', [mensagensDias]);
      const r = await q('DELETE FROM registros WHERE quando < now() - make_interval(days => $1::int)', [registrosDias]);
      const e = await q('DELETE FROM erros WHERE quando < now() - make_interval(days => $1::int)', [registrosDias]);
      return { mensagens: m.rowCount, registros: r.rowCount, erros: e.rowCount };
    }
  };

  return {
    disponivel,
    iniciar,
    parar,
    aoMudarConexao,
    usuarios,
    sessoes,
    config,
    historico,
    ingestao,
    retencao,
    metricas: async (periodo) => { exigir(); return calcularMetricas(conexao.consultar, periodo); }
  };
}

// Atalho: repositório sobre uma URL do Postgres. "criarPool" permite injetar o pool nos testes.
function criarRepositorioDeUrl(url, opcoes = {}) {
  let repo = null;
  const conexao = criarConexao({ url, ...opcoes, aoMudar: (estado) => { if (repo) repo.aoMudarConexao(estado); } });
  repo = criarRepositorio(conexao);
  return repo;
}

module.exports = { criarRepositorio, criarRepositorioDeUrl, COLUNAS };
