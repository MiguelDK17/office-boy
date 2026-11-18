// Tela de PERFIL — portada do Figma Make, com dados REAIS de config/perfil.json
// e config/respostas.json (GET /api/config → PUT /api/config/{perfil,respostas}).
//
// Diferenças conscientes do protótipo:
//   • Currículos: não existe "Definir como ativo" — o bot escolhe sozinho
//     pelo campo usar_quando (ver src/curriculo-tailored.ts). A lista aqui é
//     editável (foco/arquivo/usar_quando) e salva em curriculos.json.
//   • Nível de inglês usa os valores do backend (nenhum/basico/.../fluente).

import { useEffect, useRef, useState } from "react";
import type { UseConfig } from "../hooks/useConfig";
import { enviarCurriculo, urlCurriculo } from "../lib/api";
import {
  ActionBar,
  ChipField,
  Field,
  FormCard,
  Glyph,
  ScreenHeader,
  SelectField,
  TextAreaField,
} from "../components/form";

const NIVEIS_INGLES = ["nenhum", "basico", "intermediario", "avancado", "fluente"];
const ROTULOS_INGLES: Record<string, string> = {
  nenhum: "Nenhum",
  basico: "Básico",
  intermediario: "Intermediário",
  avancado: "Avançado",
  fluente: "Fluente",
};
const MODELOS_TRABALHO = ["remoto", "hibrido", "presencial"];
const ROTULOS_MODELO: Record<string, string> = {
  remoto: "Remoto",
  hibrido: "Híbrido",
  presencial: "Presencial",
};

function str(p: Record<string, unknown>, chave: string): string {
  const v = p[chave];
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
}

function lista(p: Record<string, unknown>, chave: string): string[] {
  const v = p[chave];
  return Array.isArray(v) ? v.map(String) : [];
}

export function ProfileScreen({ cfg }: { cfg: UseConfig }) {
  const [dirty, setDirty] = useState(false);
  const [salvando, setSalvando] = useState(false);
  const [saved, setSaved] = useState(false);
  const [erroSalvar, setErroSalvar] = useState<string | null>(null);

  // Estado local do formulário: inicializado do config real.
  const [p, setP] = useState<Record<string, unknown>>(() => cfg.config?.perfil ?? {});
  const [resp, setResp] = useState<Record<string, unknown>>(() => cfg.config?.respostas ?? {});
  const [curriculos, setCurriculos] = useState<{
    fallback?: Record<string, string>;
    curriculos?: Array<Record<string, string>>;
  }>(() => cfg.config?.curriculos ?? {});

  // Recarregou config do backend (ou terminou de carregar) → rehidrata o form.
  useEffect(() => {
    if (cfg.config) {
      setP(cfg.config.perfil);
      setResp(cfg.config.respostas);
      setCurriculos(cfg.config.curriculos);
      setDirty(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg.config]);

  const set = (chave: string, valor: unknown) => {
    setP((atual) => ({ ...atual, [chave]: valor }));
    marcarDirty();
  };
  const setR = (chave: string, valor: string) => {
    setResp((atual) => ({ ...atual, [chave]: valor }));
    marcarDirty();
  };
  const marcarDirty = () => {
    setDirty(true);
    setSaved(false);
    setErroSalvar(null);
  };

  // ========== UPLOAD DE CURRÍCULO ==========
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [idTrocar, setIdTrocar] = useState<string | null>(null); // null = currículo novo
  const [enviando, setEnviando] = useState(false);
  const [erroUpload, setErroUpload] = useState<string | null>(null);

  /** id seguro: nome do arquivo em slug (mesma regra do backend). */
  const slugCurriculo = (nome: string) =>
    nome
      .replace(/\.[^.]+$/, "")
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "curriculo";

  const abrirUpload = (id: string | null) => {
    setIdTrocar(id);
    fileInputRef.current?.click();
  };

  const processarArquivo = async (file: File) => {
    if (!file) return;
    try {
      if (file.size > 10 * 1024 * 1024) {
        setErroUpload("Arquivo maior que 10 MB.");
        return;
      }
      if (!/\.(pdf|docx?|txt)$/i.test(file.name)) {
        setErroUpload("Formato não suportado — use PDF, DOC ou DOCX.");
        return;
      }
      setEnviando(true);
      setErroUpload(null);
      const base64 = await new Promise<string>((resolve, reject) => {
        const leitor = new FileReader();
        leitor.onload = () => resolve(String(leitor.result).split(",")[1] ?? "");
        leitor.onerror = () => reject(new Error("Falha ao ler o arquivo"));
        leitor.readAsDataURL(file);
      });
      // "Trocar" reusa o id da linha (substitui o arquivo); novo currículo
      // deriva o id do nome — o backend registra em curriculos.json.
      let id = idTrocar ?? slugCurriculo(file.name);
      // slug derivado pode colidir com um currículo existente (ex.: dois
      // arquivos com nomes parecidos) — sobrescreveria a entrada sem avisar
      if (!idTrocar && listaCurriculos.some((c) => String(c.id) === id)) {
        const substituir = window.confirm(
          `Já existe um currículo com o id "${id}". Substituir o arquivo dele?`,
        );
        if (!substituir) return;
      }
      const resultado = await enviarCurriculo(id, file.name, base64);
      if (resultado.erro) {
        setErroUpload(resultado.erro);
      } else if (resultado.entrada) {
        // atualiza só a lista de currículos — NÃO recarregar o config inteiro,
        // pois descartaria edições não salvas do formulário
        const entrada = resultado.entrada;
        setCurriculos((atual) => {
          const lista = Array.isArray(atual.curriculos) ? atual.curriculos : [];
          const i = lista.findIndex((c) => String(c.id) === entrada.id);
          const novaLista =
            i >= 0 ? lista.map((c, j) => (j === i ? { ...c, ...entrada } : c)) : [...lista, entrada];
          return { ...atual, curriculos: novaLista };
        });
        setSaved(true);
        window.setTimeout(() => setSaved(false), 3000);
      }
    } catch (e) {
      setErroUpload(e instanceof Error ? e.message : "Falha ao ler o arquivo");
    } finally {
      setEnviando(false);
      setIdTrocar(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  async function salvar() {
    setSalvando(true);
    setErroSalvar(null);
    const perfilNovo = { ...p };
    if (typeof perfilNovo.anos_experiencia === "string") {
      perfilNovo.anos_experiencia = Number(perfilNovo.anos_experiencia) || 0;
    }
    const erroPerfil = await cfg.salvarPerfil(perfilNovo);
    const erroResp = await cfg.salvarRespostas(resp);
    const erroCur = await cfg.salvarCurriculos(curriculos);
    setSalvando(false);
    const erro = erroPerfil ?? erroResp ?? erroCur;
    if (erro) {
      setErroSalvar(erro);
      setDirty(true);
      return;
    }
    setDirty(false);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 3000);
    await cfg.recarregar();
  }

  const experiencias = (Array.isArray(p.experiencias) ? p.experiencias : []) as Array<
    Record<string, string>
  >;
  const listaCurriculos = (Array.isArray((curriculos as { curriculos?: unknown }).curriculos)
    ? (curriculos as { curriculos: Array<Record<string, string>> }).curriculos
    : []) as Array<Record<string, string>>;
  const fallback = ((curriculos as { fallback?: Record<string, string> }).fallback ?? {}) as Record<string, string>;

  return (
    <div className="screen-view profile-screen">
      {cfg.erro && !cfg.config && (
        <div className="restart-banner" role="alert">
          <span className="restart-mark">!</span>
          <div>
            <strong>Falha ao carregar o perfil</strong>
            <p>{cfg.erro} — o backend pode estar fora do ar.</p>
          </div>
          <button onClick={() => void cfg.recarregar()}>Tentar de novo</button>
        </div>
      )}
      {cfg.carregando && !cfg.config && (
        <div className="restart-banner" role="status">
          <span className="restart-mark">…</span>
          <div>
            <strong>Carregando perfil</strong>
            <p>Buscando perfil.json, respostas.json e currículos no backend.</p>
          </div>
        </div>
      )}

      <ScreenHeader
        eyebrow="PERFIL DO CANDIDATO"
        title="Seu perfil profissional"
        description="Essas informações ajudam o Office Boy a encontrar vagas e preencher candidaturas por você."
      />

      <div className="form-layout">
        <FormCard title="Dados pessoais" description="Informações usadas nos formulários de candidatura.">
          <div className="field-grid">
            <Field label="Nome completo" value={str(p, "nome")} onChange={(v) => set("nome", v)} />
            <Field label="E-mail" type="email" value={str(p, "email")} onChange={(v) => set("email", v)} />
            <Field label="Telefone" value={str(p, "telefone")} onChange={(v) => set("telefone", v)} />
            <Field label="Cidade e UF" value={str(p, "cidade")} onChange={(v) => set("cidade", v)} />
            <Field
              label="Título profissional"
              value={str(p, "titulo_profissional")}
              onChange={(v) => set("titulo_profissional", v)}
            />
            <Field
              label="Anos de experiência"
              type="number"
              // vazio permitido — o save converte "" para 0
              value={str(p, "anos_experiencia")}
              onChange={(v) => set("anos_experiencia", v)}
            />
            <SelectField
              label="Nível de inglês"
              value={str(p, "nivel_ingles") || "intermediario"}
              options={NIVEIS_INGLES}
              onChange={(v) => set("nivel_ingles", v)}
            />
            <Field
              label="Disponibilidade"
              value={str(p, "disponibilidade")}
              onChange={(v) => set("disponibilidade", v)}
            />
          </div>
        </FormCard>

        <FormCard title="O que estou buscando" description="Preferências usadas para filtrar e priorizar vagas.">
          <div className="field-grid">
            <Field
              label="Pretensão salarial"
              value={str(p, "pretensao_salarial")}
              onChange={(v) => set("pretensao_salarial", v)}
            />
            <div className="form-field">
              <span className="field-label">Modelo de trabalho</span>
              <div className="segmented-control">
                {MODELOS_TRABALHO.map((modelo) => {
                  const ativos = lista(p, "modelo_trabalho");
                  const selecionado = ativos.includes(modelo);
                  return (
                    <button
                      key={modelo}
                      type="button"
                      className={selecionado ? "selected" : ""}
                      onClick={() =>
                        set(
                          "modelo_trabalho",
                          selecionado ? ativos.filter((m) => m !== modelo) : [...ativos, modelo],
                        )
                      }
                    >
                      {ROTULOS_MODELO[modelo]}
                    </button>
                  );
                })}
              </div>
            </div>
            <TextAreaField
              label="Regra de localização"
              value={str(p, "regra_localizacao")}
              rows={3}
              onChange={(v) => set("regra_localizacao", v)}
            />
            <ChipField
              label="Palavras-chave de busca"
              values={lista(p, "palavras_chave_busca")}
              onChange={(v) => set("palavras_chave_busca", v)}
            />
            <ChipField
              label="Empresas bloqueadas"
              values={lista(p, "blacklist_empresas")}
              onChange={(v) => set("blacklist_empresas", v)}
            />
            <ChipField
              label="Termos de título bloqueados"
              values={lista(p, "blacklist_termos_titulo")}
              onChange={(v) => set("blacklist_termos_titulo", v)}
            />
          </div>
        </FormCard>

        <FormCard title="Skills e palavras-chave" description="Tecnologias que definem o seu perfil.">
          <div className="field-grid">
            <ChipField
              label="Stack principal"
              values={lista(p, "stack_principal")}
              onChange={(v) => set("stack_principal", v)}
            />
            <ChipField
              label="Bancos de dados"
              values={lista(p, "bancos_de_dados")}
              onChange={(v) => set("bancos_de_dados", v)}
            />
            <ChipField
              label="Metodologias"
              values={lista(p, "metodologias")}
              onChange={(v) => set("metodologias", v)}
            />
          </div>
        </FormCard>

        <FormCard title="Links e resumo" description="Presença profissional e apresentação.">
          <div className="field-grid">
            <Field label="LinkedIn" value={str(p, "linkedin")} onChange={(v) => set("linkedin", v)} />
            <Field label="GitHub" value={str(p, "github")} onChange={(v) => set("github", v)} />
            <Field label="Portfólio" value={str(p, "portfolio")} onChange={(v) => set("portfolio", v)} />
            <Field
              label="Caminho do currículo padrão"
              value={str(p, "curriculo_path")}
              onChange={(v) => set("curriculo_path", v)}
            />
            <TextAreaField
              label="Resumo profissional"
              value={str(p, "resumo_profissional")}
              onChange={(v) => set("resumo_profissional", v)}
            />
          </div>
        </FormCard>

        <FormCard
          title="Experiência profissional"
          description="Histórico utilizado para responder formulários."
        >
          {experiencias.length === 0 && (
            <p className="field-hint field-wide" style={{ gridColumn: "1 / -1" }}>
              Nenhuma experiência registrada no perfil.json ainda.
            </p>
          )}
          {experiencias.map((exp, index) => (
            <div className="experience-block field-wide" key={index}>
              <div className="field-grid">
                <Field
                  label="Empresa"
                  value={exp.empresa ?? ""}
                  onChange={(v) =>
                    set("experiencias", experiencias.map((e, i) => (i === index ? { ...e, empresa: v } : e)))
                  }
                />
                <Field
                  label="Cargo"
                  value={exp.cargo ?? ""}
                  onChange={(v) =>
                    set("experiencias", experiencias.map((e, i) => (i === index ? { ...e, cargo: v } : e)))
                  }
                />
                <Field
                  label="Período"
                  value={exp.periodo ?? ""}
                  onChange={(v) =>
                    set("experiencias", experiencias.map((e, i) => (i === index ? { ...e, periodo: v } : e)))
                  }
                />
                <TextAreaField
                  label="Descrição"
                  value={exp.descricao ?? ""}
                  rows={3}
                  onChange={(v) =>
                    set("experiencias", experiencias.map((e, i) => (i === index ? { ...e, descricao: v } : e)))
                  }
                />
                <button
                  type="button"
                  className="discard-button"
                  onClick={() =>
                    set("experiencias", experiencias.filter((_, i) => i !== index))
                  }
                >
                  Remover experiência
                </button>
              </div>
            </div>
          ))}
          <button
            type="button"
            className="advanced-link"
            onClick={() =>
              set("experiencias", [
                ...experiencias,
                { empresa: "", cargo: "", periodo: "", descricao: "" },
              ])
            }
          >
            + Adicionar experiência
          </button>
        </FormCard>

        <FormCard title="Formação e informações extras">
          <div className="field-grid">
            <Field
              label="Formação"
              value={((p.informacoes_extras ?? {}) as Record<string, string>).formacao ?? ""}
              onChange={(v) =>
                set("informacoes_extras", {
                  ...((p.informacoes_extras ?? {}) as Record<string, string>),
                  formacao: v,
                })
              }
            />
            <Field
              label="Idiomas"
              value={((p.informacoes_extras ?? {}) as Record<string, string>).idiomas ?? ""}
              onChange={(v) =>
                set("informacoes_extras", {
                  ...((p.informacoes_extras ?? {}) as Record<string, string>),
                  idiomas: v,
                })
              }
            />
            <Field
              label="Certificações"
              value={((p.informacoes_extras ?? {}) as Record<string, string>).certificacoes ?? ""}
              onChange={(v) =>
                set("informacoes_extras", {
                  ...((p.informacoes_extras ?? {}) as Record<string, string>),
                  certificacoes: v,
                })
              }
            />
            <Field
              label="Diferencial"
              value={((p.informacoes_extras ?? {}) as Record<string, string>).diferencial ?? ""}
              onChange={(v) =>
                set("informacoes_extras", {
                  ...((p.informacoes_extras ?? {}) as Record<string, string>),
                  diferencial: v,
                })
              }
            />
          </div>
        </FormCard>

        <FormCard title="Respostas automáticas" description="Base para perguntas comuns em candidaturas (config/respostas.json).">
          <div className="field-grid">
            <Field
              label="Disponibilidade de início"
              value={str(resp, "disponibilidade_inicio")}
              onChange={(v) => setR("disponibilidade_inicio", v)}
            />
            <Field
              label="Pretensão salarial (resposta)"
              value={str(resp, "pretensao_salarial")}
              onChange={(v) => setR("pretensao_salarial", v)}
            />
            <Field
              label="Aceita viagem?"
              value={str(resp, "aceita_viagem")}
              onChange={(v) => setR("aceita_viagem", v)}
            />
            <Field
              label="Possui veículo?"
              value={str(resp, "possui_veiculo")}
              onChange={(v) => setR("possui_veiculo", v)}
            />
            <Field
              label="Estado civil"
              value={str(resp, "estado_civil")}
              onChange={(v) => setR("estado_civil", v)}
            />
            <Field
              label="Data de nascimento"
              type="date"
              value={str(resp, "data_nascimento")}
              onChange={(v) => setR("data_nascimento", v)}
            />
            <TextAreaField
              label="Como conheceu a empresa"
              value={str(resp, "como_conheceu_empresa")}
              rows={3}
              onChange={(v) => setR("como_conheceu_empresa", v)}
            />
            <TextAreaField
              label="Por que trabalhar aqui?"
              value={str(resp, "por_que_trabalhar_aqui")}
              rows={3}
              onChange={(v) => setR("por_que_trabalhar_aqui", v)}
            />
            <TextAreaField
              label="Pontos fortes"
              value={str(resp, "pontos_fortes")}
              rows={3}
              onChange={(v) => setR("pontos_fortes", v)}
            />
            <TextAreaField
              label="Pontos fracos"
              value={str(resp, "pontos_fracos")}
              rows={3}
              onChange={(v) => setR("pontos_fracos", v)}
            />
            <TextAreaField
              label="Expectativa de carreira"
              value={str(resp, "expectativa_carreira")}
              rows={3}
              onChange={(v) => setR("expectativa_carreira", v)}
            />
            <TextAreaField
              label="Trabalho em equipe"
              value={str(resp, "trabalho_em_equipe")}
              rows={3}
              onChange={(v) => setR("trabalho_em_equipe", v)}
            />
          </div>
        </FormCard>

        <FormCard
          title="Currículos"
          description="O bot escolhe automaticamente a melhor versão usando o critério usar_quando."
          className="full-card"
        >
          <div className="resume-list">
            {fallback.id && (
              <div className="resume-row">
                <span className="resume-icon">
                  <Glyph name="file" />
                </span>
                <div className="resume-copy">
                  <strong>{fallback.foco ?? "Currículo original"}</strong>
                  <span>{fallback.usar_quando ?? "Fallback para vagas genéricas"}</span>
                  <code>{fallback.arquivo ?? ""}</code>
                </div>
                <div className="resume-actions">
                  <span className="active-badge">FALLBACK</span>
                </div>
              </div>
            )}
            {listaCurriculos.map((cur, index) => (
              // id pode se repetir em teoria — index garante key única
              <div className="resume-row" key={`${cur.id}-${index}`}>
                <span className="resume-icon">
                  <Glyph name="file" />
                </span>
                <div className="resume-copy">
                  <strong>{cur.foco || cur.id}</strong>
                  <code>{cur.arquivo}</code>
                </div>
                <div className="resume-actions resume-edit">
                  <input
                    aria-label="Arquivo"
                    value={cur.arquivo ?? ""}
                    placeholder="./curriculos/.../Curriculo.pdf"
                    onChange={(e) => {
                      setCurriculos({
                        ...curriculos,
                        curriculos: listaCurriculos.map((c, i) =>
                          i === index ? { ...c, arquivo: e.target.value } : c,
                        ),
                      });
                      marcarDirty();
                    }}
                  />
                  <input
                    aria-label="Foco"
                    value={cur.foco ?? ""}
                    placeholder="Foco do currículo"
                    onChange={(e) => {
                      setCurriculos({
                        ...curriculos,
                        curriculos: listaCurriculos.map((c, i) =>
                          i === index ? { ...c, foco: e.target.value } : c,
                        ),
                      });
                      marcarDirty();
                    }}
                  />
                  <input
                    aria-label="Usar quando"
                    value={cur.usar_quando ?? ""}
                    placeholder="Quando o bot deve usar este currículo"
                    onChange={(e) => {
                      setCurriculos({
                        ...curriculos,
                        curriculos: listaCurriculos.map((c, i) =>
                          i === index ? { ...c, usar_quando: e.target.value } : c,
                        ),
                      });
                      marcarDirty();
                    }}
                  />
                </div>
                <div className="resume-actions">
                  <button type="button" onClick={() => abrirUpload(String(cur.id ?? ""))}>
                    Trocar
                  </button>
                  <button
                    type="button"
                    className="view-button"
                    onClick={() =>
                      window.open(urlCurriculo(String(cur.id ?? "")), "_blank", "noopener")
                    }
                  >
                    <Glyph name="eye" size={15} /> Visualizar
                  </button>
                </div>
              </div>
            ))}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.doc,.docx,.txt"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void processarArquivo(f);
            }}
          />
          <button
            type="button"
            className="upload-zone"
            disabled={enviando}
            onClick={() => abrirUpload(null)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const f = e.dataTransfer.files?.[0];
              if (f) void processarArquivo(f);
            }}
          >
            <span>
              <Glyph name="upload" size={22} />
            </span>
            <strong>
              {enviando ? "Enviando currículo…" : "Arraste um currículo ou clique para enviar"}
            </strong>
            <small>PDF, DOC ou DOCX · máximo 10 MB</small>
          </button>
          {erroUpload && (
            <p className="field-hint" role="alert" style={{ marginTop: 8 }}>
              {erroUpload}
            </p>
          )}
          <p className="field-hint" style={{ marginTop: 10 }}>
            O bot escolhe automaticamente a melhor versão pelo campo{" "}
            <code>usar_quando</code> — nunca existe um "currículo ativo" fixo.
          </p>
        </FormCard>
      </div>

      <ActionBar
        dirty={dirty && !salvando}
        saved={saved}
        erro={erroSalvar}
        saveLabel={salvando ? "Salvando..." : "Salvar perfil"}
        onSave={salvar}
        onDiscard={() => {
          if (cfg.config) {
            setP(cfg.config.perfil);
            setResp(cfg.config.respostas);
            setCurriculos(cfg.config.curriculos);
          }
          setDirty(false);
          setErroSalvar(null);
        }}
      />
    </div>
  );
}
