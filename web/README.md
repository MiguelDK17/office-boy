# Dashboard Web do Office Boy (React)

Front do dashboard — port do design do Figma Make, sem alterações visuais.
Em produção, o **backend** (`src/control-server.ts`) serve o build desta pasta
na porta 1717 (mesma porta da API). O dashboard antigo continua em `/legacy`.

## Como rodar

```bash
# Desenvolvimento (front + backend juntos, com hot reload):
npm run dev:all        # backend em 1717 + front em http://localhost:5173
                       # (o Vite faz proxy de /api e /events para a 1717)

# Produção (build + servido pelo Node):
npm run web:build      # gera web/dist
npm run ui             # control server servindo o build em http://localhost:1717
                       # (porta vem de BOT_UI_PORT; fallback 1717 — no Docker é
                       #  DASHBOARD_PORT=1717 dentro do container, mapeada como 1717:3000)
```

> Em desenvolvimento o front fica em **5173** (servidor do Vite, com hot reload)
> e o backend na **1717** — o proxy de `/api` e `/events` no `vite.config.ts`
> conecta os dois, então tudo acontece na mesma origem do ponto de vista do
> navegador. Para trocar a porta do backend, ajuste `OFFICEBOY_BACKEND_URL`.

## Trocar os Lotties

As animações de exemplo ficam em `web/src/assets/`:

- `idle.json` — exibido quando o bot está **Parado**;
- `working.json` — exibido quando o bot está **Rodando** (velocidade em 40%
  quando **Parando**).

Para usar as animações finais, basta substituir esses dois arquivos (mesmos
nomes) — nada mais muda. O componente que os carrega é
`web/src/components/LottieRobot.tsx`.

## Como funciona o /events

O hook `useBot` (`web/src/hooks/useBot.ts`) abre um `EventSource` em `/events`
(SSE) uma única vez e recebe:

- `snapshot` — estado completo ao conectar (status do run, últimas 200 linhas
  de log, contadores, padrão de iterações do .env);
- `log` — cada nova linha do bot em tempo real (com timestamp e nível, para as
  cores do terminal);
- `estado` — mudanças de estado (iniciou, parada solicitada, encerrou);
- `progresso` — iteração atual/total do loop do agente e candidaturas da run.

A reconexão é automática (nativa do EventSource); com o backend fora do ar a
UI mostra o chip "SEM CONEXÃO". Métricas e candidaturas vêm de `GET /api/data`,
recarregadas quando o estado do run muda. Para trocar para polling no futuro,
basta reimplementar este hook — a UI não o enxerga.

## Estados lembrados no navegador

Tema claro/escuro (`officeboy-tema`) e terminal aberto/fechado
(`officeboy-terminal`) persistem no `localStorage`.
