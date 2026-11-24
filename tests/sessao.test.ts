// Contrato do módulo de sessão: guard de login com VERIFICAÇÃO (re-navegar a
// URL alvo antes de desistir) e health check pré-run dos sites configurados.

import { describe, it, expect } from 'vitest';
import { ehPaginaDeLogin, exigeLoginParaCandidatar } from '../src/sessao';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sessao = readFileSync(path.resolve(__dirname, '..', 'src', 'sessao.ts'), 'utf-8');
const agente = readFileSync(path.resolve(__dirname, '..', 'src', 'agente.ts'), 'utf-8');
const index = readFileSync(path.resolve(__dirname, '..', 'src', 'index.ts'), 'utf-8');

describe('módulo de sessão — contrato', () => {

  it('detecta página de cadastro da Catho pelo marcador Cadastre-se', () => {
    const pagina = [
      'Page URL: https://www.catho.com.br/cadastro-candidato',
      'Page Title: Cadastre-se na Catho',
      'Cadastre-se para criar sua conta e continuar.',
    ].join('\n');
    expect(ehPaginaDeLogin(pagina)).toBe(true);
  });

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

  it('o health check LÊ o conteúdo da página — navigate sozinho não traz o body', () => {
    // Cenário: browser_navigate devolve apenas "### Page / Page URL / Title".
    // Sem a leitura via browser_evaluate, o detector de login nunca via texto.
    expect(sessao).toContain('export async function lerPaginaAtual');
    expect(sessao).toContain("name: 'browser_evaluate'");
    expect(sessao).toContain('montarScriptLerPagina');
    expect(sessao).toMatch(/Page URL: \$\{pagina\.url/);
  });

  it('reconhece redirecionamentos de login/cadastro de Catho e Indeed', () => {
    // Catho manda para /cadastro-candidato; Indeed para secure.indeed.com/auth
    expect(sessao).toContain('/cadastro-candidato');
    expect(sessao).toContain('/auth(?:[/?#]|$)');
  });

  it('o index roda o health check ANTES do agente e aborta se TODAS as sessões quebrarem', () => {
    // Cenário + Ação + Validação: economiza um run inteiro contra o muro
    expect(index).toContain('verificarSessoes(mcpClient, sites)');
    expect(index).toMatch(/todosQuebrados && !config\.dryRun/);
    expect(index).toMatch(/Faca login manual no Chrome do bot/);
  });

  it('agente.ts reexporta as funções movidas (compatibilidade de imports/testes)', () => {
    // Cenário + Ação + Validação
    expect(agente).toContain("export { ehPaginaDeLogin, exigeLoginParaCandidatar, extrairTextoMcp, construirAvisoVerificacaoLogin } from './sessao.js'");
  });
});

describe('sessão anônima em portais que abrem a busca sem login', () => {
  it('Catho: detecta o aviso de cadastro PARA CANDIDATAR-SE', () => {
    const pagina = '- Page URL: https://www.catho.com.br/vagas/desenvolvedor-android/\n' +
      'Vagas de emprego ... Cadastre-se para ver todas as oportunidades e se candidatar.';
    expect(exigeLoginParaCandidatar('Catho', pagina)).toBe(true);
    expect(exigeLoginParaCandidatar('Catho', 'Resultados de busca sem aviso de cadastro')).toBe(false);
  });

  it('Catho logada: CTA de newsletter NÃO dispara falso positivo', () => {
    const pagina = '- Page URL: https://www.catho.com.br/vagas/desenvolvedor-android/\n' +
      'Olá, Miguel. Minha conta. Cadastre-se agora para receber vagas por e-mail.';
    expect(exigeLoginParaCandidatar('Catho', pagina)).toBe(false);
  });

  it('Indeed: detecta sign-in para candidatar em /viewjob', () => {
    const pagina = '- Page URL: https://br.indeed.com/viewjob?jk=abc123\n' +
      'Sign in to apply to this job.';
    expect(exigeLoginParaCandidatar('Indeed', pagina)).toBe(true);
    // Busca com vjk não é vaga específica.
    expect(exigeLoginParaCandidatar('Indeed', '- Page URL: https://br.indeed.com/jobs?q=android&vjk=abc123 Sign in to apply')).toBe(false);
  });

  it('o agente recebe a lista de sites com sessão quebrada e os remove da rodada', () => {
    expect(agente).toMatch(/sitesBloqueados: string\[\] = \[\]/);
    expect(agente).toMatch(/s\.ativo && !bloqueados\.has\(s\.nome\.toLowerCase\(\)\)/);
    expect(index).toMatch(/sessoes\.filter\(s => s\.status === 'login_exigido'\)\.map\(s => s\.site\)/);
  });

  it('qualquer página de login detectada no meio da run pausa o bot (não só URL /login)', () => {
    expect(agente).toMatch(/const loginDetectado = ehPaginaDeLogin\(resultado\)\s*\|\| exigeLoginParaCandidatar\(siteAtual, resultado\)/);
    expect(agente).toMatch(/if \(loginDetectado\) \{/);
    expect(agente).toMatch(/config\.pausarEmLogin/);
    expect(agente).toMatch(/solicitarPausaAgente\(\)/);
  });

  it('browser_snapshot com filename é interceptado — o conteúdo precisa voltar', () => {
    // Cenário: na run de 24/11 o modelo pediu filename e ficou cego.
    expect(agente).toContain("toolName === 'browser_snapshot' && typeof toolArgs.filename === 'string'");
    expect(agente).toContain('delete toolArgs.filename');
    expect(agente).toMatch(/snapshot precisa voltar no resultado/);
  });

  it('logs de argumentos de tool nunca devolvem algo que pareça URL navegável', () => {
    expect(agente).toContain("copia[chave] = '[URL]'");
    expect(agente).not.toMatch(/copia\[chave\] = chaveVaga\(valor\)/);
  });
});
