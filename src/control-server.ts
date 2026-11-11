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
//   POST /api/start    → inicia o bot ({ dryRun?: boolean, maxIteracoes?: number })
//   POST /api/stop     → para o bot em andamento

import http from 'http';
import { spawn, type ChildProcess } from 'child_process';
import path from 'path';
import { existsSync, readFileSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import { log } from './logger.js';
import { inicializarBanco, contarCandidaturasDesde, listarCandidaturas, obterEstatisticas } from './database.js';
import { gerarHTML } from './dashboard.js';

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

function saneiaMaxIteracoes(valor: unknown): number {
  const n = Math.floor(Number(valor));
  if (!Number.isFinite(n)) return PADRAO_MAX_ITERACOES;
  return Math.min(Math.max(n, 1), MAX_ITERACOES_TETO);
}

interface EstadoRun {
  rodando: boolean;
  parando: boolean;
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
}

const estado: EstadoRun = {
  rodando: false,
  parando: false,
  pid: null,
  iniciadoEm: null,
  encerradoEm: null,
  codigoSaida: null,
  dryRun: true,
  origem: null,
  linhas: [],
  ultimoCusto: null,
  iteracaoAtual: 0,
  iteracaoTotal: 0,
};

let processo: ChildProcess | null = null;

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
    pid: estado.pid,
    iniciadoEm: estado.iniciadoEm,
    encerradoEm: estado.encerradoEm,
    codigoSaida: estado.codigoSaida,
    dryRun: estado.dryRun,
    ultimoCusto: estado.ultimoCusto,
    iteracaoAtual: estado.iteracaoAtual,
    iteracaoTotal: estado.iteracaoTotal,
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
): Promise<{ ok: boolean; motivo?: string; maxIteracoes?: number }> {
  if (estado.rodando) return { ok: false, motivo: 'Já existe um run em andamento' };

  const nav = await consultarNavegador();
  if (nav && !nav.conectado) {
    const motivo = `Navegador indisponível em ${nav.endpoint} — o Chrome não está respondendo. `
      + 'Verifique o container (docker compose logs) e tente de novo em instantes.';
    log('WARN', `Control: run recusado — ${motivo}`);
    return { ok: false, motivo };
  }

  const { command, args } = comandoDoBot();
  const usarDryRun = dryRun ?? (process.env.DRY_RUN === 'true');
  const limiteIteracoes = saneiaMaxIteracoes(maxIteracoes);

  estado.rodando = true;
  estado.parando = false;
  estado.dryRun = usarDryRun;
  estado.pid = null;
  estado.iniciadoEm = new Date().toISOString();
  estado.encerradoEm = null;
  estado.codigoSaida = null;
  estado.ultimoCusto = null;
  estado.origem = 'ui';
  estado.iteracaoAtual = 0;
  estado.iteracaoTotal = limiteIteracoes;

  // O filho NÃO sobe dashboard (esta porta já é do control server) e roda em
  // modo agente normal. MAX_ITERACOES sobrescreve o .env — tem precedência
  // porque é o valor explicitamente escolhido na UI para ESTE run.
  const env = {
    ...process.env,
    DASHBOARD_ENABLED: 'false',
    CONTROL_MODE: 'false',
    DRY_RUN: String(usarDryRun),
    MAX_ITERACOES: String(limiteIteracoes),
  };

  registrarLinha(`[control] iniciando bot (dry-run=${usarDryRun}, iteracoes<=${limiteIteracoes}) — ${command} ${args.join(' ')}`);
  log('INFO', `Control: iniciando bot (dry-run=${usarDryRun}, max ${limiteIteracoes} iteracoes)`);
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
    estado.codigoSaida = code;
    estado.encerradoEm = new Date().toISOString();
    estado.pid = null;
    registrarLinha(`[control] bot encerrado (codigo ${code})`);
    log('INFO', `Control: bot encerrado (código ${code})`);
    broadcastEstado();
  });

  processo.on('error', (err) => {
    estado.rodando = false;
    estado.parando = false;
    registrarLinha(`[control] erro ao iniciar bot: ${err.message}`);
    log('ERRO', `Control: erro ao iniciar bot — ${err.message}`);
    broadcastEstado();
  });

  return { ok: true, maxIteracoes: limiteIteracoes };
}

/** Para o processo do bot (SIGTERM) se estiver rodando. */
export function pararRun(): boolean {
  if (!estado.rodando || !processo) return false;
  estado.parando = true;
  registrarLinha('[control] parada solicitada (SIGTERM)');
  try {
    processo.kill('SIGTERM');
  } catch (err) {
    estado.parando = false;
    registrarLinha(`[control] falha ao parar: ${err instanceof Error ? err.message : String(err)}`);
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
      if (dados.length > 10_000) req.destroy();
    });
    req.on('end', () => resolve(dados));
    req.on('error', () => resolve(''));
  });
}

/** Sobe o control server (UI + API). */
export function iniciarControlServer(port: number, host: string): void {
  inicializarBanco();

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
        iniciadoEm: estado.iniciadoEm,
        encerradoEm: estado.encerradoEm,
        codigoSaida: estado.codigoSaida,
        dryRun: estado.dryRun,
        ultimoCusto: estado.ultimoCusto,
        iteracaoAtual: estado.iteracaoAtual,
        iteracaoTotal: estado.iteracaoTotal,
        maxIteracoesPadrao: PADRAO_MAX_ITERACOES,
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
          dryRun: estado.dryRun,
          iniciadoEm: estado.iniciadoEm,
          iteracaoAtual: estado.iteracaoAtual,
          iteracaoTotal: estado.iteracaoTotal,
          candidaturasDaRun: contarCandidaturasDaRun(),
          ultimoCusto: estado.ultimoCusto,
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
        pid: estado.pid,
        iniciadoEm: estado.iniciadoEm,
        encerradoEm: estado.encerradoEm,
        codigoSaida: estado.codigoSaida,
        dryRun: estado.dryRun,
        ultimoCusto: estado.ultimoCusto,
        linhas: estado.linhas.length,
        iteracaoAtual: estado.iteracaoAtual,
        iteracaoTotal: estado.iteracaoTotal,
        // Padrão de iterações (do .env) — usado para pré-preencher o campo na UI.
        maxIteracoesPadrao: PADRAO_MAX_ITERACOES,
        navegador: await consultarNavegador(),
      });
      return;
    }

    if (caminho === '/api/logs') {
      responderJSON(res, 200, { linhas: estado.linhas.slice(-200) });
      return;
    }

    if (caminho === '/api/start' && req.method === 'POST') {
      const corpo = await lerCorpo(req);
      let dryRun: boolean | undefined;
      let maxIteracoes: number | undefined;
      try {
        const parsed = JSON.parse(corpo || '{}') as { dryRun?: boolean; maxIteracoes?: unknown };
        if (typeof parsed.dryRun === 'boolean') dryRun = parsed.dryRun;
        if (parsed.maxIteracoes !== undefined && parsed.maxIteracoes !== null && parsed.maxIteracoes !== '') {
          maxIteracoes = saneiaMaxIteracoes(parsed.maxIteracoes);
        }
      } catch {
        // corpo inválido: usa os padrões do .env
      }
      const resultado = await iniciarRun(dryRun, maxIteracoes);
      responderJSON(res, resultado.ok ? 200 : 409, {
        ok: resultado.ok,
        mensagem: resultado.ok ? 'Bot iniciado' : (resultado.motivo ?? 'Não foi possível iniciar'),
        rodando: estado.rodando,
        maxIteracoes: resultado.maxIteracoes,
      });
      return;
    }

    if (caminho === '/api/stop' && req.method === 'POST') {
      const ok = pararRun();
      responderJSON(res, ok ? 200 : 409, {
        ok,
        mensagem: ok ? 'Parada solicitada' : 'Nenhum run em andamento',
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

  // Ao encerrar o container, o processo filho não pode ficar órfão.
  for (const sinal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sinal, () => {
      if (estado.rodando) {
        try {
          processo?.kill('SIGTERM');
        } catch {
          // silencioso
        }
      }
      process.exit(0);
    });
  }
}
