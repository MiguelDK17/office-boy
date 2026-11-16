// Contrato do módulo de sessão: guard de login com VERIFICAÇÃO (re-navegar a
// URL alvo antes de desistir) e health check pré-run dos sites configurados.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('módulo de sessão — contrato', () => {
  const sessao = readFileSync(path.resolve(__dirname, '..', 'src', 'sessao.ts'), 'utf-8');
  const agente = readFileSync(path.resolve(__dirname, '..', 'src', 'agente.ts'), 'utf-8');
  const index = readFileSync(path.resolve(__dirname, '..', 'src', 'index.ts'), 'utf-8');

  it('o guard pede VERIFICAÇÃO da sessão (re-navegar a URL alvo) antes de reportar falha', () => {
    // Cenário + Ação + Validação: o aviso instrui o teste determinístico
    expect(sessao).toContain('export function construirAvisoVerificacaoLogin');
    expect(sessao).toMatch(/VERIFIQUE a sessao/);
    expect(sessao).toMatch(/browser_navigate para voltar para/);
    expect(sessao).toMatch(/Se a pagina carregar normalmente[^']*sessao esta OK/);
    // Só reporta `sessao_expirada` se cair no login DE NOVO
    expect(sessao).toMatch(/cair na pagina de login NOVAMENTE[^']*reportar_falha com codigo "sessao_expirada"/);
    // E nunca tenta preencher formulário de login
    expect(sessao).toMatch(/tente preencher formularios de login/);
  });

  it('sessão quebrada (3+ páginas de login) pula direto, sem o teste', () => {
    // Cenário + Ação + Validação: evita loop de verificação contra muro real
    expect(sessao).toMatch(/paginasLogin >= 3/);
    expect(sessao).toMatch(/NAO perca tempo com o teste: PULE o site agora/);
  });

  it('o agente rastreia a última URL navegada para o guard verificar', () => {
    // Cenário + Ação + Validação: URL alvo do aviso vem do browser_navigate
    expect(agente).toContain('ultimaUrlNavegada');
    expect(agente).toMatch(/toolName === 'browser_navigate'/);
    expect(agente).toContain('construirAvisoVerificacaoLogin(ultimaUrlNavegada, paginasLogin)');
  });

  it('health check pré-run: testa a primeira URL de busca de cada site ativo', () => {
    // Cenário + Ação + Validação: usa o mesmo mcpClient/Chrome do agente
    expect(sessao).toContain('export async function verificarSessoes');
    expect(sessao).toMatch(/s\.ativo && s\.urls_busca\.length > 0/);
    expect(sessao).toMatch(/name: 'browser_navigate'/);
    expect(sessao).toContain("ehPaginaDeLogin(texto)");
    // Classificação em três estados
    expect(sessao).toContain("'ok' | 'login_exigido' | 'erro'");
  });

  it('o index roda o health check ANTES do agente e aborta se TODAS as sessões quebrarem', () => {
    // Cenário + Ação + Validação: economiza um run inteiro contra o muro
    expect(index).toContain('verificarSessoes(mcpClient, sites)');
    expect(index).toMatch(/todosQuebrados && !config\.dryRun/);
    expect(index).toMatch(/Faca login manual no Chrome do bot/);
  });

  it('agente.ts reexporta as funções movidas (compatibilidade de imports/testes)', () => {
    // Cenário + Ação + Validação
    expect(agente).toContain("export { ehPaginaDeLogin, extrairTextoMcp, construirAvisoVerificacaoLogin } from './sessao.js'");
  });
});
