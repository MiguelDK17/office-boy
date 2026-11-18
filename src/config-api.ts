// API DE CONFIGURAÇÃO (/api/config) — perfil, respostas, sites, currículos e .env.
//
// Responsabilidades:
//   1. GET  /api/config                    → configs reais (JSON) + campos de .env
//                                            (secrets NUNCA saem daqui — só "definido")
//   2. PUT  /api/config/perfil             → grava config/perfil.json (merge sobre o atual)
//   3. PUT  /api/config/respostas          → grava config/respostas.json (merge, preserva _chaves)
//   4. PUT  /api/config/sites              → grava config/sites.json (validado)
//   5. PUT  /api/config/curriculos         → grava config/curriculos.json (validado)
//   6. PUT  /api/config/env                → atualiza o .env (whitelist; reiniciar o bot depois)
//
// Segurança: secrets só recebem SUBSTITUIÇÃO quando o valor chega não-vazio —
// nunca são devolvidos, nunca são apagados por campo vazio da UI. Escrita de
// JSON é atômica (tmp + rename) para não corromper config com um crash no meio.

import http from 'http';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { log } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Diretórios sobrescrevíveis via OFFICEBOY_DATA_DIR — usados pelos testes de
// integração (isolam config/ e curriculos/ num tmp) sem tocar os dados reais.
const baseDados = process.env.OFFICEBOY_DATA_DIR
  ? path.resolve(process.env.OFFICEBOY_DATA_DIR)
  : null;
const DIR_CONFIG = baseDados ? path.join(baseDados, 'config') : path.resolve(__dirname, '..', 'config');
const ARQ_ENV = baseDados ? path.join(baseDados, '.env') : path.resolve(__dirname, '..', '.env');

// ========== CAMPOS DE .env EXPOSTOS NA UI (whitelist) ==========

export type GrupoEnv = 'execucao' | 'agente' | 'auxiliar' | 'servidor' | 'notificacoes' | 'cron';
type TipoEnv = 'numero' | 'booleano' | 'texto';

interface CampoEnv {
  chave: string;
  tipo: TipoEnv;
  grupo: GrupoEnv;
  secreto?: boolean;
  somenteLeitura?: boolean;
}

// O que a UI vê/edita. Tudo fora desta lista é invisível para o front —
// variáveis novas do .env continuam funcionando, só não aparecem na tela.
const CAMPOS_ENV: CampoEnv[] = [
  // Execução
  { chave: 'LIMITE_DIARIO', tipo: 'numero', grupo: 'execucao' },
  { chave: 'MAX_POR_EXECUCAO', tipo: 'numero', grupo: 'execucao' },
  { chave: 'MAX_ITERACOES', tipo: 'numero', grupo: 'execucao' },
  { chave: 'META_CANDIDATURAS', tipo: 'numero', grupo: 'execucao' },
  { chave: 'SCORE_MINIMO', tipo: 'numero', grupo: 'execucao' },
  { chave: 'CUSTO_MAX_USD', tipo: 'numero', grupo: 'execucao' },
  { chave: 'DELAY_MIN', tipo: 'numero', grupo: 'execucao' },
  { chave: 'DELAY_MAX', tipo: 'numero', grupo: 'execucao' },
  { chave: 'DRY_RUN', tipo: 'booleano', grupo: 'execucao' },
  { chave: 'PAUSAR_EM_LOGIN', tipo: 'booleano', grupo: 'execucao' },
  // Agente de navegação (OpenRouter-first: OpenAI é apenas um dos provedores)
  { chave: 'AGENT_LLM_BASE_URL', tipo: 'texto', grupo: 'agente' },
  { chave: 'AGENT_LLM_MODEL', tipo: 'texto', grupo: 'agente' },
  { chave: 'AGENT_LLM_API_KEY', tipo: 'texto', secreto: true, grupo: 'agente' },
  // LLM auxiliar (currículo/cover letter/mensagem)
  { chave: 'LLM_AUX_PROVIDER', tipo: 'texto', grupo: 'auxiliar' },
  { chave: 'LLM_AUX_MODEL', tipo: 'texto', grupo: 'auxiliar' },
  { chave: 'OPENAI_BASE_URL', tipo: 'texto', grupo: 'auxiliar' },
  { chave: 'OPENAI_API_KEY', tipo: 'texto', secreto: true, grupo: 'auxiliar' },
  { chave: 'OLLAMA_URL', tipo: 'texto', grupo: 'auxiliar' },
  // Fallback automático do modelo auxiliar (ver src/llm-adapter.ts — o
  // agente NÃO usa Gemini; quando o provedor principal falha, tenta Gemini)
  { chave: 'GEMINI_MODEL', tipo: 'texto', grupo: 'auxiliar' },
  { chave: 'GEMINI_API_KEY', tipo: 'texto', secreto: true, grupo: 'auxiliar' },
  // Servidor (portas vêm do docker compose — somente leitura)
  { chave: 'BOT_UI_PORT', tipo: 'numero', somenteLeitura: true, grupo: 'servidor' },
  { chave: 'BOT_NOVNC_PORT', tipo: 'numero', somenteLeitura: true, grupo: 'servidor' },
  { chave: 'BOT_CDP_PORT', tipo: 'numero', somenteLeitura: true, grupo: 'servidor' },
  { chave: 'DASHBOARD_PORT', tipo: 'numero', somenteLeitura: true, grupo: 'servidor' },
  // DASHBOARD_HOST e CDP_ENDPOINT são sobrescritos pelo environment: do
  // docker compose (que vence o env_file) — editar na UI não teria efeito.
  { chave: 'DASHBOARD_HOST', tipo: 'texto', somenteLeitura: true, grupo: 'servidor' },
  { chave: 'CDP_ENDPOINT', tipo: 'texto', somenteLeitura: true, grupo: 'servidor' },
  { chave: 'DASHBOARD_TOKEN', tipo: 'texto', secreto: true, grupo: 'servidor' },
  { chave: 'CONTROL_MODE', tipo: 'booleano', somenteLeitura: true, grupo: 'servidor' },
  // Notificações
  { chave: 'TELEGRAM_BOT_TOKEN', tipo: 'texto', secreto: true, grupo: 'notificacoes' },
  { chave: 'TELEGRAM_CHAT_ID', tipo: 'texto', secreto: true, grupo: 'notificacoes' },
  { chave: 'SMTP_HOST', tipo: 'texto', grupo: 'notificacoes' },
  { chave: 'SMTP_PORT', tipo: 'numero', grupo: 'notificacoes' },
  { chave: 'SMTP_USER', tipo: 'texto', grupo: 'notificacoes' },
  { chave: 'SMTP_PASS', tipo: 'texto', secreto: true, grupo: 'notificacoes' },
  { chave: 'EMAIL_DESTINATARIO', tipo: 'texto', grupo: 'notificacoes' },
  // Agendamento
  { chave: 'CRON_ATIVO', tipo: 'booleano', grupo: 'cron' },
  { chave: 'CRON_HORARIO', tipo: 'texto', grupo: 'cron' },
];

const CHAVES_ENV = new Set(CAMPOS_ENV.map(c => c.chave));

// ========== HELPERS ==========

function lerJSON<T>(caminho: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(caminho, 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

/** Escrita atômica: escreve em .tmp e rename — crash no meio não corrompe. */
function gravarJSONAtomico(caminho: string, valor: unknown): void {
  const tmp = `${caminho}.tmp`;
  writeFileSync(tmp, JSON.stringify(valor, null, 2), 'utf-8');
  renameSync(tmp, caminho);
}

/** Normaliza um campo de lista para string[] (aceita string separada por vírgula). */
function listaDe(valor: unknown): string[] {
  if (Array.isArray(valor)) return valor.map(String);
  if (typeof valor === 'string' && valor.trim()) {
    return valor.split(',').map(s => s.trim()).filter(Boolean);
  }
  return [];
}

/** Converte o valor do process.env para o tipo declarado do campo. */
function valorEnv(campo: CampoEnv): { valor: string | number | boolean | null; definido: boolean } {
  const cru = process.env[campo.chave];
  const definido = cru !== undefined && cru !== '';
  if (campo.secreto) return { valor: null, definido };
  if (!definido) return { valor: null, definido: false };
  switch (campo.tipo) {
    case 'numero': {
      const n = Number(cru);
      return { valor: Number.isFinite(n) ? n : null, definido: true };
    }
    case 'booleano':
      return { valor: cru === 'true', definido: true };
    default:
      return { valor: String(cru), definido: true };
  }
}

// ========== VALIDAÇÕES DE ESCRITA ==========

const TIPOS_SITE = new Set(['portal_vagas', 'linkedin', 'empresa_direta']);

function validarSites(corpo: unknown): { ok: boolean; sites?: { nome: string; tipo: string; instrucoes: string; urls_busca: string[]; ativo: boolean }[]; motivo?: string } {
  const sites = (corpo as { sites?: unknown })?.sites;
  if (!Array.isArray(sites)) return { ok: false, motivo: 'Body precisa de { sites: [...] }' };
  const validos: {
    nome: string;
    tipo: string;
    instrucoes: string;
    urls_busca: string[];
    ativo: boolean;
  }[] = [];
  for (const s of sites) {
    const nome = String((s as { nome?: unknown })?.nome ?? '').trim();
    const tipo = String((s as { tipo?: unknown })?.tipo ?? '').trim();
    if (!nome) return { ok: false, motivo: 'Todo site precisa de nome' };
    if (!TIPOS_SITE.has(tipo)) return { ok: false, motivo: `Tipo invalido para ${nome}: ${tipo}` };
    validos.push({
      nome,
      tipo,
      instrucoes: String((s as { instrucoes?: unknown })?.instrucoes ?? ''),
      urls_busca: listaDe((s as { urls_busca?: unknown })?.urls_busca),
      ativo: Boolean((s as { ativo?: unknown })?.ativo),
    });
  }
  return { ok: true, sites: validos };
}

function validarCurriculos(corpo: unknown): {
  ok: boolean;
  dados?: { fallback: Record<string, string>; curriculos: Record<string, string>[] };
  motivo?: string;
} {
  const c = corpo as { fallback?: unknown; curriculos?: unknown };
  if (!c || typeof c !== 'object') return { ok: false, motivo: 'Body invalido' };
  const curriculos = Array.isArray(c.curriculos) ? c.curriculos : null;
  if (!curriculos) return { ok: false, motivo: 'Body precisa de { curriculos: [...] }' };
  for (const cur of curriculos) {
    if (!String((cur as { id?: unknown })?.id ?? '').trim()) {
      return { ok: false, motivo: 'Todo curriculo precisa de id' };
    }
  }
  return {
    ok: true,
    dados: {
      fallback: (typeof c.fallback === 'object' && c.fallback !== null ? c.fallback : {}) as Record<string, string>,
      curriculos: curriculos.map(cur => ({
        id: String((cur as { id?: unknown }).id),
        arquivo: String((cur as { arquivo?: unknown })?.arquivo ?? ''),
        foco: String((cur as { foco?: unknown })?.foco ?? ''),
        usar_quando: String((cur as { usar_quando?: unknown })?.usar_quando ?? ''),
      })),
    },
  };
}

/**
 * Atualiza o .env in-place: substitui o valor das chaves conhecidas e anexa as
 * ausentes no fim. Comentários e chaves fora da whitelist são preservados.
 * Secret vazio = pular (nunca apagar por engano).
 *
 * NÃO é atômica de propósito: o .env é bind-mount de arquivo único no compose
 * (./.env:/app/.env), e tmp+rename trocaria o inode — o container continuaria
 * vendo o arquivo velho. A escrita é síncrona e ponta a ponta (sem await no
 * meio), então não há interleaving dentro do processo. O risco residual é
 * crash DO PROCESSO entre truncate e write; aceito e documentado.
 */
function atualizarEnv(valores: Record<string, string>): { ok: boolean; motivo?: string } {
  if (!existsSync(ARQ_ENV)) {
    return { ok: false, motivo: 'Arquivo .env não encontrado neste ambiente (no container ele é injetado pelo docker compose — edite o .env do host e reinicie).' };
  }
  const linhas = readFileSync(ARQ_ENV, 'utf-8').split('\n');
  const pendentes = new Map<string, string>();
  for (const [chave, valor] of Object.entries(valores)) {
    const campo = CAMPOS_ENV.find(c => c.chave === chave);
    if (!campo) return { ok: false, motivo: `Chave fora da whitelist: ${chave}` };
    if (campo.somenteLeitura) return { ok: false, motivo: `${chave} é somente leitura (definida no docker compose)` };
    if (campo.secreto && String(valor).trim() === '') continue; // secreto vazio = mantém o atual
    // \n/\r no valor criaria uma nova linha no .env → injeção de variável
    // arbitrária fora da whitelist. Valores são single-line, ponto.
    if (/[\r\n]/.test(String(valor))) {
      return { ok: false, motivo: `${chave}: valor não pode conter quebra de linha` };
    }
    pendentes.set(chave, String(valor));
  }
  const tocadas = new Set<string>();
  const novas = linhas.map(linha => {
    const m = /^([A-Z][A-Z0-9_]*)=/.exec(linha);
    if (!m || !pendentes.has(m[1])) return linha;
    tocadas.add(m[1]);
    return `${m[1]}=${pendentes.get(m[1])}`;
  });
  for (const [chave, valor] of pendentes) {
    if (!tocadas.has(chave)) novas.push(`${chave}=${valor}`);
  }
  writeFileSync(ARQ_ENV, novas.join('\n'), 'utf-8');
  log('INFO', `Config: .env atualizado (${pendentes.size} chave(s): ${[...pendentes.keys()].join(', ')})`);
  return { ok: true };
}

// ========== CATÁLOGO DE MODELOS (OpenRouter) ==========

interface ModeloResumo {
  name: string;
  id: string;
  free: boolean;
  context: string;
}

let cacheModelos: { url: string; quando: number; dados: ModeloResumo[] } | null = null;

/**
 * Proxy do catálogo /models de um endpoint OpenAI-compatible (o front não tem
 * a chave e o navegador não resolve CORS de todos os provedores). Só aceita
 * https e responde com a lista compacta usada pelo ModelCombobox.
 */
async function carregarCatalogoModelos(baseUrl: string): Promise<{ ok: boolean; modelos?: ModeloResumo[]; motivo?: string }> {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return { ok: false, motivo: 'Endereço de API inválido' };
  }
  if (url.protocol !== 'https:') return { ok: false, motivo: 'Somente endpoints https são suportados no catálogo' };
  // chave pela URL completa (paths diferentes = catálogos diferentes)
  const base = baseUrl.replace(/\/+$/, '');
  if (cacheModelos && cacheModelos.url === base && Date.now() - cacheModelos.quando < 5 * 60_000) {
    return { ok: true, modelos: cacheModelos.dados };
  }
  try {
    const resp = await fetch(`${base}/models`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return { ok: false, motivo: `Catálogo respondeu ${resp.status}` };
    const json = (await resp.json()) as { data?: Array<{ id?: string; name?: string; context_length?: number; pricing?: { prompt?: string } }> };
    const modelos: ModeloResumo[] = (json.data ?? [])
      .filter(m => typeof m.id === 'string')
      .map(m => {
        const precoPrompt = Number(m.pricing?.prompt ?? '1');
        const context = m.context_length ?? 0;
        return {
          id: m.id as string,
          name: m.name ?? (m.id as string),
          free: Number.isFinite(precoPrompt) && precoPrompt === 0,
          context: context >= 1_000_000 ? `${Math.round(context / 100_000) / 10}M` : `${Math.round(context / 1024)}k`,
        };
      });
    if (modelos.length === 0) return { ok: false, motivo: 'Catálogo vazio' };
    cacheModelos = { url: base, quando: Date.now(), dados: modelos };
    return { ok: true, modelos };
  } catch (err) {
    return { ok: false, motivo: `Falha ao consultar ${base}/models — ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ========== CURRÍCULOS: UPLOAD / DOWNLOAD ==========

const DIR_CURRICULOS = baseDados ? path.join(baseDados, 'curriculos') : path.resolve(__dirname, '..', 'curriculos');
const LIMITE_UPLOAD = 15 * 1024 * 1024; // 15 MB (PDF de 10 MB ≈ 13,4 MB em base64)

/** Corpo grande como Buffer (upload de PDF chega em base64 dentro de JSON). */
function lerCorpoGrande(req: http.IncomingMessage, limite: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const pedacos: Buffer[] = [];
    let tamanho = 0;
    let estourou = false;
    req.on('data', (c: Buffer) => {
      if (estourou) return;
      tamanho += c.length;
      if (tamanho > limite) {
        estourou = true;
        pedacos.length = 0;
        return;
      }
      pedacos.push(c);
    });
    req.on('end', () => resolve(estourou ? null : Buffer.concat(pedacos)));
    req.on('error', () => resolve(null));
  });
}

/** id seguro para nome de pasta: [a-z0-9-], 1–48 chars. */
function idSeguro(valor: unknown): string {
  return String(valor ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

/**
 * Grava o PDF enviado pela UI em curriculos/<id>/<nome> e registra (ou
 * atualiza) a entrada em curriculos.json. O "usar_quando" fica vazio para o
 * usuário preencher — é ele que ensina o bot quando usar o currículo.
 */
function salvarArquivoCurriculo(corpo: unknown): { ok: boolean; motivo?: string; entrada?: { id: string; arquivo: string; foco?: string; usar_quando?: string } } {
  const c = corpo as { id?: unknown; nome?: unknown; foco?: unknown; base64?: unknown };
  const id = idSeguro(c?.id);
  if (!id) return { ok: false, motivo: 'Upload precisa de id (slug do currículo)' };
  // Sanitização dura: sem separadores, sem \r\n (viraria header injection no
  // Content-Disposition e derrubaria o processo via writeHead) e sem aspas.
  const nome =
    String(c?.nome ?? 'Curriculo.pdf')
      .replace(/[\r\n"\\[\]]/g, '_')
      .slice(0, 120) || 'Curriculo.pdf';
  if (!/\.(pdf|docx?|txt)$/i.test(nome)) return { ok: false, motivo: 'Formato não suportado (use PDF, DOC ou DOCX)' };
  const bruto = String(c?.base64 ?? '').replace(/^data:[^;]+;base64,/, '').replace(/[^A-Za-z0-9+/=]/g, '');
  if (!bruto) return { ok: false, motivo: 'Upload sem conteúdo de arquivo' };
  const dados = Buffer.from(bruto, 'base64'); // Buffer.from nunca lança; chars inválidos já foram removidos acima
  if (dados.length === 0) return { ok: false, motivo: 'Arquivo vazio' };
  const dirAlvo = path.join(DIR_CURRICULOS, id);
  const arquivo = path.join(dirAlvo, nome);
  try {
    mkdirSync(dirAlvo, { recursive: true });
    writeFileSync(arquivo, dados);
  } catch (err) {
    log('ERRO', `Config: falha ao gravar currículo — ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, motivo: 'Falha ao gravar o arquivo em curriculos/ (permissão?)' };
  }
  const relativo = `./curriculos/${id}/${nome}`;
  const atual = lerJSON<{ fallback?: Record<string, string>; curriculos?: Array<Record<string, string>> }>(
    path.join(DIR_CONFIG, 'curriculos.json'),
    {},
  );
  const lista = Array.isArray(atual.curriculos) ? atual.curriculos : [];
  const existente = lista.findIndex(cur => String(cur?.id) === id);
  const focoSugerido = String(c?.foco ?? '').trim() || nome.replace(/\.[^.]+$/, '');
  // "Trocar" troca só o arquivo — preserva foco e usar_quando escritos pelo
  // usuário (a entrada devolvida é a pós-merge completa; a UI substitui a
  // linha inteira por ela). Entrada nova: foco derivado, usar_quando vazio
  // para o usuário preencher.
  const entrada: Record<string, string> =
    existente >= 0
      ? { ...lista[existente], id, arquivo: relativo }
      : { id, arquivo: relativo, foco: focoSugerido, usar_quando: '' };
  if (existente >= 0) lista[existente] = entrada;
  else lista.push(entrada);
  try {
    gravarJSONAtomico(path.join(DIR_CONFIG, 'curriculos.json'), { ...atual, curriculos: lista });
  } catch (err) {
    log('ERRO', `Config: arquivo gravado mas curriculos.json falhou — ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, motivo: 'Arquivo gravado, mas falha ao atualizar curriculos.json' };
  }
  log('INFO', `Config: currículo "${id}" gravado (${dados.length} bytes) pela UI`);
  return { ok: true, entrada: { ...entrada, id: String(entrada.id), arquivo: String(entrada.arquivo) } };
}

/**
 * Serve o arquivo de um currículo registrado (Visualizar). Resolve o caminho
 * gravado no curriculos.json e GARANTE que fica dentro de curriculos/ — sem
 * isso um id/caminho manipulado leria arquivos arbitrários do disco.
 */
function arquivoCurriculo(idBruto: string): { ok: boolean; caminho?: string; nome?: string; motivo?: string } {
  const id = idSeguro(idBruto);
  if (!id) return { ok: false, motivo: 'id inválido' };
  const atual = lerJSON<{ curriculos?: Array<Record<string, string>> }>(
    path.join(DIR_CONFIG, 'curriculos.json'),
    {},
  );
  const entrada = (atual.curriculos ?? []).find(cur => String(cur?.id) === id);
  const relativo = String(entrada?.arquivo ?? '');
  if (!relativo) return { ok: false, motivo: 'Currículo não encontrado' };
  // resolve relativo à raiz de dados (repo ou OFFICEBOY_DATA_DIR) e GARANTE
  // que fica dentro de curriculos/ — sem isso um caminho manipulado leria
  // arquivos arbitrários do disco
  const base = path.resolve(DIR_CURRICULOS);
  const alvo = path.resolve(DIR_CURRICULOS, '..', relativo.replace(/^\.\//, ''));
  if (!alvo.startsWith(base + path.sep)) return { ok: false, motivo: 'Caminho fora de curriculos/' };
  if (!existsSync(alvo)) return { ok: false, motivo: 'Arquivo não existe no disco' };
  return { ok: true, caminho: alvo, nome: path.basename(alvo) };
}

// ========== ROTEADOR ==========

function responderJSON(res: http.ServerResponse, codigo: number, corpo: unknown): void {
  const dados = JSON.stringify(corpo);
  res.writeHead(codigo, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(dados);
}

function lerCorpo(req: http.IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    let dados = '';
    let estourou = false;
    req.on('data', (c) => {
      if (estourou) return; // descarta o excedente, mas mantém o socket vivo
      dados += c;
      // configs reais cabem em ~6 KB; 100 KB é folga
      if (dados.length > 100_000) {
        estourou = true;
        dados = '';
      }
    });
    req.on('end', () => resolve(estourou ? null : dados));
    req.on('error', () => resolve(estourou ? null : ''));
  });
}

/** Roteia /api/config*. Devolve false se o caminho não for desta API. */
export async function rotearConfig(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  caminho: string,
): Promise<boolean> {
  // Estrito: /api/config exato ou /api/config/<rota> — /api/configfoo é 404.
  if (caminho !== '/api/config' && !caminho.startsWith('/api/config/')) return false;
  const metodo = req.method ?? 'GET';

  // ----- GET: tudo que a UI de Perfil/Configurações precisa, de uma vez -----
  if (caminho === '/api/config' && metodo === 'GET') {
    const perfil = lerJSON<Record<string, unknown>>(path.join(DIR_CONFIG, 'perfil.json'), {});
    const respostas = lerJSON<Record<string, unknown>>(path.join(DIR_CONFIG, 'respostas.json'), {});
    const sites = lerJSON<{ sites: unknown[] }>(path.join(DIR_CONFIG, 'sites.json'), { sites: [] });
    const curriculos = lerJSON<Record<string, unknown>>(path.join(DIR_CONFIG, 'curriculos.json'), {});
    responderJSON(res, 200, {
      perfil,
      respostas,
      sites,
      curriculos,
      env: CAMPOS_ENV.map(campo => ({
        chave: campo.chave,
        grupo: campo.grupo,
        tipo: campo.tipo,
        secreto: Boolean(campo.secreto),
        somenteLeitura: Boolean(campo.somenteLeitura),
        ...valorEnv(campo),
      })),
      envDisponivel: existsSync(ARQ_ENV),
    });
    return true;
  }

  if (metodo !== 'PUT') {
    // ----- GET /api/config/modelos: catálogo OpenRouter p/ ModelCombobox -----
    if (caminho === '/api/config/modelos' && metodo === 'GET') {
      const baseUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
        .searchParams.get('baseUrl') ?? process.env.AGENT_LLM_BASE_URL ?? 'https://openrouter.ai/api/v1';
      const catalogo = await carregarCatalogoModelos(baseUrl);
      if (!catalogo.ok) {
        responderJSON(res, 502, { ok: false, mensagem: catalogo.motivo ?? 'Catálogo indisponível' });
        return true;
      }
      responderJSON(res, 200, { ok: true, modelos: catalogo.modelos });
      return true;
    }
    // ----- GET /api/config/curriculos/arquivo?id=: Visualizar (PDF inline) -----
    if (caminho === '/api/config/curriculos/arquivo' && metodo === 'GET') {
      const id = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`).searchParams.get('id') ?? '';
      const arq = arquivoCurriculo(id);
      if (!arq.ok || !arq.caminho) {
        responderJSON(res, 404, { ok: false, mensagem: arq.motivo ?? 'Currículo não encontrado' });
        return true;
      }
      const conteudo = readFileSync(arq.caminho);
      res.writeHead(200, {
        'Content-Type': /\.pdf$/i.test(arq.nome ?? '') ? 'application/pdf' : 'application/octet-stream',
        'Content-Disposition': `inline; filename="${arq.nome}"`,
        'Content-Length': conteudo.length,
        'Cache-Control': 'no-store',
      });
      res.end(conteudo);
      return true;
    }
    responderJSON(res, 405, { ok: false, mensagem: 'Metodo nao suportado' });
    return true;
  }

  // Escrita de config é a única rota que SUBSTITUI secrets e grava PII —
  // se DASHBOARD_TOKEN estiver definido, PUT exige o header X-Config-Token.
  // (GET continua aberto, no padrão do resto do dashboard — o container
  // exposto em 0.0.0.0 continua sendo um risco documentado no compose.)
  const token = process.env.DASHBOARD_TOKEN;
  if (token) {
    const informado = req.headers['x-config-token'];
    if (informado !== token) {
      responderJSON(res, 403, { ok: false, mensagem: 'X-Config-Token ausente ou incorreto (defina DASHBOARD_TOKEN no .env)' });
      return true;
    }
  }

  // ----- PUT /api/config/curriculos/arquivo: upload de PDF/DOC (JSON base64).
  // Depois do check de token — grava PII (currículo) e substitui arquivos.
  if (caminho === '/api/config/curriculos/arquivo') {
    const bruto = await lerCorpoGrande(req, LIMITE_UPLOAD);
    if (bruto === null) {
      responderJSON(res, 413, { ok: false, mensagem: 'Arquivo maior que 15 MB' });
      return true;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bruto.toString('utf-8'));
    } catch {
      responderJSON(res, 400, { ok: false, mensagem: 'JSON inválido' });
      return true;
    }
    const resultado = salvarArquivoCurriculo(parsed);
    if (!resultado.ok) {
      responderJSON(res, 400, { ok: false, mensagem: resultado.motivo ?? 'Falha no upload' });
      return true;
    }
    responderJSON(res, 200, { ok: true, mensagem: 'Currículo enviado', entrada: resultado.entrada });
    return true;
  }

  const corpo = await lerCorpo(req);
  if (corpo === null) {
    responderJSON(res, 413, { ok: false, mensagem: 'Corpo maior que 100 KB' });
    return true;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(corpo || '{}');
  } catch {
    responderJSON(res, 400, { ok: false, mensagem: 'JSON invalido' });
    return true;
  }

  // ----- PUT /api/config/perfil: merge sobre o arquivo atual -----
  if (caminho === '/api/config/perfil') {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      responderJSON(res, 400, { ok: false, mensagem: 'Body precisa ser um objeto de perfil' });
      return true;
    }
    const atual = lerJSON<Record<string, unknown>>(path.join(DIR_CONFIG, 'perfil.json'), {});
    const p = { ...atual, ...(parsed as Record<string, unknown>) } as Record<string, unknown>;
    // Saneia as listas conhecidas (a UI pode mandar string "a, b" de chips)
    for (const chaveLista of ['stack_principal', 'modelo_trabalho', 'palavras_chave_busca', 'bancos_de_dados', 'metodologias', 'blacklist_empresas', 'blacklist_termos_titulo']) {
      if (chaveLista in p) p[chaveLista] = listaDe(p[chaveLista]);
    }
    if ('anos_experiencia' in p) p.anos_experiencia = Math.max(0, Number(p.anos_experiencia) || 0);
    if ('experiencias' in p && Array.isArray(p.experiencias)) {
      p.experiencias = (p.experiencias as Record<string, unknown>[]).map(e => ({
        empresa: String(e.empresa ?? ''),
        cargo: String(e.cargo ?? ''),
        periodo: String(e.periodo ?? ''),
        descricao: String(e.descricao ?? ''),
      }));
    }
    if ('informacoes_extras' in p && (p.informacoes_extras === null || typeof p.informacoes_extras !== 'object')) {
      p.informacoes_extras = {};
    }
    try {
      gravarJSONAtomico(path.join(DIR_CONFIG, 'perfil.json'), p);
      log('INFO', 'Config: perfil.json atualizado pela UI');
      responderJSON(res, 200, { ok: true, mensagem: 'Perfil salvo' });
    } catch (err) {
      log('ERRO', `Config: falha ao gravar perfil.json — ${err instanceof Error ? err.message : String(err)}`);
      responderJSON(res, 500, { ok: false, mensagem: 'Falha ao gravar perfil.json (permissão de escrita)' });
    }
    return true;
  }

  // ----- PUT /api/config/respostas: merge, preservando chaves internas (_comentario etc.) -----
  if (caminho === '/api/config/respostas') {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      responderJSON(res, 400, { ok: false, mensagem: 'Body precisa ser um objeto de respostas' });
      return true;
    }
    const atual = lerJSON<Record<string, unknown>>(path.join(DIR_CONFIG, 'respostas.json'), {});
    const entrada = parsed as Record<string, unknown>;
    const novo: Record<string, unknown> = { ...atual };
    for (const [chave, valor] of Object.entries(entrada)) {
      if (chave.startsWith('_')) continue; // chaves internas nunca vêm da UI
      novo[chave] = valor === null ? '' : String(valor);
    }
    try {
      gravarJSONAtomico(path.join(DIR_CONFIG, 'respostas.json'), novo);
      log('INFO', 'Config: respostas.json atualizado pela UI');
      responderJSON(res, 200, { ok: true, mensagem: 'Respostas salvas' });
    } catch (err) {
      log('ERRO', `Config: falha ao gravar respostas.json — ${err instanceof Error ? err.message : String(err)}`);
      responderJSON(res, 500, { ok: false, mensagem: 'Falha ao gravar respostas.json (permissão de escrita)' });
    }
    return true;
  }

  // ----- PUT /api/config/sites -----
  if (caminho === '/api/config/sites') {
    const v = validarSites(parsed);
    if (!v.ok) {
      responderJSON(res, 400, { ok: false, mensagem: v.motivo ?? 'Sites invalidos' });
      return true;
    }
    try {
      gravarJSONAtomico(path.join(DIR_CONFIG, 'sites.json'), { sites: v.sites });
      log('INFO', 'Config: sites.json atualizado pela UI');
      responderJSON(res, 200, { ok: true, mensagem: 'Sites salvos' });
    } catch (err) {
      log('ERRO', `Config: falha ao gravar sites.json — ${err instanceof Error ? err.message : String(err)}`);
      responderJSON(res, 500, { ok: false, mensagem: 'Falha ao gravar sites.json (permissão de escrita)' });
    }
    return true;
  }

  // ----- PUT /api/config/curriculos -----
  if (caminho === '/api/config/curriculos') {
    const v = validarCurriculos(parsed);
    if (!v.ok) {
      responderJSON(res, 400, { ok: false, mensagem: v.motivo ?? 'Curriculos invalidos' });
      return true;
    }
    try {
      gravarJSONAtomico(path.join(DIR_CONFIG, 'curriculos.json'), v.dados);
      log('INFO', 'Config: curriculos.json atualizado pela UI');
      responderJSON(res, 200, { ok: true, mensagem: 'Currículos salvos' });
    } catch (err) {
      log('ERRO', `Config: falha ao gravar curriculos.json — ${err instanceof Error ? err.message : String(err)}`);
      responderJSON(res, 500, { ok: false, mensagem: 'Falha ao gravar curriculos.json (permissão de escrita)' });
    }
    return true;
  }

  // ----- PUT /api/config/env: whitelist, secret vazio = preserva -----
  if (caminho === '/api/config/env') {
    const valores = (parsed as { valores?: Record<string, unknown> })?.valores;
    if (!valores || typeof valores !== 'object') {
      responderJSON(res, 400, { ok: false, mensagem: 'Body precisa de { valores: {...} }' });
      return true;
    }
    const limpos: Record<string, string> = {};
    for (const [chave, valor] of Object.entries(valores)) {
      if (!CHAVES_ENV.has(chave)) {
        responderJSON(res, 400, { ok: false, mensagem: `Chave fora da whitelist: ${chave}` });
        return true;
      }
      limpos[chave] = String(valor ?? '');
    }
    const resultado = atualizarEnv(limpos);
    if (!resultado.ok) {
      responderJSON(res, 409, { ok: false, mensagem: resultado.motivo ?? 'Falha ao atualizar .env' });
      return true;
    }
    // .env só é lido na inicialização — a UI mostra o banner de reinicialização.
    responderJSON(res, 200, { ok: true, mensagem: 'Configurações salvas. Reinicie o bot para aplicar.', reiniciar: true });
    return true;
  }

  responderJSON(res, 404, { ok: false, mensagem: 'Rota de config desconhecida' });
  return true;
}
