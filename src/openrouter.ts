import { randomUUID } from 'crypto';

/** Política de roteamento específica do OpenRouter. */

export type OpenRouterRoutingStrategy = 'price' | 'latency' | 'throughput';

export interface OpenRouterProviderRouting {
  sort: OpenRouterRoutingStrategy;
  /** Mantém failover para outro provider do mesmo modelo quando necessário. */
  allow_fallbacks: true;
  /** Evita escolher endpoint que não aceite tools/parâmetros enviados. */
  require_parameters: true;
}

/** Gera um agrupador único para uma execução completa do Office Boy. */
export function criarSessaoOpenRouter(): string {
  return `officeboy-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
}

/** Detecta o endpoint oficial sem afetar outros providers OpenAI-compatible. */
export function ehOpenRouter(baseUrl: string): boolean {
  try {
    const hostname = new URL(baseUrl).hostname;
    return hostname === 'openrouter.ai' || hostname.endsWith('.openrouter.ai');
  } catch {
    return false;
  }
}

/** Retorna a política; preço é o default e as outras estratégias ficam extensíveis. */
export function obterRoteamentoOpenRouter(
  estrategia: OpenRouterRoutingStrategy = 'price',
): OpenRouterProviderRouting {
  return { sort: estrategia, allow_fallbacks: true, require_parameters: true };
}

/** Campos extras da API; retorna objeto vazio fora do OpenRouter. */
export function camposOpenRouter(
  baseUrl: string,
  estrategia: OpenRouterRoutingStrategy = 'price',
  sessionId?: string,
): { provider: OpenRouterProviderRouting; session_id?: string } | Record<string, never> {
  return ehOpenRouter(baseUrl)
    ? {
        provider: obterRoteamentoOpenRouter(estrategia),
        ...(sessionId ? { session_id: sessionId } : {}),
      }
    : {};
}
