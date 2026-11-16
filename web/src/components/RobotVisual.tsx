// Visual do robô no slot do hero — animação Lottie no lugar do placeholder,
// com as órbitas e pontos do design original como ambiente.
//
// TROCA DE LOTTIE: ver src/components/LottieRobot.tsx (idle.json / working.json).

import { LottieRobot } from "./LottieRobot";

export function RobotVisual({
  running,
  stopping,
  paused,
}: {
  running: boolean;
  stopping: boolean;
  paused: boolean;
}) {
  return (
    <div
      className={`lottie-slot ${running ? "is-running" : ""} ${stopping ? "is-stopping" : ""} ${paused ? "is-paused" : ""}`}
      aria-label={
        paused ? "Animação do robô Office Boy pausada" : "Animação do robô Office Boy"
      }
    >
      <span className="orbit orbit-one" />
      <span className="orbit orbit-two" />
      <span className="float-dot dot-one" />
      <span className="float-dot dot-two" />
      <span className="float-dot dot-three" />
      <LottieRobot running={running} stopping={stopping} paused={paused} />
      <span className="lottie-label">
        {paused ? "lottie-placeholder · pausado" : "lottie-placeholder"}
      </span>
    </div>
  );
}
