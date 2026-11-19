'use strict';

// Calcula as métricas do painel a partir das tabelas mensagens e registros.
// "consultar(sql, params)" é async e devolve { rows }, como o pg.
// O intervalo é [inicio, fim) e "fuso" é um nome IANA (ex.: 'America/Sao_Paulo').

const { agruparDuvidas } = require('./normalizar');

const LIMITE_DUVIDAS_BRUTAS = 2000;
const LIMITE_DUVIDAS = 20;
const LIMITE_INTENCOES = 10;

// Converte o valor de uma contagem (bigint vem como string) em número, usando 0 quando não há valor.
function numero(valor) {
  return Number(valor ?? 0);
}

async function calcularMetricas(consultar, { inicio, fim, fuso }) {
  const periodo = [inicio, fim];
  const periodoComFuso = [inicio, fim, fuso];

  // Recebidas: mensagens enviadas pelo contato dentro do intervalo.
  const filtroRecebidas = `de = 'contato' AND quando >= $1 AND quando < $2`;

  const [
    totaisRes,
    porDiaRes,
    porOrigemRes,
    porIntencaoRes,
    porHoraRes,
    duvidasRes,
    iaTotaisRes,
    iaFalhasRes,
    iaModeloRes,
  ] = await Promise.all([
    consultar(
      `SELECT count(*) AS recebidas,
              count(DISTINCT conversa) AS contatos,
              count(*) FILTER (WHERE resultado = 'respondida') AS respondidas
         FROM mensagens
        WHERE ${filtroRecebidas}`,
      periodo,
    ),

    consultar(
      `SELECT to_char(quando AT TIME ZONE $3, 'YYYY-MM-DD') AS dia,
              count(*) AS recebidas,
              count(*) FILTER (WHERE resultado = 'respondida') AS respondidas
         FROM mensagens
        WHERE ${filtroRecebidas}
        GROUP BY 1
        ORDER BY 1`,
      periodoComFuso,
    ),

    consultar(
      `SELECT CASE
                WHEN motivo = 'transferida_para_atendimento_humano' THEN 'atendimento_humano'
                WHEN motivo = 'ia' OR intencao = 'ia' THEN 'ia'
                WHEN motivo IN ('nao_reconhecida', 'midia_sem_texto', 'fallback_esgotado') THEN 'fallback'
                ELSE 'menu_regras'
              END AS origem,
              count(*) AS total
         FROM mensagens
        WHERE ${filtroRecebidas} AND resultado = 'respondida'
        GROUP BY 1
        ORDER BY total DESC, origem`,
      periodo,
    ),

    consultar(
      `SELECT intencao, count(*) AS total
         FROM mensagens
        WHERE ${filtroRecebidas} AND intencao IS NOT NULL AND intencao <> ''
        GROUP BY intencao
        ORDER BY total DESC, intencao
        LIMIT ${LIMITE_INTENCOES}`,
      periodo,
    ),

    consultar(
      `SELECT extract(hour FROM quando AT TIME ZONE $3)::int AS hora,
              count(*) AS total
         FROM mensagens
        WHERE ${filtroRecebidas}
        GROUP BY 1`,
      periodoComFuso,
    ),

    consultar(
      `SELECT texto, count(*) AS total
         FROM mensagens
        WHERE ${filtroRecebidas} AND intencao = 'nao_entendi' AND btrim(texto) <> ''
        GROUP BY texto
        ORDER BY total DESC
        LIMIT ${LIMITE_DUVIDAS_BRUTAS}`,
      periodo,
    ),

    // Atividade da IA na tabela registros.
    consultar(
      `SELECT count(*) FILTER (WHERE ia IS NOT NULL AND ia <> '') AS consultas,
              count(*) FILTER (WHERE ia = 'respondeu') AS respostas
         FROM registros
        WHERE quando >= $1 AND quando < $2`,
      periodo,
    ),

    consultar(
      `SELECT ia AS motivo, count(*) AS total
         FROM registros
        WHERE quando >= $1 AND quando < $2
          AND ia IS NOT NULL AND ia <> '' AND ia <> 'respondeu'
        GROUP BY ia
        ORDER BY total DESC, ia`,
      periodo,
    ),

    consultar(
      `SELECT ia_modelo AS modelo, count(*) AS total
         FROM registros
        WHERE quando >= $1 AND quando < $2
          AND ia = 'respondeu' AND ia_modelo IS NOT NULL
        GROUP BY ia_modelo
        ORDER BY total DESC, ia_modelo`,
      periodo,
    ),
  ]);

  const totais = totaisRes.rows[0] ?? {};
  const recebidas = numero(totais.recebidas);
  const respondidas = numero(totais.respondidas);

  // Horas sem mensagens continuam aparecendo com total zero.
  const porHora = Array.from({ length: 24 }, (_, hora) => ({ hora, total: 0 }));
  for (const linha of porHoraRes.rows) {
    porHora[Number(linha.hora)].total = numero(linha.total);
  }

  const iaTotais = iaTotaisRes.rows[0] ?? {};

  const duvidas = agruparDuvidas(
    duvidasRes.rows.map((linha) => ({ texto: linha.texto, total: numero(linha.total) })),
    LIMITE_DUVIDAS,
  );

  return {
    totais: {
      recebidas,
      contatos: numero(totais.contatos),
      respondidas,
      naoRespondidas: recebidas - respondidas,
    },
    porDia: porDiaRes.rows.map((linha) => ({
      dia: linha.dia,
      recebidas: numero(linha.recebidas),
      respondidas: numero(linha.respondidas),
    })),
    porOrigem: porOrigemRes.rows.map((linha) => ({
      origem: linha.origem,
      total: numero(linha.total),
    })),
    porIntencao: porIntencaoRes.rows.map((linha) => ({
      intencao: linha.intencao,
      total: numero(linha.total),
    })),
    ia: {
      consultas: numero(iaTotais.consultas),
      respostas: numero(iaTotais.respostas),
      falhas: iaFalhasRes.rows.map((linha) => ({
        motivo: linha.motivo,
        total: numero(linha.total),
      })),
      porModelo: iaModeloRes.rows.map((linha) => ({
        modelo: linha.modelo,
        total: numero(linha.total),
      })),
    },
    porHora,
    duvidas,
  };
}

module.exports = { calcularMetricas };
