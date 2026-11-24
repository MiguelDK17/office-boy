// URL REAL da aba do Chrome, lida via CDP. A URL que o LLM repassa em args.url
// pode ser a de uma etapa do formulário ou conter tracking — aqui consultamos
// o navegador para confirmar qual página está aberta no momento da ação.

const TIMEOUT_MS = 2000;

export async function urlAtualDoChrome(): Promise<string | null> {
  const endpoint = process.env.CDP_ENDPOINT || 'http://127.0.0.1:9222';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(`${endpoint.replace(/\/+$/, '')}/json/list`, {
      signal: ctrl.signal,
    });
    if (!resp.ok) return null;
    const abas = (await resp.json()) as Array<{ type: string; url: string }>;
    const pagina = abas.find((aba) => aba.type === 'page' && /^https?:\/\//i.test(aba.url));
    return pagina?.url ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
