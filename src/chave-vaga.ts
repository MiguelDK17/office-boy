// Chave canônica da VAGA — usada para deduplicar candidaturas e vagas vistas.
//
// A URL que o LLM passa muda de uma execução para outra (tracking, refId,
// empresa, barra final) e, na Gupy, o registro acabava gravando a URL da
// ETAPA DO FORMULÁRIO em vez da vaga. Aqui extraímos o identificador estável
// de cada portal. Nunca logar a URL inteira: pode conter token na query.

const TRACKING = new Set([
  'refid', 'trackingid', 'tracking_id', 'companyname', 'company_name',
  'jobboardsource', 'job_board_source', 'utm_source', 'utm_medium',
  'utm_campaign', 'utm_term', 'utm_content', 'vjk', 'pp', 'from',
  'alternatechannel', 'ebp', 'sentry', 'gclid', 'fbclid', 'source',
]);

/** URL sem parâmetros de tracking — usada como fallback e para exibição. */
export function urlCanonica(url: string): string {
  try {
    const u = new URL(url.trim());
    for (const chave of [...u.searchParams.keys()]) {
      if (TRACKING.has(chave.toLowerCase())) u.searchParams.delete(chave);
    }
    u.hash = '';
    return `${u.origin}${u.pathname.replace(/\/+$/, '') || '/'}${u.search}`;
  } catch {
    return url.trim();
  }
}

/** Decodifica o payload base64 da Gupy, ex.: eyJqb2JJZCI6MTIz... */
function jobIdGupy(parte: string): string | null {
  try {
    const texto = Buffer.from(parte, 'base64').toString('utf-8');
    const dado = JSON.parse(texto) as { jobId?: number | string };
    return dado.jobId ? String(dado.jobId) : null;
  } catch {
    return null;
  }
}

/**
 * Identificador estável da vaga. Prefere o ID do portal; cai para host+caminho
 * sem tracking quando o portal não expõe um id (Catho, por exemplo).
 */
export function chaveVaga(url: string): string {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return `bruto:${url.trim()}`;
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');

  // LinkedIn: /jobs/view/1234567890/ ou ?currentJobId=1234567890
  if (host.includes('linkedin.com')) {
    const id = u.pathname.match(/\/jobs\/(?:view|search-results)\/?(\d+)/)?.[1]
      ?? u.searchParams.get('currentJobId');
    if (id) return `linkedin:${id}`;
  }

  // Gupy: todas as URLs da MESMA vaga precisam da mesma chave. O fluxo passa
  // por /job/<base64> → /candidates/jobs/<id>/apply → /candidates/applications/<app>.
  if (host.includes('gupy.io')) {
    const base64 = u.pathname.match(/\/job\/([^/]+)/)?.[1];
    const id = base64 ? jobIdGupy(base64) : null;
    if (id) return `gupy:${id}`;
    const apply = u.pathname.match(/\/candidates\/jobs\/(\d+)\/apply/)?.[1];
    if (apply) return `gupy:${apply}`;
    const app = u.pathname.match(/\/candidates\/applications\/(\d+)/)?.[1];
    if (app) return `gupy-app:${app}`;
  }

  // Indeed: jk/vjk na query ou /viewjob?jk=
  if (host.includes('indeed.com')) {
    const id = u.searchParams.get('jk') ?? u.searchParams.get('vjk');
    if (id) return `indeed:${id}`;
  }

  // Mantém parâmetros relevantes (id=111 vs id=222 são vagas diferentes),
  // descartando apenas tracking — urlCanonica() faz isso.
  const canonica = urlCanonica(url);
  const caminho = canonica.replace(/^https?:\/\/[^/]+/, '');
  return `url:${host}${caminho}`;
}
