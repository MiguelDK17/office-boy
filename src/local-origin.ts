// Guarda de escrita local — usada pelas rotas de sites E pelo PUT /api/config.
// O servidor já escuta em 127.0.0.1; esta é a segunda camada contra CSRF/DNS
// rebinding: Host e, quando presente, Origin precisam ser locais.

import type http from 'http';

const HOSTS_LOCAIS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function hostnameLocal(host: string | undefined): boolean {
  if (!host) return false;
  try {
    return HOSTS_LOCAIS.has(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
}

export function origemLocalPermitida(req: http.IncomingMessage): boolean {
  if (!hostnameLocal(req.headers.host)) return false;
  const origem = req.headers.origin;
  if (!origem) return true;
  try {
    return HOSTS_LOCAIS.has(new URL(origem).hostname);
  } catch {
    return false;
  }
}
