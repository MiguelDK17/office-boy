// Barra do funil de resultados.

export function FunnelBar({
  label,
  value,
  percent,
}: {
  label: string;
  value: number;
  percent: number;
}) {
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
