// Contrato da API DE CONFIGURAÇÃO (/api/config) — telas de Perfil e
// Configurações da UI. Secrets nunca saem do backend; escrita de JSON é
// atômica; .env é atualizado in-place com whitelist e comentários preservados.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('api/config — contrato', () => {
  const configApi = readFileSync(path.resolve(__dirname, '..', 'src', 'config-api.ts'), 'utf-8');
  const control = readFileSync(path.resolve(__dirname, '..', 'src', 'control-server.ts'), 'utf-8');
  const api = readFileSync(path.resolve(__dirname, '..', 'web', 'src', 'lib', 'api.ts'), 'utf-8');
  const app = readFileSync(path.resolve(__dirname, '..', 'web', 'src', 'App.tsx'), 'utf-8');

  it('GET nunca devolve o valor de um secret (só definido true/false)', () => {
    expect(configApi).toMatch(/if \(campo\.secreto\) return \{ valor: null, definido \}/);
  });

  it('escrita de JSON é atômica (tmp + rename) — crash não corrompe config', () => {
    expect(configApi).toMatch(/writeFileSync\(tmp, JSON\.stringify\(valor, null, 2\)[\s\S]*renameSync\(tmp, caminho\)/);
  });

  it('.env é atualizado in-place: whitelist, secreto vazio = preserva, comentarios intactos', () => {
    expect(configApi).toMatch(/Chave fora da whitelist/);
    expect(configApi).toMatch(/if \(campo\.secreto && String\(valor\)\.trim\(\) === ''\) continue/);
    // Substituição linha a linha preserva o resto do arquivo (comentários).
    expect(configApi).toContain('.exec(linha)');
  });

  it('os configs reais editáveis são perfil/respostas/sites/curriculos — todos com PUT', () => {
    for (const rota of ['perfil', 'respostas', 'sites', 'curriculos', 'env']) {
      expect(configApi).toContain(`/api/config/${rota}`);
    }
    for (const fn of ['carregarConfiguracao', 'salvarPerfil', 'salvarRespostas', 'salvarSites', 'salvarCurriculos', 'salvarEnv']) {
      expect(api).toContain(fn);
    }
  });

  it('o control server roteia /api/config antes das rotas de run', () => {
    expect(control).toContain('rotearConfig');
    const rotaConfig = control.indexOf('rotearConfig(req, res, caminho)');
    const rotaStart = control.indexOf("'/api/start' && req.method === 'POST'");
    expect(rotaConfig).toBeGreaterThan(-1);
    expect(rotaConfig).toBeLessThan(rotaStart);
  });

  it('a UI tem as 3 abas (Run/Perfil/Configurações) e sem artefatos do Figma', () => {
    expect(app).toContain('main-tabs');
    expect(app).toMatch(/type ActiveTab = "run" \| "profile" \| "settings"/);
    expect(app).not.toContain('frame-label');
    expect(app).not.toContain('lottie-placeholder');
  });

  it('OpenRouter-first: o card do agente não mais fala "compatível com a API OpenAI" como dono', () => {
    const settings = readFileSync(
      path.resolve(__dirname, '..', 'web', 'src', 'screens', 'SettingsScreen.tsx'),
      'utf-8',
    );
    expect(settings).toMatch(/Modelo principal via OpenRouter/);
    // Gemini legado do agente saiu da tela (o agente não usa mais; o auxiliar continua).
    expect(settings).not.toContain('GEMINI_MODEL');
  });
});
