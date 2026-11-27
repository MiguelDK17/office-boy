export interface Experiencia {
  empresa: string;
  cargo: string;
  periodo: string;
  descricao: string;
}

export interface Perfil {
  nome: string;
  email: string;
  telefone: string;
  /** CPF real do candidato; nunca deve ser inventado ou substituído por "a combinar". */
  cpf?: string;
  linkedin: string;
  github: string;
  portfolio: string;
  curriculo_path: string;
  titulo_profissional: string;
  anos_experiencia: number;
  stack_principal: string[];
  resumo_profissional: string;
  pretensao_salarial: string;
  modelo_trabalho: string[];
  cidade: string;
  disponibilidade: string;
  palavras_chave_busca: string[];
  experiencias?: Experiencia[];
  bancos_de_dados?: string[];
  metodologias?: string[];
  informacoes_extras?: Record<string, string>;
  // Preferências opcionais (retrocompatíveis — ausentes = comportamento atual)
  regra_localizacao?: string;
  /** Localidades onde presencial/híbrido são aceitos; fora delas vale a regra textual. */
  localizacoes_presencial_hibrido?: string[];
  nivel_ingles?: NivelIngles;
  blacklist_empresas?: string[];
  blacklist_termos_titulo?: string[];
}

/** Escala ordinal de proficiência em inglês, usada nas checagens eliminatórias. */
export type NivelIngles = 'nenhum' | 'basico' | 'intermediario' | 'avancado' | 'fluente';

export interface Site {
  /** UUID gerado e persistido (sites-api) — identifica o site nas rotas. */
  id?: string;
  nome: string;
  urls_busca: string[];
  tipo: 'portal_vagas' | 'linkedin' | 'empresa_direta';
  instrucoes: string;
  ativo: boolean;
}

export interface SitesConfig {
  sites: Site[];
}

export interface Candidatura {
  id?: number;
  plataforma: string;
  titulo_vaga: string;
  empresa: string;
  url: string;
  data_aplicacao: string;
  mensagem_enviada: number;
  status: string;
  score?: number;
  screenshot_path?: string;
  resultado?: string;
}

export type StatusFilaVaga = 'pendente' | 'processando' | 'aplicado' | 'pulada' | 'erro';

export interface VagaFila {
  id?: number;
  url: string;
  titulo_vaga: string;
  empresa: string;
  plataforma: string;
  descricao?: string;
  localizacao?: string;
  score?: number;
  status: StatusFilaVaga;
  motivo?: string;
  data_criacao?: string;
}

/** Configuração de um servidor MCP remoto genérico. */
export interface McpServerConfig {
  name: string;
  transport?: 'streamable-http' | 'stdio';
  url?: string;
  token?: string;
  command?: string;
  args?: string[];
  authentication?: 'bearer' | 'none';
  enabled?: boolean;
  /** Obrigatória para evitar expor tools mutáveis sem revisão explícita. */
  allowedTools?: string[];
}

export interface AgenteConfig {
  /** full = descoberta + candidatura, discovery = só fila, apply = só fila pendente. */
  modoExecucao?: 'full' | 'discovery' | 'apply';
  // LLM do agente de navegação (agnóstico, padrão OpenAI SDK — funciona com
  // OpenRouter, OpenAI nativa, Ollama ou qualquer endpoint OpenAI-compatible).
  agentLlmBaseUrl: string;
  agentLlmApiKey: string;
  agentLlmModel: string;
  // Chaves legadas do Gemini: mantidas como fallback opcional do LLM auxiliar
  // (src/llm-adapter.ts). O agente de navegação NÃO usa mais estas chaves.
  geminiApiKey: string;
  geminiModel: string;
  cdpEndpoint: string;
  limiteDiario: number;
  maxPorExecucao: number;
  // Teto de iterações do loop do agente por run (padrão 100; ajustável na UI).
  maxIteracoes: number;
  delayMin: number;
  delayMax: number;
  dryRun: boolean;
  scoreMinimo: number;
  // Dashboard (porta do servidor web local)
  dashboardPort: number;
  // Host de bind do dashboard (127.0.0.1 local; 0.0.0.0 no Docker p/ port-mapping)
  dashboardHost: string;
  // Circuito de parada por custo (0 = desativado)
  custoMaxUsd: number;
  // Meta de candidaturas de qualidade por run (default 10; 0 = desativado).
  // Encerramento "de sucesso": quando a contagem de candidaturas registradas
  // com score >= scoreMinimo atinge a meta, o run finaliza limpo (recovery
  // limpo, sem erro fatal). MAX_ITERACOES e CUSTO_MAX_USD continuam como
  // backstops, nunca como gatilho principal.
  metaCandidaturas: number;
  // Pausar o run automaticamente ao detectar página de login (default true).
  // O processo fica vivo e a UI/Telegram avisam para o usuário logar no Chrome.
  pausarEmLogin: boolean;
  // Telegram (opcional)
  telegramBotToken: string;
  telegramChatId: string;
  telegramAtivo: boolean;
  // Email (opcional)
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPass: string;
  emailDestinatario: string;
  emailAtivo: boolean;
  // Cron (desativado por padrão)
  cronAtivo: boolean;
  cronHorario: string;
  // Multi-LLM (opcional — provider auxiliar para cover letter, currículo, mensagem)
  llmAuxProvider: string;
  llmAuxModel: string;
  ollamaUrl: string;
  openaiApiKey: string;
  openaiBaseUrl: string;
  // Rebase Jobs (fonte complementar de vagas via MCP, opt-in).
  rebaseJobsEnabled: boolean;
  rebaseJobsMcpUrl: string;
  rebaseJobsToken: string;
  rebaseJobsAllowExternalApply?: boolean;
  rebaseJobsAllowedHosts?: string[];
  /** ID compartilhado pelas chamadas OpenRouter de uma execução. */
  openRouterSessionId?: string;
}

export interface RespostasPredefinidas {
  [chave: string]: string | Record<string, string>;
}
