// Suporte dedicado a PORTAIS DE VAGA (Catho, Indeed, ...).
//
// Por que existe: nesses portais a listagem é uma SPA pesada. O
// `browser_snapshot` devolve 28–34 mil caracteres — quase tudo filtros de
// busca, banners e navegação — e os cards do Indeed são <button> sem href.
// O modelo então improvisa `browser_evaluate`, copia refs velhas e clica na
// vaga errada (run de 24/11: clicou em "Analista de Requisitos" quando queria
// "Desenvolvedor Flutter Jr.").
//
// Aqui a extração é DETERMINÍSTICA: um único `browser_evaluate` devolve a
// lista limpa {titulo, empresa, local, salario, url, candidatura} com URL
// DIRETA de cada vaga. O modelo navega direto para a URL, sem depender de
// refs da listagem.

import { chaveVaga } from './chave-vaga.js';

export type PortalId = 'catho' | 'indeed' | 'generico';

export interface VagaListada {
  portal: string;
  titulo: string;
  empresa: string;
  local: string;
  salario: string;
  candidatura_simplificada: boolean;
  /** Nota pública da empresa no portal, quando disponível na listagem. */
  avaliacao_empresa: number | null;
  url: string;
}

export interface ListaVagasNormalizada {
  portal: PortalId;
  vagas: VagaListada[];
  proxima_pagina: string;
}

const MAX_TITULO = 240;
const MAX_CAMPO = 160;

/** Identifica o portal pela URL da aba atual. */
export function portalDaUrl(url: string | null | undefined): PortalId {
  if (!url) return 'generico';
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return 'generico';
  }
  if (host === 'catho.com.br' || host.endsWith('.catho.com.br')) return 'catho';
  if (host === 'indeed.com' || host.endsWith('.indeed.com')) return 'indeed';
  return 'generico';
}

function limparTexto(valor: unknown, max = MAX_CAMPO): string {
  if (typeof valor !== 'string') return '';
  return valor.replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Normaliza uma nota pública de empresa para a escala 0..5. */
export function normalizarAvaliacaoEmpresa(valor: unknown): number | null {
  if (typeof valor === 'number') {
    return Number.isFinite(valor) && valor >= 0 && valor <= 5 ? valor : null;
  }
  if (typeof valor !== 'string') return null;
  const match = valor.trim().replace(',', '.').match(/(?:^|\s)([0-5](?:\.\d)?)(?:\s|$)/);
  if (!match) return null;
  const nota = Number(match[1]);
  return Number.isFinite(nota) && nota >= 0 && nota <= 5 ? nota : null;
}

function urlValidaParaPortal(portal: PortalId, bruto: unknown): string {
  if (typeof bruto !== 'string') return '';
  let url: URL;
  try {
    url = new URL(bruto);
  } catch {
    return '';
  }
  // Só https: links relativos/estranhos vindos da página são descartados.
  if (url.protocol !== 'https:') return '';
  const host = url.hostname.toLowerCase();
  if (portal === 'catho') {
    if (!(host === 'catho.com.br' || host.endsWith('.catho.com.br'))) return '';
    if (!url.pathname.includes('/vagas/')) return '';
  } else if (portal === 'indeed') {
    if (!(host === 'indeed.com' || host.endsWith('.indeed.com'))) return '';
    if (!url.pathname.startsWith('/viewjob')) return '';
    if (!url.searchParams.get('jk')) return '';
  }
  return url.href;
}

function urlDaMesmaPagina(portal: PortalId, bruto: unknown): string {
  if (typeof bruto !== 'string') return '';
  try {
    const url = new URL(bruto);
    if (url.protocol !== 'https:') return '';
    const host = url.hostname.toLowerCase();
    if (portal === 'catho' && !(host === 'catho.com.br' || host.endsWith('.catho.com.br'))) return '';
    if (portal === 'indeed' && !(host === 'indeed.com' || host.endsWith('.indeed.com'))) return '';
    return url.href;
  } catch {
    return '';
  }
}

/**
 * Normaliza a saída bruta do `browser_evaluate` (`{vagas: [...]}`) para o
 * contrato da tool `listar_vagas`.
 *
 * Regras de segurança/qualidade:
 * - só https e host do portal (nunca confia cegamente no DOM);
 * - título obrigatório;
 * - dedupe pela chave canônica da vaga (mesma usada pelo banco);
 * - respeita o limite pedido.
 */
/** Portal declarado pelo próprio script (evita depender de qual aba o CDP lista primeiro). */
export function portalDoBruto(bruto: unknown): PortalId {
  const valor = bruto && typeof bruto === 'object'
    ? (bruto as Record<string, unknown>).portal
    : '';
  return valor === 'catho' || valor === 'indeed' ? valor : 'generico';
}

export function normalizarVagasListadas(
  portal: PortalId,
  bruto: unknown,
  limite = 25,
): ListaVagasNormalizada {
  const max = Math.max(1, Math.min(50, Math.floor(Number.isFinite(limite) ? limite : 25)));
  const declarado = portalDoBruto(bruto);
  const efetivo: PortalId = declarado !== 'generico' ? declarado : portal;
  if (efetivo === 'generico') return { portal: 'generico', vagas: [], proxima_pagina: '' };

  const objeto = (bruto && typeof bruto === 'object' ? bruto : {}) as Record<string, unknown>;
  const lista = Array.isArray(objeto.vagas) ? objeto.vagas : [];

  const vagas: VagaListada[] = [];
  const vistos = new Set<string>();

  for (const item of lista) {
    if (!item || typeof item !== 'object') continue;
    const v = item as Record<string, unknown>;
    const url = urlValidaParaPortal(efetivo, v.url);
    if (!url) continue;

    const titulo = limparTexto(v.titulo, MAX_TITULO);
    if (!titulo) continue;

    const chave = chaveVaga(url);
    if (vistos.has(chave)) continue;
    vistos.add(chave);

    vagas.push({
      portal: limparTexto(v.portal) || (efetivo === 'catho' ? 'Catho' : 'Indeed'),
      titulo,
      empresa: limparTexto(v.empresa),
      local: limparTexto(v.local),
      salario: limparTexto(v.salario),
      candidatura_simplificada: v.candidatura_simplificada === true,
      avaliacao_empresa: normalizarAvaliacaoEmpresa(v.avaliacao_empresa),
      url,
    });
    if (vagas.length >= max) break;
  }

  return {
    portal: efetivo,
    vagas,
    proxima_pagina: urlDaMesmaPagina(efetivo, objeto.proxima_pagina),
  };
}

/**
 * Script executado DENTRO da página (via MCP `browser_evaluate`).
 *
 * Mantido como função geradora para o limite ser interpolado com segurança.
 * `String.raw` preserva os backslashes das regexes (sem escape duplo).
 */
export function montarScriptListarVagas(limite = 25): string {
  const max = Math.max(1, Math.min(50, Math.floor(Number.isFinite(limite) ? limite : 25)));
  return String.raw`async () => {
  const LIMITE = ${max};
  const limpar = (t) => (t || '').replace(/\s+/g, ' ').trim();
  const abs = (h) => { try { return new URL(h, location.origin).href; } catch (e) { return ''; } };
  const host = location.hostname.toLowerCase();
  const portal = host.indexOf('catho.com.br') !== -1 ? 'catho' : host.indexOf('indeed.') !== -1 ? 'indeed' : 'generico';
  const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

  // A listagem é SPA e monta os cards depois do load. Sem esta espera, a
  // primeira leitura logo após o navigate voltava vazia/incompleta (o modelo
  // então desistia ou caía no snapshot gigante).
  if (portal !== 'generico') {
    const seletor = portal === 'catho' ? 'article' : '[data-jk]';
    const minimo = portal === 'catho' ? 3 : 4;
    const inicio = Date.now();
    while (Date.now() - inicio < 7000 && document.querySelectorAll(seletor).length < minimo) {
      await dormir(400);
    }
  }

  const out = [];
  const vistos = new Set();
  const push = (v) => {
    if (!v.url || !/^https:\/\//i.test(v.url) || vistos.has(v.url)) return;
    vistos.add(v.url);
    out.push(v);
  };
  const prox = document.querySelector('a[rel="next"], a[aria-label*="Próxima"], a[aria-label*="Next"], a[title*="Próxima"], a[title*="Next"]');

  if (host.indexOf('catho.com.br') !== -1) {
    for (const card of document.querySelectorAll('article')) {
      const link = card.querySelector('a[href*="/vagas/"]');
      if (!link) continue;
      const ps = Array.from(card.querySelectorAll('p')).map((p) => limpar(p.innerText)).filter(Boolean);
      const local = ps.find((p) => /\bvagas?\b\s*-/i.test(p)) || '';
      push({
        portal: 'Catho',
        titulo: limpar(card.querySelector('h2') ? card.querySelector('h2').innerText : '') || limpar(link.innerText),
        empresa: ps.find((p) => !/R\$|a combinar|\bvagas?\b\s*-|publicada|atualizada/i.test(p)) || '',
        local: local.replace(/^.*?-\s*/, ''),
        salario: ps.find((p) => /R\$|a combinar/i.test(p)) || '',
        candidatura_simplificada: false,
        avaliacao_empresa: null,
        url: abs(link.getAttribute('href')),
      });
      if (out.length >= LIMITE) break;
    }
  } else if (host.indexOf('indeed.') !== -1) {
    for (const el of document.querySelectorAll('[data-jk]')) {
      const jk = el.getAttribute('data-jk');
      if (!jk) continue;
      const card = el.closest('li') || el;
      // Cards de layout/virtualização do Indeed têm altura 0 e chaves
      // fictícias (456789abcdef0123...). Nunca são vagas reais.
      const altura = card.getBoundingClientRect ? card.getBoundingClientRect().height : 0;
      if (altura < 20) continue;
      const txt = limpar(card.innerText);
      push({
        portal: 'Indeed',
        titulo: limpar(card.querySelector('h3') ? card.querySelector('h3').innerText : ''),
        empresa: limpar(card.querySelector('[data-testid="company-name"]') ? card.querySelector('[data-testid="company-name"]').innerText : ''),
        local: limpar(card.querySelector('[data-testid="text-location"]') ? card.querySelector('[data-testid="text-location"]').innerText : ''),
        salario: (txt.match(/R\$\s?[\d.,]+[^\n]{0,20}/i) || [''])[0],
        candidatura_simplificada: /candidate-se facilmente|candidatura simplificada/i.test(txt),
        avaliacao_empresa: (() => {
          const m = txt.match(/(?:·|•)\s*([0-5](?:[.,]\d)?)\s*(?:★|star|estrelas?)?/i)
            || txt.match(/([0-5](?:[.,]\d)?)\s*(?:★|star|estrelas?)/i);
          return m ? Number(m[1].replace(',', '.')) : null;
        })(),
        url: 'https://br.indeed.com/viewjob?jk=' + encodeURIComponent(jk),
      });
      if (out.length >= LIMITE) break;
    }
  }

  return JSON.stringify({
    portal: portal,
    host: host,
    total: out.length,
    proxima_pagina: prox ? prox.href : '',
    vagas: out,
  });
}`;
}

/** Script que devolve a URL/título/texto visível da aba atual. */
export function montarScriptLerPagina(): string {
  return String.raw`() => ({
  url: location.href,
  title: document.title,
  texto: (document.body ? document.body.innerText : '').slice(0, 8000),
})`;
}

/** Script que lê a nota pública da empresa na página de detalhe do Indeed. */
export function montarScriptLerAvaliacaoIndeed(): string {
  return String.raw`() => {
  const texto = (document.body ? document.body.innerText : '').replace(/\s+/g, ' ');
  const candidatos = [
    ...Array.from(document.querySelectorAll('[aria-label], [title]')).flatMap((el) => [
      el.getAttribute('aria-label') || '',
      el.getAttribute('title') || '',
    ]),
    ...Array.from(document.querySelectorAll('[data-testid*="rating" i], [data-testid*="star" i]')).map((el) => el.textContent || ''),
    texto,
  ];
  for (const valor of candidatos) {
    const m = valor.match(/(?:·|•)\s*([0-5](?:[.,]\d)?)\s*(?:★|star|estrelas?)/i)
      || valor.match(/(?:·|•)\s*([0-5](?:[.,]\d)?)\s*(?:★|star|estrelas?)?/i)
      || valor.match(/([0-5](?:[.,]\d)?)\s*(?:★|star|estrelas?)/i);
    if (m) {
      const nota = Number(m[1].replace(',', '.'));
      if (Number.isFinite(nota) && nota >= 0 && nota <= 5) return JSON.stringify({ portal: 'indeed', avaliacao_empresa: nota });
    }
  }
  return JSON.stringify({ portal: 'indeed', avaliacao_empresa: null });
}`;
}

/**
 * Extrai o valor devolvido por `browser_evaluate` do texto do MCP.
 *
 * O Playwright MCP responde:
 *   ### Result
 *   "{\"vagas\":[...]}"      <- o valor vem JSON-encoded como string
 *   ### Ran Playwright code
 *
 * Faz o parse em duas camadas (envelope + string interna) e devolve o objeto.
 */
export function extrairResultadoEvaluate(texto: string): unknown {
  const match = String(texto).match(/### Result\s*\n([\s\S]*?)(?:\n### Ran Playwright code|$)/);
  if (!match) throw new Error('browser_evaluate nao retornou a secao ### Result');
  const bruto = match[1].trim();
  if (!bruto) throw new Error('browser_evaluate retornou resultado vazio');

  let valor: unknown;
  try {
    valor = JSON.parse(bruto);
  } catch {
    return bruto;
  }
  // Envelope string → parse da string interna (JSON.stringify feito na página).
  if (typeof valor === 'string') {
    try {
      return JSON.parse(valor);
    } catch {
      return valor;
    }
  }
  return valor;
}
