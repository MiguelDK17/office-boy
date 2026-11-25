import { createHash } from 'node:crypto';

import { chaveVaga } from './chave-vaga.js';

export type PortalDescricao = 'catho' | 'indeed' | 'gupy' | 'linkedin' | 'generico';

export interface AnaliseDescricaoVaga {
  portal: PortalDescricao;
  url: string;
  titulo: string;
  empresa: string;
  localizacao: string;
  modelo_trabalho: string;
  salario: string;
  descricao: string;
  secoes: Record<string, string>;
  confianca: number;
  avisos: string[];
}

export interface RegistroAnaliseDescricao extends AnaliseDescricaoVaga {
  chave: string;
  hash: string;
  analisada_em: string;
}

const MAX_DESCRICAO = 18000;
const MAX_SECAO = 6000;
const MIN_DESCRICAO = 80;

function texto(valor: unknown, max = 500): string {
  return typeof valor === 'string'
    ? valor.replace(/\s+/g, ' ').trim().slice(0, max)
    : '';
}

function portalDaUrl(url: string): PortalDescricao {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host === 'catho.com.br' || host.endsWith('.catho.com.br')) return 'catho';
    if (host === 'indeed.com' || host.endsWith('.indeed.com')) return 'indeed';
    if (host === 'gupy.io' || host.endsWith('.gupy.io')) return 'gupy';
    if (host === 'linkedin.com' || host.endsWith('.linkedin.com')) return 'linkedin';
  } catch { /* URL inválida será reprovada pela confiança. */ }
  return 'generico';
}

function hashAnalise(url: string, titulo: string, empresa: string, descricao: string): string {
  return createHash('sha256')
    .update(`${chaveVaga(url)}\n${titulo.trim().toLocaleLowerCase()}\n${empresa.trim().toLocaleLowerCase()}\n${descricao}`)
    .digest('hex');
}

export function chaveAnalise(url: string, titulo: string, empresa: string): string {
  return `${chaveVaga(url)}|${titulo.trim().toLocaleLowerCase()}|${empresa.trim().toLocaleLowerCase()}`;
}

export function normalizarAnaliseDescricao(raw: unknown, urlEsperada = ''): RegistroAnaliseDescricao {
  const dado = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const url = texto(dado.url, 2000) || urlEsperada;
  const portal = portalDaUrl(url);
  const secoesBrutas = dado.secoes && typeof dado.secoes === 'object' ? dado.secoes as Record<string, unknown> : {};
  const secoes: Record<string, string> = {};
  for (const [nome, valor] of Object.entries(secoesBrutas)) {
    const secao = texto(valor, MAX_SECAO);
    if (secao) secoes[nome] = secao;
  }

  const descricao = texto(dado.descricao, MAX_DESCRICAO);
  const titulo = texto(dado.titulo, 240);
  const empresa = texto(dado.empresa, 240);
  const avisos = Array.isArray(dado.avisos) ? dado.avisos.filter((v): v is string => typeof v === 'string').slice(0, 12) : [];
  let confianca = Number(dado.confianca);
  if (!Number.isFinite(confianca)) confianca = 0;
  confianca = Math.max(0, Math.min(1, confianca));

  if (!url || !titulo) avisos.push('TITULO_OU_URL_AUSENTE');
  if (!empresa) avisos.push('EMPRESA_NAO_IDENTIFICADA');
  if (descricao.length < MIN_DESCRICAO) avisos.push('DESCRICAO_INSUFICIENTE');
  if (portal === 'generico') avisos.push('PORTAL_NAO_RECONHECIDO');

  return {
    portal, url, titulo, empresa,
    localizacao: texto(dado.localizacao, 240),
    modelo_trabalho: texto(dado.modelo_trabalho, 120),
    salario: texto(dado.salario, 160),
    descricao, secoes, confianca, avisos,
    chave: chaveAnalise(url, titulo, empresa),
    hash: hashAnalise(url, titulo, empresa, descricao),
    analisada_em: new Date().toISOString(),
  };
}

export function analisePodeLiberar(analise: RegistroAnaliseDescricao | undefined, url: string, titulo: string, empresa: string, confiancaMinima = 0.65): boolean {
  if (!analise || analise.chave !== chaveAnalise(url, titulo, empresa)) return false;
  if (analise.confianca < confiancaMinima || analise.descricao.length < MIN_DESCRICAO) return false;
  return !analise.avisos.some((aviso) => /AUSENTE|INSUFICIENTE|AMBIGU|NAO_IDENTIFICADA|TERMO_BLOQUEADO|CONTEINER|SEM_SINAIS/.test(aviso));
}

/** Script executado na página atual. Ele nunca usa document.body.innerText como fonte principal. */
export function montarScriptAnalisarDescricao(): string {
  return String.raw`(() => {
  const limpar = (v, max = 6000) => String(v || '').replace(/\\s+/g, ' ').trim().slice(0, max);
  const host = location.hostname.toLowerCase();
  const portal = (host === 'catho.com.br' || host.endsWith('.catho.com.br')) ? 'catho' : (host === 'indeed.com' || host.endsWith('.indeed.com')) ? 'indeed' : host === 'gupy.io' || host.endsWith('.gupy.io') ? 'gupy' : (host === 'linkedin.com' || host.endsWith('.linkedin.com')) ? 'linkedin' : 'generico';
  const avisos = [];
  const ignorar = 'nav, header, footer, aside, [role="navigation"], [role="banner"], [aria-label*="related" i], [aria-label*="recomend" i], .ads, .advertisement, [data-testid*="recommend" i]';
  const textoEl = (el, max = 6000) => { if (!el) return ''; const clone = el.cloneNode(true); clone.querySelectorAll(ignorar).forEach((n) => n.remove()); return limpar(clone.innerText || clone.textContent, max); };
  const meta = (keys) => { for (const key of keys) { const el = document.querySelector('meta[property="' + key + '"], meta[name="' + key + '"]'); if (el?.content) return limpar(el.content, 400); } return ''; };
  const jsonLd = Array.from(document.querySelectorAll('script[type="application/ld+json"]')).map((s) => { try { return JSON.parse(s.textContent || 'null'); } catch (_) { return null; } }).flatMap((v) => Array.isArray(v) ? v : [v]).find((v) => v && (v['@type'] === 'JobPosting' || v.title || v.description)) || {};
  const pick = (selectors) => { for (const selector of selectors) { const el = document.querySelector(selector); const value = textoEl(el, 500); if (value) return value; } return ''; };
  const titulo = limpar(jsonLd.title || meta(['og:title']) || document.querySelector('h1')?.innerText || document.title, 240);
  const empresa = limpar(jsonLd.hiringOrganization?.name || pick(['[data-testid*="company" i]', '[class*="company" i]', '[class*="employer" i]']) || meta(['og:site_name']), 240);
  const localizacao = limpar(jsonLd.jobLocation?.address?.addressLocality || pick(['[data-testid*="location" i]', '[class*="location" i]']), 240);
  const salario = limpar(jsonLd.baseSalary?.value?.value || pick(['[data-testid*="salary" i]', '[class*="salary" i]']), 160);
  let raiz;
  let raizEspecifica = true;
  if (portal === 'linkedin') raiz = document.querySelector('.jobs-description__content, .jobs-box__html-content, [class*="jobs-description" i]');
  else if (portal === 'indeed') raiz = document.querySelector('#jobDescriptionText, [data-testid="jobDescriptionText"], .jobsearch-JobComponent-description');
  else if (portal === 'catho') raiz = document.querySelector('[data-testid*="description" i], [class*="job-description" i], article');
  else if (portal === 'gupy') raiz = document.querySelector('[data-testid*="job" i], [data-testid*="description" i], article');
  else raiz = null;
  if (!raiz && portal !== 'generico') { raiz = document.querySelector('main, [role="main"]'); raizEspecifica = false; }
  if (!raizEspecifica) avisos.push('CONTEINER_GENERICO');
  const secoes = {};
  if (raiz) raiz.querySelectorAll('h2, h3, h4').forEach((h) => { const nome = limpar(h.innerText, 120); if (!nome) return; let n = h.nextElementSibling; const partes = []; while (n && !/^H[1-4]$/.test(n.tagName)) { const t = textoEl(n, 1500); if (t) partes.push(t); n = n.nextElementSibling; } if (partes.length) secoes[nome] = limpar(partes.join(' '), 6000); });
  const descricao = textoEl(raiz, 18000) || limpar(jsonLd.description, 18000);
  const sinais = Object.keys(secoes).length + (/requisit|responsabil|descri|qualifica|sobre a vaga/i.test(descricao) ? 1 : 0);
  let confianca = 0;
  if (titulo) confianca += .2;
  if (empresa) confianca += .15;
  if (descricao.length >= 80) confianca += .4;
  if (Object.keys(secoes).length) confianca += .15;
  if (jsonLd.description) confianca += .1;
  if (sinais === 0) avisos.push('SEM_SINAIS_DE_DESCRICAO');
  if (!raiz && !jsonLd.description) avisos.push('CONTEINER_DA_VAGA_NAO_IDENTIFICADO');
  return { portal, url: location.href, titulo, empresa, localizacao, modelo_trabalho: /remot|h[ií]brid|presencial/i.exec(descricao)?.[0] || '', salario, descricao, secoes, confianca, avisos };
})()`;
}

