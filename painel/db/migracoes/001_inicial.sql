-- Migração 001: usuários, sessões, versões da configuração e histórico do robô.

CREATE TABLE usuarios (
  id serial PRIMARY KEY,
  usuario text NOT NULL UNIQUE,
  senha_hash text NOT NULL,
  papel text NOT NULL CHECK (papel IN ('admin', 'editor', 'leitor')),
  ativo boolean NOT NULL DEFAULT true,
  criado_em timestamptz NOT NULL DEFAULT now(),
  ultimo_login timestamptz
);
-- Impede dois usuários que só diferem por maiúsculas e minúsculas.
CREATE UNIQUE INDEX usuarios_usuario_minusculo ON usuarios (lower(usuario));

CREATE TABLE sessoes (
  id_hash text PRIMARY KEY,
  usuario_id integer NOT NULL REFERENCES usuarios (id) ON DELETE CASCADE,
  criada_em timestamptz NOT NULL DEFAULT now(),
  ultimo_uso timestamptz NOT NULL DEFAULT now(),
  ip text
);
CREATE INDEX sessoes_usuario ON sessoes (usuario_id);

CREATE TABLE config_versoes (
  id serial PRIMARY KEY,
  criado_em timestamptz NOT NULL DEFAULT now(),
  autor text NOT NULL,
  conteudo jsonb NOT NULL,
  revisao text NOT NULL,
  comentario text
);
CREATE INDEX config_versoes_criado_em ON config_versoes (criado_em DESC);

-- Uma linha por registro de conversas-AAAA-MM-DD.log.
-- "arquivo" guarda o nome do arquivo (com "#N" se ele foi recriado) e "posicao" o byte em que a linha começa.
CREATE TABLE mensagens (
  id bigserial PRIMARY KEY,
  quando timestamptz NOT NULL,
  sessao text,
  conversa text NOT NULL,
  telefone text,
  nome text,
  de text,
  texto text,
  resultado text,
  motivo text,
  intencao text,
  resposta text,
  evento_id text,
  ia text,
  ia_modelo text,
  msg text,
  extra jsonb NOT NULL DEFAULT '{}'::jsonb,
  arquivo text NOT NULL,
  posicao bigint NOT NULL
);
CREATE UNIQUE INDEX mensagens_origem ON mensagens (arquivo, posicao);
CREATE INDEX mensagens_quando ON mensagens (quando);
CREATE INDEX mensagens_conversa_quando ON mensagens (conversa, quando);
CREATE INDEX mensagens_telefone ON mensagens (telefone);
CREATE INDEX mensagens_texto_busca ON mensagens USING gin (to_tsvector('portuguese', coalesce(texto, '')));

-- Uma linha por registro de chatbot-AAAA-MM-DD.log (atividade, sem texto de mensagem).
CREATE TABLE registros (
  id bigserial PRIMARY KEY,
  quando timestamptz NOT NULL,
  resultado text,
  motivo text,
  evento text,
  detalhe text,
  intencao text,
  ia text,
  ia_modelo text,
  ia_tentativas integer,
  sessao text,
  extra jsonb NOT NULL DEFAULT '{}'::jsonb,
  arquivo text NOT NULL,
  posicao bigint NOT NULL
);
CREATE UNIQUE INDEX registros_origem ON registros (arquivo, posicao);
CREATE INDEX registros_quando ON registros (quando);

-- Uma linha por registro de erros-AAAA-MM-DD.log (workflow de erros do n8n).
CREATE TABLE erros (
  id bigserial PRIMARY KEY,
  quando timestamptz NOT NULL,
  workflow text,
  no text,
  erro text,
  descricao text,
  http integer,
  execucao text,
  modo text,
  extra jsonb NOT NULL DEFAULT '{}'::jsonb,
  arquivo text NOT NULL,
  posicao bigint NOT NULL
);
CREATE UNIQUE INDEX erros_origem ON erros (arquivo, posicao);
CREATE INDEX erros_quando ON erros (quando);

-- Até onde cada arquivo de log já foi lido. "geracao" aumenta quando o arquivo é recriado ou truncado.
CREATE TABLE ingestao (
  arquivo text PRIMARY KEY,
  posicao bigint NOT NULL DEFAULT 0,
  geracao integer NOT NULL DEFAULT 0,
  atualizado_em timestamptz NOT NULL DEFAULT now()
);
