// Ícones inline (SVG stroke) — extraídos do layout original, sem alteração visual.

import type { JSX } from "react";

export type IconName =
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

const iconPaths: Record<IconName, JSX.Element> = {
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

export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
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
