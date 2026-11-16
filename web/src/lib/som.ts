// Som de atenção da UI — notificação de pausa.
//
// USA O MP3 DO PIXABAY: web/src/assets/notification.mp3, importado pelo Vite
// (vira asset com hash no build). Para trocar o som, substitua o arquivo —
// nada mais muda.
//
// Por que o guard de gesto: navegadores bloqueiam áudio até a primeira
// interação do usuário com a página (autoplay policy). Como o som dispara no
// evento de pausa (que chega via SSE, sem clique), pré-carregamos o áudio no
// primeiro clique (botão "Iniciar bot" / "Retomar" — gestos válidos). Se o
// usuário nunca clicou (ex.: recarregou a página com o run já pausado), o
// play() é recusado silenciosamente — melhor sem som do que quebrar a UI.

import notificacaoUrl from "../assets/notification.mp3";

let audio: HTMLAudioElement | null = null;

/** Pré-carrega o som num clique do usuário (contorna o autoplay policy). */
export function prepararAudio(): void {
  try {
    if (!audio) {
      audio = new Audio(notificacaoUrl);
      audio.preload = "auto";
      audio.volume = 0.9;
      audio.load();
    }
  } catch {
    // Ambiente sem áudio: a UI continua funcionando sem som.
  }
}

/** Toca a notificação (do início; chamadas em sequência reiniciam). */
export function tocarSomPausa(): void {
  if (!audio) return;
  try {
    audio.currentTime = 0;
    const p = audio.play();
    // Play recusado (autoplay policy, aba nunca interagida): silencioso.
    if (p) p.catch(() => undefined);
  } catch {
    // Silencioso — som é aprimoramento, nunca um ponto de falha da UI.
  }
}
