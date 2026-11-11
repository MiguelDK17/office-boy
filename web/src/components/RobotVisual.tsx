// Visual do robô (animação CSS do design original).
// ETAPA 4: o placeholder interno será substituído pelas animações Lottie
// (src/assets/idle.json e working.json) — o orbit, os dots e o orb permanecem.

import { Icon } from "./Icon";

export function RobotVisual({ running }: { running: boolean }) {
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
