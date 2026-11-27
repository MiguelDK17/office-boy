import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import {
  conectarRebaseJobsMCP,
  montarComandoMCP,
  PLAYWRIGHT_MCP_VERSION,
  REBASE_JOBS_MCP_URL,
  REBASE_JOBS_REQUEST_TIMEOUT_MS,
  REBASE_JOBS_READ_ONLY_TOOLS,
} from '../src/mcp-client';

const requireLocal = createRequire(import.meta.url);
const binReal = requireLocal.resolve('@playwright/mcp/package.json').replace(/package\.json$/, 'cli.js');

describe('montarComandoMCP — binário local vs npx', () => {
  it('usa o binário local (node + cli.js) quando disponível — sem download em runtime', () => {
    // Cenário: binário pré-instalado (imagem Docker ou dependência local)
    const bin = binReal;

    // Ação
    const { command, args } = montarComandoMCP('http://127.0.0.1:9222', bin);

    // Validação
    expect(command).toBe(process.execPath);
    expect(args).toEqual([bin, '--cdp-endpoint', 'http://127.0.0.1:9222']);
  });

  it('cai para npx com versão pinada quando não há binário local', () => {
    // Cenário: sem binário (dev local sem a dependência instalada)
    // Ação
    const { command, args } = montarComandoMCP('http://127.0.0.1:9222', '/inexistente/cli.js');

    // Validação: nunca @latest — sempre a versão pinada
    expect(command).toBe('npx');
    expect(args).toEqual([
      `@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}`,
      '--cdp-endpoint',
      'http://127.0.0.1:9222',
    ]);
    expect(PLAYWRIGHT_MCP_VERSION).toBe('0.0.70');
  });

  it('resolve o binário do node_modules local sem override', () => {
    // Cenário: dependência instalada no projeto (pós yarn add)
    // Ação
    const { command, args } = montarComandoMCP('http://127.0.0.1:9222');

    // Validação
    expect(command).toBe(process.execPath);
    expect(args[0]).toMatch(/@playwright\/mcp\/cli\.js$/);
    expect(args.slice(1)).toEqual(['--cdp-endpoint', 'http://127.0.0.1:9222']);
  });
});

describe('Rebase Jobs MCP — configuração segura', () => {
  it('usa o endpoint oficial como padrão e expõe somente tools de leitura', () => {
    expect(REBASE_JOBS_MCP_URL).toBe('https://rebasedev.com.br/mcp');
    expect([...REBASE_JOBS_READ_ONLY_TOOLS]).toEqual(['buscar_vagas', 'ver_vaga', 'sobre_o_catalogo']);
    expect(REBASE_JOBS_REQUEST_TIMEOUT_MS).toBe(15_000);
  });

  it('recusa endpoint HTTP ou host diferente antes de fazer rede', async () => {
    await expect(conectarRebaseJobsMCP('http://127.0.0.1:9999/mcp', 'token'))
      .rejects.toThrow(/https:\/\/rebasedev\.com\.br\/mcp/);
    await expect(conectarRebaseJobsMCP('https://example.com/mcp', 'token'))
      .rejects.toThrow(/https:\/\/rebasedev\.com\.br\/mcp/);
  });

  it('recusa token vazio antes de fazer rede', async () => {
    await expect(conectarRebaseJobsMCP(undefined, '  '))
      .rejects.toThrow(/REBASE_JOBS_TOKEN/);
  });
});
