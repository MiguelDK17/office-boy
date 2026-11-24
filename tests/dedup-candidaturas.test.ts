// Regressão: a mesma vaga com URLs diferentes (tracking / etapa do formulário)
// não pode gerar duas candidaturas nem ser reanalisada após reprovação.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import {
  inicializarBanco,
  fecharBanco,
  registrarCandidatura,
  verificarJaAplicou,
  registrarVagaVista,
  verificarBloqueioPermanente,
  confirmarRegistroPendente,
  removerPendente,
  listarCandidaturas,
  contarCandidaturasHoje,
} from '../src/database';
import { chaveVaga } from '../src/chave-vaga';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'ob-dedup-'));
  inicializarBanco(path.join(dir, 'candidaturas.db'));
});

afterEach(() => {
  fecharBanco();
  rmSync(dir, { recursive: true, force: true });
});

const vagaComTracking = 'https://www.linkedin.com/jobs/view/4490649725/?refId=abc&companyName=X';
const vagaLimpa = 'https://www.linkedin.com/jobs/view/4490649725/';

describe('deduplicação de candidaturas', () => {
  it('verificarJaAplicou reconhece a mesma vaga com tracking diferente', () => {
    expect(verificarJaAplicou(vagaComTracking)).toBe(false);
    expect(registrarCandidatura({
      plataforma: 'LinkedIn',
      titulo_vaga: 'Android Engineer',
      empresa: 'BairesDev',
      url: vagaLimpa,
      mensagem_enviada: 0,
      status: 'aplicado',
      score: 8,
    })).toBe(true);
    expect(verificarJaAplicou(vagaComTracking)).toBe(true);
    expect(verificarJaAplicou(vagaLimpa)).toBe(true);
  });

  it('insert repetido por chave canônica é ignorado', () => {
    const dados = {
      plataforma: 'LinkedIn',
      titulo_vaga: 'Android Engineer',
      empresa: 'BairesDev',
      url: vagaLimpa,
      mensagem_enviada: 0,
      status: 'aplicado',
      score: 8,
    };
    expect(registrarCandidatura(dados)).toBe(true);
    expect(registrarCandidatura({ ...dados, url: vagaComTracking })).toBe(false);
    expect(listarCandidaturas(10)).toHaveLength(1);
  });
  it('dry-run NÃO conta como candidatura real', () => {
    expect(registrarCandidatura({
      plataforma: 'Gupy', titulo_vaga: 'Simulação', empresa: 'ACME',
      url: 'https://x/simulada', mensagem_enviada: 0, status: 'dry-run', score: 9,
    })).toBe(true);
    expect(verificarJaAplicou('https://x/simulada')).toBe(false);
    // Uma execução real pode candidatar-se de verdade depois.
    expect(registrarCandidatura({
      plataforma: 'Gupy', titulo_vaga: 'Real', empresa: 'ACME',
      url: 'https://x/simulada', mensagem_enviada: 0, status: 'aplicado', score: 9,
    })).toBe(true);
    expect(verificarJaAplicou('https://x/simulada')).toBe(true);
    expect(contarCandidaturasHoje()).toBe(1);
  });

  it('registro pendente pode ser confirmado ou desfeito', () => {
    const dados = {
      plataforma: 'Gupy', titulo_vaga: 'Pendente', empresa: 'ACME',
      url: 'https://x/pendente', mensagem_enviada: 0, status: 'pendente', score: 9,
    };
    expect(registrarCandidatura(dados)).toBe(true);
    expect(verificarJaAplicou(dados.url)).toBe(true); // bloqueia clique duplo
    expect(removerPendente(dados.url)).toBe(true); // clique falhou
    expect(verificarJaAplicou(dados.url)).toBe(false); // vaga liberada de novo
    registrarCandidatura(dados);
    expect(confirmarRegistroPendente(dados.url)).toBe(true);
  });

  it('Gupy: /candidates/jobs/<id>/apply e /job/<base64> são a mesma vaga', () => {
    const base64 = Buffer.from(JSON.stringify({ jobId: 6312133, source: 'gupy_portal' })).toString('base64');
    expect(chaveVaga(`https://empresa.gupy.io/job/${base64}`)).toBe('gupy:6312133');
    expect(chaveVaga('https://empresa.gupy.io/candidates/jobs/6312133/apply')).toBe('gupy:6312133');
    expect(registrarCandidatura({
      plataforma: 'Gupy', titulo_vaga: 'Android', empresa: 'ACME',
      url: `https://empresa.gupy.io/job/${base64}`, mensagem_enviada: 0,
      status: 'aplicado', score: 9,
    })).toBe(true);
    expect(verificarJaAplicou('https://empresa.gupy.io/candidates/jobs/6312133/apply')).toBe(true);
  });
});

describe('reanálise de vagas reprovadas', () => {
  it('bloqueio permanente é reconhecido pela chave da vaga', () => {
    expect(registrarVagaVista({
      url: vagaComTracking,
      titulo_vaga: 'Android Engineer',
      empresa: 'BairesDev',
      plataforma: 'LinkedIn',
      score: 5,
      motivo_pulo: 'PERMANENTE: exige inglês avançado',
    })).toBe(true);
    expect(verificarBloqueioPermanente(vagaLimpa)).toContain('inglês avançado');
    // Tentar reanalisar com outra URL da MESMA vaga não deve registrar de novo.
    expect(registrarVagaVista({
      url: vagaLimpa,
      titulo_vaga: 'Android Engineer',
      empresa: 'BairesDev',
      plataforma: 'LinkedIn',
      score: 9,
    })).toBe(false);
  });
});
