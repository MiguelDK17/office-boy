// Primitivas de formulário das telas de Perfil e Configurações — portadas do
// design do Figma Make, adaptadas para dados CONTROLADOS (o protótipo usava
// defaultValue + estado interno; aqui os valores vêm dos configs reais).

import { useState } from "react";

export type GlyphName = "check" | "eye" | "file" | "lock" | "upload";

const glyphPaths: Record<GlyphName, React.ReactNode> = {
  check: <path d="m5 12 4 4L19 6" />,
  eye: (
    <>
      <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
      <circle cx="12" cy="12" r="2.5" />
    </>
  ),
  file: (
    <>
      <path d="M6 2.5h8l4 4V21H6V2.5Z" />
      <path d="M14 2.5v4h4M9 12h6M9 16h6" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="10" width="14" height="11" rx="3" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </>
  ),
  upload: (
    <>
      <path d="M12 16V4m-4 4 4-4 4 4" />
      <path d="M4 15v5h16v-5" />
    </>
  ),
};

export function Glyph({ name, size = 18 }: { name: GlyphName; size?: number }) {
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
      {glyphPaths[name]}
    </svg>
  );
}

export function ScreenHeader({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <div className="screen-heading">
      <span>{eyebrow}</span>
      <h1>{title}</h1>
      <p>{description}</p>
    </div>
  );
}

export function FormCard({
  title,
  description,
  children,
  className = "",
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`form-card ${className}`}>
      <div className="form-card-heading">
        <h2>{title}</h2>
        {description && <p>{description}</p>}
      </div>
      {children}
    </section>
  );
}

/** Campo de texto controlado. Números ficam string no input (o salvar converte). */
export function Field({
  label,
  value,
  type = "text",
  placeholder,
  hint,
  badge,
  disabled,
  onChange,
}: {
  label: string;
  value: string | number;
  type?: string;
  placeholder?: string;
  hint?: string;
  badge?: string;
  disabled?: boolean;
  onChange: (valor: string) => void;
}) {
  return (
    <label className="form-field">
      <span className="field-label">
        {label}
        {badge && <small className="read-only-badge">{badge}</small>}
      </span>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
      {hint && <small className="field-hint">{hint}</small>}
    </label>
  );
}

export function SelectField({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (valor: string) => void;
}) {
  return (
    <label className="form-field">
      <span className="field-label">{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option value={option} key={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}

export function TextAreaField({
  label,
  value,
  rows = 4,
  max = 600,
  onChange,
}: {
  label: string;
  value: string;
  rows?: number;
  max?: number;
  onChange: (valor: string) => void;
}) {
  return (
    <label className="form-field field-wide">
      <span className="field-label">{label}</span>
      <textarea
        value={value}
        rows={rows}
        onChange={(event) => onChange(event.target.value)}
      />
      <small className="field-counter">
        {value.length}/{max}
      </small>
    </label>
  );
}

export function Toggle({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      className={`setting-toggle ${checked ? "setting-toggle-on" : ""}`}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  );
}

/** Editor de chips (listas de strings). Enter adiciona; × remove. */
export function ChipField({
  label,
  values,
  onChange,
  placeholder = "+ Adicionar",
}: {
  label: string;
  values: string[];
  onChange: (valores: string[]) => void;
  placeholder?: string;
}) {
  const [rascunho, setRascunho] = useState("");
  return (
    <div className="form-field field-wide">
      <span className="field-label">{label}</span>
      <div className="chip-editor">
        {values.map((chip) => (
          <span className="edit-chip" key={chip}>
            {chip}
            <button
              type="button"
              aria-label={`Remover ${chip}`}
              onClick={() => onChange(values.filter((item) => item !== chip))}
            >
              ×
            </button>
          </span>
        ))}
        <input
          value={rascunho}
          placeholder={placeholder}
          onChange={(event) => setRascunho(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && rascunho.trim()) {
              event.preventDefault();
              onChange([...values, rascunho.trim()]);
              setRascunho("");
            }
          }}
        />
      </div>
    </div>
  );
}

/** Barra fixa de ações: estado "dirty" + Descartar/Salvar + toast de sucesso. */
export function ActionBar({
  dirty,
  saved,
  saveLabel,
  erro,
  onSave,
  onDiscard,
}: {
  dirty: boolean;
  saved: boolean;
  saveLabel: string;
  erro?: string | null;
  onSave: () => void;
  onDiscard: () => void;
}) {
  return (
    <>
      <div className="action-bar">
        <div className={`change-state ${dirty ? "has-changes" : ""}`}>
          <span />
          {erro ? erro : dirty ? "Alterações não salvas" : "Tudo atualizado"}
        </div>
        <div>
          <button className="discard-button" disabled={!dirty} onClick={onDiscard}>
            Descartar
          </button>
          <button className="save-button" disabled={!dirty} onClick={onSave}>
            {saveLabel}
          </button>
        </div>
      </div>
      {saved && (
        <div className="success-toast" role="status">
          <span>
            <Glyph name="check" size={15} />
          </span>
          Alterações salvas com sucesso
        </div>
      )}
    </>
  );
}

/** Campo de secret: nunca mostra o valor — só "definido" + botão Substituir.
 *  O rascunho morre aqui dentro: "" = sem substituição pendente (não suja o form). */
export function SecretField({
  label,
  definido,
  onChange,
}: {
  label: string;
  definido: boolean;
  onChange: (valor: string) => void;
}) {
  const [replacing, setReplacing] = useState(false);
  const [rascunho, setRascunho] = useState("");
  return (
    <div className="form-field secret-field">
      <span className="field-label">{label}</span>
      <div className="secret-control">
        {replacing ? (
          <input
            type="password"
            autoFocus
            value={rascunho}
            placeholder="Insira o novo valor"
            onChange={(event) => {
              setRascunho(event.target.value);
              onChange(event.target.value);
            }}
          />
        ) : (
          <div className="masked-value">
            {definido ? "••••••••••••••••" : "não definido"}
          </div>
        )}
        <button
          type="button"
          onClick={() => {
            if (replacing) {
              setRascunho("");
              onChange(""); // cancelou: descarta a substituição pendente
            }
            setReplacing((value) => !value);
          }}
        >
          {replacing ? "Cancelar" : "Substituir"}
        </button>
      </div>
    </div>
  );
}
