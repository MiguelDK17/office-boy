// Contrato do módulo de PORTAIS (Catho/Indeed): extração determinística da
// listagem com URLs diretas, validação de host e dedupe pela chave canônica.
//
// Cenário que originou o módulo (run de 24/11): o modelo improvisava
// browser_evaluate, copiava refs velhas e clicava na vaga errada; o snapshot da
// listagem tinha 28–34k chars de filtros.

import { describe, it, expect } from 'vitest';
import {
  portalDaUrl,
  portalDoBruto,
  normalizarVagasListadas,
  extrairResultadoEvaluate,
  montarScriptListarVagas,
  montarScriptLerPagina,
  montarScriptLerAvaliacaoIndeed,
  normalizarAvaliacaoEmpresa,
} from '../src/portais';

/** Monta o retorno do MCP como o Playwright devolve (valor JSON-encoded). */
function respostaMcp(payload: unknown): string {
  return `### Result\n${JSON.stringify(JSON.stringify(payload))}\n### Ran Playwright code\n\`\`\`js\nawait page.evaluate(...);\n\`\`\``;
}

describe('portais — identificação', () => {
  it('reconhece Catho, Indeed (inclusive subdomínios) e o resto como genérico', () => {
    expect(portalDaUrl('https://www.catho.com.br/vagas/desenvolvedor-android/')).toBe('catho');
    expect(portalDaUrl('https://catho.com.br/vagas/x')).toBe('catho');
    expect(portalDaUrl('https://br.indeed.com/jobs?q=android')).toBe('indeed');
    expect(portalDaUrl('https://www.linkedin.com/jobs/search/')).toBe('generico');
    expect(portalDaUrl(null)).toBe('generico');
  });

  it('usa o portal declarado pelo script quando presente', () => {
    expect(portalDoBruto({ portal: 'catho' })).toBe('catho');
    expect(portalDoBruto({ portal: 'indeed' })).toBe('indeed');
    expect(portalDoBruto({ portal: 'outro' })).toBe('generico');
    expect(portalDoBruto(null)).toBe('generico');
  });
});

describe('portais — parse do browser_evaluate', () => {
  it('desembrulha o envelope string do MCP', () => {
    const dados = extrairResultadoEvaluate(
      respostaMcp({ portal: 'indeed', vagas: [{ titulo: 'Dev', url: 'https://br.indeed.com/viewjob?jk=abc' }] }),
    );
    expect(dados).toEqual({
      portal: 'indeed',
      vagas: [{ titulo: 'Dev', url: 'https://br.indeed.com/viewjob?jk=abc' }],
    });
  });

  it('aceita retorno que já é objeto JSON (sem envelope)', () => {
    const dados = extrairResultadoEvaluate('### Result\n{"portal":"catho","vagas":[]}\n### Ran Playwright code');
    expect(dados).toEqual({ portal: 'catho', vagas: [] });
  });

  it('falha de forma explícita quando não há seção ### Result', () => {
    expect(() => extrairResultadoEvaluate('ERRO_TOOL: timeout')).toThrow(/### Result/);
  });
});

describe('portais — normalização Catho', () => {
  const bruto = {
    portal: 'catho',
    proxima_pagina: 'https://www.catho.com.br/vagas/desenvolvedor-android/?page=2',
    vagas: [
      {
        portal: 'Catho',
        titulo: '  Desenvolvedor   Android ',
        empresa: 'ACME',
        local: 'Belo Horizonte',
        salario: 'R$ 8.000',
        candidatura_simplificada: false,
        url: 'https://www.catho.com.br/vagas/desenvolvedor-android/123',
      },
      // duplicata pela chave canônica (query/tracking não muda a vaga)
      {
        titulo: 'Desenvolvedor Android (duplicata)',
        url: 'https://www.catho.com.br/vagas/desenvolvedor-android/123?utm_source=x',
      },
      // host estranho: descartado
      { titulo: 'Vaga falsa', url: 'https://evil.example.com/vagas/x/1' },
      // sem título: descartado
      { titulo: '   ', url: 'https://www.catho.com.br/vagas/sem-titulo/2' },
      // http (não https): descartado
      { titulo: 'HTTP', url: 'http://www.catho.com.br/vagas/http/3' },
    ],
  };

  it('mantém só vagas válidas, normaliza texto e deduplica', () => {
    const r = normalizarVagasListadas('catho', bruto, 25);
    expect(r.portal).toBe('catho');
    expect(r.vagas).toHaveLength(1);
    expect(r.vagas[0]).toMatchObject({
      portal: 'Catho',
      titulo: 'Desenvolvedor Android',
      empresa: 'ACME',
      local: 'Belo Horizonte',
      salario: 'R$ 8.000',
      url: 'https://www.catho.com.br/vagas/desenvolvedor-android/123',
    });
    expect(r.proxima_pagina).toBe('https://www.catho.com.br/vagas/desenvolvedor-android/?page=2');
  });

  it('respeita o limite pedido', () => {
    const muitas = {
      portal: 'catho',
      vagas: Array.from({ length: 10 }, (_, i) => ({
        titulo: `Vaga ${i}`,
        url: `https://www.catho.com.br/vagas/vaga-${i}/${i}`,
      })),
    };
    expect(normalizarVagasListadas('catho', muitas, 3).vagas).toHaveLength(3);
    // teto duro de 50
    const gigante = {
      portal: 'catho',
      vagas: Array.from({ length: 80 }, (_, i) => ({
        titulo: `Vaga ${i}`,
        url: `https://www.catho.com.br/vagas/vaga-${i}/${i}`,
      })),
    };
    expect(normalizarVagasListadas('catho', gigante, 999).vagas).toHaveLength(50);
  });
});

describe('portais — normalização Indeed', () => {
  const bruto = {
    portal: 'indeed',
    vagas: [
      {
        portal: 'Indeed',
        titulo: 'Android Developer - Remote',
        empresa: 'Guarana',
        local: 'Home Office in São Paulo, SP',
        salario: 'R$ 13.000 por mês',
        candidatura_simplificada: true,
        url: 'https://br.indeed.com/viewjob?jk=365053259027c8b4',
      },
      // URL de busca não é vaga: descartada
      { titulo: 'Busca', url: 'https://br.indeed.com/jobs?q=android&vjk=abc' },
      // viewjob sem jk: descartada
      { titulo: 'Sem jk', url: 'https://br.indeed.com/viewjob' },
      // host não-Indeed: descartada
      { titulo: 'Outro', url: 'https://example.com/viewjob?jk=abc' },
    ],
  };

  it('aceita só /viewjob com jk do host Indeed', () => {
    const r = normalizarVagasListadas('indeed', bruto, 25);
    expect(r.vagas).toHaveLength(1);
    expect(r.vagas[0]).toMatchObject({
      titulo: 'Android Developer - Remote',
      empresa: 'Guarana',
      candidatura_simplificada: true,
      avaliacao_empresa: null,
      url: 'https://br.indeed.com/viewjob?jk=365053259027c8b4',
    });
  });

  it('normaliza a avaliação da empresa e preserva a trava de 2,5', () => {
    expect(normalizarAvaliacaoEmpresa('4.0')).toBe(4);
    expect(normalizarAvaliacaoEmpresa('2,5')).toBe(2.5);
    expect(normalizarAvaliacaoEmpresa('6.0')).toBeNull();
    const r = normalizarVagasListadas('indeed', {
      portal: 'indeed',
      vagas: [{ titulo: 'Vaga ruim', empresa: 'Empresa ruim', avaliacao_empresa: '2,5', url: 'https://br.indeed.com/viewjob?jk=ruim' }],
    });
    expect(r.vagas[0].avaliacao_empresa).toBe(2.5);
    expect(r.vagas[0].avaliacao_empresa !== null && r.vagas[0].avaliacao_empresa <= 2.5).toBe(true);
  });

  it('lista vazia/portal genérico não explode', () => {
    expect(normalizarVagasListadas('generico', { vagas: [] }, 10).vagas).toEqual([]);
    expect(normalizarVagasListadas('indeed', null, 10).vagas).toEqual([]);
    expect(normalizarVagasListadas('indeed', { portal: 'x', vagas: 'nada' }, 10).vagas).toEqual([]);
  });
});

describe('portais — scripts injetados na página', () => {
  it('o script da lista cobre Catho (article) e Indeed (data-jk)', () => {
    const script = montarScriptListarVagas(15);
    expect(script).toContain('LIMITE = 15');
    expect(script).toContain("querySelectorAll('article')");
    expect(script).toContain("querySelectorAll('[data-jk]')");
    expect(script).toContain('getBoundingClientRect().height');
    expect(script).toContain('https://br.indeed.com/viewjob?jk=');
    // nunca monta URL http://
    expect(script).not.toMatch(/['"]http:\/\//);
  });

  it('o script de leitura devolve url/título/texto visível', () => {
    const script = montarScriptLerPagina();
    expect(script).toContain('location.href');
    expect(script).toContain('document.title');
    expect(script).toContain('innerText');
  });

  it('o script de avaliação lê nota ao lado da estrela na página do Indeed', () => {
    const script = montarScriptLerAvaliacaoIndeed();
    expect(script).toContain('aria-label');
    expect(script).toContain('star|estrelas?');
    expect(script).toContain('avaliacao_empresa');
  });
});
