// Contrato da guarda anti-abandono: resposta só-texto cedo no run não pode
// encerrar a execução — o controle volta ao modelo com um aviso, com teto de
// nudges e limite de iterações onde a guarda atua.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('guarda anti-abandono', () => {
  const agente = readFileSync(path.resolve(__dirname, '..', 'src', 'agente.ts'), 'utf-8');

  it('recusa a desistência e devolve controle ao modelo (nudge user)', () => {
    // Cenário + Ação + Validação: o bloco de texto-puro empurra um aviso
    expect(agente).toContain('Guarda anti-abandono');
    expect(agente).toMatch(/AVISO_DO_SISTEMA: voce respondeu APENAS TEXTO/);
    expect(agente).toMatch(/continue;\s*\n\s*\}\s*\n\s*log\('AGENTE', `Resposta final do modelo/);
  });

  it('o nudge tem teto (MAX_NUDGES) e limite de iterações (20% do run, clampado)', () => {
    // Cenário + Ação + Validação: nunca nudgear infinitamente
    expect(agente).toContain('MAX_NUDGES_ABANDONO = 2');
    expect(agente).toMatch(/Math\.min\(Math\.max\(Math\.floor\(maxIter \* 0\.2\), 5\), 50\)/);
    expect(agente).toMatch(/nudgesAbandono < MAX_NUDGES_ABANDONO/);
  });

  it('após nudges esgotados, preserva o recovery (desistência ≠ conclusão)', () => {
    // Cenário + Ação + Validação: a próxima run retenta com o aviso de recovery
    expect(agente).toMatch(/if \(nudgesAbandono > 0\) \{\s*\n\s*salvarRecovery/);
  });
});
