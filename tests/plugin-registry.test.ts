import { describe, expect, it } from 'vitest';
import { listarPlugins, validarManifesto } from '../src/plugin-registry';

describe('plugin registry', () => {
  it('valida settings camelCase e escopos MCP', () => {
    const manifesto = validarManifesto({
      id: 'exemplo',
      version: '1.0.0',
      name: 'Exemplo',
      description: 'Plugin de teste',
      connection: { transport: 'streamable-http', url: 'https://example.com/mcp' },
      settings: [
        { key: 'enabled', envKey: 'PLUGIN_EXEMPLO_ENABLED', label: 'Ativo', type: 'boolean', default: false },
        { key: 'apiToken', envKey: 'PLUGIN_EXEMPLO_API_TOKEN', label: 'Token', type: 'secret', required: true },
      ],
      tools: [{ name: 'buscar', scope: 'discovery' }],
    });
    expect(manifesto.settings.find((setting) => setting.key === 'apiToken')?.key).toBe('apiToken');
    expect(manifesto.tools[0].scope).toBe('discovery');
  });

  it('aceita manifesto sem tools e lista o plugin oficial', () => {
    expect(() => validarManifesto({
      id: 'inseguro', version: '1.0.0', name: 'Inseguro', description: '',
      connection: { transport: 'stdio', command: 'node' }, settings: [], tools: [],
    })).toThrow(/enabled obrigatório/);
    expect(listarPlugins().some(plugin => plugin.manifest.id === 'rebase-jobs')).toBe(true);
  });
});
