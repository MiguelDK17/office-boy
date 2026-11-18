// Testes de INTEGRAÇÃO do upload/download de currículos
// (/api/config/curriculos/arquivo) — rodam num servidor real com os dados
// isolados em tmp via OFFICEBOY_DATA_DIR, cobrindo as correções da revisão:
//   • upload exige X-Config-Token quando DASHBOARD_TOKEN está definido (B1)
//   • "Trocar" preserva foco e usar_quando da entrada (I3)
//   • nome de arquivo com \r\n" é sanitizado (sem header injection, I1)
//   • path traversal no GET continua bloqueado

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

process.env.OFFICEBOY_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'officeboy-upload-'));
// token definido para TODOS os testes deste arquivo — o upload exige o header
process.env.DASHBOARD_TOKEN = 'token-de-teste';

// import dinâmico: os diretórios são resolvidos no carregamento do módulo
const { rotearConfig } = await import('../src/config-api');

const dados = process.env.OFFICEBOY_DATA_DIR;
const PDF = '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< >>\n%%EOF';

let servidor: Server;
let porta = 0;

beforeAll(async () => {
  mkdirSync(path.join(dados!, 'config'), { recursive: true });
  // currículo pré-existente com foco/usar_quando escritos pelo "usuário"
  mkdirSync(path.join(dados!, 'curriculos', 'android'), { recursive: true });
  writeFileSync(path.join(dados!, 'curriculos', 'android', 'antigo.pdf'), PDF);
  writeFileSync(
    path.join(dados!, 'config', 'curriculos.json'),
    JSON.stringify({ curriculos: [{ id: 'android', arquivo: './curriculos/android/antigo.pdf', foco: 'Android sênior', usar_quando: 'Vagas mobile' }] }),
  );
  servidor = createServer(async (req, res) => {
    const caminho = new URL(req.url ?? '/', `http://localhost`).pathname;
    const tratado = await rotearConfig(req, res, caminho);
    if (!tratado) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((r) => servidor.listen(0, '127.0.0.1', () => r()));
  porta = (servidor.address() as AddressInfo).port;
});

afterAll(async () => {
  servidor.closeAllConnections?.();
  await new Promise<void>((r) => servidor!.close(() => r()));
  rmSync(dados!, { recursive: true, force: true });
});

function put(caminho: string, body: unknown, token?: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${porta}${caminho}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Config-Token': token } : {}) },
    body: JSON.stringify(body),
  });
}

describe('upload de currículo (PUT /api/config/curriculos/arquivo)', () => {
  it('SEM X-Config-Token responde 403 (bloqueador B1 — rota depois do check de token)', async () => {
    const r = await put('/api/config/curriculos/arquivo', { id: 'novo', nome: 'X.pdf', base64: btoa(PDF) });
    expect(r.status).toBe(403);
    const j = await r.json() as { ok: boolean };
    expect(j.ok).toBe(false);
  });

  it('token errado também é 403', async () => {
    const r = await put('/api/config/curriculos/arquivo', { id: 'novo', nome: 'X.pdf', base64: btoa(PDF) }, 'errado');
    expect(r.status).toBe(403);
  });

  it('com token grava e registra em curriculos.json', async () => {
    const r = await put('/api/config/curriculos/arquivo', { id: 'novo', nome: 'Novo.pdf', base64: btoa(PDF) }, 'token-de-teste');
    expect(r.status).toBe(200);
    const j = await r.json() as { ok: boolean; entrada: { id: string; arquivo: string; usar_quando: string } };
    expect(j.ok).toBe(true);
    expect(j.entrada.usar_quando).toBe('');
    const disco = path.join(dados!, 'curriculos', 'novo', 'Novo.pdf');
    expect(readFileSync(disco, 'utf-8')).toContain('%PDF');
  });

  it('"Trocar" (mesmo id) preserva foco e usar_quando escritos pelo usuário (I3)', async () => {
    const r = await put('/api/config/curriculos/arquivo', { id: 'android', nome: 'Novo-v2.pdf', base64: btoa(PDF) }, 'token-de-teste');
    expect(r.status).toBe(200);
    const j = await r.json() as { entrada: { arquivo: string; foco: string; usar_quando: string } };
    expect(j.entrada.arquivo).toBe('./curriculos/android/Novo-v2.pdf');
    expect(j.entrada.foco).toBe('Android sênior');
    expect(j.entrada.usar_quando).toBe('Vagas mobile');
    const emDisco = JSON.parse(readFileSync(path.join(dados!, 'config', 'curriculos.json'), 'utf-8'));
    const android = emDisco.curriculos.find((c: { id: string }) => c.id === 'android');
    expect(android.usar_quando).toBe('Vagas mobile');
    expect(android.foco).toBe('Android sênior');
  });

  it('nome de arquivo com \\n é sanitizado — GET não quebra o servidor (I1)', async () => {
    const r = await put('/api/config/curriculos/arquivo', { id: 'linha', nome: 'mau\nmalicioso.pdf', base64: btoa(PDF) }, 'token-de-teste');
    expect(r.status).toBe(200);
    const j = await r.json() as { entrada: { arquivo: string } };
    expect(j.entrada.arquivo).not.toMatch(/[\r\n]/);
    const g = await fetch(`http://127.0.0.1:${porta}/api/config/curriculos/arquivo?id=linha`);
    expect(g.status).toBe(200);
    const cd = g.headers.get('content-disposition') ?? '';
    expect(cd).not.toMatch(/[\r\n]/);
    await g.arrayBuffer();
  });

  it('GET com id de path traversal continua 404 (nunca lê fora de curriculos/)', async () => {
    const r = await fetch(`http://127.0.0.1:${porta}/api/config/curriculos/arquivo?id=..%2F..%2Fconfig%2Fcurriculos.json`);
    expect(r.status).toBe(404);
    await r.arrayBuffer();
  });
});
