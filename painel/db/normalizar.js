'use strict';

// Normaliza o texto de uma dúvida para agrupar variações: minúsculas, sem acento e sem pontuação.
function normalizarTexto(texto) {
  return String(texto ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Junta linhas { texto, total } cujo texto normalizado é igual e devolve as "limite" mais comuns.
function agruparDuvidas(linhas, limite = 20) {
  const grupos = new Map();
  for (const { texto, total } of linhas) {
    const chave = normalizarTexto(texto);
    if (!chave) continue;
    grupos.set(chave, (grupos.get(chave) || 0) + Number(total));
  }
  return [...grupos.entries()]
    .map(([texto, total]) => ({ texto, total }))
    .sort((a, b) => b.total - a.total || a.texto.localeCompare(b.texto))
    .slice(0, limite);
}

module.exports = { normalizarTexto, agruparDuvidas };
