// Validação de URLs de busca — fonte ÚNICA das regras, usada tanto nas rotas
// por site (sites-api.ts) quanto no PUT legado de config (config-api.ts).
// O front espelha estas mesmas regras em SiteUrlsDialog.tsx.

export const MAX_URLS_POR_SITE = 50;
export const MAX_CARACTERES_URL = 2048;

export interface ErroValidacaoUrl {
  indice: number;
  motivo: string;
}

type ResultadoValidacao =
  | { ok: true; urls: string[] }
  | { ok: false; mensagem: string; erros: ErroValidacaoUrl[] };

/**
 * Forma canônica usada SÓ para comparar duplicatas (não é o que se grava):
 * host/scheme em minúsculas, porta padrão removida e barras finais do caminho
 * ignoradas. Query e hash continuam fazendo parte da identidade — buscas com
 * filtros diferentes são URLs diferentes. O caminho é case-sensitive (RFC).
 */
export function normalizarUrlParaComparacao(url: string): string | null {
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol !== 'https:') return null;
    const caminho = parsed.pathname.replace(/\/+$/, '') || '/';
    return `${parsed.protocol}//${parsed.host}${caminho}${parsed.search}${parsed.hash}`;
  } catch {
    return null;
  }
}

export function validarUrls(entrada: unknown): ResultadoValidacao {
  if (!Array.isArray(entrada)) {
    return { ok: false, mensagem: 'Body precisa de { urls: [...] }', erros: [] };
  }
  if (entrada.length > MAX_URLS_POR_SITE) {
    return {
      ok: false,
      mensagem: `Máximo de ${MAX_URLS_POR_SITE} URLs por site`,
      erros: [],
    };
  }

  const erros: ErroValidacaoUrl[] = [];
  const urls: string[] = [];
  const vistos = new Map<string, number>();

  entrada.forEach((item, indice) => {
    if (typeof item !== 'string') {
      erros.push({ indice, motivo: 'URL precisa ser texto' });
      return;
    }
    const url = item.trim();
    if (!url) {
      erros.push({ indice, motivo: 'URL vazia' });
      return;
    }
    if (url.length > MAX_CARACTERES_URL) {
      erros.push({ indice, motivo: `URL muito longa (máx. ${MAX_CARACTERES_URL} caracteres)` });
      return;
    }
    if (/[\s\u0000-\u001f\u007f]/.test(url)) {
      erros.push({ indice, motivo: 'URL não pode conter espaços nem caracteres de controle' });
      return;
    }
    const chave = normalizarUrlParaComparacao(url);
    if (!chave) {
      erros.push({ indice, motivo: 'Use uma URL https:// válida' });
      return;
    }
    const anterior = vistos.get(chave);
    if (anterior !== undefined) {
      erros.push({ indice, motivo: `URL duplicada (igual à de posição ${anterior + 1})` });
      return;
    }
    vistos.set(chave, indice);
    urls.push(url);
  });

  if (erros.length > 0) {
    return {
      ok: false,
      mensagem: erros.length === 1 ? '1 URL inválida' : `${erros.length} URLs inválidas`,
      erros,
    };
  }
  return { ok: true, urls };
}
