// API DOS SITES (/api/sites/:id/*) — URLs de busca e ativação POR SITE.
//
// Por que existe: o PUT /api/config/sites reescreve a lista inteira. Se o
// dialog de URLs usasse aquela rota, ele gravaria junto qualquer toggle/edits
// pendentes da página. Aqui a escrita é cirúrgica: só o campo do site alvo.
//
//   GET   /api/sites/:id/urls   → { ok, site: { id, nome, ativo }, urls }
//   PUT   /api/sites/:id/urls   → { urls: string[] } (lista COMPLETA)
//   PATCH /api/sites/:id/ativo  → { ativo: boolean }
//
// Regras: só https://, máx. 50 URLs/site, máx. 2048 chars/URL, sem duplicatas
// (comparação normalizada via new URL — host/porta/barra final). Escrita
// atômica (tmp + rename), backup único por sessão e somente campos do site
// alvo. O bot lê sites.json no início de cada run — por isso a resposta avisa
// quando a mudança só vale na próxima execução.

import http from 'http';
import { copyFileSync, existsSync } from 'fs';
import path from 'path';
import {
  DIR_CONFIG,
  gravarJSONAtomico,
  lerCorpo,
  lerJSON,
  responderJSON,
} from './config-api.js';
import { garantirIdsSites } from './site-ids.js';
import { origemLocalPermitida } from './local-origin.js';
import {
  MAX_CARACTERES_URL,
  MAX_URLS_POR_SITE,
  normalizarUrlParaComparacao,
  validarUrls,
  type ErroValidacaoUrl,
} from './url-validation.js';
import { log } from './logger.js';

// Reexportados para os testes/consumidores que importam daqui.
export { MAX_CARACTERES_URL, MAX_URLS_POR_SITE, normalizarUrlParaComparacao, origemLocalPermitida, validarUrls };
export type { ErroValidacaoUrl };

const ARQ_SITES = path.join(DIR_CONFIG, 'sites.json');
// 50 × 2048 + sobra para aspas/vírgulas/chaves e outros campos do body.
const LIMITE_CORPO_URLS = MAX_URLS_POR_SITE * MAX_CARACTERES_URL + 4096;

interface SiteArmazenado {
  id?: string;
  nome?: string;
  ativo?: boolean;
  urls_busca?: string[];
  [chave: string]: unknown;
}

interface ArquivoSites {
  sites?: SiteArmazenado[];
  [chave: string]: unknown;
}

// ========== BACKUP (uma vez por sessão) ==========

let backupNestaSessao = false;

/**
 * Copia sites.json → sites.json.bak antes da primeira escrita do processo.
 * Só marca a flag DEPOIS do sucesso: se a cópia falhar, a próxima escrita
 * tenta de novo em vez de seguir silenciosamente sem backup.
 */
function prepararBackup(): boolean {
  if (backupNestaSessao) return true;
  try {
    if (existsSync(ARQ_SITES)) copyFileSync(ARQ_SITES, `${ARQ_SITES}.bak`);
    backupNestaSessao = true;
    return true;
  } catch (err) {
    log('WARN', `Sites: não foi possível criar sites.json.bak — ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

function tokenValido(req: http.IncomingMessage): boolean {
  const token = process.env.DASHBOARD_TOKEN;
  if (!token) return true;
  return req.headers['x-config-token'] === token;
}

// ========== MIGRAÇÃO DE IDS ==========

/**
 * Garante UUID em todo site sem id no sites.json. Roda na subida do control
 * server; idempotente e com backup antes da primeira escrita.
 */
export function migrarIdsSites(): void {
  const cfg = lerJSON<ArquivoSites>(ARQ_SITES, { sites: [] });
  if (!Array.isArray(cfg.sites) || cfg.sites.length === 0) return;
  const { sites, mudou } = garantirIdsSites(cfg.sites);
  if (!mudou) return;
  try {
    if (!prepararBackup()) return; // nunca grava sem ter o backup
    gravarJSONAtomico(ARQ_SITES, { ...cfg, sites });
    log('INFO', `Sites: id(s) gerados/ajustados em sites.json (${sites.length} site(s))`);
  } catch (err) {
    log('ERRO', `Sites: falha ao gravar ids em sites.json — ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ========== ESCRITA SERIALIZADA ==========

let fila: Promise<void> = Promise.resolve();

/** Serializa as gravações no sites.json (evita intercalar duas requisições). */
function comLock<T>(tarefa: () => T): Promise<T> {
  const resultado = fila.then(tarefa, tarefa);
  fila = resultado.then(
    () => undefined,
    () => undefined,
  );
  return resultado;
}

type ResultadoGravacao =
  | { ok: true; site: SiteArmazenado }
  | { ok: false; status: number; mensagem: string };

/**
 * Relê o arquivo e altera SÓ o site do id — preserva ordem, demais campos e
 * demais sites. Roda dentro do lock.
 */
function gravarAlteracaoNoSite(
  id: string,
  alterar: (site: SiteArmazenado) => void,
): ResultadoGravacao {
  const cfg = lerJSON<ArquivoSites>(ARQ_SITES, { sites: [] });
  const sites = Array.isArray(cfg.sites) ? cfg.sites : [];
  const indice = sites.findIndex((s) => s && typeof s === 'object' && s.id === id);
  if (indice === -1) return { ok: false, status: 404, mensagem: 'Site não encontrado' };

  const alterado: SiteArmazenado = { ...sites[indice] };
  alterar(alterado);

  // Os demais sites voltam EXATAMENTE como estavam (mesma referência). A
  // migração de ids é feita só na subida do servidor — nunca depassa aqui
  // alterando sites que não são o alvo desta requisição.
  const lista = sites.map((s, i) => (i === indice ? alterado : s));

  try {
    if (!prepararBackup()) {
      return { ok: false, status: 500, mensagem: 'Falha ao criar backup de sites.json' };
    }
    gravarJSONAtomico(ARQ_SITES, { ...cfg, sites: lista });
  } catch (err) {
    log('ERRO', `Sites: falha ao gravar sites.json — ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, status: 500, mensagem: 'Falha ao gravar sites.json (permissão de escrita)' };
  }
  return { ok: true, site: alterado };
}

function lerSite(id: string): SiteArmazenado | null {
  const cfg = lerJSON<ArquivoSites>(ARQ_SITES, { sites: [] });
  const sites = Array.isArray(cfg.sites) ? cfg.sites : [];
  return sites.find((s) => s && typeof s === 'object' && s.id === id) ?? null;
}

// ========== ROTEADOR ==========

const ROTA = /^\/api\/sites\/([^/]+)\/(urls|ativo)$/;

export async function rotearSites(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  caminho: string,
  opts: { rodando: () => boolean },
): Promise<boolean> {
  if (caminho !== '/api/sites' && !caminho.startsWith('/api/sites/')) return false;

  const casamento = ROTA.exec(caminho);
  if (!casamento) {
    responderJSON(res, 404, { ok: false, mensagem: 'Rota de site desconhecida' });
    return true;
  }

  let id: string;
  try {
    id = decodeURIComponent(casamento[1]);
  } catch {
    responderJSON(res, 400, { ok: false, mensagem: 'Id de site inválido' });
    return true;
  }
  if (!id) {
    responderJSON(res, 400, { ok: false, mensagem: 'Id de site ausente' });
    return true;
  }

  const recurso = casamento[2];
  const metodo = req.method ?? 'GET';
  const aplicadoNaProximaRun = () => Boolean(opts.rodando());

  // ----- GET /api/sites/:id/urls -----
  if (recurso === 'urls' && metodo === 'GET') {
    const site = lerSite(id);
    if (!site) {
      responderJSON(res, 404, { ok: false, mensagem: 'Site não encontrado' });
      return true;
    }
    responderJSON(res, 200, {
      ok: true,
      site: { id, nome: site.nome ?? '', ativo: Boolean(site.ativo) },
      urls: Array.isArray(site.urls_busca) ? site.urls_busca : [],
    });
    return true;
  }

  if (recurso === 'urls' && metodo !== 'PUT') {
    responderJSON(res, 405, { ok: false, mensagem: 'Método não suportado' });
    return true;
  }
  if (recurso === 'ativo' && metodo !== 'PATCH') {
    responderJSON(res, 405, { ok: false, mensagem: 'Método não suportado' });
    return true;
  }

  // ----- Daqui para baixo é ESCRITA -----
  if (!origemLocalPermitida(req)) {
    responderJSON(res, 403, {
      ok: false,
      mensagem: 'Gravação de sites só é aceita de localhost (Host/Origin locais)',
    });
    return true;
  }
  if (!tokenValido(req)) {
    responderJSON(res, 403, {
      ok: false,
      mensagem: 'X-Config-Token ausente ou incorreto (defina DASHBOARD_TOKEN no .env)',
    });
    return true;
  }

  // Limite compatível com o payload máximo válido (50 URLs × 2048 chars).
  const corpo = await lerCorpo(req, LIMITE_CORPO_URLS);
  if (corpo === null) {
    responderJSON(res, 413, {
      ok: false,
      mensagem: `Corpo muito grande (máx. ${Math.round(LIMITE_CORPO_URLS / 1024)} KB)`,
    });
    return true;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(corpo || '{}');
  } catch {
    responderJSON(res, 400, { ok: false, mensagem: 'JSON inválido' });
    return true;
  }

  // ----- PUT /api/sites/:id/urls -----
  if (recurso === 'urls') {
    const entrada = (parsed as { urls?: unknown })?.urls;
    const validacao = validarUrls(entrada);
    if (!validacao.ok) {
      responderJSON(res, 400, {
        ok: false,
        mensagem: validacao.mensagem,
        erros: validacao.erros,
      });
      return true;
    }

    const resultado = await comLock(() =>
      gravarAlteracaoNoSite(id, (site) => {
        site.urls_busca = validacao.urls;
      }),
    );
    if (!resultado.ok) {
      responderJSON(res, resultado.status, { ok: false, mensagem: resultado.mensagem });
      return true;
    }
    // Log sem as URLs: elas podem carregar token na query string.
    log('INFO', `Sites: URLs de "${resultado.site.nome ?? id}" atualizadas (${validacao.urls.length})`);
    responderJSON(res, 200, {
      ok: true,
      mensagem: 'URLs salvas',
      urls: validacao.urls,
      aplicadoNaProximaRun: aplicadoNaProximaRun(),
    });
    return true;
  }

  // ----- PATCH /api/sites/:id/ativo -----
  const ativo = (parsed as { ativo?: unknown })?.ativo;
  if (typeof ativo !== 'boolean') {
    responderJSON(res, 400, { ok: false, mensagem: 'Body precisa de { ativo: boolean }' });
    return true;
  }
  const resultado = await comLock(() =>
    gravarAlteracaoNoSite(id, (site) => {
      site.ativo = ativo;
    }),
  );
  if (!resultado.ok) {
    responderJSON(res, resultado.status, { ok: false, mensagem: resultado.mensagem });
    return true;
  }
  log('INFO', `Sites: "${resultado.site.nome ?? id}" ${ativo ? 'ativado' : 'desativado'}`);
  responderJSON(res, 200, {
    ok: true,
    mensagem: ativo ? 'Site ativado' : 'Site desativado',
    ativo,
    aplicadoNaProximaRun: aplicadoNaProximaRun(),
  });
  return true;
}
