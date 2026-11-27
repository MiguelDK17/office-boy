// Control Server — a UI que comanda o bot.
//
// Antes, subir o container já rodava o agente (gastando cota sem ninguém
// pedir). Agora o container sobe SÓ este servidor: ele serve o dashboard e
// espera o usuário mandar rodar.
//
// Arquitetura: o control server é o PAI e roda o bot como PROCESSO FILHO
// (`node dist/index.js`). Assim o run tem ciclo de vida próprio (pode ser
// parado, ter seu exit code consultado) e a UI sobrevive entre execuções.
//
// Endpoints:
//   GET  /             → front React (web/dist; sem build → redirect /legacy)
//   GET  /legacy       → dashboard HTML antigo (até a nova UI ser validada)
//   GET  /api/status   → estado do run (rodando, pid, custo, dry-run)
//   GET  /api/data     → métricas, funil e candidaturas recentes (JSON)
//   GET  /api/logs     → últimas linhas de log do run
//   GET  /events       → SSE: snapshot + log/estado/progresso ao vivo
//   GET  /api/config   → perfil, respostas, sites, currículos e .env (mascarado)
//   PUT  /api/config/* → grava perfil/respostas/sites/curriculos/env (ver config-api.ts)
//   POST /api/start    → inicia o bot ({ dryRun?: boolean, maxIteracoes?: number })
//   POST /api/stop     → para o bot em andamento

import http from 'http';
import { spawn, type ChildProcess } from 'child_process';
import path from 'path';
import { existsSync, readFileSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import { log } from './logger.js';
import { inicializarBanco, fecharBanco, contarCandidaturasDesde, listarCandidaturas, obterEstatisticas } from './database.js';
import { gerarHTML } from './dashboard.js';
import { BOOT_ID, registrarAoReiniciar, rotearConfig } from './config-api.js';
import { migrarIdsSites, rotearSites } from './sites-api.js';
import { origemLocalPermitida } from './local-origin.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Front React (web/dist). Se o build ainda não existir, "/" cai no dashboard
// legado — permite rodar o backend sem precisar do front compilado.
const WEB_DIST = path.resolve(__dirname, '..', 'web', 'dist');

const MAX_LINHAS_LOG = 400;
/** Clientes conectados no stream SSE /events. */
const clientesSse = new Set<http.ServerResponse>();

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
  '.woff2': 'font/woff2',
};

// Teto de iteracoes configurável na UI (PADRAO_MAX_ITERACOES = fallback do .env,
// 500 quando o .env não define; clamp: 1 evita run de 0 iteracoes, teto de
// 5000 é a guarda intencional contra um run sem fim por engano).
const PADRAO_MAX_ITERACOES = parseInt(process.env.MAX_ITERACOES || '500', 10) || 500;
const MAX_ITERACOES_TETO = 5000;

// Meta de candidaturas de qualidade configurável na UI (PADRAO_META =
// fallback do .env, 10 quando não define; 0 = desativada; teto de 1000 é
// guarda contra valor absurdo vindo da UI).
const PADRAO_META_CANDIDATURAS = Math.max(parseInt(process.env.META_CANDIDATURAS || '10', 10) || 0, 0);

function saneiaMetaCandidaturas(valor: unknown): number {
  const n = Math.floor(Number(valor));
  if (!Number.isFinite(n)) return PADRAO_META_CANDIDATURAS;
  return Math.min(Math.max(n, 0), 1000);
}

function saneiaMaxIteracoes(valor: unknown): number {
  const n = Math.floor(Number(valor));
  if (!Number.isFinite(n)) return PADRAO_MAX_ITERACOES;
  return Math.min(Math.max(n, 1), MAX_ITERACOES_TETO);
}

interface EstadoRun {
  rodando: boolean;
  parando: boolean;
  /** Run em pausa (SIGUSR2 ao filho) — processo vivo, aguardando retomada. */
  pausado: boolean;
  /** Motivo da pausa: 'login' = automática por página de login; null = manual. */
  motivoPausa: 'login' | null;
  pid: number | null;
  iniciadoEm: string | null;
  encerradoEm: string | null;
  codigoSaida: number | null;
  dryRun: boolean;
  origem: string | null;
  linhas: string[];
  ultimoCusto: number | null;
  /** Progresso do loop do agente, extraído das linhas "Iteracao N/M". */
  iteracaoAtual: number;
  iteracaoTotal: number;
  modo: 'full' | 'discovery' | 'apply';
}

const estado: EstadoRun = {
  rodando: false,
  parando: false,
  pausado: false,
  motivoPausa: null,
  pid: null,
  iniciadoEm: null,
  encerradoEm: null,
  codigoSaida: null,
  // Produção é o padrão; dry-run precisa ser escolhido explicitamente na UI
  // ou via DRY_RUN=true.
  dryRun: false,
  origem: null,
  linhas: [],
  ultimoCusto: null,
  iteracaoAtual: 0,
  iteracaoTotal: 0,
  modo: 'full',
};

let processo: ChildProcess | null = null;

function controleAutorizado(req: http.IncomingMessage, exigeToken = false): boolean {
  const configurado = (process.env.DASHBOARD_TOKEN || '').trim();
  const bearer = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  const apresentado = req.headers['x-config-token'] || bearer;
  if (exigeToken && !configurado) return false;
  if (configurado) return typeof apresentado === 'string' && apresentado === configurado;
  return origemLocalPermitida(req);
}

// Prazo para o bot encerrar após o SIGTERM (parada suave). Ele termina a
// iteração atual antes de sair — isso pode levar alguns minutos (chamada LLM
// + tool calls de navegador). Se estourar o prazo (iteração travada), escala
// para SIGKILL. Ajustável via PARADA_GRACIOSA_TIMEOUT_MS.
const PARADA_GRACIOSA_TIMEOUT_MS = (() => {
  const n = parseInt(process.env.PARADA_GRACIOSA_TIMEOUT_MS || '300000', 10);
  return Number.isFinite(n) && n > 0 ? n : 300000;
})();
let prazoParadaGraciosa: NodeJS.Timeout | null = null;

/** Comando para rodar o bot: build (dist) em produção, tsx em desenvolvimento. */
function comandoDoBot(): { command: string; args: string[] } {
  const entry = process.argv[1] ?? '';
  if (entry.endsWith('.ts')) {
    return { command: 'npx', args: ['tsx', path.resolve(__dirname, 'index.ts')] };
  }
  return { command: process.execPath, args: [path.resolve(__dirname, 'index.js')] };
}

function registrarLinha(linha: string): void {
  const limpa = linha.replace(/\x1b\[[0-9;]*m/g, '').trimEnd();
  if (!limpa) return;
  estado.linhas.push(limpa);
  if (estado.linhas.length > MAX_LINHAS_LOG) {
    estado.linhas.splice(0, estado.linhas.length - MAX_LINHAS_LOG);
  }
  // Custo aparece no resumo final do run ("Custo tokens: $0.0165 USD").
  const m = limpa.match(/Custo tokens:\s*\$([0-9.]+)/);
  if (m) {
    const v = parseFloat(m[1]);
    if (!Number.isNaN(v)) estado.ultimoCusto = v;
  }
  // Progresso do loop do agente ("Iteracao 12/500") — alimenta o contador da
  // run na UI sem tocar na lógica do bot.
  const it = limpa.match(/Iteracao (\d+)\/(\d+)/);
  if (it) {
    const atual = parseInt(it[1], 10);
    const total = parseInt(it[2], 10);
    if (Number.isFinite(atual) && Number.isFinite(total) && (atual !== estado.iteracaoAtual || total !== estado.iteracaoTotal)) {
      estado.iteracaoAtual = atual;
      estado.iteracaoTotal = total;
      emitirSse('progresso', {
        iteracaoAtual: estado.iteracaoAtual,
        iteracaoTotal: estado.iteracaoTotal,
        candidaturasDaRun: contarCandidaturasDaRun(),
      });
    }
  }
  // Confirmação de pausa/retomada vindas do próprio agente (o estado
  // `pausado` é setado otimisticamente no POST e confirmado aqui).
  // `motivoPausa` distingue a pausa manual ("Pausar" da UI) da pausa
  // AUTOMÁTICA por página de login — a UI usa para mostrar a instrução
  // "faça login no Chrome" e tocar o som de atenção.
  if (/Run pausada/.test(limpa)) {
    estado.pausado = true;
    broadcastEstado();
  } else if (/Run retomada/.test(limpa)) {
    estado.pausado = false;
    estado.motivoPausa = null;
    broadcastEstado();
  }
  if (/PAGINA DE LOGIN detectada/.test(limpa)) {
    estado.motivoPausa = 'login';
    broadcastEstado();
  }
  emitirSse('log', { linha: limpa });
}

// ========== SSE (/events) ==========
//
// Tempo real para a UI nova (React): log ao vivo, progresso da run e
// mudanças de estado — sem polling e sem alterar a lógica do bot.
// Formato: `event: <nome>\ndata: <json>\n\n`.

function emitirSse(evento: string, dados: unknown): void {
  if (clientesSse.size === 0) return;
  const payload = `event: ${evento}\ndata: ${JSON.stringify(dados)}\n\n`;
  for (const cliente of clientesSse) {
    try {
      cliente.write(payload);
    } catch {
      // Cliente morto: o handler de 'close' o remove em seguida.
      clientesSse.delete(cliente);
    }
  }
}

function broadcastEstado(): void {
  emitirSse('estado', {
    rodando: estado.rodando,
    parando: estado.parando,
    pausado: estado.pausado,
    motivoPausa: estado.motivoPausa,
    pid: estado.pid,
    iniciadoEm: estado.iniciadoEm,
    encerradoEm: estado.encerradoEm,
    codigoSaida: estado.codigoSaida,
    dryRun: estado.dryRun,
    ultimoCusto: estado.ultimoCusto,
    iteracaoAtual: estado.iteracaoAtual,
    iteracaoTotal: estado.iteracaoTotal,
    modo: estado.modo,
  });
}

/** Candidaturas registradas no banco desde o início do run (inclui dry-run). */
function contarCandidaturasDaRun(): number {
  if (!estado.iniciadoEm) return 0;
  return contarCandidaturasDesde(
    new Date(estado.iniciadoEm).toLocaleString('sv-SE').replace('T', ' '),
  );
}

/**
 * Inicia o bot como processo filho. Retorna false se já houver um rodando.
 *
 * Gate de navegador: sem navegador conectado, um run só gastaria tokens
 * (e tempo) até falhar em todas as tools. Como o Chrome é persistente no
 * container, o caso "navegador caiu" é exatamente o cenário que o watchdog
 * resolve — aqui recusamos o run com uma mensagem clara.
 */
export async function iniciarRun(
  dryRun?: boolean,
  maxIteracoes?: number,
  metaCandidaturas?: number,
  modo?: 'full' | 'discovery' | 'apply',
): Promise<{ ok: boolean; motivo?: string; maxIteracoes?: number; metaCandidaturas?: number }> {
  if (estado.rodando) return { ok: false, motivo: 'Já existe um run em andamento' };

  const modoRun = modo ?? (process.env.OFFICEBOY_MODE === 'apply'
    ? 'apply'
    : process.env.OFFICEBOY_MODE === 'discovery' ? 'discovery' : 'full');
  const nav = modoRun === 'discovery' ? null : await consultarNavegador();
  if (nav && !nav.conectado) {
    const motivo = `Navegador indisponível em ${nav.endpoint} — o Chrome não está respondendo. `
      + 'Verifique o container (docker compose logs) e tente de novo em instantes.';
    log('WARN', `Control: run recusado — ${motivo}`);
    return { ok: false, motivo };
  }

  const { command, args } = comandoDoBot();
  const usarDryRun = dryRun ?? (process.env.DRY_RUN === 'true');
  const limiteIteracoes = saneiaMaxIteracoes(maxIteracoes);
  const meta = saneiaMetaCandidaturas(metaCandidaturas);

  estado.rodando = true;
  estado.parando = false;
  estado.pausado = false;
  estado.motivoPausa = null;
  estado.dryRun = usarDryRun;
  estado.pid = null;
  estado.iniciadoEm = new Date().toISOString();
  estado.encerradoEm = null;
  estado.codigoSaida = null;
  estado.ultimoCusto = null;
  estado.origem = 'ui';
  estado.iteracaoAtual = 0;
  estado.iteracaoTotal = limiteIteracoes;
  estado.modo = modoRun;

  // O filho NÃO sobe dashboard (esta porta já é do control server) e roda em
  // modo agente normal. MAX_ITERACOES e META_CANDIDATURAS sobrescrevem o .env
  // — têm precedência porque são os valores explicitamente escolhidos na UI
  // para ESTE run.
  const env = {
    ...process.env,
    DASHBOARD_ENABLED: 'false',
    CONTROL_MODE: 'false',
    DRY_RUN: String(usarDryRun),
    MAX_ITERACOES: String(limiteIteracoes),
    META_CANDIDATURAS: String(meta),
    OFFICEBOY_MODE: modoRun,
  };

  registrarLinha(`[control] iniciando bot (modo=${modoRun}, dry-run=${usarDryRun}, iteracoes<=${limiteIteracoes}, meta=${meta}) — ${command} ${args.join(' ')}`);
  log('INFO', `Control: iniciando bot (modo=${modoRun}, dry-run=${usarDryRun}, max ${limiteIteracoes} iteracoes, meta ${meta} candidaturas)`);
  broadcastEstado();

  processo = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  estado.pid = processo.pid ?? null;

  processo.stdout?.on('data', (d: Buffer) => {
    for (const l of d.toString('utf-8').split('\n')) registrarLinha(l);
  });
  processo.stderr?.on('data', (d: Buffer) => {
    for (const l of d.toString('utf-8').split('\n')) registrarLinha(l);
  });

  processo.on('exit', (code) => {
    estado.rodando = false;
    estado.parando = false;
    estado.pausado = false;
    estado.motivoPausa = null;
    estado.codigoSaida = code;
    estado.encerradoEm = new Date().toISOString();
    estado.pid = null;
    registrarLinha(`[control] bot encerrado (codigo ${code})`);
    log('INFO', `Control: bot encerrado (código ${code})`);
    if (prazoParadaGraciosa) {
      clearTimeout(prazoParadaGraciosa);
      prazoParadaGraciosa = null;
    }
    broadcastEstado();
  });

  processo.on('error', (err) => {
    estado.rodando = false;
    estado.parando = false;
    registrarLinha(`[control] erro ao iniciar bot: ${err.message}`);
    log('ERRO', `Control: erro ao iniciar bot — ${err.message}`);
    broadcastEstado();
  });

  return { ok: true, maxIteracoes: limiteIteracoes, metaCandidaturas: meta };
}

/**
 * Para o bot em execução. O SIGTERM agora é tratado pelo filho como PARADA
 * SUAVE: o agente termina a iteração atual (chamada LLM + tool calls), salva
 * o recovery e sai pelo caminho normal — sem abandonar trabalho pela metade.
 * Se não encerrar dentro do prazo (iteração travada), escala para SIGKILL.
 */
export function pararRun(): boolean {
  if (!estado.rodando || !processo) return false;
  estado.parando = true;
  registrarLinha('[control] parada suave solicitada (SIGTERM) — o bot finaliza a iteracao atual e sai limpo');
  log('INFO', 'Control: parada suave solicitada (SIGTERM)');
  try {
    processo.kill('SIGTERM');
  } catch (err) {
    estado.parando = false;
    registrarLinha(`[control] falha ao parar: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
  // Escalonamento: se o filho não sair no prazo, força o encerramento.
  if (prazoParadaGraciosa) clearTimeout(prazoParadaGraciosa);
  prazoParadaGraciosa = setTimeout(() => {
    prazoParadaGraciosa = null;
    if (estado.rodando && processo) {
      registrarLinha('[control] parada suave nao concluiu no prazo — forçando encerramento (SIGKILL)');
      log('WARN', 'Control: forçando encerramento do bot (SIGKILL)');
      try {
        processo.kill('SIGKILL');
      } catch {
        // Processo já morreu entre o check e o kill — nada a fazer.
      }
    }
  }, PARADA_GRACIOSA_TIMEOUT_MS);
  if (typeof prazoParadaGraciosa.unref === 'function') {
    prazoParadaGraciosa.unref();
  }
  broadcastEstado();
  return true;
}

/**
 * Coloca o run em PAUSA (POST /api/pause). SIGUSR2 ao filho: o agente termina
 * a iteração atual, entra em espera com o processo vivo e o navegador/sessão
 * preservados; "Retomar" (POST /api/resume) continua de onde parou.
 */
export function pausarRun(): boolean {
  if (!estado.rodando || !processo || estado.parando) return false;
  if (estado.pausado) return true; // já pausado: idempotente
  estado.pausado = true;
  registrarLinha('[control] pausa solicitada (SIGUSR2) — efetiva no fim da iteracao atual');
  log('INFO', 'Control: pausa solicitada (SIGUSR2)');
  try {
    processo.kill('SIGUSR2');
  } catch (err) {
    estado.pausado = false;
    registrarLinha(`[control] falha ao pausar: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
  broadcastEstado();
  return true;
}

/** Retoma um run pausado (POST /api/resume). SIGWINCH ao filho. */
export function retomarRun(): boolean {
  if (!estado.rodando || !processo) return false;
  if (!estado.pausado) return true; // não pausado: idempotente
  estado.pausado = false;
  registrarLinha('[control] retomada solicitada (SIGWINCH)');
  log('INFO', 'Control: retomada solicitada (SIGWINCH)');
  try {
    processo.kill('SIGWINCH');
  } catch (err) {
    estado.pausado = true;
    registrarLinha(`[control] falha ao retomar: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
  broadcastEstado();
  return true;
}

export function obterEstado(): EstadoRun {
  return {
    ...estado,
    linhas: estado.linhas.slice(-120),
  };
}

/**
 * Consulta (via HTTP do CDP, sem MCP) qual navegador o bot está usando e o
 * que está na aba ativa. Tira a dúvida "o bot pegou o Chrome certo?" — sem
 * isso, no modo host não há nenhuma janela nova aparecendo e parece que o
 * navegador não conectou.
 */
export async function consultarNavegador(): Promise<{
  endpoint: string;
  url: string;
  titulo: string;
  conectado: boolean;
  origem: 'externo' | 'local';
} | null> {
  const endpoint = (process.env.CDP_ENDPOINT || 'http://127.0.0.1:9222').replace(/\/+$/, '');
  const origem = process.env.BOT_NAVEGADOR_ORIGEM === 'local' ? 'local' : 'externo';
  try {
    const resp = await fetch(`${endpoint}/json/list`, {
      signal: AbortSignal.timeout(2500),
    });
    if (!resp.ok) return { endpoint, url: '', titulo: '', conectado: false, origem };
    const alvos = (await resp.json()) as Array<{ type?: string; title?: string; url?: string }>;
    const paginas = alvos.filter((a) => a.type === 'page');
    // Preferimos uma aba de conteúdo real; se só houver chrome:// (ex.: nova
    // guia), mostramos essa mesmo assim — melhor um título aproximado do que
    // um campo vazio que faz parecer que o navegador não conectou.
    const pagina =
      paginas.find((a) => a.url && !a.url.startsWith('chrome://')) ?? paginas[0];
    return {
      endpoint,
      url: pagina?.url ?? '',
      titulo: pagina?.title ?? '',
      conectado: true,
      origem,
    };
  } catch {
    return { endpoint, url: '', titulo: '', conectado: false, origem };
  }
}

function responderJSON(res: http.ServerResponse, codigo: number, corpo: unknown): void {
  const json = JSON.stringify(corpo);
  res.writeHead(codigo, {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(json);
}

/**
 * URL do navegador remoto (noVNC), com autoconnect — é o que faz o Chrome
 * aparecer na tela. Montada a partir do Host da requisição, trocando a porta
 * do dashboard pela do noVNC (funciona tanto em localhost quanto por IP/domínio).
 *
 * Só é oferecida quando existe Chrome LOCAL no container (flag do entrypoint):
 * no modo host o navegador é o do usuário, e não há o que espelhar.
 */
function urlDoNoVnc(req: http.IncomingMessage): string | undefined {
  if (process.env.BOT_HAS_LOCAL_CHROME !== 'true') return undefined;
  const portaNoVnc = process.env.BOT_NOVNC_PORT || '7900';
  const host = (req.headers.host || `localhost:${portaNoVnc}`).split(':')[0];
  return `http://${host}:${portaNoVnc}/vnc.html?autoconnect=1&resize=scale`;
}

/**
 * Serve os arquivos do front React (web/dist). Caminho seguro contra path
 * traversal: o caminho resolvido precisa continuar dentro de WEB_DIST.
 * Sem o build pronto, "/" e rotas desconhecidas caem no dashboard legado.
 */
function servirEstatico(req: http.IncomingMessage, res: http.ServerResponse, caminho: string): void {
  if (!existsSync(WEB_DIST)) {
    // Build do front ausente: nem tenta — legado direto.
    res.writeHead(302, { Location: '/legacy' });
    res.end();
    return;
  }
  const relativo = caminho === '/' || caminho === '/index.html' ? '/index.html' : caminho;
  let absoluto: string;
  try {
    absoluto = path.resolve(WEB_DIST, '.' + relativo);
  } catch {
    res.writeHead(400); res.end('bad request'); return;
  }
  if (absoluto !== WEB_DIST && !absoluto.startsWith(WEB_DIST + path.sep)) {
    res.writeHead(403); res.end('forbidden'); return;
  }
  if (!existsSync(absoluto) || statSync(absoluto).isDirectory()) {
    // SPA fallback: rotas desconhecidas recebem o index.html do front.
    absoluto = path.join(WEB_DIST, 'index.html');
  }
  try {
    const conteudo = readFileSync(absoluto);
    const ext = path.extname(absoluto).toLowerCase();
    const ehAsset = relativo.startsWith('/assets/');
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      // Assets do Vite têm hash no nome: cache eterno; index.html: sempre revalidar.
      'Cache-Control': ehAsset ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : conteudo);
  } catch (err) {
    log('ERRO', `Control: falha ao servir ${relativo} — ${err instanceof Error ? err.message : String(err)}`);
    res.writeHead(500); res.end('erro interno');
  }
}

function lerCorpo(req: http.IncomingMessage): Promise<string> {  return new Promise((resolve) => {
    let dados = '';
    req.on('data', (c) => {
      dados += c;
      // 100 KB: os configs reais (perfil/respostas) cabem em ~6 KB — a folga é
      // para nunca estrangular a PUT /api/config/perfil de um perfil grande.
      if (dados.length > 100_000) req.destroy();
    });
    req.on('end', () => resolve(dados));
    req.on('error', () => resolve(''));
  });
}

/** Sobe o control server (UI + API). */
export function iniciarControlServer(port: number, host: string): void {
  inicializarBanco();
  // Migração de ids dos sites: uma vez, antes de aceitar requisições. Sem id
  // a UI teria de identificar o site pelo nome, que é texto livre.
  migrarIdsSites();

  const srv = http.createServer(async (req, res) => {
    const url = req.url ?? '/';
    const caminho = url.split('?')[0];

    if (caminho === '/' || caminho === '/index.html') {
      servirEstatico(req, res, '/');
      return;
    }

    if (caminho === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      // Snapshot inicial: a UI monta a tela na hora, sem esperar o primeiro log.
      res.write(`event: snapshot\ndata: ${JSON.stringify({
        rodando: estado.rodando,
        parando: estado.parando,
        pausado: estado.pausado,
        motivoPausa: estado.motivoPausa,
        iniciadoEm: estado.iniciadoEm,
        encerradoEm: estado.encerradoEm,
        codigoSaida: estado.codigoSaida,
        dryRun: estado.dryRun,
        ultimoCusto: estado.ultimoCusto,
        iteracaoAtual: estado.iteracaoAtual,
        iteracaoTotal: estado.iteracaoTotal,
        modo: estado.modo,
        maxIteracoesPadrao: PADRAO_MAX_ITERACOES,
        metaCandidaturasPadrao: PADRAO_META_CANDIDATURAS,
        linhas: estado.linhas.slice(-200),
        candidaturasDaRun: contarCandidaturasDaRun(),
      })}\n\n`);
      clientesSse.add(res);
      req.on('close', () => clientesSse.delete(res));
      return;
    }

    if (caminho === '/api/data') {
      const stats = obterEstatisticas();
      // Funil de resultados — mesma semântica do dashboard legado: o
      // denominador honesto são as candidaturas com desfecho conhecido.
      const cont = (r: string) => stats.porResultado.find(x => x.resultado === r)?.total ?? 0;
      const totalCandidaturas = stats.porResultado.reduce((acc, x) => acc + x.total, 0);
      const comDesfecho = stats.porResultado
        .filter(x => x.resultado !== 'aguardando')
        .reduce((acc, x) => acc + x.total, 0);
      const respondidas = comDesfecho - cont('sem_resposta');
      const entrevistas = cont('entrevista') + cont('oferta');
      const ofertas = cont('oferta');
      const pct = (n: number) => (totalCandidaturas > 0 ? Math.round((n / totalCandidaturas) * 1000) / 10 : 0);

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        hoje: { total: stats.hoje.total, scoreMedio: stats.hoje.score_medio },
        total: stats.total,
        porPlataforma: stats.porPlataforma.map(p => ({
          plataforma: p.plataforma,
          total: p.total,
          scoreMedio: p.score_medio,
        })),
        porStatus: stats.porStatus,
        funil: {
          enviadas: totalCandidaturas,
          respondidas,
          respondidasPercentual: comDesfecho > 0 ? Math.round((respondidas / comDesfecho) * 1000) / 10 : null,
          entrevistas,
          ofertas,
          comDesfecho,
          taxaResposta: comDesfecho > 0 ? Math.round(((respondidas) / comDesfecho) * 1000) / 10 : null,
        },
        percentuais: {
          enviadas: 100,
          respondidas: pct(respondidas),
          entrevistas: pct(entrevistas),
          ofertas: pct(ofertas),
        },
        candidaturas: listarCandidaturas(20).map(c => ({
          id: c.id,
          empresa: c.empresa,
          tituloVaga: c.titulo_vaga,
          plataforma: c.plataforma,
          url: c.url,
          dataAplicacao: c.data_aplicacao,
          score: c.score,
          status: c.status,
          resultado: c.resultado ?? 'aguardando',
        })),
        run: {
          rodando: estado.rodando,
          parando: estado.parando,
          pausado: estado.pausado,
          motivoPausa: estado.motivoPausa,
          dryRun: estado.dryRun,
          iniciadoEm: estado.iniciadoEm,
          iteracaoAtual: estado.iteracaoAtual,
          iteracaoTotal: estado.iteracaoTotal,
          candidaturasDaRun: contarCandidaturasDaRun(),
          ultimoCusto: estado.ultimoCusto,
          modo: estado.modo,
        },
      }));
      return;
    }

    if (caminho === '/legacy') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(
        gerarHTML({
          ativo: true,
          rodando: estado.rodando,
          dryRun: estado.dryRun,
          novncUrl: urlDoNoVnc(req),
        }),
      );
      return;
    }

    // Estáticos do front React (assets, favicon) e SPA fallback.
    if ((req.method === 'GET' || req.method === 'HEAD') && !caminho.startsWith('/api/')) {
      servirEstatico(req, res, caminho);
      return;
    }

    if (caminho === '/api/status') {
      responderJSON(res, 200, {
        rodando: estado.rodando,
        parando: estado.parando,
        pausado: estado.pausado,
        motivoPausa: estado.motivoPausa,
        pid: estado.pid,
        iniciadoEm: estado.iniciadoEm,
        encerradoEm: estado.encerradoEm,
        codigoSaida: estado.codigoSaida,
        dryRun: estado.dryRun,
        ultimoCusto: estado.ultimoCusto,
        linhas: estado.linhas.length,
        iteracaoAtual: estado.iteracaoAtual,
        iteracaoTotal: estado.iteracaoTotal,
        modo: estado.modo,
        // Padrão de iterações (do .env) — usado para pré-preencher o campo na UI.
        maxIteracoesPadrao: PADRAO_MAX_ITERACOES,
        // Padrão da meta de qualidade (do .env) — idem, pré-preenche o campo.
        metaCandidaturasPadrao: PADRAO_META_CANDIDATURAS,
        // Troca a cada subida: a UI usa para confirmar que o restart terminou.
        bootId: BOOT_ID,
        navegador: await consultarNavegador(),
      });
      return;
    }

    if (caminho === '/api/logs') {
      responderJSON(res, 200, { linhas: estado.linhas.slice(-200) });
      return;
    }

    // /api/sites/:id/*: URLs de busca e ativação por site (ver sites-api.ts)
    if (await rotearSites(req, res, caminho, { rodando: () => estado.rodando })) {
      return;
    }

    // /api/config*: perfil, respostas, sites, currículos e .env (ver config-api.ts)
    if (await rotearConfig(req, res, caminho, { rodando: () => estado.rodando })) {
      return;
    }

    if (caminho === '/api/start' && req.method === 'POST') {
      const corpo = await lerCorpo(req);
      let dryRun: boolean | undefined;
      let maxIteracoes: number | undefined;
      let metaCandidaturas: number | undefined;
      let modo: 'full' | 'discovery' | 'apply' | undefined;
      try {
        const parsed = JSON.parse(corpo || '{}') as { dryRun?: boolean; maxIteracoes?: unknown; metaCandidaturas?: unknown; modo?: unknown };
        const modoPedido = parsed.modo === 'full' || parsed.modo === 'discovery' || parsed.modo === 'apply' ? parsed.modo : undefined;
        if (!controleAutorizado(req, modoPedido === 'apply')) {
          responderJSON(res, 403, { ok: false, mensagem: modoPedido === 'apply' ? 'Modo apply exige DASHBOARD_TOKEN.' : 'Acesso ao controle não autorizado.' });
          return;
        }
        if (typeof parsed.dryRun === 'boolean') dryRun = parsed.dryRun;
        if (parsed.maxIteracoes !== undefined && parsed.maxIteracoes !== null && parsed.maxIteracoes !== '') {
          maxIteracoes = saneiaMaxIteracoes(parsed.maxIteracoes);
        }
        if (parsed.metaCandidaturas !== undefined && parsed.metaCandidaturas !== null && parsed.metaCandidaturas !== '') {
          metaCandidaturas = saneiaMetaCandidaturas(parsed.metaCandidaturas);
        }
        modo = modoPedido;
      } catch {
        // corpo inválido: usa os padrões do .env
      }
      if (!controleAutorizado(req, modo === 'apply')) {
        responderJSON(res, 403, { ok: false, mensagem: modo === 'apply' ? 'Modo apply exige DASHBOARD_TOKEN.' : 'Acesso ao controle não autorizado.' });
        return;
      }
      const resultado = await iniciarRun(dryRun, maxIteracoes, metaCandidaturas, modo);
      responderJSON(res, resultado.ok ? 200 : 409, {
        ok: resultado.ok,
        mensagem: resultado.ok ? 'Bot iniciado' : (resultado.motivo ?? 'Não foi possível iniciar'),
        rodando: estado.rodando,
        maxIteracoes: resultado.maxIteracoes,
        metaCandidaturas: resultado.metaCandidaturas,
      });
      return;
    }

    if (caminho === '/api/stop' && req.method === 'POST') {
      if (!controleAutorizado(req)) { responderJSON(res, 403, { ok: false, mensagem: 'Acesso ao controle não autorizado.' }); return; }
      const ok = pararRun();
      responderJSON(res, ok ? 200 : 409, {
        ok,
        mensagem: ok ? 'Parada solicitada' : 'Nenhum run em andamento',
      });
      return;
    }

    if (caminho === '/api/pause' && req.method === 'POST') {
      if (!controleAutorizado(req)) { responderJSON(res, 403, { ok: false, mensagem: 'Acesso ao controle não autorizado.' }); return; }
      const ok = pausarRun();
      responderJSON(res, ok ? 200 : 409, {
        ok,
        mensagem: ok ? 'Pausa solicitada' : 'Nenhum run pausável em andamento',
      });
      return;
    }

    if (caminho === '/api/resume' && req.method === 'POST') {
      if (!controleAutorizado(req)) { responderJSON(res, 403, { ok: false, mensagem: 'Acesso ao controle não autorizado.' }); return; }
      const ok = retomarRun();
      responderJSON(res, ok ? 200 : 409, {
        ok,
        mensagem: ok ? 'Retomada solicitada' : 'Nenhum run em andamento',
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });

  srv.on('error', (err) => {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'EADDRINUSE') {
      log('ERRO', `Control server: a porta ${port} já está em uso.`);
      log('ERRO', 'Outro container do bot provavelmente está rodando. Rode "./bin/officeboy down" e tente de novo.');
      log('ERRO', 'Se não for o bot, mude BOT_UI_PORT no .env.');
      // Sai com erro: o container reinicia (restart: unless-stopped) e o
      // problema fica visível no log, em vez de um loop silencioso.
      process.exit(1);
    }
    log('ERRO', `Control server: falha na porta ${port} — ${err.message}`);
    process.exit(1);
  });

  // Shutdown usado pelo auto-restart do PUT /api/config/env: fecha SSE, derruba
  // o filho (se houver), libera a porta e faz checkpoint do banco ANTES do
  // process.exit — sem truncar o 200 nem deixar conexões penduradas.
  registrarAoReiniciar(async () => {
    for (const cliente of clientesSse) {
      try {
        cliente.end();
      } catch {
        // cliente já foi embora
      }
    }
    clientesSse.clear();
    if (estado.rodando) {
      try {
        processo?.kill('SIGTERM');
      } catch {
        // processo já morreu
      }
    }
    await new Promise<void>((resolve) => {
      srv.close(() => resolve());
      setTimeout(resolve, 2000).unref(); // keep-alive preso não trava o restart
    });
    fecharBanco();
  });

  srv.listen(port, host, () => {
    log('INFO', `Control server em http://${host}:${port} (UI — o bot só roda quando você pedir)`);
  });

  // Heartbeat do SSE: mantém o stream vivo através de proxies e detecta
  // clientes mortos (o write em um socket fechado lança → remoção).
  setInterval(() => {
    for (const cliente of clientesSse) {
      try {
        cliente.write(': ping\n\n');
      } catch {
        clientesSse.delete(cliente);
      }
    }
  }, 20_000).unref();

  // Ao encerrar o container, o processo filho não pode ficar órfão. Aqui é
  // derrubada TOTAL: o SIGKILL mata na hora, sem esperar a iteração atual
  // terminar (diferente do botão "Parar" da UI, que usa a parada suave) —
  // no shutdown do servidor ninguém estará lendo os pipes do filho.
  for (const sinal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sinal, () => {
      if (estado.rodando) {
        try {
          processo?.kill('SIGKILL');
        } catch {
          // silencioso
        }
      }
      process.exit(0);
    });
  }
}
