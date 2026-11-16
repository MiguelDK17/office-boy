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

// Página de login: URL de autenticação + marcador textual. Os dois juntos
// evitam falso positivo (ex.: um link "Sign in" solto na navegação de uma
// página logada).
const RE_URL_LOGIN =
  /https?:\/\/[^\s)\]]*(?:\/login|\/signin|\/sign-in|\/checkpoint\/login|\/auth\/|\/accounts\/login|\/uas\/login)/i;
const RE_MARCADOR_LOGIN =
  /\b(sign in|log in|login|entrar|iniciar sess[aã]o|fazer login|entre com sua conta)\b/i;

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
    let texto: string;
    try {
      const mcpResult = await mcpClient.callTool({
        name: 'browser_navigate',
        arguments: { url },
      });
      texto = extrairTextoMcp((mcpResult as { content?: unknown }).content);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      resultados.push({ site: site.nome, status: 'erro', url, detalhe: msg.substring(0, 200) });
      log('SESSAO', `${site.nome}: ERRO — ${msg.substring(0, 150)}`);
      continue;
    }

    let status: StatusSessao;
    if (ehPaginaDeLogin(texto)) {
      status = 'login_exigido';
    } else if (texto.startsWith('ERRO_TOOL') || /net::ERR_|Navigation timeout/i.test(texto.slice(0, 500))) {
      status = 'erro';
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
