// Contrato da guarda anti-abandono: resposta só-texto NUNCA encerra o run.
// O fusível antigo (aceitar a desistência como "resposta final" após N
// nudges) foi removido — texto é recusado com um aviso `user` e o loop
// continua; os únicos encerramentos válidos são determinísticos (meta de
// qualidade, teto de iterações, custo máximo, erro fatal ou parada/pausa).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('guarda anti-abandono', () => {
  const agente = readFileSync(path.resolve(__dirname, '..', 'src', 'agente.ts'), 'utf-8');

  it('recusa a resposta só-texto e devolve controle ao modelo (nudge user)', () => {
    // Cenário + Ação + Validação: o bloco de texto-puro empurra um aviso
    expect(agente).toContain('Guarda anti-abandono');
    expect(agente).toMatch(/AVISO_DO_SISTEMA: voce respondeu APENAS TEXTO/);
    expect(agente).toContain('texto NAO encerra o run');
  });

  it('NÃO existe fusível: não há teto de nudges que aceite a desistência', () => {
    // Cenário + Ação + Validação: o ramo que aceitava texto como resposta
    // final (aceitar após nudges esgotados) foi removido por completo.
    expect(agente).not.toMatch(/MAX_NUDGES_ABANDONO/);
    expect(agente).not.toMatch(/Resposta final do modelo/);
    // A janela de iterações onde a guarda atuava (20% do run) também sumiu —
    // a guarda atua no run INTEIRO.
    expect(agente).not.toMatch(/limiteGuardaAbandono/);
  });

  it('o ramo de texto-puro SEMPRE dá continue (nunca break com respostaFinal = texto)', () => {
    // Cenário + Ação + Validação: o bloco sem tool calls recusa e volta ao
    // loop; a única saída do run por texto aceito seria respostaFinal = texto.
    expect(agente).toMatch(
      /nudgesAbandono\+\+;[\s\S]*?AVISO_DO_SISTEMA[\s\S]*?\}\);\s*\n\s*continue;/,
    );
    expect(agente).not.toMatch(/respostaFinal = textoModelo/);
  });

  it('a recusa NÃO preserva recovery como erro fatal (texto não é fim de run)', () => {
    // Cenário + Ação + Validação: o branch antigo (nudgesAbandono > 0 →
    // salvarRecovery + saiuComErroFatal) foi removido; recovery só é assunto
    // de erro fatal/parada suave.
    expect(agente).not.toMatch(/if \(nudgesAbandono > 0\) \{\s*\n\s*salvarRecovery/);
  });
});
