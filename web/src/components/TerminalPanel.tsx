// Terminal recolhível na base da tela — log ao vivo do run.
//
// Comportamentos (design original preservado):
// - cabeçalho com ticker da última linha, pausar scroll e chevron;
// - expandido: linhas com timestamp e cor por nível;
// - auto-scroll que pausa quando "pausar scroll" está ativo ou quando o
//   usuário rola para cima;
// - estado aberto/fechado lembrado no localStorage (pelo App, via prop).
//
// TROCA DE TEMA também é lembrada no localStorage — ver App.tsx.

import { useEffect, useRef, useState } from "react";
import type { LogLine } from "../lib/types";
import { Icon, type IconName } from "./Icon";

export function TerminalPanel({
  logs,
  expanded,
  onToggle,
}: {
  logs: LogLine[];
  expanded: boolean;
  onToggle: () => void;
}) {
  const [paused, setPaused] = useState(false);
  const [noFim, setNoFim] = useState(true); // usuário está no fim do log?
  const corpoRef = useRef<HTMLDivElement>(null);

  const ultimaLinha = logs[logs.length - 1];

  // Auto-scroll: só acompanha quando o usuário está no fim e o scroll
  // não está pausado. Rolar para cima cancela o acompanhamento.
  useEffect(() => {
    const corpo = corpoRef.current;
    if (!corpo) return;
    if (expanded && !paused && noFim) {
      corpo.scrollTop = corpo.scrollHeight;
    }
  }, [logs, expanded, paused, noFim]);

  function aoRolar() {
    const corpo = corpoRef.current;
    if (!corpo) return;
    const fim = corpo.scrollTop + corpo.clientHeight >= corpo.scrollHeight - 24;
    setNoFim(fim);
  }

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
          <i className={ultimaLinha ? `log-${ultimaLinha.tone}` : "log-muted"}>●</i>
          {ultimaLinha
            ? `\u00a0${ultimaLinha.time}\u00a0 ${ultimaLinha.text}`
            : "\u00a0sem saída ainda — inicie o bot"}
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
      <div className="terminal-body" ref={corpoRef} onScroll={aoRolar}>
        {logs.length === 0 && (
          <div className="log-line log-muted">
            <span>--:--:--</span>
            <span>Aguardando o primeiro run — o log do bot aparece aqui.</span>
          </div>
        )}
        {logs.map((log) => (
          <div className={`log-line log-${log.tone}`} key={log.id}>
            <span>{log.time}</span>
            <span>{log.text}</span>
          </div>
        ))}
        <div className="terminal-cursor">_</div>
      </div>
    </section>
  );
}

export type { IconName };
