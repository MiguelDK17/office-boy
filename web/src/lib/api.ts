// Camada de acesso ao backend do Office Boy (control server na porta 1717).
//
// Transporte em tempo real: SSE em /events (eventos snapshot, log, estado e
// progresso). Em dev o Vite faz proxy de /api e /events para o backend;
// em produção o próprio Node serve o build e os endpoints na mesma porta.

import type {
  ApiData,
  EstadoRun,
  LogLine,
  LogTone,
  Progresso,
  Snapshot,
} from "./types";

/** Corpo de GET /api/data — métricas, funil e candidaturas recentes. */
export async function carregarDados(): Promise<ApiData> {
  const resp = await fetch("/api/data");
  if (!resp.ok) throw new Error(`api/data: ${resp.status}`);
  return (await resp.json()) as ApiData;
}

/** POST /api/start. Iterações null/undefined → o backend usa o padrão do .env.
 *  Retorna a mensagem de erro do backend (ex.: navegador indisponível) ou null. */
export async function iniciarBot(
  dryRun: boolean,
  maxIteracoes?: number | null,
): Promise<string | null> {
  const resp = await fetch("/api/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      dryRun,
      ...(maxIteracoes != null && Number.isFinite(maxIteracoes)
        ? { maxIteracoes }
        : {}),
    }),
  });
  const corpo = (await resp.json().catch(() => ({}))) as { mensagem?: string };
  return resp.ok ? null : (corpo.mensagem ?? "Não foi possível iniciar o bot");
}

export async function pararBot(): Promise<void> {
  await fetch("/api/stop", { method: "POST" });
}

/** POST /api/pause — pausa na fronteira da iteração (processo vivo). */
export async function pausarBot(): Promise<void> {
  await fetch("/api/pause", { method: "POST" });
}

/** POST /api/resume — retoma um run pausado. */
export async function retomarBot(): Promise<void> {
  await fetch("/api/resume", { method: "POST" });
}

const LINHA = /^\[([^\]]+)\] \[(\w+)\]\s?(.*)$/;

function nivelParaTone(nivel: string): LogTone {
  switch (nivel) {
    case "ERRO":
    case "FALHA":
      return "error";
    case "WARN":
      return "warn";
    case "TOOL":
      return "tool";
    case "AGENTE":
      return "agent";
    default:
      return "muted";
  }
}

let seqLog = 0; // Sequência das linhas (usada como key estável no terminal).

/** Converte uma linha crua do backend em LogLine (timestamp local + cor por nível). */
export function parseLinha(crua: string): LogLine {
  const m = LINHA.exec(crua);
  if (m) {
    const [, iso, nivel, texto] = m;
    const data = new Date(iso);
    return {
      id: seqLog++,
      time: Number.isNaN(data.getTime())
        ? "--:--:--"
        : data.toLocaleTimeString("pt-BR", { hour12: false }),
      tone: nivelParaTone(nivel),
      text: texto,
    };
  }
  // Linhas do control server (ex.: "[control] parada solicitada") e ruído sem
  // timestamp do logger — entram com o horário atual.
  return {
    id: seqLog++,
    time: new Date().toLocaleTimeString("pt-BR", { hour12: false }),
    tone: crua.startsWith("[control]") ? "agent" : "muted",
    text: crua,
  };
}

export interface EventHandlers {
  onSnapshot: (s: Snapshot) => void;
  onEstado: (e: EstadoRun) => void;
  onProgresso: (p: Progresso) => void;
  onLog: (l: LogLine) => void;
  onStatusConexao: (conectado: boolean) => void;
}

/** Conecta no SSE /events com reconexão automática nativa.
 *  Devolve a função de desligamento. */
export function conectarEventos(handlers: EventHandlers): () => void {
  const es = new EventSource("/events");

  es.addEventListener("open", () => handlers.onStatusConexao(true));
  es.onerror = () => {
    // O EventSource reconecta sozinho; aqui só marcamos a UI como offline.
    handlers.onStatusConexao(false);
  };

  es.addEventListener("snapshot", (ev) => {
    handlers.onStatusConexao(true);
    handlers.onSnapshot(JSON.parse((ev as MessageEvent<string>).data));
  });
  es.addEventListener("estado", (ev) => {
    handlers.onStatusConexao(true);
    handlers.onEstado(JSON.parse((ev as MessageEvent<string>).data));
  });
  es.addEventListener("progresso", (ev) => {
    handlers.onProgresso(JSON.parse((ev as MessageEvent<string>).data));
  });
  es.addEventListener("log", (ev) => {
    const { linha } = JSON.parse((ev as MessageEvent<string>).data) as { linha: string };
    handlers.onLog(parseLinha(linha));
  });

  return () => es.close();
}

/** Lote inicial: transforma as linhas do snapshot em LogLine. */
export function parseLote(linhas: string[]): LogLine[] {
  return linhas.map(parseLinha);
}
