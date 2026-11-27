import 'dotenv/config';
import { readFileSync } from 'fs';
import { ARQ_ENV, chavesEnvParaReaplicar } from './config-api.js';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { conectarMCP, conectarPlaywrightMCP, conectarRebaseJobsMCP, desconectarMCP, limparAbasCDP, verificarChromeCDP, REBASE_JOBS_READ_ONLY_TOOLS } from './mcp-client.js';
import { inicializarBanco, fecharBanco, registrarExecucao, contarCandidaturasHoje, listarCandidaturas, listarVagasVistasDesde, obterAgoraBanco, obterEstatisticas } from './database.js';
import { executarAgente, solicitarParadaAgente, paradaAgenteSolicitada, solicitarPausaAgente, retomarAgente, pausaAgenteAtiva, type McpServerConnection } from './agente.js';
import { iniciarDashboard, pararDashboard } from './dashboard.js';
import { iniciarControlServer } from './control-server.js';
import { inicializarLogger, log } from './logger.js';
import { configurarTelegram, notificarResumo, notificarErro, enviarTelegram } from './notificacoes.js';
import { verificarSessoes } from './sessao.js';
import { configurarEmail, enviarRelatorioEmail, gerarHTMLRelatorio } from './email.js';
import { iniciarCron, pararCron } from './cron.js';
import { exibirResumoTokens, obterCustoTotal, obterTokensTotal, obterTotalChamadas, resetarTracker } from './token-tracker.js';
import { configurarLLMAux } from './llm-adapter.js';
import { criarSessaoOpenRouter } from './openrouter.js';
import { executarDiscoveryRebase } from './rebase-discovery.js';
import type { Perfil, SitesConfig, AgenteConfig } from './types.js';
import { atualizarStatusPlugin, listarPlugins } from './plugin-registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function carregarConfig<T>(arquivo: string): T {
  const caminho = path.resolve(__dirname, '..', 'config', arquivo);
  try {
    const conteudo = readFileSync(caminho, 'utf-8');
    return JSON.parse(conteudo) as T;
  } catch (error) {
    console.error(`\nERRO: Nao foi possivel carregar ${caminho}`);
    console.error('Verifique se o arquivo existe e esta no formato JSON correto.\n');
    process.exit(1);
  }
}

function validarEnv(): AgenteConfig {
  // LLM do agente de navegação (agnóstico, padrão OpenAI SDK).
  const agentLlmApiKey = process.env.AGENT_LLM_API_KEY || process.env.OPENAI_API_KEY || '';
  const modoExecucao = process.env.OFFICEBOY_MODE === 'discovery'
    ? 'discovery'
    : process.env.OFFICEBOY_MODE === 'apply' ? 'apply' : 'full';
  if (!agentLlmApiKey && modoExecucao !== 'discovery') {
    console.error('\nERRO: AGENT_LLM_API_KEY nao definida.');
    console.error('Copie .env.example para .env e preencha sua chave (OpenRouter, OpenAI, etc.).\n');
    process.exit(1);
  }

  return {
    modoExecucao,
    agentLlmBaseUrl: process.env.AGENT_LLM_BASE_URL || 'https://openrouter.ai/api/v1',
    agentLlmApiKey,
    agentLlmModel: process.env.AGENT_LLM_MODEL || 'deepseek/deepseek-v4-flash-0731',
    // Legado (fallback opcional do LLM auxiliar — o agente NÃO usa mais).
    geminiApiKey: process.env.GEMINI_API_KEY || '',
    geminiModel: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    cdpEndpoint: process.env.CDP_ENDPOINT || 'http://127.0.0.1:9222',
    limiteDiario: parseInt(process.env.LIMITE_DIARIO || '10', 10),
    maxPorExecucao: parseInt(process.env.MAX_POR_EXECUCAO || '5', 10),
    // Teto de iterações do agente (o teto do loop). Await em valores absurdos:
    // um número gigante faz o run rodar (e gastar) sem fim; um ≤0 é o mesmo que
    // "nao executar". Clamp em 1..5000 como rede de segurança, tanto para o
    // .env quanto para o valor vindo da UI (via control server).
    // Default 500 quando o .env não define MAX_ITERACOES — alto o bastante
    // para um run longo, mas sob o teto de 5000 (guarda contra run infinito).
    maxIteracoes: Math.min(Math.max(parseInt(process.env.MAX_ITERACOES || '500', 10) || 500, 1), 5000),
    delayMin: parseInt(process.env.DELAY_MIN || '2000', 10),
    delayMax: parseInt(process.env.DELAY_MAX || '5000', 10),
    dryRun: process.env.DRY_RUN === 'true',
    scoreMinimo: parseInt(process.env.SCORE_MINIMO || '6', 10),
    // Meta de candidaturas de qualidade por run — o encerramento de SUCESSO do
    // agente. Default 10; 0 = desativado (run só encerra por MAX_ITERACOES ou
    // CUSTO_MAX_USD). Contada no gate determinístico de registrar_candidatura.
    metaCandidaturas: Math.max(parseInt(process.env.META_CANDIDATURAS ?? '10', 10) || 0, 0),
    custoMaxUsd: parseFloat(process.env.CUSTO_MAX_USD || '0'),
    // Pausa automática no login: true por padrão (só roda com o usuário por perto).
    pausarEmLogin: process.env.PAUSAR_EM_LOGIN !== 'false',
    dashboardPort: parseInt(process.env.DASHBOARD_PORT || '3000', 10),
    dashboardHost: process.env.DASHBOARD_HOST || '127.0.0.1',
    // Telegram
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
    telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
    telegramAtivo: process.env.TELEGRAM_ATIVO !== 'false',
    // Email
    smtpHost: process.env.SMTP_HOST || '',
    smtpPort: parseInt(process.env.SMTP_PORT || '587', 10),
    smtpUser: process.env.SMTP_USER || '',
    smtpPass: process.env.SMTP_PASS || '',
    emailDestinatario: process.env.EMAIL_DESTINATARIO || '',
    emailAtivo: process.env.EMAIL_ATIVO !== 'false',
    // Cron
    cronAtivo: process.env.CRON_ATIVO === 'true',
    cronHorario: process.env.CRON_HORARIO || '09:00',
    // Multi-LLM
    // Padrão: OpenRouter (via provider OpenAI-compatible). Ollama = local/grátis.
    // Gemini = provider auxiliar/secundário (+ fallback automático).
    llmAuxProvider: process.env.LLM_AUX_PROVIDER || 'openai',
    llmAuxModel: process.env.LLM_AUX_MODEL || process.env.AGENT_LLM_MODEL || 'deepseek/deepseek-chat',
    ollamaUrl: process.env.OLLAMA_URL || 'http://localhost:11434',
    openaiApiKey: process.env.OPENAI_API_KEY || '',
    openaiBaseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    rebaseJobsEnabled: process.env.REBASE_JOBS_ENABLED === 'true',
    rebaseJobsMcpUrl: process.env.REBASE_JOBS_MCP_URL || 'https://rebasedev.com.br/mcp',
    rebaseJobsToken: process.env.REBASE_JOBS_TOKEN || '',
    rebaseJobsAllowExternalApply: process.env.REBASE_JOBS_ALLOW_EXTERNAL_APPLY === 'true',
    rebaseJobsAllowedHosts: (process.env.REBASE_JOBS_ALLOWED_HOSTS || '').split(',').map(h => h.trim().toLowerCase()).filter(Boolean),
  };
}

// ===== Parada suave (SIGTERM/SIGINT) =====
//
// "Parar bot" na UI envia SIGTERM ao processo; Ctrl+C envia SIGINT. Em vez de
// morrer no meio de uma iteração (tool call em andamento, formulário pela
// metade), o primeiro sinal marca o agente para parar na próxima fronteira de
// iteração — a atual termina por completo e o processo sai pelo caminho
// normal (recovery salvo, resumo, notificações, cleanup do MCP/banco).
// Um SEGUNDO sinal encerra na hora (escape: iteracao travada).
let fluxoEmAndamento = false;
let sinaisDeParadaRecebidos = 0;

function handlerParadaSuave(sinal: string): void {
  // No modo control server, quem responde a SIGTERM/SIGINT é o próprio
  // control server (encaminha ao filho e sai) — este handler é no-op aqui.
  if (process.env.CONTROL_MODE === 'true') return;
  sinaisDeParadaRecebidos++;
  if (sinaisDeParadaRecebidos >= 2) {
    log('WARN', `Recebido ${sinal} pela 2a vez. Encerrando imediatamente...`);
    fecharBanco();
    process.exit(0);
  }
  if (!fluxoEmAndamento) {
    log('INFO', `Recebido ${sinal} sem execucao em andamento. Encerrando.`);
    fecharBanco();
    process.exit(0);
  }
  if (paradaAgenteSolicitada()) {
    log('WARN', `Recebido ${sinal}, porem a parada suave ja estava marcada. Aguardando o fim da iteracao atual...`);
    return;
  }
  log('WARN', `Recebido ${sinal}. Parada suave: finalizando a iteracao atual antes de sair (recovery sera salvo)...`);
  solicitarParadaAgente();
}

// Pausa/retomada por sinais — escolha de sinais sem papel reservado no Node
// (SIGUSR1 fica para o inspector; SIGHUP/SIGINT/SIGTERM já têm significado).
// PAUSA = SIGUSR2 (control server envia em POST /api/pause)
// RETOMA = SIGWINCH (control server envia em POST /api/resume)
function handlerPausa(): void {
  if (process.env.CONTROL_MODE === 'true' || !fluxoEmAndamento) return;
  if (pausaAgenteAtiva()) return;
  log('WARN', 'Pausa solicitada. A run sera pausada quando a iteracao atual terminar...');
  solicitarPausaAgente();
}

function handlerRetomada(): void {
  if (process.env.CONTROL_MODE === 'true' || !fluxoEmAndamento) return;
  if (!pausaAgenteAtiva()) return;
  log('INFO', 'Retomada solicitada. A run continua na proxima iteracao.');
  retomarAgente();
}

async function executarFluxoPrincipal(config: AgenteConfig): Promise<void> {
  fluxoEmAndamento = true;
  try {
    const openRouterSessionId = criarSessaoOpenRouter();
    log('INFO', `Sessão OpenRouter: ${openRouterSessionId}`);
    await executarFluxoInterno({ ...config, openRouterSessionId });
  } finally {
    fluxoEmAndamento = false;
  }
}

async function executarFluxoInterno(config: AgenteConfig): Promise<void> {
  // Carrega configuracoes
  const perfil = carregarConfig<Perfil>('perfil.json');
  log('INFO', `Perfil carregado: ${perfil.nome} (${perfil.titulo_profissional})`);

  const sites = carregarConfig<SitesConfig>('sites.json');
  const sitesAtivos = sites.sites.filter(s => s.ativo);
  log('INFO', `Sites: ${sitesAtivos.length} ativo(s) de ${sites.sites.length} total`);

  // Inicializa banco de dados
  inicializarBanco();
  // Usa o mesmo relógio/formato dos defaults de data do SQLite para separar
  // com precisão os pulos desta execução dos relatórios anteriores.
  const inicioRun = obterAgoraBanco();
  const candidaturasHoje = contarCandidaturasHoje();
  log('INFO', `Candidaturas hoje: ${candidaturasHoje}/${config.limiteDiario}`);

  if (candidaturasHoje >= config.limiteDiario && !config.dryRun) {
    log('WARN', 'Limite diario de candidaturas ja atingido. Tente novamente amanha.');
    fecharBanco();
    return;
  }

  // Inicia dashboard web (só se habilitado — no modo control server quem
  // serve a UI é o control server, e o filho do run não pode bindar a porta).
  if (process.env.DASHBOARD_ENABLED !== 'false') {
    iniciarDashboard(config.dashboardPort, config.dashboardHost);
  }

  // Conecta ao Playwright MCP (que conecta ao Chrome).
  // Antes de subir o MCP, valida que o Chrome esta acessivel via CDP: o
  // handshake do MCP conecta mesmo sem o Chrome no ar, entao sem essa checagem
  // a falha so apareceria no meio do loop do agente, ja tendo gasto chamadas do
  // LLM (ver verificarChromeCDP em mcp-client.ts).
  let mcpClient: Client;
  const mcpServers: McpServerConnection[] = [];
  let rebaseJobsDisponivel = false;
  for (const plugin of listarPlugins()) {
    if (plugin.manifest.id === 'rebase-jobs' || !plugin.enabled || !plugin.configured) continue;
    const token = plugin.manifest.settings.find(setting => setting.type === 'secret')?.envKey;
    const url = plugin.manifest.connection.url;
    try {
      const client = await conectarMCP({
        name: plugin.manifest.id,
        transport: plugin.manifest.connection.transport,
        url,
        command: plugin.manifest.connection.command,
        args: plugin.manifest.connection.args,
        authentication: plugin.manifest.connection.authentication,
        token: token ? process.env[token] : undefined,
        allowedTools: plugin.manifest.tools.map(tool => tool.name),
      });
      mcpServers.push({
        name: plugin.manifest.id,
        client,
        readOnlyAllowlist: new Set(plugin.manifest.tools.map(tool => tool.name)),
        toolScopes: new Map(plugin.manifest.tools.map(tool => [tool.name, tool.scope])),
      });
      atualizarStatusPlugin(plugin.manifest.id, 'connected');
    } catch (error) {
      atualizarStatusPlugin(plugin.manifest.id, 'error');
      log('WARN', `Plugin MCP ${plugin.manifest.name} indisponivel — continuando: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  let servidoresMcp: unknown[] = [];
  try {
    const valor = JSON.parse(process.env.MCP_SERVERS_JSON || '[]') as unknown;
    if (Array.isArray(valor)) servidoresMcp = valor;
  } catch {
    log('WARN', 'MCP_SERVERS_JSON invalido — ignorando servidores MCP genericos.');
  }
  for (const servidor of servidoresMcp) {
    if (!servidor || typeof servidor !== 'object') continue;
    const item = servidor as { name?: unknown; url?: unknown; token?: unknown; enabled?: unknown; allowedTools?: unknown };
    if (item.enabled === false || typeof item.name !== 'string' || typeof item.url !== 'string' || typeof item.token !== 'string') continue;
    const allowedTools = Array.isArray(item.allowedTools)
      ? item.allowedTools.filter((tool): tool is string => typeof tool === 'string')
      : [];
    try {
      const client = await conectarMCP({ name: item.name, url: item.url, token: item.token, allowedTools });
      mcpServers.push({ name: item.name, client, readOnlyAllowlist: new Set(allowedTools) });
    } catch (error) {
      log('WARN', `MCP ${item.name} indisponivel — continuando: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (config.rebaseJobsEnabled && config.modoExecucao !== 'apply') {
    if (!config.rebaseJobsToken) {
      log('WARN', 'Rebase Jobs habilitado, mas REBASE_JOBS_TOKEN nao foi definida — continuando sem essa fonte.');
    } else {
      try {
        const rebase = await conectarRebaseJobsMCP(config.rebaseJobsMcpUrl, config.rebaseJobsToken);
        mcpServers.push({ name: 'rebase-jobs', client: rebase, readOnlyAllowlist: REBASE_JOBS_READ_ONLY_TOOLS });
        atualizarStatusPlugin('rebase-jobs', 'connected');
        rebaseJobsDisponivel = true;
      } catch (error) {
        atualizarStatusPlugin('rebase-jobs', 'error');
        log('WARN', `Rebase Jobs indisponivel — continuando com os portais atuais: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  try {
    await verificarChromeCDP(config.cdpEndpoint);
    mcpClient = await conectarPlaywrightMCP(config.cdpEndpoint);
    mcpServers.unshift({ name: 'playwright', client: mcpClient });
  } catch (error) {
    log('ERRO', error instanceof Error ? error.message : String(error));
    await notificarErro('Falha ao conectar ao Chrome. Verifique se o CDP esta ativo.');
    await desconectarMCP().catch(cleanupError => {
      log('WARN', `Falha no cleanup dos clientes MCP: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
    });
    fecharBanco();
    process.exit(1);
  }

  // HEALTH CHECK DE SESSÃO PRÉ-RUN: entra na URL de busca de cada site ativo
  // e classifica a sessão (ok / login_exigido / erro) ANTES da primeira
  // chamada de LLM. Sessão morta descoberta aqui economiza um run inteiro de
  // iterações queimadas contra o muro do login (o bot usa o MESMO Chrome via
  // CDP, então o teste reflete exatamente a sessão que o agente vai usar).
  const sessoes = config.modoExecucao === 'apply' ? [] : await verificarSessoes(mcpClient, sites);
  if (sessoes.length > 0) {
    const quebradas = sessoes.filter((s) => s.status !== 'ok');
    if (quebradas.length === 0) {
      log('INFO', `Health check de sessao: ${sessoes.length} site(s) OK`);
    } else {
      const detalhes = quebradas.map((s) => `- ${s.site}: ${s.status} (${s.url})`).join('\n');
      log('WARN', `Health check de sessao: ${quebradas.map((s) => `${s.site}=${s.status}`).join(', ')}`);
      // Todos quebrados (e run real) → aborta antes de gastar LLM: sem login
      // manual no Chrome do bot não há fluxo de candidatura possível.
      const todosQuebrados = quebradas.length === sessoes.length;
      await enviarTelegram(
        todosQuebrados && !config.dryRun
          ? `🟠 SESSAO EXPIRADA em todos os sites configurados\n${detalhes}\nRun NAO iniciado. Faca login manual no Chrome do bot e inicie novamente.`
          : `🟠 ATENCAO DE SESSAO (antes do run)\n${detalhes}\nO run vai iniciar mesmo assim; estes sites podem exigir login manual no Chrome do bot.`,
      );
      if (todosQuebrados && !config.dryRun) {
        log('WARN', 'Todos os sites com sessao quebrada — run abortado antes de gastar chamadas de LLM.');
        await desconectarMCP();
        fecharBanco();
        return;
      }
    }
  }

  // Executa o agente
  const erros: string[] = [];
  let resultado = '';
  // Só login_exigido bloqueia o site: 'erro' no health check (timeout/ERR_)
  // é transitório e não deve eliminar o portal da rodada inteira.
  const sitesBloqueados = sessoes.filter(s => s.status === 'login_exigido').map(s => s.site);

  try {
    resultado = await executarAgente(
      mcpClient,
      perfil,
      config.modoExecucao === 'apply' ? { sites: [] } : sites,
      { ...config, rebaseJobsEnabled: rebaseJobsDisponivel },
      sitesBloqueados,
      mcpServers,
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    erros.push(msg);
    log('ERRO', `ERRO FATAL: ${msg}`);
    await notificarErro(msg);
  }

  // Registra execucao
  const candidaturasDepois = contarCandidaturasHoje();
  const novasCandidaturas = candidaturasDepois - candidaturasHoje;

  registrarExecucao(
    novasCandidaturas,
    sitesAtivos.map(s => s.nome),
    erros,
  );

  // Resumo final
  log('INFO', '='.repeat(60));
  log('INFO', config.dryRun ? '  RESUMO DA EXECUCAO (DRY-RUN)' : '  RESUMO DA EXECUCAO');
  log('INFO', '='.repeat(60));
  log('INFO', `  Modo: ${config.dryRun ? 'DRY-RUN (simulacao)' : 'PRODUCAO'}`);
  log('INFO', `  Novas candidaturas: ${novasCandidaturas}`);
  log('INFO', `  Total hoje: ${candidaturasDepois}/${config.limiteDiario}`);
  const sitesProcessados = sitesAtivos.filter(s => !sitesBloqueados.includes(s.nome));
  log('INFO', `  Sites processados: ${sitesProcessados.map(s => s.nome).join(', ')}`);
  if (sitesBloqueados.length > 0) {
    log('INFO', `  Sites ignorados (sessão inválida): ${sitesBloqueados.join(', ')}`);
  }
  log('INFO', `  Erros: ${erros.length > 0 ? erros.join('; ') : 'Nenhum'}`);
  log('INFO', `  Custo tokens:      $${obterCustoTotal().toFixed(4)} USD (${obterTokensTotal().toLocaleString('pt-BR')} tokens, ${obterTotalChamadas()} chamadas)`);
  log('INFO', `  Dashboard: http://localhost:${config.dashboardPort}`);

  // Resumo detalhado de tokens
  exibirResumoTokens();

  if (resultado) {
    log('AGENTE', `Relatorio:\n${resultado}`);
  }

  // Notificacoes
  await notificarResumo(novasCandidaturas, erros.length, config.dryRun);

  // Relatorio por email — busca dados reais do banco (antes ia sempre vazio)
  const candidaturasRecentes = novasCandidaturas > 0 ? listarCandidaturas(novasCandidaturas) : [];
  const empresasRelatorio = candidaturasRecentes.map(
    c => `${c.empresa} — ${c.titulo_vaga} (score ${c.score ?? '-'})`,
  );
  const scoreMedioHoje = obterEstatisticas().hoje.score_medio ?? 0;
  const vagasPuloAltoScore = listarVagasVistasDesde(inicioRun, 8);

  await enviarRelatorioEmail(
    `Office Boy — ${novasCandidaturas} candidatura(s) ${config.dryRun ? '(DRY-RUN)' : ''}`,
    gerarHTMLRelatorio({
      total: novasCandidaturas,
      empresas: empresasRelatorio,
      erros,
      dryRun: config.dryRun,
      scoresMedio: scoreMedioHoje,
      vagasPuloAltoScore,
    }),
  );

  // Cleanup
  await desconectarMCP();
  // Fecha as abas em excesso deixadas pelo run, preservando uma (se fechar
  // todas pelo navegador o Chrome sai inteiro — ver TOOLS_MCP_BLOQUEADAS).
  const abasFechadas = await limparAbasCDP(config.cdpEndpoint);
  if (abasFechadas > 0) log('INFO', `Limpeza: ${abasFechadas} aba(s) fechada(s) (1 preservada para o proximo run)`);
  fecharBanco();
  log('INFO', 'Agente finalizado com sucesso.');
}

async function main() {
  // Inicializa logger antes de tudo
  inicializarLogger();

  // Sinais de parada: SIGTERM (usado pelo control server em "Parar bot") e
  // SIGINT (Ctrl+C). Registrados cedo para cobrir todos os modos (run único,
  // cron e control server).
  process.on('SIGTERM', () => handlerParadaSuave('SIGTERM'));
  process.on('SIGINT', () => handlerParadaSuave('SIGINT'));
  // Pausa real da run: SIGUSR2 pausa, SIGWINCH retoma (ver handlerPausa).
  process.on('SIGUSR2', () => handlerPausa());
  process.on('SIGWINCH', () => handlerRetomada());

  log('INFO', '='.repeat(60));
  log('INFO', '  OFFICE BOY - Agente Inteligente de Candidaturas');
  log('INFO', '='.repeat(60));

  // O `dotenv/config` não sobrescreve variáveis já definidas — e o Compose
  // injeta as de infraestrutura (DASHBOARD_HOST, CDP_ENDPOINT...) no container.
  // Num restart automático, reaplicamos do .env montado SOMENTE as chaves que
  // a UI pode editar, para o novo modelo/API key valerem sem mexer no host.
  try {
    const novas = chavesEnvParaReaplicar(readFileSync(ARQ_ENV, 'utf-8'));
    let total = 0;
    for (const [chave, valor] of Object.entries(novas)) {
      process.env[chave] = valor;
      total++;
    }
    if (total > 0) log('INFO', `Config: ${total} variável(is) reaplicada(s) do .env montado`);
  } catch {
    // Sem .env acessível, segue com o ambiente injetado (modo dev/container).
  }

  // Valida ambiente
  const config = validarEnv();

  if (config.modoExecucao === 'discovery' && process.env.CONTROL_MODE !== 'true') {
    const perfil = carregarConfig<Perfil>('perfil.json');
    inicializarBanco();
    try {
      if (!config.rebaseJobsEnabled) throw new Error('REBASE_JOBS_ENABLED=true e necessario no modo discovery');
      const resultado = await executarDiscoveryRebase(perfil, config);
      log('INFO', `Discovery Rebase concluido: ${resultado.encontradas} encontrada(s), ${resultado.enfileiradas} enfileirada(s), ${resultado.puladas} pulada(s).`);
    } catch (error) {
      log('ERRO', `Discovery Rebase falhou: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    } finally {
      fecharBanco();
    }
    return;
  }

  // MODO CONTROL SERVER: o container sobe SÓ a UI (dashboard + botões) e
  // NÃO roda o agente. O run parte de um clique em "Iniciar bot" (ou
  // POST /api/start). Evita gastar cota sem ninguém pedir.
  if (process.env.CONTROL_MODE === 'true') {
    log('INFO', `Modelo agente: ${config.agentLlmModel} (${config.agentLlmBaseUrl})`);
    log('INFO', `Modo: CONTROL SERVER — o bot só roda quando você pedir (UI em http://localhost:${config.dashboardPort})`);
    iniciarControlServer(config.dashboardPort, config.dashboardHost);
    return; // mantém o processo vivo servindo a UI
  }

  log('INFO', `Modelo agente: ${config.agentLlmModel} (${config.agentLlmBaseUrl})`);
  log('INFO', `CDP: ${config.cdpEndpoint}`);
  log('INFO', `Limite diario: ${config.limiteDiario}`);
  log('INFO', `Score minimo: ${config.scoreMinimo}/10`);
  log('INFO', `Meta de qualidade: ${config.metaCandidaturas > 0 ? `${config.metaCandidaturas} candidatura(s) por run` : 'desativada'}`);

  if (config.dryRun) {
    log('WARN', '*** MODO DRY-RUN ATIVO — nenhuma candidatura sera enviada de verdade ***');
  }

  // Configura notificacoes (opcionais)
  configurarTelegram(config.telegramBotToken, config.telegramChatId, config.telegramAtivo);
  configurarEmail(config.smtpHost, config.smtpPort, config.smtpUser, config.smtpPass, config.emailDestinatario, config.emailAtivo);

  // Configura LLM auxiliar (cover letter, currículo, mensagem recrutador)
  configurarLLMAux({
    provider: config.llmAuxProvider,
    model: config.llmAuxModel,
    geminiApiKey: config.geminiApiKey,
    geminiModel: config.geminiModel,
    ollamaUrl: config.ollamaUrl,
    openaiApiKey: config.openaiApiKey,
    openaiBaseUrl: config.openaiBaseUrl,
    sessionId: config.openRouterSessionId,
  });

  // Verifica se é modo cron ou execução única
  if (config.cronAtivo) {
    log('INFO', `Modo CRON ativado. Horario: ${config.cronHorario}`);
    log('INFO', 'O bot ficara rodando e executara automaticamente no horario configurado.');
    log('INFO', 'Pressione Ctrl+C para parar.');

    iniciarCron(config.cronHorario, () => {
      resetarTracker();
      return executarFluxoPrincipal(config);
    });

    // Os sinais SIGINT/SIGTERM já estão registrados em main() — o handler
    // trata tanto a parada suave de um run em andamento quanto o encerramento
    // do cron sem run ativo (fluxoEmAndamento === false → sai direto).
  } else {
    // Execução única
    await executarFluxoPrincipal(config);
    // Fecha o dashboard para o processo poder encerrar (no modo cron ele
    // permanece aberto entre execucoes para visualizacao).
    pararDashboard();
  }
}

main().catch((error) => {
  log('ERRO', `Erro inesperado: ${error}`);
  fecharBanco();
  process.exit(1);
});
