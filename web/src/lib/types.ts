// Tipos compartilhados entre a camada de dados (lib/api.ts, hooks/useBot.ts)
// e os componentes da UI.

export type BotState = "stopped" | "running" | "paused" | "stopping" | "offline";
export type ModoExecucao = "full" | "discovery" | "apply";

export interface PluginSettingInfo {
  key: string;
  label: string;
  type: "text" | "secret" | "boolean" | "number";
  hint?: string;
  required?: boolean;
  defined: boolean;
  value?: string | number | boolean;
}

export interface PluginInfo {
  id: string;
  version: string;
  name: string;
  description: string;
  connection: { transport: "streamable-http" | "stdio"; url?: string; command?: string; authentication?: "bearer" | "none" };
  enabled: boolean;
  configured: boolean;
  connectionStatus: "inactive" | "ready" | "invalid" | "connected" | "error";
  settings: PluginSettingInfo[];
  tools: Array<{ name: string; scope: "read" | "discovery" | "queue" | "apply" }>;
}

// ========== /api/config (telas Perfil e Configurações) ==========

export type GrupoEnv = "execucao" | "agente" | "auxiliar" | "servidor" | "notificacoes" | "cron";

/** Um campo do .env exposto na UI. Secret NUNCA tem valor — só "definido". */
export interface CampoEnv {
  chave: string;
  grupo: GrupoEnv;
  tipo: "numero" | "booleano" | "texto";
  secreto: boolean;
  somenteLeitura: boolean;
  valor: string | number | boolean | null;
  definido: boolean;
}

export interface ExperienciaPerfil {
  empresa: string;
  cargo: string;
  periodo: string;
  descricao: string;
}

/** Corpo de GET /api/config — dados reais dos configs e do .env. */
export interface Configuracao {
  perfil: Record<string, unknown>;
  respostas: Record<string, unknown>;
  sites: { sites: SiteConfig[] };
  curriculos: {
    fallback?: Record<string, string>;
    curriculos?: Array<{ id: string; arquivo: string; foco: string; usar_quando: string }>;
  };
  env: CampoEnv[];
  /** false = .env não existe neste ambiente (container) — salvar config mostra o motivo. */
  envDisponivel: boolean;
}

export interface SiteConfig {
  /** UUID gerado pelo backend e persistido no sites.json. */
  id: string;
  nome: string;
  tipo: "portal_vagas" | "linkedin" | "empresa_direta" | string;
  instrucoes: string;
  urls_busca: string[];
  ativo: boolean;
}

/** Estado completo do run, como enviado no snapshot e nos eventos `estado` do SSE. */
export interface EstadoRun {
  rodando: boolean;
  parando: boolean;
  /** Run em pausa — processo vivo, aguardando "Retomar". */
  pausado: boolean;
  /** Motivo da pausa: 'login' = automática por página de login; null = manual. */
  motivoPausa: "login" | null;
  iniciadoEm: string | null;
  encerradoEm: string | null;
  codigoSaida: number | null;
  dryRun: boolean;
  ultimoCusto: number | null;
  iteracaoAtual: number;
  iteracaoTotal: number;
  modo: ModoExecucao;
}

export interface Snapshot extends EstadoRun {
  maxIteracoesPadrao: number;
  metaCandidaturasPadrao: number;
  linhas: string[];
  candidaturasDaRun: number;
}

export interface Progresso {
  iteracaoAtual: number;
  iteracaoTotal: number;
  candidaturasDaRun: number;
}

export interface Candidatura {
  id: number;
  empresa: string;
  tituloVaga: string;
  plataforma: string;
  url: string;
  dataAplicacao: string;
  score: number | null;
  status: string;
  resultado: string;
}

/** Corpo de GET /api/data — métricas, funil e candidaturas recentes. */
export interface ApiData {
  hoje: { total: number; scoreMedio: number | null };
  total: number;
  porPlataforma: Array<{ plataforma: string; total: number; scoreMedio: number | null }>;
  porStatus: Array<{ status: string; total: number }>;
  funil: {
    enviadas: number;
    respondidas: number;
    respondidasPercentual: number | null;
    entrevistas: number;
    ofertas: number;
    comDesfecho: number;
    taxaResposta: number | null;
  };
  percentuais: { enviadas: number; respondidas: number; entrevistas: number; ofertas: number };
  candidaturas: Candidatura[];
  run: {
    rodando: boolean;
    parando: boolean;
    pausado: boolean;
    motivoPausa: "login" | null;
    dryRun: boolean;
    iniciadoEm: string | null;
    iteracaoAtual: number;
    iteracaoTotal: number;
    candidaturasDaRun: number;
    ultimoCusto: number | null;
    modo: ModoExecucao;
  };
}

export type LogTone = "info" | "muted" | "success" | "error" | "warn" | "tool" | "agent";

/** Linha de log já parseada para o terminal da UI. */
export interface LogLine {
  id: number;
  time: string;
  tone: LogTone;
  text: string;
}
