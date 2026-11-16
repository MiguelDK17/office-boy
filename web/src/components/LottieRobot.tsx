// Animação Lottie do robô: idle.json quando Parado (e Pausado — o robô "descansa"),
// working.json quando Rodando; em Parando a velocidade cai para 40% (transição suave).
//
// TROCAR AS ANIMAÇÕES: substitua src/assets/idle.json e src/assets/working.json
// pelos JSONs finais exportados do Lottie (mesmos nomes, nada mais muda).
// Os arquivos atuais são animações de exemplo geradas para o projeto.

import { Lottie } from "lottie-react";
import idleData from "../assets/idle.json";
import workingData from "../assets/working.json";

export function LottieRobot({
  running,
  stopping,
  paused,
}: {
  running: boolean;
  stopping: boolean;
  paused: boolean;
}) {
  const animando = running && !paused;
  return (
    <Lottie
      className="lottie-anim"
      src={animando ? workingData : idleData}
      loop
      autoplay
      speed={stopping ? 0.4 : 1}
      aria-hidden="true"
    />
  );
}
