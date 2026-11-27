// Primitivas de formulário das telas de Perfil e Configurações — portadas do
// design do Figma Make, adaptadas para dados CONTROLADOS (o protótipo usava
// defaultValue + estado interno; aqui os valores vêm dos configs reais).

import { useEffect, useRef, useState } from "react";
import { carregarModelos, type ModeloCatalogo } from "../lib/api";

export type GlyphName =
  | "check"
  | "eye"
  | "file"
  | "lock"
  | "upload"
  | "list-edit"
  | "external"
  | "edit"
  | "trash"
  | "plus"
  | "close"
  | "alert";

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
  "list-edit": (
    <>
      <path d="M5 6h8M5 12h6M5 18h6" />
      <path d="m15 15 4-4 2 2-4 4-3 1 1-3Z" />
    </>
  ),
  external: (
    <>
      <path d="M14 5h5v5M19 5l-8 8" />
      <path d="M19 14v4.5A1.5 1.5 0 0 1 17.5 20h-12A1.5 1.5 0 0 1 4 18.5v-12A1.5 1.5 0 0 1 5.5 5H10" />
    </>
  ),
  edit: (
    <>
      <path d="m4 16-.8 4.8L8 20l10.8-10.8a2.1 2.1 0 0 0-3-3L4 16Z" />
      <path d="m14.5 7.5 2 2" />
    </>
  ),
  trash: (
    <>
      <path d="M4 7h16M10 11v5M14 11v5M6 7l1 13h10l1-13M9 7V4h6v3" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  alert: (
    <>
      <path d="M12 4 21 20H3L12 4Z" />
      <path d="M12 9v5M12 17h.01" />
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

/**
 * Rótulo amigável do campo.
 * `technicalName` continua aceito para documentar a chave do .env nos usos
 * internos, mas identificadores técnicos não são exibidos na interface.
 */
export function RotuloCampo({
  label,
  technicalName: _technicalName,
}: {
  label: string;
  technicalName?: string;
}) {
  return <span>{label}</span>;
}

/**
 * Campo de texto controlado. Números ficam string no input (o salvar converte).
 * `unit` renderiza o sufixo fixo (US$, ms); validação de número negativo é
 * embutida (design: "Use um valor igual ou maior que zero.").
 */
export function Field({
  label,
  technicalName,
  value,
  type = "text",
  placeholder,
  unit,
  hint,
  badge,
  disabled,
  onChange,
  onBlur,
}: {
  label: string;
  technicalName?: string;
  value: string | number;
  type?: string;
  placeholder?: string;
  unit?: string;
  hint?: string;
  badge?: string;
  disabled?: boolean;
  onChange: (valor: string) => void;
  onBlur?: () => void;
}) {
  const invalido = type === "number" && String(value) !== "" && Number(value) < 0;
  return (
    <label className={`form-field ${invalido ? "field-error" : ""}`}>
      <span className="field-label">
        <RotuloCampo label={label} technicalName={technicalName} />
        {badge && <small className="read-only-badge">{badge}</small>}
      </span>
      <div className={unit ? "input-with-unit" : undefined}>
        <input
          type={type}
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          onBlur={onBlur}
        />
        {unit && <span>{unit}</span>}
      </div>
      <small className="field-hint">
        {invalido ? "Use um valor igual ou maior que zero." : hint}
      </small>
    </label>
  );
}

/** Dropdown customizado do design (não usa <select> nativo). */
export function SelectField({
  label,
  technicalName,
  value,
  options,
  onChange,
}: {
  label: string;
  technicalName?: string;
  value: string;
  options: string[];
  onChange: (valor: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const raiz = useRef<HTMLDivElement>(null);
  // fecha por clique-fora (onBlur no trigger fecharia antes do click da opção:
  // o mousedown da opção rouba o foco e desmonta o menu)
  useEffect(() => {
    if (!open) return;
    const fora = (e: PointerEvent) => {
      if (raiz.current && !raiz.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", fora);
    return () => document.removeEventListener("pointerdown", fora);
  }, [open]);
  return (
    <div ref={raiz} className={`form-field custom-select ${open ? "custom-select-open" : ""}`}>
      <span className="field-label">
        <RotuloCampo label={label} technicalName={technicalName} />
      </span>
      <button
        type="button"
        className="custom-select-trigger"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        onKeyDown={(event) => {
          if (event.key === "Escape") setOpen(false);
        }}
      >
        {value}
        <span>⌄</span>
      </button>
      {open && (
        <div className="custom-select-menu">
          {options.map((option) => (
            <button
              type="button"
              className={value === option ? "custom-option-selected" : ""}
              // não roubar o foco do trigger: o click precisa chegar aqui
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onChange(option);
                setOpen(false);
              }}
              key={option}
            >
              <span>{value === option ? "✓" : ""}</span>
              {option}
            </button>
          ))}
        </div>
      )}
    </div>
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
  ariaLabel,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  /** Nome acessível — obrigatório quando não há label visível associado. */
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
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
        {/* key e remoção por ÍNDICE: chips duplicados são legítimos
            (ex.: duas empresas bloqueadas com o mesmo nome) e um filtro
            por valor removeria todas as ocorrências de uma vez. */}
        {values.map((chip, index) => (
          <span className="edit-chip" key={`${index}-${chip}`}>
            {chip}
            <button
              type="button"
              aria-label={`Remover ${chip}`}
              onClick={() => onChange(values.filter((_, i) => i !== index))}
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

/** Campo de secret: nunca mostra o valor — badge "Configurada" + Substituir.
 *  O rascunho morre aqui dentro: "" = sem substituição pendente (não suja o form). */
export function SecretField({
  label,
  technicalName,
  definido,
  onChange,
  onBlur,
}: {
  label: string;
  technicalName?: string;
  definido: boolean;
  onChange: (valor: string) => void;
  onBlur?: () => void;
}) {
  const [replacing, setReplacing] = useState(false);
  const [rascunho, setRascunho] = useState("");
  return (
    <div className="form-field secret-field">
      <span className="field-label">
        <RotuloCampo label={label} technicalName={technicalName} />
        <small className={`configured-badge ${definido ? "" : "nao-configurada"}`}>
          {definido ? "Configurada" : "Não configurada"}
        </small>
      </span>
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
            onBlur={onBlur}
          />
        ) : (
          <div className="masked-value">
            {definido ? "••••••••••••••••" : "—"}
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

// ========== MODEL COMBOBOX (catálogo OpenRouter) ==========

type StatusModelos = "pronto" | "carregando" | "erro";

/**
 * Seletor de modelo do design: quando o endereço da API é OpenRouter, mostra
 * o catálogo real (busca + filtro "somente grátis" + estados loading/erro/
 * vazio) com "Digitar manualmente" e "Atualizar catálogo". Para endpoints
 * não-OpenRouter (OpenAI nativa, Ollama) cai num Field manual — catálogo
 * padrão não existe lá.
 */
export function ModelCombobox({
  label = "Modelo",
  technicalName,
  apiAddress,
  value,
  onChange,
}: {
  label?: string;
  technicalName: string;
  apiAddress: string;
  value: string;
  onChange: (valor: string) => void;
}) {
  const isOpenRouter = (apiAddress || "https://openrouter.ai/api/v1").toLowerCase().includes("openrouter");
  const [open, setOpen] = useState(false);
  const [manual, setManual] = useState(false);
  const [status, setStatus] = useState<StatusModelos>("pronto");
  const [freeOnly, setFreeOnly] = useState(false);
  const [query, setQuery] = useState("");
  const [catalogo, setCatalogo] = useState<ModeloCatalogo[] | null>(null);
  const [erroCatalogo, setErroCatalogo] = useState<string | null>(null);
  const raiz = useRef<HTMLDivElement>(null);

  // fecha por clique-fora (o trigger não usa onBlur: fecharia antes do click
  // da opção, igual ao SelectField)
  useEffect(() => {
    if (!open) return;
    const fora = (e: PointerEvent) => {
      if (raiz.current && !raiz.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", fora);
    return () => document.removeEventListener("pointerdown", fora);
  }, [open]);

  // trocou o endereço da API → catálogo antigo é de outro provedor; recarrega
  useEffect(() => {
    setCatalogo(null);
    setStatus("pronto");
    setErroCatalogo(null);
    setOpen(false);
  }, [apiAddress]);

  // manual: campo livre (id do modelo) — também é o caminho p/ não-OpenRouter
  if (!isOpenRouter || manual) {
    return (
      <div className="manual-model-field">
        <Field
          label={label}
          technicalName={technicalName}
          value={value}
          hint="Informe o id do modelo do seu provedor."
          onChange={onChange}
        />
        {manual && isOpenRouter && (
          <button type="button" className="return-combobox" onClick={() => setManual(false)}>
            Voltar para a lista de modelos
          </button>
        )}
      </div>
    );
  }

  const filtrados = (catalogo ?? []).filter(
    (m) =>
      (!freeOnly || m.free) &&
      (m.name.toLowerCase().includes(query.toLowerCase()) ||
        m.id.toLowerCase().includes(query.toLowerCase())),
  );

  const abrirFechar = async () => {
    const proximo = !open;
    setOpen(proximo);
    if (proximo && catalogo === null && status !== "carregando") {
      setStatus("carregando");
      setErroCatalogo(null);
      try {
        setCatalogo(await carregarModelos(apiAddress));
        setStatus("pronto");
      } catch (e) {
        setErroCatalogo(e instanceof Error ? e.message : "Falha no catálogo");
        setStatus("erro");
      }
    }
  };

  const recarregar = async () => {
    setStatus("carregando");
    setErroCatalogo(null);
    try {
      setCatalogo(await carregarModelos(apiAddress));
      setStatus("pronto");
    } catch (e) {
      setErroCatalogo(e instanceof Error ? e.message : "Falha no catálogo");
      setStatus("erro");
    }
  };

  return (
    <div ref={raiz} className={`model-combobox field-wide ${open ? "combobox-open" : ""}`}>
      <span className="field-label">
        <RotuloCampo label={label} technicalName={technicalName} />
      </span>
      <button type="button" className="model-trigger" onClick={() => void abrirFechar()} aria-expanded={open}>
        <span>
          <strong>{value || "Escolha um modelo"}</strong>
        </span>
        <span className="model-chevron">⌄</span>
      </button>
      {open && (
        <div className="model-dropdown">
          <div className="model-search">
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Buscar por nome ou id…"
            />
          </div>
          <div className="model-filter">
            <span>Somente grátis</span>
            <Toggle checked={freeOnly} onChange={setFreeOnly} />
          </div>
          {status === "carregando" ? (
            <div className="model-state">
              <span className="model-spinner" />
              <strong>Buscando modelos…</strong>
              <small>Consultando o catálogo do provedor</small>
            </div>
          ) : status === "erro" ? (
            <div className="model-state model-error">
              <strong>Não foi possível carregar os modelos</strong>
              <small>{erroCatalogo ?? "Verifique o endereço da API e tente novamente."}</small>
              <div>
                <button type="button" onClick={() => void recarregar()}>
                  Tentar de novo
                </button>
                <button type="button" className="manual-link" onClick={() => setManual(true)}>
                  Digitar manualmente
                </button>
              </div>
            </div>
          ) : filtrados.length === 0 ? (
            <div className="model-state">
              <strong>Nenhum modelo encontrado</strong>
              <small>Tente buscar por outro nome ou id.</small>
            </div>
          ) : (
            <div className="model-list">
              {filtrados.map((modelo) => (
                <button
                  type="button"
                  className={value === modelo.id ? "model-selected" : ""}
                  onClick={() => {
                    onChange(modelo.id);
                    setOpen(false);
                  }}
                  key={modelo.id}
                >
                  <span className="model-check">{value === modelo.id ? "✓" : ""}</span>
                  <span className="model-option-copy">
                    <strong>{modelo.name}</strong>
                  </span>
                  <span className="model-tags">
                    {modelo.free && <small>Grátis</small>}
                    <small>{modelo.context}</small>
                  </span>
                </button>
              ))}
            </div>
          )}
          <button type="button" className="refresh-models" onClick={() => void recarregar()}>
            Atualizar catálogo
          </button>
        </div>
      )}
    </div>
  );
}
