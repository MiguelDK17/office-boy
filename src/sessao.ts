// Módulo de SESSÃO: tudo que depende do estado de autenticação nos portais.
//
// Duas responsabilidades:
//   1. GUARD DE LOGIN COM VERIFICAÇÃO — quando o navegador cai numa página de
//      login, em vez de mandar o modelo desistir na hora (o que ensinava o
//      agente a pular vagas que só precisavam de um bounce de SSO), ele
//      recebe a instrução de RE-NAVEGAR a URL que estava processando: se a
//      página carregar, a sessão está OK; se cair no login de novo, aí sim
//      reporta `sessao_expirada`.
//   2. HEALTH CHECK PRÉ-RUN — antes de gastar a primeira chamada de LLM,
//      entra na URL de busca de cada site ativo de sites.json e classifica a
//      sessão (ok / login_exigido / erro). Sessão morta descoberta aqui
//      economiza um run inteiro de iterações queimadas contra um muro.

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { log } from './logger.js';
import type { SitesConfig } from './types.js';
import { extrairResultadoEvaluate, montarScriptLerPagina } from './portais.js';

// Página de login: URL de autenticação + marcador textual. Os dois juntos
// evitam falso positivo (ex.: um link "Sign in" solto na navegação de uma
// página logada).
const RE_URL_LOGIN =
  /https?:\/\/[^\s)\]]*(?:\/login|\/signin|\/sign-in|\/checkpoint\/login|\/auth(?:[/?#]|$)|\/accounts\/login|\/uas\/login|\/cadastro-candidato|\/cadastro|\/registro|\/register|\/criar-conta|\/entrar(?:[/?#]|$))/i;
const RE_MARCADOR_LOGIN =
  /\b(sign in|log in|login|entrar|iniciar sess[aã]o|fazer login|entre com sua conta|cadastre-se|cadastre se|crie sua conta|criar conta|create account|sign up)\b/i;

/**
 * Detecta se a tool devolveu uma PÁGINA DE LOGIN (sessão expirada ou
 * nunca logado).
 *
 * Janelas assimétricas: a URL de login aparece no INÍCIO dos resultados de
 * tool ("### Open tabs - [Gupy](https://.../candidates/signin)"), mas o
 * marcador textual do formulário pode vir DEPOIS de um snapshot longo — no
 * run de 13/11/2026 (Algar) o guard não disparou porque "entre com sua conta"
 * ficava além dos 2000 chars. URL em 2000 + marcador em 6000 preserva o
 * pareamento (evita falso positivo de um link "Sign in" solto) e cobre o
 * caso real.
 */
export function ehPaginaDeLogin(texto: string): boolean {
  const janelaUrl = texto.slice(0, 2000);
  const janelaMarcador = texto.slice(0, 6000);
  return RE_URL_LOGIN.test(janelaUrl) && RE_MARCADOR_LOGIN.test(janelaMarcador);
}

/**
 * Portais onde a BUSCA abre sem login, mas a CANDIDATURA exige conta.
 * `ehPaginaDeLogin` não pega esse caso: a URL é de busca, não de login, e o
 * run inteiro é gasto até descobrir no botão "Enviar".
 */
export function exigeLoginParaCandidatar(site: string, texto: string): boolean {
  const inicio = texto.slice(0, 8000).toLowerCase();
  const url = texto.slice(0, 2000).toLowerCase();
  const logado = /minha conta|\bsair\b|meu perfil|ol[aá],?\s+\w+/.test(inicio);
  if (logado) return false;

  if (/catho/i.test(site)) {
    // Sinal forte: cadastro para VER/CANDIDATAR-SE. "Cadastre-se agora" sozinho
    // é CTA de newsletter e aparece até para usuário logado.
    return /\/vagas\//.test(url)
      && /cadastre[- ]se para ver|cadastre[- ]se agora para ver|entre ou cadastre[- ]se para/.test(inicio);
  }
  if (/indeed/i.test(site)) {
    // Busca com vjk NÃO é vaga: precisa ser /viewjob ou /jobs/view/<id>.
    const vagaEspecifica = /\/viewjob|\/jobs\/view\/\d+/.test(url);
    return vagaEspecifica && /sign in to apply|entre para candidatar|sign in to see|entre com sua conta para/i.test(inicio);
  }
  return false;
}

/**
 * Extrai texto do retorno bruto de `mcpClient.callTool`, preservando o
 * payload intacto: partes `text` são concatenadas; partes não-texto viram
 * JSON. Retorna 'OK' quando não há conteúdo.
 */
export function extrairTextoMcp(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return (
      content
        .map((c) => {
          if (typeof c === 'string') return c;
          if (c && typeof c === 'object' && 'type' in c) {
            const part = c as { type: string; text?: unknown };
            if (part.type === 'text' && part.text !== undefined) return String(part.text);
          }
          return JSON.stringify(c);
        })
        .join('\n') || 'OK'
    );
  }
  if (content === null || content === undefined) return 'OK';
  return JSON.stringify(content);
}

/**
 * Monta o aviso de VERIFICAÇÃO DE SESSÃO injetado no resultado da tool quando
 * o navegador caiu numa página de login.
 *
 * Diferente do aviso antigo (que mandava reportar `sessao_expirada` na hora —
 * o que fazia o modelo pular vagas que só precisavam do bounce automático de
 * SSO), este pede um teste determinístico: re-navegar a URL que estava
 * sendo processada. Só reporta falha se a sessão FALHAR no teste.
 *
 * @param urlAlvo Última URL navegada pelo agente (rastreada no loop); null se
 *                não houve navegação ainda (usa orientação genérica).
 * @param paginasLogin Quantas páginas de login nesta execução — a partir de 3
 *                     a sessão é considerada quebrada e o aviso manda pular
 *                     direto (sem teste), como no comportamento antigo.
 */
export function construirAvisoVerificacaoLogin(
  urlAlvo: string | null,
  paginasLogin: number,
): string {
  let aviso =
    `\n\nAVISO_DO_SISTEMA: o navegador esta numa PAGINA DE LOGIN. ` +
    `Muitas vezes isso e apenas um BOUNCE temporario de autenticacao (SSO) — a sessao pode voltar sozinha ao reabrir a pagina. ` +
    `Antes de desistir, VERIFIQUE a sessao: ` +
    (urlAlvo
      ? `use browser_navigate para voltar para "${urlAlvo}" (a URL que voce estava processando). `
      : `use browser_navigate para voltar para a URL da vaga ou da listagem que voce estava processando. `) +
    `Se a pagina carregar normalmente (sem cair no login de novo), a sessao esta OK — siga o fluxo de candidatura normalmente, NAO reporte falha. ` +
    `Se cair na pagina de login NOVAMENTE, a sessao esta realmente expirada: ai sim use reportar_falha com codigo "sessao_expirada" (url_vaga = URL atual) e PULE para o proximo site. ` +
    `Em NENHUM caso tente preencher formularios de login ou clicar em campos de autenticacao.`;
  if (paginasLogin >= 3) {
    aviso +=
      ` ATENCAO: ${paginasLogin} paginas de login em sequencia — a sessao esta quebrada, ` +
      `NAO perca tempo com o teste: PULE o site agora (reportar_falha "sessao_expirada").`;
  }
  return aviso;
}

// ========== HEALTH CHECK PRÉ-RUN ==========

export type StatusSessao = 'ok' | 'login_exigido' | 'erro';

export interface ResultadoSessao {
  site: string;
  status: StatusSessao;
  /** URL usada no teste. */
  url: string;
  /** Primeiros caracteres do resultado, para log/diagnóstico. */
  detalhe: string;
}

/**
 * Lê URL/título/texto visível da aba atual.
 *
 * `browser_navigate` devolve APENAS "### Page / - Page URL / - Page Title" —
 * nenhum conteúdo. Sem esta leitura, o health check era cego: `ehPaginaDeLogin`
 * e `exigeLoginParaCandidatar` dependem de texto que nunca chegava (Catho
 * anônima era classificada como "OK" na run de 24/11).
 */
export async function lerPaginaAtual(
  mcpClient: Client,
): Promise<{ url: string; title: string; texto: string } | null> {
  try {
    const resp = await mcpClient.callTool({
      name: 'browser_evaluate',
      arguments: { function: montarScriptLerPagina() },
    });
    const dados = extrairResultadoEvaluate(
      extrairTextoMcp((resp as { content?: unknown }).content),
    );
    if (!dados || typeof dados !== 'object') return null;
    const d = dados as Record<string, unknown>;
    return {
      url: typeof d.url === 'string' ? d.url : '',
      title: typeof d.title === 'string' ? d.title : '',
      texto: typeof d.texto === 'string' ? d.texto : '',
    };
  } catch {
    return null;
  }
}

/**
 * Health check de sessão pré-run: para cada site ATIVO com `urls_busca`
 * configuradas, navega à primeira URL e classifica a sessão.
 *
 * Usa o MESMO mcpClient do agente (mesmo Chrome, mesmo perfil) — é exatamente
 * isso que queremos testar: a sessão que o agente vai usar.
 *
 * Nunca lança: falha de navegação vira status 'erro' do site. O run decide o
 * que fazer com os resultados (o index.ts notifica e, se TODOS os sites
 * testados estiverem quebrados, evita iniciar a rodada).
 */
export async function verificarSessoes(
  mcpClient: Client,
  sites: SitesConfig,
): Promise<ResultadoSessao[]> {
  const alvos = sites.sites.filter((s) => s.ativo && s.urls_busca.length > 0);
  const resultados: ResultadoSessao[] = [];

  for (const site of alvos) {
    const url = site.urls_busca[0];
    log('SESSAO', `Verificando sessao em ${site.nome} (${url})...`);
    let navegacao: string;
    try {
      const mcpResult = await mcpClient.callTool({
        name: 'browser_navigate',
        arguments: { url },
      });
      navegacao = extrairTextoMcp((mcpResult as { content?: unknown }).content);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      resultados.push({ site: site.nome, status: 'erro', url, detalhe: msg.substring(0, 200) });
      log('SESSAO', `${site.nome}: ERRO — ${msg.substring(0, 150)}`);
      continue;
    }

    // Conteúdo real da página (o navigate não traz body). Se a leitura falhar,
    // cai para o retorno da navegação — melhor que ficar cego de vez.
    const pagina = await lerPaginaAtual(mcpClient);
    const texto = pagina
      ? `Page URL: ${pagina.url || url}\nPage Title: ${pagina.title}\n${pagina.texto}`
      : navegacao;

    let status: StatusSessao;
    if (navegacao.startsWith('ERRO_TOOL') || /net::ERR_|Navigation timeout/i.test(navegacao.slice(0, 500))) {
      status = 'erro';
    } else if (ehPaginaDeLogin(texto) || exigeLoginParaCandidatar(site.nome, texto)) {
      status = 'login_exigido';
    } else {
      status = 'ok';
    }
    resultados.push({ site: site.nome, status, url, detalhe: texto.slice(0, 200) });
    log('SESSAO', `${site.nome}: ${status.toUpperCase()}`);

    // Respiro entre sites: navegações em sequência imediata são o padrão de
    // navegação que menos queremos imitar (ver DELAY_MIN/MAX do fluxo).
    if (alvos.indexOf(site) < alvos.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }

  return resultados;
}
