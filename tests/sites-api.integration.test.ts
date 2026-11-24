// Integração das rotas /api/sites/:id/* com arquivo isolado em tmp.
// Cobre o que os testes puros não alcançam: status HTTP, guarda de origem,
// token, limite de corpo compatível com 50 URLs longas e escrita cirúrgica.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';

let dir: string;
let arquivo: string;
let servidor: http.Server;
let base: string;
let modulo: typeof import('../src/sites-api');

const cfgInicial = () => ({
  sites: [
    {
      nome: 'Gupy',
      tipo: 'portal_vagas',
      instrucoes: 'instrucoes originais',
      urls_busca: ['https://gupy.example/a'],
      ativo: true,
      id: '04c009ed-7dca-4bf6-9495-f7df0000c90e',
      campoExtra: 'preservar',
    },
    {
      nome: 'LinkedIn',
      tipo: 'linkedin',
      instrucoes: 'outra instrucao',
      urls_busca: ['https://linkedin.example/b'],
      ativo: false,
      id: '94b3411c-023d-49f1-a4c2-b5e9aef08f34',
    },
  ],
  chaveTopo: 'preservar',
});

beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'officeboy-sites-'));
  mkdirSync(path.join(dir, 'config'));
  arquivo = path.join(dir, 'config', 'sites.json');
  writeFileSync(arquivo, JSON.stringify(cfgInicial(), null, 2));
  vi.stubEnv('OFFICEBOY_DATA_DIR', dir);
  vi.stubEnv('DASHBOARD_TOKEN', '');
  vi.resetModules();
  modulo = await import('../src/sites-api');

  servidor = http.createServer(async (req, res) => {
    const caminho = (req.url ?? '/').split('?')[0];
    if (await modulo.rotearSites(req, res, caminho, { rodando: () => false })) return;
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

async function req(
  method: string,
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const resp = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: resp.status, json: (await resp.json()) as Record<string, unknown> };
}

const idGupy = '04c009ed-7dca-4bf6-9495-f7df0000c90e';

/** fetch do Node ignora o header Host — usa http.request para testar a guarda. */
function reqComHost(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const corpo = JSON.stringify({ ativo: false });
    const r = http.request(
      {
        hostname: '127.0.0.1',
        port: (servidor.address() as AddressInfo).port,
        path: `/api/sites/${idGupy}/ativo`,
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Host: host, 'Content-Length': Buffer.byteLength(corpo) },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    r.on('error', reject);
    r.end(corpo);
  });
}

describe('rotas /api/sites/:id/* — integração', () => {
  it('GET devolve urls do site e 404 para id desconhecido', async () => {
    const ok = await req('GET', `/api/sites/${idGupy}/urls`);
    expect(ok.status).toBe(200);
    expect(ok.json.urls).toEqual(['https://gupy.example/a']);
    expect((ok.json.site as { nome: string }).nome).toBe('Gupy');
    expect((await req('GET', '/api/sites/nao-existe/urls')).status).toBe(404);
  });

  it('PUT altera somente urls do site alvo, preservando campos e outros sites', async () => {
    const resp = await req('PUT', `/api/sites/${idGupy}/urls`, { urls: [' https://nova.example/x '] });
    expect(resp.status).toBe(200);
    expect(resp.json.urls).toEqual(['https://nova.example/x']);

    const cfg = JSON.parse(readFileSync(arquivo, 'utf-8'));
    expect(cfg.chaveTopo).toBe('preservar');
    expect(cfg.sites[0]).toMatchObject({
      id: idGupy,
      nome: 'Gupy',
      tipo: 'portal_vagas',
      instrucoes: 'instrucoes originais',
      ativo: true,
      campoExtra: 'preservar',
      urls_busca: ['https://nova.example/x'],
    });
    expect(cfg.sites[1]).toEqual(cfgInicial().sites[1]);
  });

  it('PATCH altera somente o ativo e grava backup antes da primeira escrita', async () => {
    expect(existsSync(`${arquivo}.bak`)).toBe(false);
    const resp = await req('PATCH', `/api/sites/${idGupy}/ativo`, { ativo: false });
    expect(resp.status).toBe(200);
    expect(existsSync(`${arquivo}.bak`)).toBe(true);
    expect(JSON.parse(readFileSync(`${arquivo}.bak`, 'utf-8'))).toEqual(cfgInicial());
    expect(JSON.parse(readFileSync(arquivo, 'utf-8')).sites[0].ativo).toBe(false);
  });

  it('aceita 50 URLs no tamanho máximo (payload acima do limite antigo de 100 KB)', async () => {
    const urls = Array.from({ length: 50 }, (_, i) => `https://example.com/${i}/${'a'.repeat(2000)}`);
    expect(JSON.stringify({ urls }).length).toBeGreaterThan(100_000);
    const resp = await req('PUT', `/api/sites/${idGupy}/urls`, { urls });
    expect(resp.status).toBe(200);
    expect(JSON.parse(readFileSync(arquivo, 'utf-8')).sites[0].urls_busca).toHaveLength(50);
  });

  it('rejeita Host remoto e Origin remoto com 403', async () => {
    expect(await reqComHost('evil.example:1717')).toBe(403);

    const origem = await req('PATCH', `/api/sites/${idGupy}/ativo`, { ativo: false }, {
      Origin: 'https://evil.example',
    });
    expect(origem.status).toBe(403);
    // nada foi gravado
    expect(JSON.parse(readFileSync(arquivo, 'utf-8')).sites[0].ativo).toBe(true);
  });

  it('exige X-Config-Token quando DASHBOARD_TOKEN está definido', async () => {
    vi.stubEnv('DASHBOARD_TOKEN', 'segredo-de-teste');
    const sem = await req('PATCH', `/api/sites/${idGupy}/ativo`, { ativo: false });
    expect(sem.status).toBe(403);
    expect((sem.json.mensagem as string)).toContain('X-Config-Token');

    const com = await req('PATCH', `/api/sites/${idGupy}/ativo`, { ativo: false }, {
      'X-Config-Token': 'segredo-de-teste',
    });
    expect(com.status).toBe(200);
  });

  it('rejeita metodo nao suportado com 405', async () => {
    const resp = await req('DELETE', `/api/sites/${idGupy}/urls`);
    expect(resp.status).toBe(405);
  });
});
