// Contrato da API POR SITE (/api/sites/:id/*) e da migração de ids.
// Cobre a validação de URLs (https-only, limites, duplicatas normalizadas),
// a geração de UUIDs e a guarda de escrita local.

import { describe, it, expect } from 'vitest';
import { randomUUID } from 'crypto';
import { garantirIdsSites } from '../src/site-ids';
import {
  MAX_CARACTERES_URL,
  MAX_URLS_POR_SITE,
  normalizarUrlParaComparacao,
  origemLocalPermitida,
  validarUrls,
} from '../src/sites-api';
import type { IncomingMessage } from 'http';

describe('garantirIdsSites — UUID estável', () => {
  it('adiciona UUID em todo site sem id e não altera os demais campos', () => {
    const entrada = [
      { nome: 'Gupy', urls_busca: [] as string[], ativo: true },
      { nome: 'LinkedIn', urls_busca: [], ativo: false },
    ];
    const { sites, mudou } = garantirIdsSites(entrada);
    expect(mudou).toBe(true);
    expect(sites).toHaveLength(2);
    for (const site of sites) {
      expect(typeof site.id).toBe('string');
      expect((site.id as string).length).toBeGreaterThanOrEqual(32);
    }
    expect(sites[0].nome).toBe('Gupy');
    expect(sites[1].ativo).toBe(false);
    expect(new Set(sites.map((s) => s.id)).size).toBe(2);
  });

  it('preserva ids existentes e é idempotente', () => {
    const id = randomUUID();
    const entrada = [{ id, nome: 'Gupy' }];
    const primeira = garantirIdsSites(entrada);
    expect(primeira.mudou).toBe(false);
    expect(primeira.sites[0].id).toBe(id);
    const segunda = garantirIdsSites(primeira.sites);
    expect(segunda.mudou).toBe(false);
    expect(segunda.sites[0].id).toBe(id);
  });

  it('regenera id repetido ou vazio (dois sites não podem ter o mesmo id)', () => {
    const id = randomUUID();
    const { sites, mudou } = garantirIdsSites([
      { id, nome: 'A' },
      { id, nome: 'B' },
      { id: '  ', nome: 'C' },
    ]);
    expect(mudou).toBe(true);
    expect(sites[0].id).toBe(id);
    expect(sites[1].id).not.toBe(id);
    expect(sites[2].id).not.toBe(id);
    expect(new Set(sites.map((s) => s.id)).size).toBe(3);
  });
});

describe('validarUrls — https-only, limites e duplicatas', () => {
  it('aceita https válidas, faz trim e preserva a ordem', () => {
    const r = validarUrls([
      '  https://portal.gupy.io/job-search/term=Android  ',
      'https://www.linkedin.com/jobs/search/?keywords=Kotlin',
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.urls).toEqual([
      'https://portal.gupy.io/job-search/term=Android',
      'https://www.linkedin.com/jobs/search/?keywords=Kotlin',
    ]);
  });

  it.each([
    'http://example.com/',
    'javascript:alert(1)',
    'file:///etc/passwd',
    'data:text/html,<h1>x</h1>',
    'ftp://example.com/',
    'nao-e-url',
    'https://exa mple.com/',
  ])('rejeita esquema/URL perigosa ou inválida: %s', (url) => {
    const r = validarUrls([url]);
    expect(r.ok).toBe(false);
  });

  it('rejeita vazia e URL acima do limite de caracteres', () => {
    const longa = `https://example.com/${'a'.repeat(MAX_CARACTERES_URL)}`;
    const r = validarUrls(['   ', longa]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.erros.map((e) => e.indice)).toEqual([0, 1]);
    expect(r.erros[1].motivo).toContain(String(MAX_CARACTERES_URL));
  });

  it('rejeita mais de MAX_URLS_POR_SITE', () => {
    const lista = Array.from({ length: MAX_URLS_POR_SITE + 1 }, (_, i) => `https://example.com/${i}`);
    const r = validarUrls(lista);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.mensagem).toContain(String(MAX_URLS_POR_SITE));
  });

  it('rejeita duplicata normalizada (host/caixa/porta/barra final)', () => {
    const r = validarUrls([
      'https://EXAMPLE.com:443/vagas',
      'https://example.com/vagas/',
    ]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.erros).toEqual([
      { indice: 1, motivo: 'URL duplicada (igual à de posição 1)' },
    ]);
  });

  it('aceita mesma URL com query diferente (buscas distintas)', () => {
    const r = validarUrls([
      'https://example.com/vagas?term=android',
      'https://example.com/vagas?term=kotlin',
    ]);
    expect(r.ok).toBe(true);
  });

  it('body que não é lista é rejeitado', () => {
    expect(validarUrls('https://example.com').ok).toBe(false);
    expect(validarUrls({ urls: [] }).ok).toBe(false);
    expect(validarUrls(null).ok).toBe(false);
  });
});

describe('normalizarUrlParaComparacao', () => {
  it('normaliza caixa do host, porta padrão e barra final', () => {
    expect(normalizarUrlParaComparacao('https://EXAMPLE.com:443')).toBe('https://example.com/');
    expect(normalizarUrlParaComparacao('https://example.com/')).toBe('https://example.com/');
  });

  it('devolve null para http e para lixo', () => {
    expect(normalizarUrlParaComparacao('http://example.com/')).toBeNull();
    expect(normalizarUrlParaComparacao('javascript:alert(1)')).toBeNull();
  });
});

describe('origemLocalPermitida — escrita só de localhost', () => {
  const req = (headers: Record<string, string>) => ({ headers }) as unknown as IncomingMessage;

  it('aceita Host local (com e sem porta) e Origin local', () => {
    expect(origemLocalPermitida(req({ host: 'localhost:1717' }))).toBe(true);
    expect(origemLocalPermitida(req({ host: '127.0.0.1:3000' }))).toBe(true);
    expect(origemLocalPermitida(req({ host: '[::1]:1717' }))).toBe(true);
    expect(
      origemLocalPermitida(req({ host: 'localhost:1717', origin: 'http://localhost:5173' })),
    ).toBe(true);
    expect(
      origemLocalPermitida(req({ host: '127.0.0.1:1717', origin: 'http://127.0.0.1:5173' })),
    ).toBe(true);
  });

  it('rejeita Host remoto, Origin remoto, Origin inválido e Host ausente', () => {
    expect(origemLocalPermitida(req({ host: '192.168.0.10:1717' }))).toBe(false);
    expect(origemLocalPermitida(req({ host: 'evil.example:1717' }))).toBe(false);
    expect(
      origemLocalPermitida(req({ host: 'localhost:1717', origin: 'https://evil.example' })),
    ).toBe(false);
    expect(
      origemLocalPermitida(req({ host: 'localhost:1717', origin: 'nao-e-origin' })),
    ).toBe(false);
    expect(origemLocalPermitida(req({}))).toBe(false);
  });
});
