// Auto-restart ao salvar .env: decisão, whitelist de reaplicação e rotas.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'http';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';

let dir: string;
let arquivoEnv: string;
let servidor: http.Server;
let base: string;
let rotearConfig: typeof import('../src/config-api')['rotearConfig'];

beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'officeboy-env-'));
  mkdirSync(path.join(dir, 'config'));
  arquivoEnv = path.join(dir, '.env');
  writeFileSync(arquivoEnv, 'AGENT_LLM_MODEL=modelo-antigo\nLIMITE_DIARIO=10\n');
  vi.stubEnv('OFFICEBOY_DATA_DIR', dir);
  vi.stubEnv('DASHBOARD_TOKEN', '');
  vi.stubEnv('CONTROL_MODE', 'true');
  vi.resetModules();
  rotearConfig = (await import('../src/config-api')).rotearConfig;

  servidor = http.createServer(async (req, res) => {
    const caminho = (req.url ?? '/').split('?')[0];
    // Simula "bot em run" — o caso parado é coberto pela função pura abaixo
    // (não podemos deixar o teste chamar process.exit de propósito).
    if (await rotearConfig(req, res, caminho, { rodando: () => true })) return;
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => servidor.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((r) => servidor.close(() => r()));
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe('deveReiniciarAutomaticamente', () => {
  it('reinicia só com bot parado, dentro do Docker e em CONTROL_MODE', async () => {
    const { deveReiniciarAutomaticamente } = await import('../src/config-api');
    expect(deveReiniciarAutomaticamente(false, true)).toBe(true);
    expect(deveReiniciarAutomaticamente(true, true)).toBe(false);
    expect(deveReiniciarAutomaticamente(false, false)).toBe(false);
    vi.stubEnv('CONTROL_MODE', 'false');
    expect(deveReiniciarAutomaticamente(false, true)).toBe(false);
    vi.stubEnv('CONTROL_MODE', 'true');
  });

  it('devolve o MOTIVO exato para cada situação', async () => {
    const { motivoSemReinicio } = await import('../src/config-api');
    vi.stubEnv('OFFICEBOY_AUTO_RESTART', '');
    expect(motivoSemReinicio(true, true)).toBe('rodando');
    expect(motivoSemReinicio(false, false)).toBe('sem-supervisor');
    vi.stubEnv('OFFICEBOY_AUTO_RESTART', 'true');
    vi.stubEnv('CONTROL_MODE', 'false');
    expect(motivoSemReinicio(false, true)).toBe('sem-control-mode');
    vi.stubEnv('CONTROL_MODE', 'true');
    vi.stubEnv('OFFICEBOY_AUTO_RESTART', 'true');
    expect(motivoSemReinicio(false, true)).toBeNull();
  });

  it('OFFICEBOY_AUTO_RESTART força o comportamento (systemd, fora do Docker)', async () => {
    const { deveReiniciarAutomaticamente } = await import('../src/config-api');
    vi.stubEnv('OFFICEBOY_AUTO_RESTART', 'true');
    expect(deveReiniciarAutomaticamente(false, false)).toBe(true);
    expect(deveReiniciarAutomaticamente(true, false)).toBe(false);
    vi.stubEnv('OFFICEBOY_AUTO_RESTART', 'false');
    expect(deveReiniciarAutomaticamente(false, true)).toBe(false);
  });
});

describe('chavesEnvParaReaplicar', () => {
  it('reaplica só chaves editáveis — nunca as de infraestrutura do Compose', async () => {
    const { chavesEnvParaReaplicar } = await import('../src/config-api');
    const resultado = chavesEnvParaReaplicar([
      'AGENT_LLM_MODEL=modelo-novo',
      'AGENT_LLM_API_KEY=sk-teste',
      'LIMITE_DIARIO=25',
      'DASHBOARD_HOST=0.0.0.0',
      'CDP_ENDPOINT=http://127.0.0.1:9222',
      'CONTROL_MODE=true',
      'DASHBOARD_PORT=1717',
      'BOT_UI_PORT=1717',
    ].join('\n'));

    expect(resultado).toEqual({
      AGENT_LLM_MODEL: 'modelo-novo',
      AGENT_LLM_API_KEY: 'sk-teste',
      LIMITE_DIARIO: '25',
    });
    // Nenhuma chave marcada como somenteLeitura pode entrar no override.
    for (const chave of ['DASHBOARD_HOST', 'CDP_ENDPOINT', 'CONTROL_MODE', 'DASHBOARD_PORT', 'BOT_UI_PORT']) {
      expect(chave in resultado).toBe(false);
    }
  });
});

describe('contrato de bootId entre backend e UI', () => {
  it('/api/status expõe bootId; o polling só aceita o processo novo', () => {
    const raiz = path.resolve(__dirname, '..');
    const ctrl = readFileSync(path.join(raiz, 'src', 'control-server.ts'), 'utf-8');
    const tela = readFileSync(path.join(raiz, 'web', 'src', 'screens', 'SettingsScreen.tsx'), 'utf-8');
    const api = readFileSync(path.join(raiz, 'web', 'src', 'lib', 'api.ts'), 'utf-8');

    expect(ctrl).toContain('bootId: BOOT_ID');
    expect(tela).toContain('dados.bootId !== bootIdEsperado');
    // Token pode ter mudado no restart — o cache precisa ser invalidado.
    expect(tela).toContain('invalidateTokenConfig()');
    expect(api).toContain('export function invalidateTokenConfig');
    // Escrita tenta de novo se o token cacheado ficou velho.
    expect(api).toContain('X-Config-Token');
  });
});

describe('PUT /api/config/env com bot em execução', () => {
  it('grava o .env mas NÃO pede reinício automático', async () => {
    const resp = await fetch(base + '/api/config/env', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ valores: { AGENT_LLM_MODEL: 'modelo-novo' } }),
    });
    const dados = (await resp.json()) as {
      reiniciando?: boolean;
      motivo?: string;
      bootId?: string;
      mensagem?: string;
    };
    expect(resp.status).toBe(200);
    expect(dados.reiniciando).toBe(false);
    expect(dados.motivo).toBe('rodando');
    expect(dados.bootId).toBeTruthy();
    expect(dados.mensagem).toContain('run');
    expect(readFileSync(arquivoEnv, 'utf-8')).toContain('AGENT_LLM_MODEL=modelo-novo');
  });

  it('rejeita chave de infraestrutura (fora da whitelist editável)', async () => {
    const resp = await fetch(base + '/api/config/env', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ valores: { DASHBOARD_HOST: '0.0.0.0' } }),
    });
    expect(resp.status).toBe(400);
    expect(readFileSync(arquivoEnv, 'utf-8')).not.toContain('0.0.0.0');
  });
});
