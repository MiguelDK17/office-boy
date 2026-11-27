// useConfig — carrega GET /api/config sob demanda (quando as abas Perfil ou
// Configurações são abertas) e expõe as ações de salvamento. As telas cuidam
// do estado "dirty" local; aqui só vivem o fetch e as chamadas PUT.

import { useCallback, useEffect, useState } from "react";
import {
  carregarConfiguracao,
  salvarCurriculos,
  salvarEnv,
  salvarPerfil,
  salvarRespostas,
  salvarSites,
  carregarPlugins,
  instalarPlugin,
  atualizarPlugin,
  alterarPlugin,
  configurarPlugin,
  removerPlugin,
} from "../lib/api";
import type { Configuracao, PluginInfo } from "../lib/types";
import type { ResultadoSalvarEnv } from "../lib/api";

export interface UseConfig {
  config: Configuracao | null;
  /** true quando o GET /api/config falhou (ex.: backend fora). */
  erro: string | null;
  carregando: boolean;
  recarregar: () => Promise<void>;
  salvarPerfil: (perfil: Record<string, unknown>) => Promise<string | null>;
  salvarRespostas: (respostas: Record<string, unknown>) => Promise<string | null>;
  salvarSites: (sites: { sites: unknown }) => Promise<string | null>;
  salvarCurriculos: (curriculos: unknown) => Promise<string | null>;
  salvarEnv: (valores: Record<string, string>) => Promise<ResultadoSalvarEnv>;
  plugins: PluginInfo[];
  recarregarPlugins: () => Promise<void>;
  instalarPlugin: (arquivo: File) => Promise<string | null>;
  atualizarPlugin: (arquivo: File) => Promise<string | null>;
  alterarPlugin: (id: string, enabled: boolean) => Promise<string | null>;
  configurarPlugin: (id: string, values: Record<string, string | number | boolean>, enabled?: boolean, confirmarStdio?: boolean) => Promise<string | null>;
  removerPlugin: (id: string) => Promise<string | null>;
}

export function useConfig(ativo: boolean): UseConfig {
  const [config, setConfig] = useState<Configuracao | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(false);
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);

  const recarregarPlugins = useCallback(async () => {
    try {
      setPlugins(await carregarPlugins());
    } catch {
      setPlugins([]);
    }
  }, []);

  const recarregar = useCallback(async () => {
    setCarregando(true);
    setErro(null);
    try {
      setConfig(await carregarConfiguracao());
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Falha ao carregar configurações");
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => {
    // Só carrega quando a aba é aberta pela primeira vez — Run continua leve.
    if (ativo && !config && !erro && !carregando) void recarregar();
  }, [ativo, config, erro, carregando, recarregar]);

  useEffect(() => {
    if (ativo) void recarregarPlugins();
  }, [ativo, recarregarPlugins]);

  return {
    config,
    erro,
    carregando,
    recarregar,
    salvarPerfil,
    salvarRespostas,
    salvarSites,
    salvarCurriculos,
    salvarEnv,
    plugins,
    recarregarPlugins,
    instalarPlugin,
    atualizarPlugin,
    alterarPlugin,
    configurarPlugin,
    removerPlugin,
  };
}
