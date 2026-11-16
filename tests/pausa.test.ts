// Contrato da pausa real: o agente aguarda com o processo vivo entre
// iterações, o filho trata os sinais de pausa/retomada e a parada suave tem
// precedência sobre a espera da pausa.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('pausa real — contrato', () => {
  const agente = readFileSync(path.resolve(__dirname, '..', 'src', 'agente.ts'), 'utf-8');
  const index = readFileSync(path.resolve(__dirname, '..', 'src', 'index.ts'), 'utf-8');

  it('o agente exporta pausa/retomada cooperativa', () => {
    // Cenário + Ação + Validação
    expect(agente).toContain('export function solicitarPausaAgente');
    expect(agente).toContain('export function retomarAgente');
    expect(agente).toContain('export function pausaAgenteAtiva');
  });

  it('a run pausada AGUARDA em espera (processo vivo) e o stop tem precedência', () => {
    // Cenário + Ação + Validação: loop só espera se NÃO houver stop pendente
    expect(agente).toContain('pausaAgenteAtiva() && !paradaSolicitada');
    // Confirmações de estado que o control server parseia do log
    expect(agente).toContain('Run pausada');
    expect(agente).toContain('Run retomada');
  });

  it('o filho trata SIGUSR2 (pausar) e SIGWINCH (retomar)', () => {
    // Cenário + Ação + Validação
    expect(index).toContain("process.on('SIGUSR2'");
    expect(index).toContain("process.on('SIGWINCH'");
  });

  it('no modo control server o handler de parada é no-op (quem encerra é o servidor)', () => {
    // Cenário + Ação + Validação: evita sair sem encaminhar o sinal ao filho
    expect(index).toContain("process.env.CONTROL_MODE === 'true'") ;
  });

  it('PAUSA AUTOMÁTICA no login: detecta página de login e pausa com aviso + Telegram', () => {
    // Cenário + Ação + Validação: o guard de login pausa o run (processo vivo)
    expect(agente).toContain('config.pausarEmLogin');
    expect(agente).toContain('solicitarPausaAgente();');
    expect(agente).toContain('PAGINA DE LOGIN detectada');
    expect(agente).toContain('Faca login no Chrome do bot e clique Retomar');
    expect(agente).toMatch(/enviarTelegram\(/);
  });

  it('o toggle da pausa automática vem do .env (PAUSAR_EM_LOGIN, default true)', () => {
    // Cenário + Ação + Validação: permite desligar para runs noturnos
    expect(index).toContain("process.env.PAUSAR_EM_LOGIN !== 'false'");
  });
});
