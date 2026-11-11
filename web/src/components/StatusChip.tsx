// Chip de estado no cabeçalho — PARADO / RODANDO / PARANDO / SEM CONEXÃO.

import type { BotState } from "../lib/types";

const labels: Record<BotState, string> = {
  stopped: "PARADO",
  running: "RODANDO",
  stopping: "PARANDO",
  offline: "SEM CONEXÃO",
};

export function StatusChip({
  status,
  desconectado,
}: {
  status: BotState;
  desconectado: boolean;
}) {
  return (
    <span
      className={`status-chip status-${desconectado ? "offline" : status}`}
      title={desconectado ? "O backend do bot não está acessível" : undefined}
    >
      <span className="status-dot" />
      {desconectado ? labels.offline : labels[status]}
    </span>
  );
}
