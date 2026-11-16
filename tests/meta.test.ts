// Contrato da META DE QUALIDADE: candidaturas registradas com score >= mínimo
// contadas de forma determinística no gate de registrar_candidatura; ao
// atingir META_CANDIDATURAS, o run encerra com SUCESSO (recovery limpo) —
// nunca por texto do modelo.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('meta de qualidade — encerramento de sucesso do run', () => {
  const agente = readFileSync(path.resolve(__dirname, '..', 'src', 'agente.ts'), 'utf-8');
  const tools = readFileSync(path.resolve(__dirname, '..', 'src', 'tools.ts'), 'utf-8');
  const index = readFileSync(path.resolve(__dirname, '..', 'src', 'index.ts'), 'utf-8');
  const control = readFileSync(path.resolve(__dirname, '..', 'src', 'control-server.ts'), 'utf-8');
  const types = readFileSync(path.resolve(__dirname, '..', 'src', 'types.ts'), 'utf-8');

  it('AgenteConfig declara metaCandidaturas e o index lê META_CANDIDATURAS (default 10, 0 = off)', () => {
    // Cenário + Ação + Validação: config existe e é parseada do .env
    expect(types).toMatch(/metaCandidaturas:\s*number/);
    expect(index).toMatch(/META_CANDIDATURAS/);
    expect(index).toMatch(/metaCandidaturas:\s*Math\.max\(parseInt\(process\.env\.META_CANDIDATURAS \?\? '10'/);
  });

  it('a contagem é DETERMINÍSTICA, no gate de registrar_candidatura (após o gate de score)', () => {
    // Cenário + Ação + Validação: incrementa só em registro válido (score já
    // garantido pelo gate), vale para produção e dry-run
    expect(tools).toContain('candidaturasQualidade++');
    expect(tools).toMatch(/if \(config\.metaCandidaturas > 0\)/);
    const gate = tools.indexOf('SCORE_ABAIXO_DO_MINIMO');
    const contador = tools.indexOf('candidaturasQualidade++');
    expect(gate).toBeGreaterThan(-1);
    expect(contador).toBeGreaterThan(gate);
  });

  it('o executor sinaliza metaAtingida e o loop do agente encerra com SUCESSO na fronteira', () => {
    // Cenário + Ação + Validação: sinal via SinaisDoExecutor; break com
    // respostaFinal de sucesso e recovery LIMPO (run completo)
    expect(tools).toMatch(/SinaisDoExecutor/);
    expect(tools).toMatch(/sinais\.metaAtingida = true/);
    expect(agente).toMatch(/const sinais = \{ metaAtingida: false \}/);
    expect(agente).toMatch(/if \(sinais\.metaAtingida\) \{[\s\S]*?limparRecovery\(\);\s*\n\s*break;/);
    expect(agente).toMatch(/meta de \$\{config\.metaCandidaturas\} candidatura\(s\) de qualidade atingida/);
  });

  it('o system prompt diz que TEXTO PURO não encerra e a meta é do sistema', () => {
    // Cenário + Ação + Validação: prompt coerente com a nova regra
    expect(agente).toMatch(/TEXTO PURO NUNCA encerra a execucao/);
    expect(agente).toMatch(/o SISTEMA encerra a execucao automaticamente/);
  });

  it('o control server expõe a meta na UI e sobrescreve via env do filho', () => {
    // Cenário + Ação + Validação: PADRAO do .env, saneia 0..1000, env override
    expect(control).toMatch(/PADRAO_META_CANDIDATURAS/);
    expect(control).toMatch(/function saneiaMetaCandidaturas/);
    expect(control).toMatch(/META_CANDIDATURAS: String\(meta\)/);
    expect(control).toMatch(/metaCandidaturasPadrao: PADRAO_META_CANDIDATURAS/);
  });
});
