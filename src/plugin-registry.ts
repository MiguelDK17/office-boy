import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export type PluginTransport = 'streamable-http' | 'stdio';
export type PluginScope = 'read' | 'discovery' | 'queue' | 'apply';
export type PluginSettingType = 'text' | 'secret' | 'boolean' | 'number';

export interface PluginSetting {
  key: string;
  envKey: string;
  label: string;
  type: PluginSettingType;
  hint?: string;
  required?: boolean;
  default?: string | number | boolean;
}

export interface PluginTool {
  name: string;
  scope: PluginScope;
}

export interface PluginManifest {
  id: string;
  version: string;
  name: string;
  description: string;
  connection: {
    transport: PluginTransport;
    url?: string;
    command?: string;
    args?: string[];
    authentication?: 'bearer' | 'none';
  };
  settings: PluginSetting[];
  tools: PluginTool[];
}

export interface PluginInfo {
  manifest: PluginManifest;
  path: string;
  enabled: boolean;
  configured: boolean;
  connectionStatus: 'inactive' | 'invalid' | 'ready' | 'connected' | 'error';
  settings: Array<PluginSetting & { defined: boolean; value?: string | number | boolean }>;
}

type PluginState = Record<string, Record<string, string>>;

export const PLUGINS_DIR = process.env.OFFICEBOY_PLUGINS_DIR
  ? path.resolve(process.env.OFFICEBOY_PLUGINS_DIR)
  : path.resolve(__dirname, '..', 'plugins');
const STATE_FILE = path.join(PLUGINS_DIR, '.state.json');

const ID_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const SETTING_KEY_RE = /^[a-z][A-Za-z0-9_-]{0,63}$/;
const ENV_RE = /^[A-Z][A-Z0-9_]{1,127}$/;

function erroManifesto(motivo: string): Error {
  return new Error(`Manifesto de plugin inválido: ${motivo}`);
}

function lerEstado(): PluginState {
  try {
    const valor = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as unknown;
    if (!valor || typeof valor !== 'object' || Array.isArray(valor)) return {};
    return Object.fromEntries(Object.entries(valor as Record<string, unknown>).flatMap(([id, settings]) => {
      if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return [];
      const normalizados = Object.fromEntries(Object.entries(settings as Record<string, unknown>)
        .filter(([, value]) => typeof value === 'string')
        .map(([key, value]) => [key, String(value)]));
      return [[id, normalizados]];
    }));
  } catch {
    return {};
  }
}

function gravarEstado(estado: PluginState): void {
  mkdirSync(PLUGINS_DIR, { recursive: true });
  const temporario = `${STATE_FILE}.tmp`;
  writeFileSync(temporario, JSON.stringify(estado, null, 2), { mode: 0o600 });
  renameSync(temporario, STATE_FILE);
}

export function validarManifesto(valor: unknown): PluginManifest {
  if (!valor || typeof valor !== 'object' || Array.isArray(valor)) throw erroManifesto('deve ser um objeto');
  const v = valor as Record<string, unknown>;
  if (typeof v.id !== 'string' || !ID_RE.test(v.id)) throw erroManifesto('id inválido');
  if (typeof v.version !== 'string' || !/^\d+\.\d+\.\d+([-.][0-9A-Za-z.-]+)?$/.test(v.version)) throw erroManifesto('version inválida');
  if (typeof v.name !== 'string' || !v.name.trim()) throw erroManifesto('name obrigatório');
  if (typeof v.description !== 'string') throw erroManifesto('description obrigatório');

  const connection = v.connection as Record<string, unknown> | undefined;
  if (!connection || (connection.transport !== 'streamable-http' && connection.transport !== 'stdio')) {
    throw erroManifesto('connection.transport deve ser streamable-http ou stdio');
  }
  if (connection.transport === 'streamable-http' && typeof connection.url !== 'string') {
    throw erroManifesto('connection.url obrigatório para streamable-http');
  }
  if (connection.transport === 'stdio' && typeof connection.command !== 'string') {
    throw erroManifesto('connection.command obrigatório para stdio');
  }
  if (connection.args !== undefined && (!Array.isArray(connection.args) || connection.args.some(a => typeof a !== 'string'))) {
    throw erroManifesto('connection.args deve ser uma lista de strings');
  }
  if (connection.authentication !== undefined && connection.authentication !== 'bearer' && connection.authentication !== 'none') {
    throw erroManifesto('connection.authentication deve ser bearer ou none');
  }

  const settings = Array.isArray(v.settings) ? v.settings : [];
  const chaves = new Set<string>();
  const settingsNormalizados = settings.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw erroManifesto('setting inválido');
    const s = raw as Record<string, unknown>;
    if (typeof s.key !== 'string' || !SETTING_KEY_RE.test(s.key)) throw erroManifesto('setting.key inválido');
    if (chaves.has(s.key)) throw erroManifesto(`setting duplicado: ${s.key}`);
    chaves.add(s.key);
    const pluginPrefix = `PLUGIN_${String(v.id).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_`;
    const legadoRebase = v.id === 'rebase-jobs' && typeof s.envKey === 'string' && s.envKey.startsWith('REBASE_JOBS_');
    if (typeof s.envKey !== 'string' || !ENV_RE.test(s.envKey) || (!s.envKey.startsWith(pluginPrefix) && !legadoRebase)) {
      throw erroManifesto(`setting.envKey deve usar o namespace ${pluginPrefix}: ${s.key}`);
    }
    if (!['text', 'secret', 'boolean', 'number'].includes(String(s.type))) throw erroManifesto(`setting.type inválido: ${s.key}`);
    return {
      key: s.key,
      envKey: s.envKey,
      label: typeof s.label === 'string' && s.label.trim() ? s.label : s.key,
      type: s.type as PluginSettingType,
      ...(typeof s.hint === 'string' ? { hint: s.hint } : {}),
      ...(typeof s.required === 'boolean' ? { required: s.required } : {}),
      ...(typeof s.default === 'string' || typeof s.default === 'number' || typeof s.default === 'boolean' ? { default: s.default } : {}),
    };
  });

  const enabledSetting = settingsNormalizados.find(setting => setting.key === 'enabled');
  if (!enabledSetting || enabledSetting.type !== 'boolean') throw erroManifesto('setting booleano enabled obrigatório');
  if (enabledSetting.default === true) {
    throw erroManifesto('plugin não pode iniciar ativo por padrão');
  }

  if (!Array.isArray(v.tools)) throw erroManifesto('tools deve ser uma lista');
  const tools = v.tools.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw erroManifesto('tool inválida');
    const t = raw as Record<string, unknown>;
    if (typeof t.name !== 'string' || !t.name.trim()) throw erroManifesto('tool.name obrigatório');
    if (!['read', 'discovery', 'queue', 'apply'].includes(String(t.scope))) throw erroManifesto(`tool.scope inválido: ${t.name}`);
    return { name: t.name, scope: t.scope as PluginScope };
  });

  return {
    id: v.id,
    version: v.version,
    name: v.name.trim(),
    description: v.description,
    connection: {
      transport: connection.transport,
      ...(typeof connection.url === 'string' ? { url: connection.url } : {}),
      ...(typeof connection.command === 'string' ? { command: connection.command } : {}),
      ...(Array.isArray(connection.args) ? { args: connection.args as string[] } : {}),
      authentication: connection.authentication === 'none' ? 'none' : 'bearer',
    },
    settings: settingsNormalizados,
    tools,
  };
}

function readManifest(dir: string): PluginManifest | null {
  const file = path.join(dir, 'manifest.json');
  if (!existsSync(file) || !statSync(file).isFile()) return null;
  try {
    return validarManifesto(JSON.parse(readFileSync(file, 'utf8')));
  } catch (error) {
    console.warn(`[PLUGIN] Ignorando ${dir}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function rejeitarLinksSimbolicos(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const alvo = path.join(dir, entry.name);
    if (lstatSync(alvo).isSymbolicLink()) throw new Error('ZIP contém link simbólico');
    if (entry.isDirectory()) rejeitarLinksSimbolicos(alvo);
  }
}

function tamanhoArvore(dir: string): number {
  return readdirSync(dir, { withFileTypes: true }).reduce((total, entry) => {
    const alvo = path.join(dir, entry.name);
    return total + (entry.isDirectory() ? tamanhoArvore(alvo) : statSync(alvo).size);
  }, 0);
}

function valorSetting(pluginId: string, setting: PluginSetting): { defined: boolean; value?: string | number | boolean } {
  const persistido = lerEstado()[pluginId]?.[setting.key];
  const bruto = process.env[setting.envKey] ?? persistido;
  if (bruto === undefined || bruto === '') {
    return setting.default === undefined ? { defined: false } : { defined: true, value: setting.default };
  }
  if (setting.type === 'secret') return { defined: true };
  if (setting.type === 'boolean') return bruto === 'true' || bruto === 'false'
    ? { defined: true, value: bruto === 'true' }
    : { defined: false };
  if (setting.type === 'number') {
    const numero = Number(bruto);
    return Number.isFinite(numero) ? { defined: true, value: numero } : { defined: false };
  }
  return { defined: true, value: bruto };
}

function infoPlugin(manifest: PluginManifest, dir: string): PluginInfo {
  const estado = lerEstado()[manifest.id] ?? {};
  for (const setting of manifest.settings) {
    if (process.env[setting.envKey] === undefined && estado[setting.key] !== undefined) process.env[setting.envKey] = estado[setting.key];
  }
  const settings = manifest.settings.map(setting => ({ ...setting, ...valorSetting(manifest.id, setting) }));
  const enabledSetting = settings.find(setting => setting.key === 'enabled' || setting.envKey.endsWith('_ENABLED'));
  const enabled = enabledSetting ? enabledSetting.value === true : false;
  const configured = manifest.settings.filter(setting => setting.required).every(setting => valorSetting(manifest.id, setting).defined);
  const statusPersistido = estado.$connectionStatus;
  const connectionStatus = !enabled ? 'inactive' : !configured ? 'invalid'
    : statusPersistido === 'connected' || statusPersistido === 'error' ? statusPersistido : 'ready';
  return { manifest, path: dir, enabled, configured, connectionStatus, settings };
}

export function listarPlugins(): PluginInfo[] {
  if (!existsSync(PLUGINS_DIR)) return [];
  const ids = new Set<string>();
  return readdirSync(PLUGINS_DIR, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .map(entry => {
      const dir = path.join(PLUGINS_DIR, entry.name);
      const manifest = readManifest(dir);
      if (manifest && manifest.id !== entry.name) {
        console.warn(`[PLUGIN] Ignorando ${dir}: diretório deve usar o mesmo id do manifesto`);
        return null;
      }
      if (manifest && ids.has(manifest.id)) {
        console.warn(`[PLUGIN] Ignorando ${dir}: id duplicado ${manifest.id}`);
        return null;
      }
      if (manifest) ids.add(manifest.id);
      return manifest ? infoPlugin(manifest, dir) : null;
    })
    .filter((plugin): plugin is PluginInfo => plugin !== null);
}

export function obterPlugin(id: string): PluginInfo | null {
  return listarPlugins().find(plugin => plugin.manifest.id === id) ?? null;
}

export async function instalarPluginZip(base64: string): Promise<PluginInfo> {
  return instalarOuAtualizarPluginZip(base64, false);
}

export async function atualizarPluginZip(base64: string): Promise<PluginInfo> {
  return instalarOuAtualizarPluginZip(base64, true);
}

async function instalarOuAtualizarPluginZip(base64: string, substituir: boolean): Promise<PluginInfo> {
  const buffer = Buffer.from(base64, 'base64');
  if (buffer.length === 0 || buffer.length > 5 * 1024 * 1024) throw new Error('Plugin ZIP vazio ou maior que 5 MB');
  mkdirSync(PLUGINS_DIR, { recursive: true });
  const temp = mkdtempSync(path.join(PLUGINS_DIR, '.install-'));
  const zip = path.join(temp, 'plugin.zip');
  const extract = path.join(temp, 'extract');
  mkdirSync(extract);
  try {
    writeFileSync(zip, buffer, { mode: 0o600 });
    const { stdout: names } = await execFileAsync('unzip', ['-Z1', zip], { maxBuffer: 512 * 1024 });
    for (const name of names.split('\n').map(n => n.trim()).filter(Boolean)) {
      if (name.startsWith('/') || name.includes('..') || name.includes('\\')) throw new Error('ZIP contém caminho inseguro');
    }
    await execFileAsync('unzip', ['-q', zip, '-d', extract], { maxBuffer: 512 * 1024 });
    rejeitarLinksSimbolicos(extract);
    if (tamanhoArvore(extract) > 20 * 1024 * 1024) throw new Error('Plugin descompactado maior que 20 MB');
    const arquivos = readdirRecursivo(extract).map(arquivo => path.relative(extract, arquivo));
    if (arquivos.some(arquivo => !/^(manifest\.json|[^/]+\.(json|ya?ml|toml|md|txt))$/i.test(arquivo))) {
      throw new Error('ZIP contém arquivo não declarativo; somente manifest.json e recursos .json/.yaml/.yml/.toml/.md/.txt são permitidos');
    }
    const manifest = readManifest(extract);
    if (!manifest) throw erroManifesto('manifest.json deve ficar na raiz do ZIP');
    const destino = path.join(PLUGINS_DIR, manifest.id);
    const estadoAnterior = lerEstado()[manifest.id] ?? {};
    // Um diretório órfão pode existir após uma instalação interrompida ou após
    // a remoção manual do manifesto. Só tratamos como duplicado quando há um
    // plugin válido instalado; diretórios inválidos podem ser substituídos
    // pela instalação validada atual.
    const pluginExistente = existsSync(destino) ? readManifest(destino) : null;
    if (pluginExistente && !substituir) throw new Error(`Plugin já instalado: ${manifest.id}`);
    const backup = path.join(PLUGINS_DIR, `.backup-${manifest.id}-${Date.now()}`);
    if (existsSync(destino)) renameSync(destino, backup);
    try {
      renameSync(extract, destino);
      if (existsSync(backup)) rmSync(backup, { recursive: true, force: true });
    } catch (error) {
      if (existsSync(destino)) rmSync(destino, { recursive: true, force: true });
      if (existsSync(backup)) renameSync(backup, destino);
      throw error;
    }
    const estado = lerEstado();
    estado[manifest.id] = {
      ...(estado[manifest.id] ?? {}),
      enabled: substituir ? (estadoAnterior.enabled ?? 'false') : 'false',
      ...(substituir && estadoAnterior.$connectionStatus ? { $connectionStatus: estadoAnterior.$connectionStatus } : {}),
    };
    gravarEstado(estado);
    return infoPlugin(manifest, destino);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function readdirRecursivo(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const alvo = path.join(dir, entry.name);
    return entry.isDirectory() ? readdirRecursivo(alvo) : [alvo];
  });
}

export function persistirPluginConfig(id: string, valores: Record<string, string>): PluginInfo {
  const plugin = obterPlugin(id);
  if (!plugin) throw new Error(`Plugin não encontrado: ${id}`);
  const estado = lerEstado();
  const atual = { ...(estado[id] ?? {}) };
  for (const setting of plugin.manifest.settings) {
    if (!Object.prototype.hasOwnProperty.call(valores, setting.key)) continue;
    const value = valores[setting.key];
    if (setting.type === 'boolean' && value !== 'true' && value !== 'false') throw new Error(`Valor booleano inválido: ${setting.key}`);
    if (setting.type === 'number' && !Number.isFinite(Number(value))) throw new Error(`Valor numérico inválido: ${setting.key}`);
    if (setting.type === 'secret' && value.trim() === '') continue;
    atual[setting.key] = value;
    process.env[setting.envKey] = value;
  }
  estado[id] = atual;
  if (atual.enabled === 'false') atual.$connectionStatus = 'inactive';
  else if (atual.enabled === 'true') atual.$connectionStatus = 'ready';
  gravarEstado(estado);
  return infoPlugin(plugin.manifest, plugin.path);
}

export function atualizarStatusPlugin(id: string, status: 'connected' | 'error'): void {
  const plugin = obterPlugin(id);
  if (!plugin) return;
  const estado = lerEstado();
  estado[id] = { ...(estado[id] ?? {}), $connectionStatus: status };
  gravarEstado(estado);
}

export function alterarPlugin(id: string, enabled: boolean): PluginInfo {
  const plugin = obterPlugin(id);
  if (!plugin) throw new Error(`Plugin não encontrado: ${id}`);
  const setting = plugin.manifest.settings.find(s => s.key === 'enabled' || s.envKey.endsWith('_ENABLED'));
  if (!setting) throw new Error(`Plugin ${id} não declara setting enabled`);
  if (enabled && !plugin.configured) throw new Error(`Plugin ${id} requer configuração válida antes da ativação`);
  return persistirPluginConfig(id, { [setting.key]: String(enabled) });
}

