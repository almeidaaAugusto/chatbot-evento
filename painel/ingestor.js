'use strict';

// Ingestor: lê os arquivos de log do robô (conversas-*, chatbot-*, erros-*) e grava no banco.
//  - incremental: guarda, por arquivo, até que byte já foi lido (tabela "ingestao");
//  - idempotente: cada linha tem a chave (arquivo, posição do byte em que a linha começa), e
//    reinserir a mesma linha é ignorado (ON CONFLICT DO NOTHING no repositório);
//  - só lê linhas completas: a última linha, se ainda não terminou em "\n", fica para o próximo ciclo;
//  - arquivo apagado: simplesmente não aparece mais; arquivo menor que a posição guardada (truncado)
//    ou recriado (o byte anterior à posição deixou de ser "\n") recomeça do zero numa nova "geração",
//    com chaves novas, para não colidir com as linhas antigas.
// O n8n não depende deste módulo: se o banco cair, o ingestor só espera e continua depois.

const fs = require('node:fs/promises');
const path = require('node:path');

const NOME_LOG = /^(conversas|chatbot|erros)-\d{4}-\d{2}-\d{2}\.log$/;
const TABELAS = { conversas: 'mensagens', chatbot: 'registros', erros: 'erros' };
const LIMITE_LEITURA = 1024 * 1024;
const LIMITE_LINHA = 32 * 1024 * 1024;
const LIMITE_TEXTO = 20000;
const INTERVALO_PADRAO_MS = 5000;

const BRUTO_NUL = /\u0000+/g;

function texto(valor) {
  if (typeof valor === 'string') return valor.replace(BRUTO_NUL, '').slice(0, LIMITE_TEXTO);
  if (typeof valor === 'number' || typeof valor === 'boolean') return String(valor);
  return null;
}

function inteiro(valor) {
  const numero = typeof valor === 'string' && /^-?\d{1,9}$/.test(valor) ? Number(valor) : valor;
  return Number.isInteger(numero) && Math.abs(numero) < 2 ** 31 ? numero : null;
}

function momento(valor) {
  if (typeof valor !== 'string') return null;
  const ms = Date.parse(valor);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

// Campos que viram coluna ficam de fora de "extra". O jsonb do Postgres não aceita \u0000.
function extraDe(dados, conhecidos) {
  const resto = {};
  for (const chave of Object.keys(dados)) if (!conhecidos.includes(chave) && dados[chave] !== undefined) resto[chave] = dados[chave];
  return JSON.stringify(resto).replace(/\\u0000/g, '');
}

const MAPAS = {
  conversas(d) {
    const quando = momento(d.quando);
    const conversa = texto(d.conversa);
    if (!quando || !conversa) return null;
    const conhecidos = ['quando', 'sessao', 'conversa', 'telefone', 'nome', 'de', 'texto', 'resultado', 'motivo', 'intencao', 'resposta', 'evento_id', 'evento', 'ia', 'iaModelo', 'msg'];
    return {
      quando, sessao: texto(d.sessao), conversa, telefone: texto(d.telefone), nome: texto(d.nome), de: texto(d.de), texto: texto(d.texto),
      resultado: texto(d.resultado), motivo: texto(d.motivo), intencao: texto(d.intencao), resposta: texto(d.resposta),
      evento_id: texto(d.evento_id ?? d.evento), ia: texto(d.ia), ia_modelo: texto(d.iaModelo), msg: texto(d.msg),
      extra: extraDe(d, conhecidos)
    };
  },
  chatbot(d) {
    const quando = momento(d.quando);
    if (!quando) return null;
    const conhecidos = ['quando', 'resultado', 'motivo', 'evento', 'detalhe', 'intencao', 'ia', 'iaModelo', 'iaTentativas', 'sessao'];
    return {
      quando, resultado: texto(d.resultado), motivo: texto(d.motivo), evento: texto(d.evento), detalhe: texto(d.detalhe), intencao: texto(d.intencao),
      ia: texto(d.ia), ia_modelo: texto(d.iaModelo), ia_tentativas: inteiro(d.iaTentativas), sessao: texto(d.sessao),
      extra: extraDe(d, conhecidos)
    };
  },
  erros(d) {
    const quando = momento(d.quando);
    if (!quando) return null;
    const conhecidos = ['quando', 'workflow', 'no', 'erro', 'descricao', 'http', 'execucao', 'modo'];
    return {
      quando, workflow: texto(d.workflow), no: texto(d.no), erro: texto(d.erro), descricao: texto(d.descricao),
      http: inteiro(d.http), execucao: texto(d.execucao), modo: texto(d.modo),
      extra: extraDe(d, conhecidos)
    };
  }
};

// Converte um pedaço de bytes (terminado em "\n") em linhas { posicao, valores }.
function extrairLinhas(buffer, inicioDoBuffer, tipo) {
  const linhas = [];
  let comeco = 0;
  for (;;) {
    const fim = buffer.indexOf(0x0a, comeco);
    if (fim < 0) break;
    const bruta = buffer.subarray(comeco, fim).toString('utf8').replace(BRUTO_NUL, '').trim();
    if (bruta) {
      try {
        const dados = JSON.parse(bruta);
        if (dados && typeof dados === 'object' && !Array.isArray(dados)) {
          const valores = MAPAS[tipo](dados);
          if (valores) linhas.push({ posicao: inicioDoBuffer + comeco, valores });
        }
      } catch {
        // Linha corrompida (disco cheio, desligamento abrupto): ignorada, a posição avança.
      }
    }
    comeco = fim + 1;
  }
  return { linhas, consumido: comeco };
}

function criarIngestor({ pasta, repositorio, intervaloMs = INTERVALO_PADRAO_MS, agora = () => Date.now(), registrar = (mensagem) => console.error(mensagem) } = {}) {
  let ultimoCicloOk = null;
  let rodando = null;
  let temporizador = null;

  async function ingerirArquivo(nome, estado) {
    const tipo = nome.slice(0, nome.indexOf('-'));
    const tabela = TABELAS[tipo];
    const caminho = path.join(pasta, nome);
    let manipulador;
    try { manipulador = await fs.open(caminho, 'r'); }
    catch (erro) { if (erro.code === 'ENOENT') return; throw erro; }
    try {
      let { size } = await manipulador.stat();
      let posicao = estado ? estado.posicao : 0;
      let geracao = estado ? estado.geracao : 0;
      let recriado = posicao > size;
      if (!recriado && posicao > 0) {
        // Um arquivo que só cresce sempre tem "\n" logo antes da posição guardada.
        const anterior = Buffer.alloc(1);
        const { bytesRead } = await manipulador.read(anterior, 0, 1, posicao - 1);
        recriado = bytesRead !== 1 || anterior[0] !== 0x0a;
      }
      if (recriado) {
        geracao = await repositorio.ingestao.reiniciar(nome);
        posicao = 0;
      }
      while (posicao < size) {
        // Lê um bloco; se não houver nenhuma quebra de linha nele, aumenta o bloco (linha enorme).
        let limite = LIMITE_LEITURA;
        let lido;
        let ultimaQuebra = -1;
        for (;;) {
          const tamanho = Math.min(size - posicao, limite);
          const buffer = Buffer.alloc(tamanho);
          const { bytesRead } = await manipulador.read(buffer, 0, tamanho, posicao);
          lido = buffer.subarray(0, bytesRead);
          ultimaQuebra = lido.lastIndexOf(0x0a);
          if (ultimaQuebra >= 0 || tamanho < limite || limite >= LIMITE_LINHA) break;
          limite *= 2;
        }
        // Sem quebra de linha: a última linha ainda está sendo gravada (ou é absurdamente grande); espera.
        if (ultimaQuebra < 0) break;
        const { linhas } = extrairLinhas(lido.subarray(0, ultimaQuebra + 1), posicao, tipo);
        const avanco = ultimaQuebra + 1;
        await repositorio.ingestao.gravarLote({ tabela, arquivo: nome, geracao, linhas, posicaoFinal: posicao + avanco });
        posicao += avanco;
        if (posicao >= size) ({ size } = await manipulador.stat());
      }
    } finally {
      await manipulador.close();
    }
  }

  // Um ciclo completo sobre a pasta de logs. Não faz nada se o banco não está pronto.
  async function ciclo() {
    if (!repositorio.disponivel()) return false;
    let nomes;
    try { nomes = await fs.readdir(pasta); }
    catch (erro) { if (erro.code === 'ENOENT') nomes = []; else throw erro; }
    const alvos = nomes.filter((nome) => NOME_LOG.test(nome)).sort();
    const estados = await repositorio.ingestao.estados();
    for (const nome of alvos) await ingerirArquivo(nome, estados.get(nome));
    ultimoCicloOk = agora();
    return true;
  }

  // Executa um ciclo (sem sobrepor outro em andamento).
  function rodarAgora() {
    if (rodando) return rodando;
    rodando = ciclo().catch((erro) => {
      if (!erro.bancoIndisponivel) registrar('Falha ao ingerir os logs no banco: ' + erro.message);
      return false;
    }).finally(() => { rodando = null; });
    return rodando;
  }

  function iniciar() {
    if (temporizador) return;
    rodarAgora();
    temporizador = setInterval(rodarAgora, intervaloMs);
    temporizador.unref();
  }

  async function parar() {
    if (temporizador) clearInterval(temporizador);
    temporizador = null;
    if (rodando) await rodando;
  }

  // Segundos desde o último ciclo concluído (null se ainda não houve nenhum).
  const atrasoSegundos = () => (ultimoCicloOk === null ? null : Math.max(0, Math.round((agora() - ultimoCicloOk) / 1000)));

  async function esquecerAntigos(dias = 30) {
    let nomes = [];
    try { nomes = (await fs.readdir(pasta)).filter((nome) => NOME_LOG.test(nome)); } catch { /* pasta ausente */ }
    return repositorio.ingestao.esquecerAntigos(dias, nomes);
  }

  return { iniciar, parar, rodarAgora, ciclo, atrasoSegundos, esquecerAntigos };
}

module.exports = { criarIngestor, extrairLinhas, MAPAS, NOME_LOG };
