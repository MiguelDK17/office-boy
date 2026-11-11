// App — dashboard do Office Boy.
//
// Integração: o estado vem do hook useBot (SSE /events + /api/data). Nenhum
// dado fictício; todos os estados visuais do design original permanecem
// (parado, rodando, parando, terminal expandido, opções avançadas, vazio).

import { useEffect, useState } from "react";
import { useBot } from "./hooks/useBot";
import { FunnelBar } from "./components/FunnelBar";
import { Icon } from "./components/Icon";
import { MetricCard } from "./components/MetricCard";
import { RobotVisual } from "./components/RobotVisual";
import { StatusChip } from "./components/StatusChip";
import { TerminalPanel } from "./components/TerminalPanel";
import type { Candidatura } from "./lib/types";

const runningMessages = [
  "Analisando vagas e enviando candidaturas compatíveis com seu perfil.",
  "Garimpando oportunidades enquanto você cuida do que importa.",
  "Seu currículo está passeando por lugares promissores.",
  "Conferindo cada detalhe antes de apertar o botão enviar.",
  "Mais uma candidatura a caminho da vaga certa.",
  "Trabalho repetitivo por aqui. Novas possibilidades por aí.",
];

function tempoRelativo(dataAplicacao: string): string {
  // "2026-09-28 16:52:38" (local, padrão SQLite) → relativo em min/h/dias.
  const data = new Date(dataAplicacao.replace(" ", "T"));
  if (Number.isNaN(data.getTime())) return "—";
  const diffMs = Date.now() - data.getTime();
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return "Agora";
  if (min < 60) return `${min} min`;
  const horas = Math.floor(min / 60);
  if (horas < 24) return `${horas} h`;
  return `${Math.floor(horas / 24)} d`;
}

function rotuloStatus(c: Candidatura): string {
  if (c.status === "dry-run") return "Dry run";
  if (c.resultado && c.resultado !== "aguardando") {
    const r = c.resultado.replace("_", " ");
    return r.charAt(0).toUpperCase() + r.slice(1);
  }
  return "Enviada";
}

export default function App() {
  const {
    status,
    desconectado,
    dryRun: dryRunDoServidor,
    maxIteracoesPadrao,
    candidaturasDaRun,
    iteracaoAtual,
    iteracaoTotal,
    logs,
    dados,
    erroIniciar,
    iniciar,
    parar,
  } = useBot();

  const [darkMode, setDarkMode] = useState(() => {
    try {
      return localStorage.getItem("officeboy-tema") === "dark";
    } catch {
      return false;
    }
  });
  const [advanced, setAdvanced] = useState(false);
  const [dryRun, setDryRun] = useState(false);
  const [terminalExpanded, setTerminalExpanded] = useState(() => {
    try {
      return localStorage.getItem("officeboy-terminal") === "aberto";
    } catch {
      return false;
    }
  });
  const [detailsVisible, setDetailsVisible] = useState(false);
  const [limit, setLimit] = useState("");
  const [messageIndex, setMessageIndex] = useState(0);

  // Lembra tema e terminal entre sessões (mesma chave do dashboard legado).
  useEffect(() => {
    try {
      localStorage.setItem("officeboy-tema", darkMode ? "dark" : "light");
    } catch {
      // localStorage indisponível: sem persistência, sem quebra.
    }
  }, [darkMode]);
  useEffect(() => {
    try {
      localStorage.setItem("officeboy-terminal", terminalExpanded ? "aberto" : "fechado");
    } catch {
      // idem
    }
  }, [terminalExpanded]);

  // Preferência de dry-run: começa com o valor do servidor (primeira resposta).
  const [dryRunIniciado, setDryRunIniciado] = useState(false);
  useEffect(() => {
    if (!dryRunIniciado && !desconectado) {
      setDryRunIniciado(true);
      setDryRun(dryRunDoServidor);
    }
  }, [dryRunIniciado, desconectado, dryRunDoServidor]);

  const running = status === "running";
  const stopping = status === "stopping";
  const count = candidaturasDaRun;
  const totalIteracoes = iteracaoTotal || maxIteracoesPadrao;
  const progress = totalIteracoes > 0 ? (iteracaoAtual / totalIteracoes) * 100 : 0;

  useEffect(() => {
    if (!running) {
      setMessageIndex(0);
      return;
    }

    const interval = window.setInterval(() => {
      setMessageIndex((current) => (current + 1) % runningMessages.length);
    }, 3600);

    return () => window.clearInterval(interval);
  }, [running]);

  async function toggleBot() {
    if (running || stopping) {
      await parar();
      return;
    }
    // Campo vazio = padrão do .env (null → backend usa MAX_ITERACOES).
    const n = parseInt(limit, 10);
    await iniciar(dryRun, Number.isFinite(n) && n >= 1 ? n : null);
  }

  const funil = dados?.funil;
  const temFunil = (funil?.enviadas ?? 0) > 0;
  const candidaturas = dados?.candidaturas ?? [];
  const plataformas = dados?.porPlataforma;

  return (
    <div className={`app-shell ${darkMode ? "dark" : ""}`}>
      <div className="ambient ambient-left" />
      <div className="ambient ambient-right" />

      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">
            <Icon name="sparkle" size={18} />
          </span>
          <span>
            <strong>Office Boy</strong>
            <small>Dashboard</small>
          </span>
        </div>
        <div className="header-actions">
          <StatusChip status={status} desconectado={desconectado} />
          <button
            className="icon-button"
            onClick={() => setDarkMode((value) => !value)}
            aria-label={darkMode ? "Ativar tema claro" : "Ativar tema escuro"}
          >
            <Icon name={darkMode ? "sun" : "moon"} size={20} />
          </button>
        </div>
      </header>

      <main className={terminalExpanded ? "with-expanded-terminal" : ""}>
        <section className="hero-card" aria-labelledby="hero-title">
          <div className="hero-heading">
            <span className="eyebrow">
              <span />
              AUTOMAÇÃO INTELIGENTE
            </span>
            <h1 id="hero-title">
              {running
                ? "Seu Office Boy está trabalhando"
                : stopping
                  ? "Encerrando a run..."
                  : "Pronto para buscar oportunidades?"}
            </h1>
            <p
              className={running ? "running-message" : erroIniciar ? "error-message" : undefined}
              key={running ? messageIndex : "stopped"}
            >
              {running
                ? runningMessages[messageIndex]
                : erroIniciar
                  ? erroIniciar
                  : stopping
                    ? "Aguarde — o bot está finalizando a iteração atual."
                    : "Inicie uma nova run e deixe o trabalho repetitivo com a gente."}
            </p>
          </div>

          <RobotVisual running={running} stopping={stopping} />

          <div className={`live-counter ${!running ? "counter-idle" : ""}`}>
            <strong>{count}</strong>
            <span>candidaturas enviadas nesta run</span>
          </div>

          <div className="progress-wrap">
            <div className="progress-copy">
              <span>Progresso da run</span>
              <span>
                <b>{iteracaoAtual}</b> de {totalIteracoes} interações
              </span>
            </div>
            <div className="progress-track">
              <span style={{ width: `${progress}%` }} />
            </div>
          </div>

          <button
            className={`primary-button ${running || stopping ? "button-stop" : ""}`}
            onClick={toggleBot}
            disabled={stopping}
          >
            <Icon name={running || stopping ? "stop" : "play"} size={21} />
            {stopping ? "Parando..." : running ? "Parar" : "Iniciar bot"}
          </button>

          <div className="hero-options">
            <label className="switch-label">
              <button
                role="switch"
                aria-checked={dryRun}
                className={`switch ${dryRun ? "switch-on" : ""}`}
                onClick={() => setDryRun((value) => !value)}
                type="button"
              >
                <span />
              </button>
              <strong>Rodada Teste</strong>
              <span className="tooltip-wrap">
                <button
                  className="tooltip-trigger"
                  type="button"
                  aria-label="Saiba mais sobre Rodada Teste"
                  aria-describedby="test-run-tooltip"
                >
                  ?
                </button>
                <span className="tooltip-content" role="tooltip" id="test-run-tooltip">
                  Simula, não envia
                </span>
              </span>
            </label>
            <button
              className={`advanced-link ${advanced ? "is-open" : ""}`}
              onClick={() => setAdvanced((value) => !value)}
            >
              Opções avançadas
              <Icon name="chevron" size={16} />
            </button>
          </div>

          <div className={`advanced-options ${advanced ? "advanced-visible" : ""}`}>
            <div>
              <label htmlFor="run-limit">Interações por run</label>
              <span>Defina um limite para esta execução</span>
            </div>
            <div className="input-wrap">
              <input
                id="run-limit"
                value={limit}
                onChange={(event) => setLimit(event.target.value.replace(/\D/g, ""))}
                inputMode="numeric"
                placeholder={String(maxIteracoesPadrao)}
              />
              <small>Vazio usa o padrão do .env</small>
            </div>
          </div>
        </section>

        <section className="metrics-grid" aria-label="Métricas">
          <MetricCard
            icon="clock"
            label="Hoje"
            value={String(dados?.hoje.total ?? 0)}
            detail={`Score médio: ${dados?.hoje.scoreMedio ? dados.hoje.scoreMedio.toFixed(1) : "—"}`}
          />
          <MetricCard
            icon="briefcase"
            label="Total"
            value={String(dados?.total ?? 0)}
            detail={`Em ${plataformas?.length ?? 0} plataforma(s)`}
          />
        </section>

        <button
          className={`details-toggle ${detailsVisible ? "details-open" : ""}`}
          onClick={() => setDetailsVisible((value) => !value)}
          aria-expanded={detailsVisible}
          aria-controls="dashboard-details"
          aria-label={
            detailsVisible ? "Ocultar performance e atividade" : "Mostrar performance e atividade"
          }
        >
          <span>{detailsVisible ? "Ocultar detalhes" : "Performance e atividade"}</span>
          <Icon name="chevron" size={18} />
        </button>

        <div
          className={`dashboard-details ${detailsVisible ? "details-visible" : ""}`}
          id="dashboard-details"
          aria-hidden={!detailsVisible}
          inert={!detailsVisible}
        >
          <div className="dashboard-details-inner">
            <section className="content-card funnel-card">
              <div className="section-heading">
                <div>
                  <span className="section-kicker">PERFORMANCE</span>
                  <h2>Funil de resultados</h2>
                </div>
                {funil?.taxaResposta != null && (
                  <span className="updated-label">Taxa de resposta: {funil.taxaResposta}%</span>
                )}
              </div>
              {temFunil ? (
                <div className="funnel-grid">
                  <FunnelBar
                    label="Enviadas"
                    value={funil?.enviadas ?? 0}
                    percent={dados?.percentuais.enviadas ?? 100}
                  />
                  <FunnelBar
                    label="Respondidas"
                    value={funil?.respondidas ?? 0}
                    percent={dados?.percentuais.respondidas ?? 0}
                  />
                  <FunnelBar
                    label="Entrevistas"
                    value={funil?.entrevistas ?? 0}
                    percent={dados?.percentuais.entrevistas ?? 0}
                  />
                  <FunnelBar
                    label="Ofertas"
                    value={funil?.ofertas ?? 0}
                    percent={dados?.percentuais.ofertas ?? 0}
                  />
                </div>
              ) : (
                <div className="empty-funnel">
                  <div className="empty-illustration">
                    <span />
                    <span />
                    <span />
                    <Icon name="trend" size={24} />
                  </div>
                  <div>
                    <strong>Seu funil aparecerá aqui</strong>
                    <p>
                      Marque desfechos com{" "}
                      <code>npm run resultado &lt;id&gt; &lt;resultado&gt;</code> para ativar as
                      métricas de retorno.
                    </p>
                  </div>
                </div>
              )}
            </section>

            <section className="content-card applications-card">
              <div className="section-heading">
                <div>
                  <span className="section-kicker">ATIVIDADE</span>
                  <h2>Candidaturas recentes</h2>
                </div>
                {running && <span className="updated-label">Atualizado agora</span>}
              </div>
              {candidaturas.length > 0 ? (
                <div className="application-list">
                  {candidaturas.map((c, index) => (
                    <div className="application-row" key={c.id}>
                      <span className={`company-avatar avatar-${index % 3}`}>
                        {c.empresa.charAt(0)}
                      </span>
                      <span className="application-company">
                        <strong>{c.empresa}</strong>
                        <small>{c.tituloVaga}</small>
                      </span>
                      <span className="application-time">{tempoRelativo(c.dataAplicacao)}</span>
                      <span className="score">
                        <small>Score</small>
                        {c.score ?? "—"}
                      </span>
                      <span
                        className={`application-status ${c.status === "dry-run" ? "status-review" : ""}`}
                      >
                        {rotuloStatus(c)}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="empty-applications">
                  <span>
                    <Icon name="envelope" size={25} />
                  </span>
                  <strong>Nenhuma candidatura registrada ainda.</strong>
                  <p>Inicie o bot para encontrar vagas compatíveis com o seu perfil.</p>
                </div>
              )}
            </section>
          </div>
        </div>
      </main>

      <TerminalPanel
        logs={logs}
        expanded={terminalExpanded}
        onToggle={() => setTerminalExpanded((value) => !value)}
      />
    </div>
  );
}
