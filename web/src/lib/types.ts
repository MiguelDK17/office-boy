// Tipos compartilhados entre a camada de dados (lib/api.ts, hooks/useBot.ts)
// e os componentes da UI.

export type BotState = "stopped" | "running" | "stopping" | "offline";

/** Estado completo do run, como enviado no snapshot e nos eventos `estado` do SSE. */
export interface EstadoRun {
  rodando: boolean;
  parando: boolean;
  iniciadoEm: string | null;
  encerradoEm: string | null;
  codigoSaida: number | null;
  dryRun: boolean;
  ultimoCusto: number | null;
  iteracaoAtual: number;
  iteracaoTotal: number;
}

export interface Snapshot extends EstadoRun {
  maxIteracoesPadrao: number;
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
    dryRun: boolean;
    iniciadoEm: string | null;
    iteracaoAtual: number;
    iteracaoTotal: number;
    candidaturasDaRun: number;
    ultimoCusto: number | null;
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
