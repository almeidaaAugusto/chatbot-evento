'use strict';

// Leitura do volume de logs para a página "Conversas" do painel:
//   conversas-AAAA-MM-DD.log  texto recebido e resposta enviada (retenção curta);
//   chatbot-AAAA-MM-DD.log    log de atividade, sem texto (daqui sai a situação do WhatsApp);
//   erros-AAAA-MM-DD.log      falhas registradas pelo workflow de erros.
// Também apaga as conversas mais antigas que a retenção (pela data no nome do arquivo).

const fs = require('node:fs/promises');
const path = require('node:path');

const FORMATO_DIA = /^\d{4}-\d{2}-\d{2}$/;
const LIMITE_LEITURA = 2 * 1024 * 1024;
const MAXIMO_ERROS = 200;

// Data local (o contêiner usa o fuso do evento, como o n8n ao nomear os arquivos).
function diaLocal(data) {
  return [data.getFullYear(), String(data.getMonth() + 1).padStart(2, '0'), String(data.getDate()).padStart(2, '0')].join('-');
}

function somarDias(dia, quantidade) {
  const [ano, mes, numero] = dia.split('-').map(Number);
  return new Date(Date.UTC(ano, mes - 1, numero + quantidade)).toISOString().slice(0, 10);
}

function retencaoValida(valor) {
  const numero = Math.floor(Number(valor));
  return Number.isFinite(numero) && numero >= 1 ? Math.min(numero, 30) : 7;
}

function erroHttp(status, mensagem) {
  const erro = new Error(mensagem);
  erro.status = status;
  return erro;
}

// Lê do byte "de" até o fim (no máximo LIMITE_LEITURA) e devolve só as linhas completas.
async function lerLinhas(arquivo, de = 0) {
  let manipulador;
  try {
    manipulador = await fs.open(arquivo, 'r');
  } catch (erro) {
    if (erro.code === 'ENOENT') return { linhas: [], ate: 0, fim: true, existe: false };
    throw erro;
  }
  try {
    const { size } = await manipulador.stat();
    let inicio = Number.isInteger(de) && de >= 0 ? de : 0;
    let reiniciado = false;
    if (inicio > size) { inicio = 0; reiniciado = true; }
    const tamanho = Math.min(size - inicio, LIMITE_LEITURA);
    if (tamanho <= 0) return { linhas: [], ate: inicio, fim: true, existe: true, reiniciado };
    const buffer = Buffer.alloc(tamanho);
    const { bytesRead } = await manipulador.read(buffer, 0, tamanho, inicio);
    const ultimaQuebra = buffer.subarray(0, bytesRead).lastIndexOf(0x0a);
    if (ultimaQuebra < 0) {
      // Linha ainda sendo gravada (ou maior que o limite de leitura, o que não acontece na prática).
      const pular = bytesRead === LIMITE_LEITURA;
      return { linhas: [], ate: pular ? inicio + bytesRead : inicio, fim: !pular, existe: true, reiniciado };
    }
    const texto = buffer.subarray(0, ultimaQuebra).toString('utf8');
    const linhas = [];
    for (const bruta of texto.split('\n')) {
      // Um desligamento abrupto (PC em suspensão, Docker fechado) pode deixar bytes nulos no
      // arquivo, colados no começo da próxima linha gravada. Eles são descartados.
      const linha = bruta.replace(/\u0000+/g, '');
      if (!linha.trim()) continue;
      try {
        const dados = JSON.parse(linha);
        if (dados && typeof dados === 'object' && !Array.isArray(dados)) linhas.push(dados);
      } catch {
        // Linha corrompida (por exemplo, disco cheio durante a gravação): ignorada.
      }
    }
    // "fim": não há mais nada a ler agora (uma linha ainda incompleta fica para a próxima leitura).
    return { linhas, ate: inicio + ultimaQuebra + 1, fim: inicio + bytesRead >= size, existe: true, reiniciado };
  } finally {
    await manipulador.close();
  }
}

function criarRegistros({ pasta, retencaoDias = 7, agora = () => new Date() } = {}) {
  const disponivel = typeof pasta === 'string' && pasta.trim() !== '';
  const retencao = retencaoValida(retencaoDias);
  const hoje = () => diaLocal(agora());
  const primeiroDia = () => somarDias(hoje(), -(retencao - 1));
  const statusPorArquivo = new Map();

  const exigirPasta = () => {
    if (!disponivel) throw erroHttp(503, 'O painel não tem acesso aos registros do robô. Inicie pelo Docker (docker compose up -d).');
  };

  async function listar(prefixo) {
    exigirPasta();
    let nomes;
    try {
      nomes = await fs.readdir(pasta);
    } catch (erro) {
      if (erro.code === 'ENOENT') return [];
      throw erro;
    }
    const padrao = new RegExp('^' + prefixo + '-(\\d{4}-\\d{2}-\\d{2})\\.log$');
    return nomes.map((nome) => ({ nome, dia: (nome.match(padrao) || [])[1] })).filter((a) => a.dia).sort((a, b) => a.dia.localeCompare(b.dia));
  }

  async function conversas(dia, de) {
    exigirPasta();
    if (typeof dia !== 'string' || !FORMATO_DIA.test(dia)) throw erroHttp(400, 'Informe o dia no formato AAAA-MM-DD.');
    if (dia < primeiroDia() || dia > hoje()) throw erroHttp(404, 'As conversas ficam guardadas só pelos últimos ' + retencao + ' dias.');
    const lido = await lerLinhas(path.join(pasta, 'conversas-' + dia + '.log'), de);
    return { dia, registros: lido.linhas, ate: lido.ate, fim: lido.fim, reiniciado: lido.reiniciado || undefined };
  }

  async function diasComConversas() {
    const inicio = primeiroDia();
    const fim = hoje();
    return (await listar('conversas')).map((a) => a.dia).filter((dia) => dia >= inicio && dia <= fim);
  }

  // Último evento de status do WhatsApp (STARTING, SCAN_QR_CODE, WORKING, STOPPED, FAILED),
  // procurado do arquivo de atividade mais recente para o mais antigo. Cada arquivo é lido
  // uma vez; o do dia é relido só a partir de onde parou.
  async function situacaoDoWhatsApp() {
    const arquivos = (await listar('chatbot')).reverse();
    for (const { nome } of arquivos) {
      const caminho = path.join(pasta, nome);
      let cache = statusPorArquivo.get(nome) || { ate: 0, status: null };
      for (;;) {
        const lido = await lerLinhas(caminho, cache.ate);
        if (lido.reiniciado) cache = { ate: 0, status: null };
        for (const linha of lido.linhas) {
          if (typeof linha.quando !== 'string') continue;
          const atual = cache.status;
          if (linha.evento === 'session.status' && typeof linha.detalhe === 'string') {
            if (atual && linha.quando < atual.quando) continue;
            // O WAHA manda STARTING e WORKING quase juntos ao reconectar, e o n8n pode gravá-los
            // fora de ordem. Um STARTING logo depois (até 3 s) de um WORKING não derruba o status.
            const foraDeOrdem = atual && atual.status === 'WORKING' && linha.detalhe === 'STARTING' &&
              Date.parse(linha.quando) - Date.parse(atual.quando) <= 3000;
            if (!foraDeOrdem) cache.status = { status: linha.detalhe, quando: linha.quando };
          } else if (linha.resultado === 'respondida' && atual && atual.status !== 'WORKING' && linha.quando >= atual.quando) {
            // Uma resposta entregue depois do último status prova que o WhatsApp está conectado.
            cache.status = { status: 'WORKING', quando: linha.quando };
          }
        }
        cache.ate = lido.ate;
        if (lido.fim) break;
      }
      statusPorArquivo.set(nome, cache);
      if (cache.status) return cache.status;
    }
    return null;
  }

  async function erros() {
    const inicio = primeiroDia();
    const lista = [];
    for (const { nome, dia } of await listar('erros')) {
      if (dia < inicio) continue;
      let de = 0;
      for (;;) {
        const lido = await lerLinhas(path.join(pasta, nome), de);
        lista.push(...lido.linhas.filter((l) => typeof l.quando === 'string'));
        de = lido.ate;
        if (lido.fim) break;
      }
    }
    return lista.sort((a, b) => b.quando.localeCompare(a.quando)).slice(0, MAXIMO_ERROS);
  }

  async function limpar() {
    if (!disponivel) return [];
    const limite = primeiroDia();
    const removidos = [];
    for (const { nome, dia } of await listar('conversas')) {
      if (dia >= limite) continue;
      try {
        await fs.unlink(path.join(pasta, nome));
        removidos.push(nome);
      } catch (erro) {
        if (erro.code !== 'ENOENT') throw erro;
      }
    }
    for (const nome of removidos) statusPorArquivo.delete(nome);
    return removidos;
  }

  return { disponivel, retencao, hoje, primeiroDia, conversas, diasComConversas, situacaoDoWhatsApp, erros, limpar };
}

module.exports = { criarRegistros, diaLocal, somarDias, lerLinhas };
