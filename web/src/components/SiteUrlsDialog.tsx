import { useEffect, useRef, useState } from "react";
import type { SiteConfig } from "../lib/types";
import { salvarUrlsSite } from "../lib/api";
import { Glyph } from "./form";

type SiteUrlsDialogProps = {
  /** Site aberto (derivado do id pela tela) ou null quando fechado. */
  site: SiteConfig | null;
  /** Persistiu com sucesso: atualiza contador/base na tela sem recarregar tudo. */
  onSaved: (siteId: string, urls: string[]) => void;
  onClose: () => void;
};

const MAX_URLS = 50;
const MAX_CARACTERES = 2048;
const CARACTERE_PROIBIDO = /[\s\u0000-\u001f\u007f]/;

/**
 * Chave canônica para detectar duplicatas — mesma regra do backend:
 * host/scheme minúsculos, porta padrão fora e barras finais do caminho
 * ignoradas. Query/hash continuam contando (buscas diferentes).
 */
function chaveComparacao(url: string): string | null {
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol !== "https:") return null;
    const caminho = parsed.pathname.replace(/\/+$/, "") || "/";
    return `${parsed.protocol}//${parsed.host}${caminho}${parsed.search}${parsed.hash}`;
  } catch {
    return null;
  }
}

/** Validação espelhada do backend. Devolve o motivo ou null se estiver ok. */
function validarUrl(valor: string, lista: string[], ignorar?: number): string | null {
  const url = valor.trim();
  if (!url) return "Informe uma URL";
  if (url.length > MAX_CARACTERES) {
    return `URL muito longa (máx. ${MAX_CARACTERES} caracteres)`;
  }
  if (CARACTERE_PROIBIDO.test(url)) {
    return "A URL não pode conter espaços nem caracteres de controle";
  }
  const chave = chaveComparacao(url);
  if (!chave) return "Use uma URL https:// válida";
  const duplicada = lista.findIndex(
    (outra, indice) => indice !== ignorar && chaveComparacao(outra) === chave,
  );
  if (duplicada >= 0) return `URL duplicada (igual à de posição ${duplicada + 1})`;
  return null;
}

type Toast = { texto: string; desfazer?: boolean };

export function SiteUrlsDialog({ site, onSaved, onClose }: SiteUrlsDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const undoRef = useRef<{ url: string; indice: number; timer: number } | null>(null);
  const closeTimerRef = useRef<number | null>(null);

  const [urls, setUrls] = useState<string[]>([]);
  const [original, setOriginal] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveErrors, setSaveErrors] = useState<{ indice: number; motivo: string }[]>([]);
  const [editing, setEditing] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);

  const siteId = site?.id ?? null;

  const cancelarUndo = () => {
    if (undoRef.current) {
      window.clearTimeout(undoRef.current.timer);
      undoRef.current = null;
    }
  };

  /** Cancela o fechamento automático pós-save (senão fecha um dialog recém-aberto). */
  const cancelarFechamento = () => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  };

  // Abre/reinicia o dialog quando muda o site. O cleanup devolve o foco ao
  // botão que abriu (o elemento é desmontado junto com o dialog).
  useEffect(() => {
    if (!site) return undefined;
    openerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setUrls([...site.urls_busca]);
    setOriginal([...site.urls_busca]);
    setDraft("");
    setError(null);
    setSaveError(null);
    setSaveErrors([]);
    setEditing(null);
    setEditDraft("");
    setEditError(null);
    setConfirmDiscard(false);
    setSaving(false);
    setToast(null);
    cancelarUndo();
    cancelarFechamento();

    const dialog = dialogRef.current;
    if (dialog && !dialog.open) {
      dialog.showModal();
      window.setTimeout(() => inputRef.current?.focus(), 0);
    }

    return () => {
      if (undoRef.current) window.clearTimeout(undoRef.current.timer);
      undoRef.current = null;
      cancelarFechamento();
      const opener = openerRef.current;
      if (dialog?.open) dialog.close();
      window.setTimeout(() => opener?.focus(), 0);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteId]);

  // Foco vai para a confirmação de descarte quando ela aparece.
  useEffect(() => {
    if (!confirmDiscard) return;
    confirmRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [confirmDiscard]);

  if (!site) return null;

  const dirty = JSON.stringify(urls) !== JSON.stringify(original);
  // Texto digitado e ainda não adicionado conta como alteração pendente.
  const rascunhoPendente = draft.trim().length > 0;
  const podeSalvar = dirty || rascunhoPendente;
  const chavesOriginais = new Set(
    original.map((url) => chaveComparacao(url)).filter((c): c is string => Boolean(c)),
  );
  const naoSalva = (url: string) => {
    const chave = chaveComparacao(url);
    return chave ? !chavesOriginais.has(chave) : true;
  };

  const fechar = () => {
    cancelarUndo();
    cancelarFechamento();
    setToast(null);
    if (dialogRef.current?.open) {
      dialogRef.current.close(); // dispara onClose do <dialog> → prop
    } else {
      onClose();
    }
  };

  const requestClose = () => {
    if (podeSalvar) {
      setConfirmDiscard(true);
      return;
    }
    fechar();
  };

  const adicionar = () => {
    cancelarUndo();
    setToast(null);
    if (urls.length >= MAX_URLS) {
      setError(`Máximo de ${MAX_URLS} URLs por site`);
      return;
    }
    const motivo = validarUrl(draft, urls);
    if (motivo) {
      setError(motivo);
      return;
    }
    setUrls([...urls, draft.trim()]);
    setDraft("");
    setError(null);
    inputRef.current?.focus();
  };

  const iniciarEdicao = (indice: number) => {
    setEditing(indice);
    setEditDraft(urls[indice]);
    setEditError(null);
    setError(null);
  };

  const confirmarEdicao = (indice: number) => {
    cancelarUndo();
    setToast(null);
    const motivo = validarUrl(editDraft, urls, indice);
    if (motivo) {
      setEditError(motivo);
      return;
    }
    setUrls(urls.map((url, i) => (i === indice ? editDraft.trim() : url)));
    setEditing(null);
    setEditDraft("");
    setEditError(null);
  };

  const remover = (indice: number) => {
    cancelarUndo();
    const url = urls[indice];
    setUrls(urls.filter((_, i) => i !== indice));
    if (editing === indice) {
      setEditing(null);
      setEditError(null);
    } else if (editing !== null && editing > indice) {
      setEditing(editing - 1);
    }
    const timer = window.setTimeout(() => {
      undoRef.current = null;
      setToast(null);
    }, 5000);
    undoRef.current = { url, indice, timer };
    setToast({ texto: "URL removida", desfazer: true });
  };

  const desfazerRemocao = () => {
    const pendente = undoRef.current;
    if (!pendente) return;
    if (urls.length >= MAX_URLS) {
      setToast({ texto: `Máximo de ${MAX_URLS} URLs por site` });
      return;
    }
    window.clearTimeout(pendente.timer);
    undoRef.current = null;
    setUrls((atual) => {
      const proximo = [...atual];
      proximo.splice(Math.min(pendente.indice, proximo.length), 0, pendente.url);
      return proximo;
    });
    setToast(null);
  };

  const salvar = async () => {
    if (saving) return;
    // O rascunho digitado mas ainda não "Adicionado" também é alteração:
    // valida e inclui no save para não perder o que o usuário acabou de colar.
    let urlsParaSalvar = urls;
    if (rascunhoPendente) {
      if (urls.length >= MAX_URLS) {
        setError(`Máximo de ${MAX_URLS} URLs por site`);
        return;
      }
      const motivo = validarUrl(draft, urls);
      if (motivo) {
        setError(motivo);
        inputRef.current?.focus();
        return;
      }
      urlsParaSalvar = [...urls, draft.trim()];
      setError(null);
    }
    cancelarUndo();
    setSaving(true);
    setSaveError(null);
    setSaveErrors([]);
    const resultado = await salvarUrlsSite(site.id, urlsParaSalvar);
    setSaving(false);
    if (resultado.erro) {
      setSaveError(resultado.erro);
      setSaveErrors(resultado.erros ?? []);
      return;
    }
    const salvos = resultado.urls ?? urlsParaSalvar;
    setUrls(salvos);
    setOriginal([...salvos]);
    setDraft("");
    onSaved(site.id, [...salvos]);
    setToast({
      texto: resultado.aplicadoNaProximaRun
        ? "URLs salvas · valem na próxima execução"
        : "URLs salvas",
    });
    cancelarFechamento();
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      if (dialogRef.current?.open) dialogRef.current.close();
    }, 900);
  };

  return (
    <dialog
      ref={dialogRef}
      className="site-urls-dialog"
      aria-labelledby="site-urls-title"
      aria-describedby="site-urls-desc"
      onClose={onClose}
      onCancel={(event) => {
        if (podeSalvar) {
          event.preventDefault();
          setConfirmDiscard(true);
        }
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <div className="site-urls-panel">
        <header className="site-urls-header">
          <div className="site-logo" aria-hidden="true">{site.nome.charAt(0)}</div>
          <div>
            <h1 id="site-urls-title">URLs de busca · {site.nome}</h1>
            <p id="site-urls-desc" aria-live="polite">
              {urls.length === 0
                ? "Nenhuma URL cadastrada"
                : `${urls.length} ${urls.length === 1 ? "URL" : "URLs"}`}
            </p>
          </div>
          <button
            type="button"
            className="icon-button dialog-close"
            aria-label="Fechar"
            onClick={requestClose}
          >
            <Glyph name="close" size={17} />
          </button>
        </header>

        <form
          className="site-url-add"
          onSubmit={(event) => {
            event.preventDefault();
            adicionar();
          }}
        >
          <label htmlFor="site-url-input">Adicionar URL de busca</label>
          <div className="site-url-add-row">
            <input
              ref={inputRef}
              id="site-url-input"
              name="url"
              type="text"
              inputMode="url"
              value={draft}
              placeholder="Cole uma URL https://..."
              autoComplete="off"
              spellCheck={false}
              aria-invalid={Boolean(error)}
              aria-describedby={error ? "site-url-error" : undefined}
              onChange={(event) => {
                setDraft(event.target.value);
                setError(null);
              }}
            />
            <button type="submit" className="primary-button site-url-add-button">
              <Glyph name="plus" size={15} /> Adicionar
            </button>
          </div>
          {error && (
            <small id="site-url-error" className="site-url-error" role="alert">
              {error}
            </small>
          )}
        </form>

        {saveError && (
          <div className="site-url-save-error" role="alert">
            <Glyph name="alert" size={15} />
            <div>
              <span>{saveError}</span>
              {saveErrors.length > 0 && (
                <ul className="site-url-error-list">
                  {saveErrors.map((erro) => (
                    <li key={`${erro.indice}-${erro.motivo}`}>
                      URL {erro.indice + 1}: {erro.motivo}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}

        <div className="site-url-list" aria-live="polite">
          {urls.length === 0 ? (
            <div className="site-url-empty">
              <div className="empty-link-art" aria-hidden="true">
                <Glyph name="external" size={24} />
              </div>
              <strong>Nenhuma URL ainda</strong>
              <p>Adicione a primeira para este site começar a buscar vagas.</p>
            </div>
          ) : (
            urls.map((url, indice) => {
              if (editing === indice) {
                return (
                  <div className="site-url-row site-url-row-editing" key={`${indice}-edicao`}>
                    <input
                      aria-label={`Editar URL ${indice + 1}`}
                      value={editDraft}
                      autoFocus
                      aria-invalid={Boolean(editError)}
                      aria-describedby={editError ? `site-url-edit-error-${indice}` : undefined}
                      onChange={(event) => {
                        setEditDraft(event.target.value);
                        setEditError(null);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          confirmarEdicao(indice);
                        }
                        if (event.key === "Escape") {
                          event.stopPropagation();
                          setEditing(null);
                          setEditError(null);
                        }
                      }}
                    />
                    <button
                      type="button"
                      className="url-action"
                      aria-label={`Confirmar edição da URL ${indice + 1}`}
                      onClick={() => confirmarEdicao(indice)}
                    >
                      <Glyph name="check" size={15} />
                    </button>
                    <button
                      type="button"
                      className="url-action"
                      aria-label={`Cancelar edição da URL ${indice + 1}`}
                      onClick={() => {
                        setEditing(null);
                        setEditError(null);
                      }}
                    >
                      <Glyph name="close" size={15} />
                    </button>
                    {editError && (
                      <p
                        id={`site-url-edit-error-${indice}`}
                        className="site-url-error site-url-edit-error"
                        role="alert"
                      >
                        {editError}
                      </p>
                    )}
                  </div>
                );
              }
              return (
                <div className="site-url-row" key={`${url}-${indice}`}>
                  <span
                    className={`unsaved-dot ${naoSalva(url) ? "is-unsaved" : ""}`}
                    title={naoSalva(url) ? "Não salva" : undefined}
                    aria-label={naoSalva(url) ? "URL não salva" : undefined}
                  />
                  <span className="site-url-value" title={url}>
                    {url}
                  </span>
                  <div className="site-url-actions">
                    <a
                      className="url-action"
                      href={url}
                      target="_blank"
                      rel="noreferrer"
                      aria-label={`Abrir URL ${indice + 1} em nova aba`}
                    >
                      <Glyph name="external" size={15} />
                    </a>
                    <button
                      type="button"
                      className="url-action"
                      aria-label={`Editar URL ${indice + 1}`}
                      onClick={() => iniciarEdicao(indice)}
                    >
                      <Glyph name="edit" size={15} />
                    </button>
                    <button
                      type="button"
                      className="url-action url-action-danger"
                      aria-label={`Excluir URL ${indice + 1}`}
                      onClick={() => remover(indice)}
                    >
                      <Glyph name="trash" size={15} />
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {toast && (
          <div className="site-url-toast" role="status" aria-live="polite">
            {toast.texto}
            {toast.desfazer && (
              <button type="button" onClick={desfazerRemocao}>
                · Desfazer
              </button>
            )}
          </div>
        )}

        <footer className="site-urls-footer">
          {confirmDiscard ? (
            <div className="discard-confirm" role="alert" ref={confirmRef}>
              <strong>Descartar alterações?</strong>
              <div>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => setConfirmDiscard(false)}
                >
                  Continuar editando
                </button>
                <button type="button" className="danger-button" onClick={fechar}>
                  Descartar
                </button>
              </div>
            </div>
          ) : (
            <>
              <button type="button" className="secondary-button" onClick={requestClose}>
                Cancelar
              </button>
              <button
                type="button"
                className="primary-button"
                disabled={!podeSalvar || saving}
                onClick={() => void salvar()}
              >
                {saving ? "Salvando…" : "Salvar"}
              </button>
            </>
          )}
        </footer>
      </div>
    </dialog>
  );
}
