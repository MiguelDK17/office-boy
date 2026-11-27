import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { existsSync } from 'fs';
import path from 'path';
import type { McpServerConfig } from './types.js';

let mcpClient: Client | null = null;
let rebaseJobsMcpClient: Client | null = null;
const mcpHttpClients: Client[] = [];

export const REBASE_JOBS_MCP_URL = 'https://rebasedev.com.br/mcp';
export const REBASE_JOBS_READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'buscar_vagas',
  'ver_vaga',
  'sobre_o_catalogo',
]);
export const REBASE_JOBS_REQUEST_TIMEOUT_MS = 15_000;

// Versão pinada do MCP (mesma do package.json — sem caret de propósito).
// Versão usada no fallback via npx quando não há binário local.
// 0.0.72+ trocou o argumento `ref` das browser tools por `target` (schema
// novo que os modelos não conhecem) — mantemos 0.0.70 (última com `ref`).
export const PLAYWRIGHT_MCP_VERSION = '0.0.70';

/**
 * Verifica, ANTES de subir o agente, que o Chrome esta acessivel via CDP.
 *
 * Por que existe: o handshake do Playwright MCP conecta com sucesso mesmo sem o
 * Chrome no ar — a falha de CDP so apareceria la na frente, no meio do loop do
 * agente (na 1a tool browser_*), depois de ja ter gasto varias chamadas do LLM
 * (e ate estourar rate limit). Falhar cedo, com instrucao clara, evita esse
 * desperdicio. Testa o proprio endpoint DevTools do Chrome (/json/version).
 *
 * Dica de rede: use 127.0.0.1 (IPv4) em vez de "localhost". O Chrome, com
 * --remote-debugging-port, faz bind so em 127.0.0.1; "localhost" pode resolver
 * para ::1 (IPv6) e dar "connect ECONNREFUSED ::1:9222".
 */
export async function verificarChromeCDP(cdpEndpoint: string, timeoutMs = 3000): Promise<void> {
  const url = `${cdpEndpoint.replace(/\/+$/, '')}/json/version`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  let ok = false;
  let motivo = '';
  try {
    const resp = await fetch(url, { signal: ctrl.signal });
    ok = resp.ok;
    if (ok) {
      // Nao usamos o corpo — cancela para liberar o socket (evita keep-alive pendurado).
      await resp.body?.cancel();
    } else {
      motivo = `HTTP ${resp.status}`;
    }
  } catch (e) {
    // signal.aborted distingue TIMEOUT de recusa/erro de rede, de forma
    // deterministica (independe do formato do erro do fetch/undici).
    motivo = ctrl.signal.aborted
      ? `timeout apos ${timeoutMs}ms`
      : e instanceof Error ? e.message : String(e);
  } finally {
    clearTimeout(timer);
  }

  if (!ok) {
    throw new Error(
      `Nao foi possivel falar com o Chrome em ${cdpEndpoint} (${motivo}).\n` +
      `Abra o Chrome com a porta de debug ANTES de rodar o bot e faca login nos sites:\n` +
      `  Windows: & "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9222 --user-data-dir="$env:USERPROFILE\\.chrome-debug-profile"\n` +
      `  Linux:   google-chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.chrome-debug-profile"\n` +
      `  Mac:     "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222 --user-data-dir="$HOME/.chrome-debug-profile"\n` +
      `Confira abrindo ${cdpEndpoint}/json/version no proprio Chrome (deve mostrar um JSON).`,
    );
  }
}

export async function conectarPlaywrightMCP(cdpEndpoint: string): Promise<Client> {
  console.log(`[MCP] Conectando ao Playwright MCP via CDP: ${cdpEndpoint}`);

  const { command, args } = montarComandoMCP(cdpEndpoint);
  const transport = new StdioClientTransport({ command, args });

  mcpClient = new Client({
    name: 'officeboy',
    version: '1.0.0',
  });

  await mcpClient.connect(transport);

  console.log('[MCP] Conectado com sucesso ao Playwright MCP!');

  const { tools } = await mcpClient.listTools();
  console.log(`[MCP] ${tools.length} tools disponiveis: ${tools.map(t => t.name).join(', ')}`);

  return mcpClient;
}

export async function desconectarMCP(): Promise<void> {
  const clientes = [
    { client: mcpClient, nome: 'Playwright' },
    { client: rebaseJobsMcpClient, nome: 'Rebase Jobs' },
  ].filter((item): item is { client: Client; nome: string } => item.client !== null)
    .concat(mcpHttpClients.map((client, index) => ({ client, nome: `MCP remoto ${index + 1}` })));
  mcpClient = null;
  rebaseJobsMcpClient = null;
  mcpHttpClients.length = 0;
  const resultados = await Promise.allSettled(clientes.map(item => item.client.close()));
  resultados.forEach((resultado, index) => {
    const nome = clientes[index].nome;
    if (resultado.status === 'fulfilled') console.log(`[MCP] ${nome} desconectado.`);
    else console.warn(`[MCP] Falha ao desconectar ${nome}: ${resultado.reason instanceof Error ? resultado.reason.message : String(resultado.reason)}`);
  });
}

/** Conecta um servidor MCP remoto genérico via Streamable HTTP. */
export async function conectarMCP(config: McpServerConfig): Promise<Client> {
  if (!Array.isArray(config.allowedTools) || config.allowedTools.length === 0) {
    throw new Error(`MCP ${config.name}: allowedTools deve conter ao menos uma tool`);
  }

  if (config.transport === 'stdio') {
    if (!config.command) throw new Error(`MCP ${config.name}: command nao definido`);
    const client = new Client({ name: 'officeboy', version: '1.0.0' });
    try {
      await client.connect(new StdioClientTransport({ command: config.command, args: config.args ?? [] }));
      const { tools } = await client.listTools();
      const permitidas = new Set(config.allowedTools);
      console.log(`[MCP] ${config.name} conectado via stdio: ${tools.filter(tool => permitidas.has(tool.name)).length}/${tools.length} tool(s) permitida(s)`);
      mcpHttpClients.push(client);
      return client;
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
  }

  if (!config.url) throw new Error(`MCP ${config.name}: url nao definida`);
  const endpoint = new URL(config.url);
  if (endpoint.protocol !== 'https:') throw new Error(`MCP ${config.name}: o endpoint deve usar HTTPS`);
  if (config.authentication !== 'none' && !config.token?.trim()) throw new Error(`MCP ${config.name}: token nao definido`);

  const fetchComTimeout: typeof fetch = async (input, init) => {
    if ((init?.method || 'GET').toUpperCase() === 'GET') return fetch(input, init);
    const timeoutSignal = AbortSignal.timeout(REBASE_JOBS_REQUEST_TIMEOUT_MS);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
    return fetch(input, { ...init, signal });
  };
  const client = new Client({ name: 'officeboy', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(endpoint, {
      fetch: fetchComTimeout,
      requestInit: config.authentication === 'none' ? undefined : { headers: { Authorization: `Bearer ${config.token?.trim()}` } },
    }));
    const { tools } = await client.listTools();
    const permitidas = new Set(config.allowedTools);
    const disponiveis = tools.filter(tool => permitidas.has(tool.name));
    console.log(`[MCP] ${config.name} conectado: ${disponiveis.length}/${tools.length} tool(s) permitida(s)`);
    mcpHttpClients.push(client);
    return client;
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
}

export const conectarMCPHTTP = conectarMCP;

/** Conecta ao Rebase Jobs via MCP Streamable HTTP, somente com tools de leitura. */
export async function conectarRebaseJobsMCP(
  url = REBASE_JOBS_MCP_URL,
  token: string,
): Promise<Client> {
  const endpoint = new URL(url);
  if (endpoint.protocol !== 'https:' || endpoint.hostname !== 'rebasedev.com.br') {
    throw new Error('REBASE_JOBS_MCP_URL deve apontar para https://rebasedev.com.br/mcp');
  }
  if (!token.trim()) throw new Error('REBASE_JOBS_TOKEN nao definida');

  console.log(`[MCP] Conectando ao Rebase Jobs: ${endpoint.toString()}`);
  const fetchComTimeout: typeof fetch = async (input, init) => {
    // O GET abre o stream SSE persistente do transporte e não pode ser
    // abortado após 15s. POST/DELETE são requisições pontuais e recebem um
    // limite para evitar travar o run em proxy ou servidor indisponível.
    if ((init?.method || 'GET').toUpperCase() === 'GET') return fetch(input, init);
    const timeoutSignal = AbortSignal.timeout(REBASE_JOBS_REQUEST_TIMEOUT_MS);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
    return fetch(input, { ...init, signal });
  };
  const transport = new StreamableHTTPClientTransport(endpoint, {
    fetch: fetchComTimeout,
    requestInit: {
      headers: { Authorization: `Bearer ${token.trim()}` },
    },
  });
  const client = new Client({ name: 'officeboy', version: '1.0.0' });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const bloqueadas = tools.filter(t => !REBASE_JOBS_READ_ONLY_TOOLS.has(t.name));
    console.log(`[MCP] Rebase Jobs conectado: ${tools.length} tool(s), ${bloqueadas.length} bloqueada(s) por allowlist`);
    rebaseJobsMcpClient = client;
    return client;
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
}

/**
 * Limpeza de abas ao fim de um run, SEM encerrar o Chrome.
 *
 * Por que existe: o modelo costuma "arrumar a casa" no fim do run e fechar
 * as abas que abriu. Como todas as abas da janela sao do bot (perfil
 * dedicado), fechar a ultima ENCERRA O CHROME INTEIRO (exit 0, sem crash) —
 * aconteceu 3x. As tools de fechamento ficam bloqueadas (TOOLS_MCP_BLOQUEADAS
 * em agente.ts) e aqui nos fechamos as abas em excesso, deixando sempre UMA
 * aba de trabalho aberta.
 *
 * Feito via HTTP do DevTools (/json/list + /json/close/<id>) — nao precisa
 * do MCP e nao depende de versao dele. Ignora falhas: limpeza e best-effort.
 */
export async function limparAbasCDP(cdpEndpoint: string): Promise<number> {
  let fechadas = 0;
  try {
    const base = cdpEndpoint.replace(/\/+$/, '');
    const resp = await fetch(`${base}/json/list`);
    if (!resp.ok) return 0;
    const abas = (await resp.json()) as Array<{ id: string; type: string; url: string }>;
    const paginas = abas.filter(a => a.type === 'page');
    if (paginas.length <= 1) return 0;
    // Mantem a ultima aba de trabalho (a mais recente); descarta o resto.
    for (const aba of paginas.slice(0, -1)) {
      try {
        await fetch(`${base}/json/close/${aba.id}`);
        fechadas++;
      } catch { /* best-effort por aba */ }
    }
  } catch { /* CDP indisponivel: nada a fazer */ }
  return fechadas;
}

export function getMCPClient(): Client {
  if (!mcpClient) {
    throw new Error('MCP Client nao inicializado. Chame conectarPlaywrightMCP() primeiro.');
  }
  return mcpClient;
}

/**
 * Monta o comando de spawn do Playwright MCP.
 *
 * Ordem de preferência:
 * 1. `PLAYWRIGHT_MCP_BIN` (imagem Docker — binário pré-instalado, sem download);
 * 2. `@playwright/mcp` resolvido do `node_modules` local (dependência do projeto);
 * 3. `npx @playwright/mcp@<pin>` (fallback — baixa da rede, como antes).
 *
 * A versão é sempre pinada (nunca @latest): baixar código novo a cada execução
 * é um vetor de supply chain com acesso ao seu navegador/CDP.
 */
export function montarComandoMCP(
  cdpEndpoint: string,
  overrideBin?: string | null,
): { command: string; args: string[] } {
  const binLocal = overrideBin !== undefined ? overrideBin : (process.env.PLAYWRIGHT_MCP_BIN || resolverBinLocal());

  if (binLocal && existsSync(binLocal)) {
    return { command: process.execPath, args: [binLocal, '--cdp-endpoint', cdpEndpoint] };
  }

  return {
    command: 'npx',
    args: [`@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}`, '--cdp-endpoint', cdpEndpoint],
  };
}

/** Resolve o binário do `@playwright/mcp` instalado como dependência (ou null). */
function resolverBinLocal(): string | null {
  try {
    const requireLocal = createRequire(import.meta.url);
    const pkgPath = requireLocal.resolve('@playwright/mcp/package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as {
      bin?: string | Record<string, string>;
    };
    const rel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.['playwright-mcp'];
    if (!rel) return null;
    const full = path.join(path.dirname(pkgPath), rel);
    return existsSync(full) ? full : null;
  } catch {
    return null;
  }
}
