// Chave canônica da vaga — dedup por ID do portal, não por URL com tracking.

import { describe, expect, it } from 'vitest';
import { chaveVaga, urlCanonica } from '../src/chave-vaga';

describe('chaveVaga', () => {
  it('LinkedIn: ignora refId/trackingId/companyName', () => {
    const base = 'https://www.linkedin.com/jobs/view/4490649725/';
    const comTracking = 'https://www.linkedin.com/jobs/view/4490649725/?companyName=Jobgether&refId=8%2FFkPZICNlgKiTOYlVspNQ%3D%3D&trackingId=abc';
    expect(chaveVaga(base)).toBe('linkedin:4490649725');
    expect(chaveVaga(comTracking)).toBe('linkedin:4490649725');
    expect(chaveVaga('https://linkedin.com/jobs/search-results/?currentJobId=4490649725'))
      .toBe('linkedin:4490649725');
  });

  it('Gupy: extrai jobId do base64 e unifica URL de busca com/sem tracking', () => {
    // {"jobId":6312133,"source":"gupy_portal"}
    const job = Buffer.from('{"jobId":6312133,"source":"gupy_portal"}').toString('base64');
    const a = `https://institutoeldorado.gupy.io/job/${job}?jobBoardSource=gupy_portal`;
    const b = `https://institutoeldorado.gupy.io/job/${job}`;
    expect(chaveVaga(a)).toBe('gupy:6312133');
    expect(chaveVaga(b)).toBe('gupy:6312133');
  });

  it('Gupy: /candidates/jobs/<id>/apply usa o MESMO jobId da URL da vaga', () => {
    const vaga = 'https://institutoeldorado.gupy.io/candidates/jobs/6312133/apply';
    expect(chaveVaga(vaga)).toBe('gupy:6312133');
  });

  it('Gupy: URL de etapa do formulário recebe chave própria (não some)', () => {
    const etapa = 'https://institutoeldorado.gupy.io/candidates/applications/776016775/steps/4384840149/curriculum';
    expect(chaveVaga(etapa)).toBe('gupy-app:776016775');
  });

  it('Indeed e portais genéricos', () => {
    expect(chaveVaga('https://br.indeed.com/viewjob?jk=abc123&vjk=xyz'))
      .toBe('indeed:abc123');
    expect(chaveVaga('https://www.catho.com.br/vagas/desenvolvedor-android/?utm_source=x'))
      .toBe('url:catho.com.br/vagas/desenvolvedor-android');
    expect(chaveVaga('https://site.com.br/vaga?id=111')).not.toBe(
      chaveVaga('https://site.com.br/vaga?id=222'),
    );
  });

  it('URL inválida não quebra', () => {
    expect(chaveVaga('')).toBe('bruto:');
    expect(chaveVaga('nao-e-url')).toBe('bruto:nao-e-url');
  });
});

describe('urlCanonica', () => {
  it('remove tracking e barra final, preservando o caminho', () => {
    expect(urlCanonica('https://www.linkedin.com/jobs/view/4490649725/?refId=abc&trackingId=x'))
      .toBe('https://www.linkedin.com/jobs/view/4490649725');
  });
});
