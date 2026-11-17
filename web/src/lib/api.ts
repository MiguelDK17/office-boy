// Camada de acesso ao backend do Office Boy (control server na porta 1717).
//
// Transporte em tempo real: SSE em /events (eventos snapshot, log, estado e
// progresso). Em dev o Vite faz proxy de /api e /events para o backend;
// em produção o próprio Node serve o build e os endpoints na mesma porta.

import type {
  ApiData,
  Configuracao,
  EstadoRun,
  LogLine,
  LogTone,
  Progresso,
  Snapshot,
} from "./types";

/** GET /api/config — dados reais dos configs (perfil/respostas/sites/currículos) + .env mascarado. */
export async function carregarConfiguracao(): Promise<Configuracao> {
  const resp = await fetch("/api/config");
  if (!resp.ok) throw new Error(`api/config: ${resp.status}`);
  return (await resp.json()) as Configuracao;
}

/** PUT genérico das rotas de config. Retorna mensagem de erro do backend ou null. */
async function salvarConfig(rota: string, corpo: unknown): Promise<string | null> {
  const resp = await fetch(`/api/config/${rota}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(corpo),
  });
  const dados = (await resp.json().catch(() => ({}))) as { mensagem?: string };
  return resp.ok ? null : (dados.mensagem ?? `Falha ao salvar ${rota}`);
}

export const salvarPerfil = (perfil: Record<string, unknown>) => salvarConfig("perfil", perfil);
export const salvarRespostas = (respostas: Record<string, unknown>) => salvarConfig("respostas", respostas);
export const salvarSites = (sites: { sites: unknown }) => salvarConfig("sites", sites);
export const salvarCurriculos = (curriculos: unknown) => salvarConfig("curriculos", curriculos);
export const salvarEnv = (valores: Record<string, string>) => salvarConfig("env", { valores });

/** Modelo do catálogo OpenRouter (GET /api/config/modelos). */
export interface ModeloCatalogo {
  name: string;
  id: string;
  free: boolean;
  context: string;
}

/** Proxy do catálogo /models do endpoint OpenAI-compatible (erro = string). */
export async function carregarModelos(baseUrl: string): Promise<ModeloCatalogo[]> {
  const resp = await fetch(`/api/config/modelos?baseUrl=${encodeURIComponent(baseUrl)}`);
  const dados = (await resp.json().catch(() => ({}))) as { modelos?: ModeloCatalogo[]; mensagem?: string };
  if (!resp.ok) throw new Error(dados.mensagem ?? `Catálogo indisponível (${resp.status})`);
  return dados.modelos ?? [];
}

/**
 * Upload de currículo (PDF/DOC) em base64 — grava em curriculos/ +
 * curriculos.json. Devolve a entrada registrada (para atualizar a lista local
 * sem recarregar o config inteiro) ou o erro.
 */
export async function enviarCurriculo(
  id: string,
  nome: string,
  base64: string,
): Promise<{
  erro: string | null;
  entrada?: { id: string; arquivo: string; foco: string; usar_quando: string };
}> {
  const resp = await fetch("/api/config/curriculos/arquivo", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, nome, base64 }),
  });
  const dados = (await resp.json().catch(() => ({}))) as {
    mensagem?: string;
    entrada?: { id: string; arquivo: string; foco: string; usar_quando: string };
  };
  return resp.ok ? { erro: null, entrada: dados.entrada } : { erro: dados.mensagem ?? "Falha no upload" };
}

/** URL para abrir/visualizar um currículo registrado. */
export const urlCurriculo = (id: string) =>
  `/api/config/curriculos/arquivo?id=${encodeURIComponent(id)}`;

/** Corpo de GET /api/data — métricas, funil e candidaturas recentes. */
export async function carregarDados(): Promise<ApiData> {
  const resp = await fetch("/api/data");
  if (!resp.ok) throw new Error(`api/data: ${resp.status}`);
  return (await resp.json()) as ApiData;
}

/** POST /api/start. Iterações/meta null/undefined → o backend usa o padrão do
 *  .env. Retorna a mensagem de erro do backend (ex.: navegador indisponível) ou null. */
export async function iniciarBot(
  dryRun: boolean,
  maxIteracoes?: number | null,
  metaCandidaturas?: number | null,
): Promise<string | null> {
  const resp = await fetch("/api/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      dryRun,
      ...(maxIteracoes != null && Number.isFinite(maxIteracoes)
        ? { maxIteracoes }
        : {}),
      ...(metaCandidaturas != null && Number.isFinite(metaCandidaturas)
        ? { metaCandidaturas }
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
