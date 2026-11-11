// useBot — estado do Office Boy para a UI, isolado atrás deste hook.
//
// Tempo real via SSE (/events) com reconexão automática; métricas via
// /api/data (recarregadas quando o estado muda). Trocar para polling no
// futuro = reimplementar só este arquivo.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  carregarDados,
  conectarEventos,
  iniciarBot,
  pararBot,
  parseLote,
} from "../lib/api";
import type {
  ApiData,
  BotState,
  EstadoRun,
  LogLine,
  Progresso,
  Snapshot,
} from "../lib/types";

const MAX_LINHAS = 400;

export interface UseBot {
  /** idle/running/stopping — "offline" não é um estado do bot, é conexão. */
  status: BotState;
  /** true quando o EventSource está fora do backend. */
  desconectado: boolean;
  dryRun: boolean;
  /** Padrão do .env (para o placeholder do campo "Interações por run"). */
  maxIteracoesPadrao: number;
  candidaturasDaRun: number;
  iteracaoAtual: number;
  iteracaoTotal: number;
  codigoSaida: number | null;
  logs: LogLine[];
  dados: ApiData | null;
  /** Mensagem de erro da última tentativa de iniciar (ex.: navegador off). */
  erroIniciar: string | null;
  iniciar: (dryRun: boolean, maxIteracoes: number | null) => Promise<void>;
  parar: () => Promise<void>;
}

const estadoInicial: EstadoRun = {
  rodando: false,
  parando: false,
  iniciadoEm: null,
  encerradoEm: null,
  codigoSaida: null,
  dryRun: false,
  ultimoCusto: null,
  iteracaoAtual: 0,
  iteracaoTotal: 0,
};

export function useBot(): UseBot {
  const [estado, setEstado] = useState<EstadoRun>(estadoInicial);
  const [desconectado, setDesconectado] = useState(true);
  const [maxIteracoesPadrao, setMaxIteracoesPadrao] = useState(500);
  const [candidaturasDaRun, setCandidaturasDaRun] = useState(0);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [dados, setDados] = useState<ApiData | null>(null);
  const [erroIniciar, setErroIniciar] = useState<string | null>(null);
  const rodandoRef = useRef(false);

  // Métricas: carrega no início e a cada mudança de estado do bot
  // (fim de run atualiza Hoje/Total/funil/candidaturas recentes).
  const recarregarDados = useCallback(async () => {
    try {
      setDados(await carregarDados());
    } catch {
      // Sem conexão: o indicador "offline" já cobre isto.
    }
  }, []);

  useEffect(() => {
    let cancelado = false;

    const aplicarEstado = (novo: EstadoRun) => {
      setEstado((anterior) => {
        const mudouRodando = anterior.rodando !== novo.rodando;
        rodandoRef.current = novo.rodando;
        if (mudouRodando) {
          if (novo.rodando) setCandidaturasDaRun(0);
          else void recarregarDados();
        }
        return novo;
      });
    };

    const fechar = conectarEventos({
      onSnapshot: (s: Snapshot) => {
        if (cancelado) return;
        setMaxIteracoesPadrao(s.maxIteracoesPadrao || 500);
        setCandidaturasDaRun(s.candidaturasDaRun);
        setLogs(parseLote(s.linhas));
        rodandoRef.current = s.rodando;
        setEstado({
          rodando: s.rodando,
          parando: s.parando,
          iniciadoEm: s.iniciadoEm,
          encerradoEm: s.encerradoEm,
          codigoSaida: s.codigoSaida,
          dryRun: s.dryRun,
          ultimoCusto: s.ultimoCusto,
          iteracaoAtual: s.iteracaoAtual,
          iteracaoTotal: s.iteracaoTotal,
        });
        void recarregarDados();
      },
      onEstado: (e: EstadoRun) => {
        if (cancelado) return;
        setErroIniciar(null);
        aplicarEstado(e);
      },
      onProgresso: (p: Progresso) => {
        if (cancelado) return;
        setEstado((anterior) => ({
          ...anterior,
          iteracaoAtual: p.iteracaoAtual,
          iteracaoTotal: p.iteracaoTotal,
        }));
        setCandidaturasDaRun(p.candidaturasDaRun);
      },
      onLog: (linha: LogLine) => {
        if (cancelado) return;
        setLogs((atual) => {
          const proximas = [...atual, linha];
          return proximas.length > MAX_LINHAS
            ? proximas.slice(proximas.length - MAX_LINHAS)
            : proximas;
        });
      },
      onStatusConexao: (conectado: boolean) => {
        if (cancelado) return;
        setDesconectado(!conectado);
        if (conectado) void recarregarDados();
      },
    });

    return () => {
      cancelado = true;
      fechar();
    };
  }, [recarregarDados]);

  const iniciar = useCallback(
    async (dryRun: boolean, maxIteracoes: number | null) => {
      setErroIniciar(null);
      const erro = await iniciarBot(dryRun, maxIteracoes);
      if (erro) setErroIniciar(erro);
    },
    [],
  );

  const parar = useCallback(async () => {
    setErroIniciar(null);
    await pararBot();
    // O estado "parando" chega pelo evento `estado` do SSE.
  }, []);

  const status: BotState = desconectado && estado.rodando
    ? "running" // Mantém a run visível; o chip "SEM CONEXÃO" sinaliza o offline.
    : estado.parando
      ? "stopping"
      : estado.rodando
        ? "running"
        : "stopped";

  return {
    status,
    desconectado,
    dryRun: estado.dryRun,
    maxIteracoesPadrao,
    candidaturasDaRun,
    iteracaoAtual: estado.iteracaoAtual,
    iteracaoTotal: estado.iteracaoTotal,
    codigoSaida: estado.codigoSaida,
    logs,
    dados,
    erroIniciar,
    iniciar,
    parar,
  };
}
