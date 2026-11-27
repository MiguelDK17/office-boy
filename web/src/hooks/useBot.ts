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
  pausarBot,
  retomarBot,
  parseLote,
} from "../lib/api";
import type {
  ApiData,
  BotState,
  EstadoRun,
  LogLine,
  Progresso,
  Snapshot,
  ModoExecucao,
} from "../lib/types";

const MAX_LINHAS = 400;

export interface UseBot {
  /** stopped/running/paused/stopping — "offline" não é um estado do bot, é conexão. */
  status: BotState;
  /** Motivo da pausa atual ('login' = automática por página de login). */
  motivoPausa: "login" | null;
  /** true quando o EventSource está fora do backend. */
  desconectado: boolean;
  dryRun: boolean;
  /** Padrão do .env (para o placeholder do campo "Interações por run"). */
  maxIteracoesPadrao: number;
  /** Padrão do .env (para o placeholder do campo "Meta de candidaturas"). */
  metaCandidaturasPadrao: number;
  candidaturasDaRun: number;
  iteracaoAtual: number;
  iteracaoTotal: number;
  codigoSaida: number | null;
  logs: LogLine[];
  dados: ApiData | null;
  /** Mensagem de erro da última tentativa de iniciar (ex.: navegador off). */
  erroIniciar: string | null;
  iniciar: (dryRun: boolean, maxIteracoes: number | null, metaCandidaturas: number | null, modo: ModoExecucao) => Promise<void>;
  parar: () => Promise<void>;
  pausar: () => Promise<void>;
  retomar: () => Promise<void>;
}

const estadoInicial: EstadoRun = {
  rodando: false,
  parando: false,
  pausado: false,
  motivoPausa: null,
  iniciadoEm: null,
  encerradoEm: null,
  codigoSaida: null,
  dryRun: false,
  ultimoCusto: null,
  iteracaoAtual: 0,
  iteracaoTotal: 0,
  modo: "full",
};

export function useBot(): UseBot {
  const [estado, setEstado] = useState<EstadoRun>(estadoInicial);
  const [desconectado, setDesconectado] = useState(true);
  const [maxIteracoesPadrao, setMaxIteracoesPadrao] = useState(500);
  const [metaCandidaturasPadrao, setMetaCandidaturasPadrao] = useState(10);
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
        setMetaCandidaturasPadrao(s.metaCandidaturasPadrao ?? 10);
        setCandidaturasDaRun(s.candidaturasDaRun);
        setLogs(parseLote(s.linhas));
        rodandoRef.current = s.rodando;
        setEstado({
          rodando: s.rodando,
          parando: s.parando,
          pausado: s.pausado,
          motivoPausa: s.motivoPausa,
          iniciadoEm: s.iniciadoEm,
          encerradoEm: s.encerradoEm,
          codigoSaida: s.codigoSaida,
          dryRun: s.dryRun,
          ultimoCusto: s.ultimoCusto,
          iteracaoAtual: s.iteracaoAtual,
          iteracaoTotal: s.iteracaoTotal,
          modo: s.modo,
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
    async (dryRun: boolean, maxIteracoes: number | null, metaCandidaturas: number | null, modo: ModoExecucao) => {
      setErroIniciar(null);
      const erro = await iniciarBot(dryRun, maxIteracoes, metaCandidaturas, modo);
      if (erro) setErroIniciar(erro);
    },
    [],
  );

  const parar = useCallback(async () => {
    setErroIniciar(null);
    await pararBot();
    // O estado "parando" chega pelo evento `estado` do SSE.
  }, []);

  const pausar = useCallback(async () => {
    await pausarBot();
    // A confirmação "Run pausada" chega pelo SSE (log + estado).
  }, []);

  const retomar = useCallback(async () => {
    await retomarBot();
  }, []);

  const status: BotState = desconectado && estado.rodando
    ? estado.pausado && !estado.parando
      ? "paused" // Mantém a pausa visível; o chip "SEM CONEXÃO" sinaliza o offline.
      : "running" // Mantém a run visível; o chip "SEM CONEXÃO" sinaliza o offline.
    : estado.parando
      ? "stopping"
      : estado.rodando
        ? estado.pausado
          ? "paused"
          : "running"
        : "stopped";

  return {
    status,
    motivoPausa: estado.motivoPausa,
    desconectado,
    dryRun: estado.dryRun,
    maxIteracoesPadrao,
    metaCandidaturasPadrao,
    candidaturasDaRun,
    iteracaoAtual: estado.iteracaoAtual,
    iteracaoTotal: estado.iteracaoTotal,
    codigoSaida: estado.codigoSaida,
    logs,
    dados,
    erroIniciar,
    iniciar,
    parar,
    pausar,
    retomar,
  };
}
