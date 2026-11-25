import { describe, expect, it } from 'vitest';
import {
  analisePodeLiberar,
  chaveAnalise,
  montarScriptAnalisarDescricao,
  normalizarAnaliseDescricao,
} from '../src/descricao-vaga';

describe('análise determinística da descrição da vaga', () => {
  const url = 'https://empresa.gupy.io/job/eyJqb2JJZCI6MTIzfQ==';

  it('normaliza a evidência e cria chave/hash estáveis da vaga', () => {
    const a = normalizarAnaliseDescricao({
      url, titulo: ' Dev Java ', empresa: 'ACME',
      descricao: 'x'.repeat(100), secoes: { Requisitos: 'Java e APIs' }, confianca: 0.9,
    });
    expect(a.portal).toBe('gupy');
    expect(a.chave).toBe(chaveAnalise(url, 'Dev Java', 'ACME'));
    expect(a.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(analisePodeLiberar(a, url, 'Dev Java', 'ACME')).toBe(true);
  });

  it('bloqueia evidência insuficiente ou com aviso de termo bloqueado', () => {
    const a = normalizarAnaliseDescricao({
      url, titulo: 'Dev', empresa: 'ACME', descricao: 'curta', confianca: 1,
      avisos: ['TERMO_BLOQUEADO'],
    });
    expect(analisePodeLiberar(a, url, 'Dev', 'ACME')).toBe(false);
    expect(analisePodeLiberar(a, url.replace('123', '999'), 'Dev', 'ACME')).toBe(false);
  });

  it('gera um extrator por contêiner e não usa body.innerText como fonte', () => {
    const script = montarScriptAnalisarDescricao();
    expect(script).toContain('#jobDescriptionText');
    expect(script).toContain('.jobs-description__content');
    expect(script).toContain('document.querySelector');
    expect(script).not.toContain('document.body.innerText');
  });
});
