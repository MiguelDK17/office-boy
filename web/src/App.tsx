import { useEffect, useMemo, useState } from "react";

type BotState = "stopped" | "running" | "stopping";
type IconName =
  | "arrow"
  | "briefcase"
  | "chevron"
  | "clock"
  | "envelope"
  | "moon"
  | "pause"
  | "play"
  | "robot"
  | "sparkle"
  | "stop"
  | "sun"
  | "terminal"
  | "trend"
  | "users";

const iconPaths: Record<IconName, React.ReactNode> = {
  arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
  briefcase: (
    <>
      <rect x="3" y="7" width="18" height="13" rx="2" />
      <path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 12h18M10 12v2h4v-2" />
    </>
  ),
  chevron: <path d="m6 9 6 6 6-6" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  envelope: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="3" />
      <path d="m4 7 8 6 8-6" />
    </>
  ),
  moon: <path d="M20 15.2A8.5 8.5 0 0 1 8.8 4a8.5 8.5 0 1 0 11.2 11.2Z" />,
  pause: (
    <>
      <path d="M9 7v10" />
      <path d="M15 7v10" />
    </>
  ),
  play: <path d="m9 7 8 5-8 5V7Z" />,
  robot: (
    <>
      <rect x="4" y="7" width="16" height="12" rx="4" />
      <path d="M12 3v4M9 12h.01M15 12h.01M8 16h8" />
    </>
  ),
  sparkle: (
    <path d="m12 3 1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3Zm6 11 .7 2.3L21 17l-2.3.7L18 20l-.7-2.3L15 17l2.3-.7L18 14Z" />
  ),
  stop: <rect x="7" y="7" width="10" height="10" rx="1.5" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="3.5" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </>
  ),
  terminal: <path d="m4 7 5 5-5 5m8 0h8" />,
  trend: <path d="m4 16 5-5 4 4 7-8m-5 0h5v5" />,
  users: (
    <>
      <circle cx="9" cy="8" r="3" />
      <path d="M3 19a6 6 0 0 1 12 0M16 5.5a3 3 0 0 1 0 5.5M17 14a5 5 0 0 1 4 5" />
    </>
  ),
};

function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {iconPaths[name]}
    </svg>
  );
}

function StatusChip({ status }: { status: BotState }) {
  const labels = { stopped: "PARADO", running: "RODANDO", stopping: "PARANDO" };
  return (
    <span className={`status-chip status-${status}`}>
      <span className="status-dot" />
      {labels[status]}
    </span>
  );
}

function MetricCard({
  icon,
  label,
  value,
  detail,
}: {
  icon: IconName;
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <article className="metric-card">
      <div className="metric-top">
        <span>{label}</span>
        <span className="metric-icon">
          <Icon name={icon} size={17} />
        </span>
      </div>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  );
}

function FunnelBar({ label, value, percent }: { label: string; value: number; percent: number }) {
  return (
    <div className="funnel-row">
      <div className="funnel-label">
        <span>{label}</span>
        <span>
          {value} <small>{percent}%</small>
        </span>
      </div>
      <div className="funnel-track">
        <span style={{ width: `${Math.max(percent, 1.5)}%` }} />
      </div>
    </div>
  );
}

const logs = [
  { time: "14:32:01", tone: "info", text: "Iniciando busca de novas oportunidades..." },
  { time: "14:32:03", tone: "muted", text: "Filtro ativo: Front-end • Remoto • Brasil" },
  {
    time: "14:32:08",
    tone: "success",
    text: "✓ Candidatura enviada para Acme Studio — Product Designer",
  },
  { time: "14:32:12", tone: "info", text: "Analisando vaga #84721 • compatibilidade 89%" },
  {
    time: "14:32:17",
    tone: "success",
    text: "✓ Candidatura enviada para Nuvem Labs — UX Designer",
  },
  { time: "14:32:20", tone: "error", text: "Aviso: campo opcional não encontrado, continuando..." },
  { time: "14:32:24", tone: "success", text: "✓ 37 candidaturas enviadas nesta run" },
];

const runningMessages = [
  "Analisando vagas e enviando candidaturas compatíveis com seu perfil.",
  "Garimpando oportunidades enquanto você cuida do que importa.",
  "Seu currículo está passeando por lugares promissores.",
  "Conferindo cada detalhe antes de apertar o botão enviar.",
  "Mais uma candidatura a caminho da vaga certa.",
  "Trabalho repetitivo por aqui. Novas possibilidades por aí.",
];

function TerminalPanel({ expanded, onToggle }: { expanded: boolean; onToggle: () => void }) {
  const [paused, setPaused] = useState(false);
  return (
    <section
      className={`terminal-panel ${expanded ? "terminal-expanded" : ""}`}
      aria-label="Terminal"
    >
      <div className="terminal-header">
        <button
          className="terminal-title"
          onClick={onToggle}
          aria-label={expanded ? "Recolher terminal" : "Expandir terminal"}
        >
          <span className="terminal-icon">
            <Icon name="terminal" size={18} />
          </span>
          <strong>Terminal</strong>
        </button>
        <span className="terminal-ticker">
          <i className="log-success">●</i> 14:32:24&nbsp; 37 candidaturas enviadas nesta run
        </span>
        <div className="terminal-actions">
          <button
            className={paused ? "active" : ""}
            onClick={() => setPaused((value) => !value)}
            aria-label={paused ? "Retomar scroll" : "Pausar scroll"}
            title={paused ? "Retomar scroll" : "Pausar scroll"}
          >
            <Icon name={paused ? "play" : "pause"} size={17} />
          </button>
          <button
            onClick={onToggle}
            aria-label={expanded ? "Recolher terminal" : "Expandir terminal"}
          >
            <span className={expanded ? "chevron-up" : ""}>
              <Icon name="chevron" size={18} />
            </span>
          </button>
        </div>
      </div>
      <div className="terminal-body">
        {logs.map((log, index) => (
          <div className={`log-line log-${log.tone}`} key={`${log.time}-${index}`}>
            <span>{log.time}</span>
            <span>{log.text}</span>
          </div>
        ))}
        <div className="terminal-cursor">_</div>
      </div>
    </section>
  );
}

function RobotVisual({ running }: { running: boolean }) {
  return (
    <div
      className={`lottie-slot ${running ? "is-running" : ""}`}
      aria-label="Animação do robô Office Boy"
    >
      <span className="orbit orbit-one" />
      <span className="orbit orbit-two" />
      <span className="float-dot dot-one" />
      <span className="float-dot dot-two" />
      <span className="float-dot dot-three" />
      <div className="robot-orb">
        <div className="robot-envelope">
          <Icon name="envelope" size={55} />
          <span className="bot-badge">
            <Icon name="robot" size={24} />
          </span>
        </div>
      </div>
      <span className="lottie-label">lottie-placeholder</span>
    </div>
  );
}

export default function App() {
  const [status, setStatus] = useState<BotState>("stopped");
  const [darkMode, setDarkMode] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [dryRun, setDryRun] = useState(false);
  const [terminalExpanded, setTerminalExpanded] = useState(false);
  const [detailsVisible, setDetailsVisible] = useState(false);
  const [limit, setLimit] = useState("");
  const [messageIndex, setMessageIndex] = useState(0);

  const running = status === "running";
  const count = running ? 37 : 0;
  const progress = (count / 500) * 100;
  const frameName = useMemo(() => {
    if (darkMode && !running) return "Frame 4 · Parado / tema escuro";
    if (advanced) return "Frame 5 · Opções avançadas";
    if (running && terminalExpanded) return "Frame 3 · Rodando / terminal expandido";
    if (running) return "Frame 2 · Rodando";
    return "Frame 1 · Parado";
  }, [advanced, darkMode, running, terminalExpanded]);

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

  function toggleBot() {
    if (running) {
      setStatus("stopping");
      window.setTimeout(() => {
        setStatus("stopped");
        setTerminalExpanded(false);
      }, 350);
    } else {
      setStatus("running");
    }
  }

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
          <span className="frame-label">{frameName}</span>
          <StatusChip status={status} />
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
              {running ? "Seu Office Boy está trabalhando" : "Pronto para buscar oportunidades?"}
            </h1>
            <p
              className={running ? "running-message" : undefined}
              key={running ? messageIndex : "stopped"}
            >
              {running
                ? runningMessages[messageIndex]
                : "Inicie uma nova run e deixe o trabalho repetitivo com a gente."}
            </p>
          </div>

          <RobotVisual running={running} />

          <div className={`live-counter ${!running ? "counter-idle" : ""}`}>
            <strong>{count}</strong>
            <span>candidaturas enviadas nesta run</span>
          </div>

          <div className="progress-wrap">
            <div className="progress-copy">
              <span>Progresso da run</span>
              <span>
                <b>{count}</b> de 500 interações
              </span>
            </div>
            <div className="progress-track">
              <span style={{ width: `${progress}%` }} />
            </div>
          </div>

          <button
            className={`primary-button ${running || status === "stopping" ? "button-stop" : ""}`}
            onClick={toggleBot}
            disabled={status === "stopping"}
          >
            <Icon name={running ? "stop" : "play"} size={21} />
            {status === "stopping" ? "Parando..." : running ? "Parar" : "Iniciar bot"}
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
                placeholder="500"
              />
              <small>Vazio usa o padrão do .env</small>
            </div>
          </div>
        </section>

        <section className="metrics-grid" aria-label="Métricas">
          <MetricCard
            icon="clock"
            label="Hoje"
            value={running ? "37" : "0"}
            detail="Score médio: —"
          />
          <MetricCard
            icon="briefcase"
            label="Total"
            value={running ? "248" : "211"}
            detail="+18% esta semana"
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
                <button className="text-link">
                  Ver detalhes <Icon name="arrow" size={16} />
                </button>
              </div>
              {running ? (
                <div className="funnel-grid">
                  <FunnelBar label="Enviadas" value={248} percent={100} />
                  <FunnelBar label="Respondidas" value={31} percent={12.4} />
                  <FunnelBar label="Entrevistas" value={8} percent={3.2} />
                  <FunnelBar label="Ofertas" value={2} percent={0.8} />
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
              {running ? (
                <div className="application-list">
                  {[
                    ["Acme Studio", "Product Designer", "Agora", "92", "Enviada"],
                    ["Nuvem Labs", "UX Designer", "2 min", "89", "Enviada"],
                    ["Verde Tecnologia", "Senior UI Designer", "5 min", "84", "Analisando"],
                  ].map(([company, role, time, score, state], index) => (
                    <div className="application-row" key={company}>
                      <span className={`company-avatar avatar-${index}`}>{company.charAt(0)}</span>
                      <span className="application-company">
                        <strong>{company}</strong>
                        <small>{role}</small>
                      </span>
                      <span className="application-time">{time}</span>
                      <span className="score">
                        <small>Score</small>
                        {score}
                      </span>
                      <span
                        className={`application-status ${state === "Analisando" ? "status-review" : ""}`}
                      >
                        {state}
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
        expanded={terminalExpanded}
        onToggle={() => setTerminalExpanded((value) => !value)}
      />
    </div>
  );
}
