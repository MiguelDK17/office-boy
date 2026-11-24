// Tela de CONFIGURAÇÕES — portada do Figma Make, com os valores REAIS do .env
// (GET /api/config → PUT /api/config/env) e dos sites (config/sites.json).
//
// OpenRouter-first (decisão do projeto):
//   • O agente usa o catálogo real do OpenRouter (ModelCombobox) — a API OpenAI
//     nativa é só uma das opções (o .env.example documenta as duas).
//   • GEMINI_MODEL/GEMINI_API_KEY são o fallback do MODELO AUXILIAR (ver
//     src/llm-adapter.ts) — ficam no card "Modelo auxiliar".
//   • Portas do Docker/BOT_* são somente leitura (definidas no compose).
//
// Save de .env exige REINICIALIZAÇÃO (dotenv lê uma vez só) — banner amarelo.

import { useEffect, useMemo, useRef, useState } from "react";
import type { CampoEnv, Configuracao, SiteConfig } from "../lib/types";
import type { UseConfig } from "../hooks/useConfig";
import { alterarSiteAtivo, invalidateTokenConfig, type MotivoSemReinicio } from "../lib/api";
import {
  ActionBar,
  Field,
  FormCard,
  Glyph,
  ModelCombobox,
  ScreenHeader,
  SecretField,
  SelectField,
  Toggle,
} from "../components/form";
import { SiteUrlsDialog } from "../components/SiteUrlsDialog";

type Valores = Record<string, string | number | boolean | null>;

/** Rótulos humanos; as chaves técnicas ficam apenas no código e no payload. */
const ROTULOS_ENV: Record<string, { label: string; unit?: string; hint?: string }> = {
  LIMITE_DIARIO: { label: "Limite diário de candidaturas" },
  MAX_POR_EXECUCAO: { label: "Máximo por execução" },
  MAX_ITERACOES: { label: "Máximo de interações", hint: "Vazio usa o padrão (500)." },
  META_CANDIDATURAS: {
    label: "Meta de candidaturas",
    hint: "Encerra a run ao atingir a meta. Use 0 para desativar.",
  },
  SCORE_MINIMO: { label: "Score mínimo para candidatar" },
  CUSTO_MAX_USD: { label: "Custo máximo por run", unit: "US$", hint: "Use 0 para desativar." },
  DELAY_MIN: { label: "Pausa mínima entre ações", unit: "ms" },
  DELAY_MAX: { label: "Pausa máxima entre ações", unit: "ms" },
  AGENT_LLM_BASE_URL: { label: "Endereço da API" },
  AGENT_LLM_API_KEY: { label: "Chave da API" },
  AGENT_LLM_MODEL: { label: "Modelo" },
  LLM_AUX_PROVIDER: { label: "Provedor" },
  LLM_AUX_MODEL: { label: "Modelo" },
  OPENAI_BASE_URL: { label: "Endereço da API auxiliar" },
  OPENAI_API_KEY: { label: "Chave da API auxiliar" },
  OLLAMA_URL: { label: "Endereço local do Ollama" },
  GEMINI_MODEL: { label: "Modelo Gemini de fallback" },
  GEMINI_API_KEY: { label: "Chave Gemini" },
  BOT_UI_PORT: { label: "Porta da interface" },
  BOT_NOVNC_PORT: { label: "Porta do navegador remoto" },
  BOT_CDP_PORT: { label: "Porta de depuração do Chrome" },
  DASHBOARD_PORT: { label: "Porta do dashboard" },
  DASHBOARD_HOST: { label: "Host do dashboard" },
  CDP_ENDPOINT: { label: "Endpoint do Chrome" },
  TELEGRAM_BOT_TOKEN: { label: "Token do bot do Telegram" },
  TELEGRAM_CHAT_ID: { label: "Identificador da conversa" },
  SMTP_HOST: { label: "Servidor de e-mail" },
  SMTP_PORT: { label: "Porta do servidor de e-mail" },
  SMTP_USER: { label: "Usuário do e-mail" },
  SMTP_PASS: { label: "Senha do e-mail" },
  EMAIL_DESTINATARIO: { label: "E-mail de destino" },
  CRON_HORARIO: { label: "Horário da execução" },
};

/** Descrições dos toggles; as chaves técnicas ficam apenas no código. */
const ROTULOS_TOGGLE: Record<string, { label: string; descricao: string }> = {
  DRY_RUN: { label: "Modo simulação", descricao: "Simula as candidaturas sem enviar." },
  PAUSAR_EM_LOGIN: { label: "Pausar ao detectar login", descricao: "O bot para e espera você entrar na conta." },
  CONTROL_MODE: { label: "Modo de controle", descricao: "Inicia somente o dashboard, sem executar o agente." },
  CRON_ATIVO: { label: "Agendamento automático", descricao: "Executa o bot no horário definido." },
};

/** Valor inicial de um campo ("" para secret — nunca pré-preenchido). */
function inicial(campo: CampoEnv): string | number | boolean | null {
  if (campo.secreto) return "";
  return campo.valor;
}

export function SettingsScreen({
  cfg,
  onReiniciarBot,
}: {
  cfg: UseConfig;
  onReiniciarBot: () => void;
}) {
  const [valores, setValores] = useState<Valores>({});
  const [siteStates, setSiteStates] = useState<SiteConfig[]>([]);
  const [dirty, setDirty] = useState(false);
  const [salvando, setSalvando] = useState(false);
  const [saved, setSaved] = useState(false);
  const [erroSalvar, setErroSalvar] = useState<string | null>(null);
  const [restartNeeded, setRestartNeeded] = useState(false);
  // true = o backend já gravou e vai reiniciar o container sozinho.
  const [reiniciando, setReiniciando] = useState(false);
  const [bootIdEsperado, setBootIdEsperado] = useState<string | null>(null);
  const [motivoReinicio, setMotivoReinicio] = useState<MotivoSemReinicio>(null);
  const [mensagemReinicio, setMensagemReinicio] = useState("");
  // Incrementado pelo botão "Tentar novamente" após timeout do polling.
  const [tentativaReinicio, setTentativaReinicio] = useState(0);
  // O dialog guarda o ID (não o objeto): o estado do site pode mudar enquanto
  // ele está aberto (ex.: toggle) sem o dialog ficar com uma cópia velha.
  const [siteUrlsOpen, setSiteUrlsOpen] = useState<string | null>(null);
  const [salvandoSiteId, setSalvandoSiteId] = useState<string | null>(null);
  const [siteAviso, setSiteAviso] = useState<{ tipo: "erro" | "ok"; texto: string } | null>(null);
  // Última versão PERSISTIDA dos sites (inclui gravações diretas do dialog e
  // do toggle). O "Descartar" e o cálculo de dirty usam esta base, não o
  // cfg.config — que fica velho depois de um save direto.
  const sitesBase = useRef<SiteConfig[]>([]);
  // Referência ao ÚLTIMO config já hidratado. Evita reidratar com cfg.config
  // obsoleto quando restartNeeded muda (antes do recarregar da página).
  const ultimoConfigRef = useRef<Configuracao | null>(null);

  // Hidrata a partir do config real; rehidrata no Descartar/Recarregar.
  useEffect(() => {
    const config = cfg.config;
    if (!config || ultimoConfigRef.current === config) return;
    ultimoConfigRef.current = config;
    const lista = config.sites.sites.map((s) => ({ ...s }));
    sitesBase.current = lista.map((s) => ({ ...s }));
    // Com restart pendente, o process.env ainda tem os valores ANTIGOS —
    // rehidratar faria o campo "reverter" logo após o save bem-sucedido
    // (parece que a alteração foi descartada). Os valores locais ficam.
    if (restartNeeded) {
      setSiteStates(lista);
      return;
    }
    setValores(Object.fromEntries(config.env.map((campo) => [campo.chave, inicial(campo)])));
    setSiteStates(lista);
    setDirty(false);
  }, [cfg.config, restartNeeded]);

  const recarregarConfig = cfg.recarregar;

  // Após o auto-restart, espera o PROCESSO NOVO (bootId diferente) e recarrega.
  useEffect(() => {
    if (!reiniciando) return;
    let cancelado = false;
    let timer = 0;
    let tentativas = 0;
    const inicio = Date.now();
    const verificar = async () => {
      try {
        const resp = await fetch("/api/status", { cache: "no-store" });
        if (resp.ok) {
          const dados = (await resp.json().catch(() => ({}))) as { bootId?: string };
          if (dados.bootId && bootIdEsperado && dados.bootId !== bootIdEsperado) {
            if (cancelado) return;
            invalidateTokenConfig(); // DASHBOARD_TOKEN pode ter mudado no restart
            setReiniciando(false);
            setRestartNeeded(false);
            setErroSalvar(null);
            setBootIdEsperado(null);
            await recarregarConfig();
            return;
          }
        }
      } catch {
        // backend ainda subindo — tenta de novo
      }
      if (cancelado) return;
      if (Date.now() - inicio > 180_000) {
        setReiniciando(false);
        setErroSalvar("O container ainda não voltou. Tente novamente ou recarregue a página.");
        setDirty(true);
        return;
      }
      tentativas++;
      const espera = tentativas < 4 ? 1500 : tentativas < 8 ? 3000 : 5000;
      timer = window.setTimeout(() => void verificar(), espera);
    };
    timer = window.setTimeout(() => void verificar(), 2500);
    return () => {
      cancelado = true;
      window.clearTimeout(timer);
    };
  }, [reiniciando, bootIdEsperado, recarregarConfig, tentativaReinicio]);

  const env = cfg.config?.env ?? [];
  const envDisponivel = cfg.config?.envDisponivel ?? false;
  const siteAberto = siteUrlsOpen
    ? siteStates.find((site) => site.id === siteUrlsOpen) ?? null
    : null;

  const porGrupo = useMemo(() => {
    const mapa = new Map<string, CampoEnv[]>();
    for (const campo of env) {
      mapa.set(campo.grupo, [...(mapa.get(campo.grupo) ?? []), campo]);
    }
    return mapa;
  }, [env]);

  const marcarDirty = () => {
    setDirty(true);
    setSaved(false);
    setErroSalvar(null);
  };

  const setCampo = (campo: CampoEnv, valor: string | number | boolean) => {
    setValores((atual) => ({ ...atual, [campo.chave]: valor }));
    marcarDirty();
  };

  // Secret: "" = sem substituição pendente; texto = novo valor.
  // "" (cancelar/limpar o rascunho) NÃO suja o form — só um valor preenchido.
  const setSecret = (campo: CampoEnv, valor: string) => {
    setValores((atual) => ({ ...atual, [campo.chave]: valor }));
    if (valor !== "") marcarDirty();
  };

  /**
   * Toggle do site grava na hora (PATCH por id), independente da barraSalvar.
   * Atualização otimista + rollback se o backend recusar.
   */
  async function alternarSite(site: SiteConfig, ativo: boolean) {
    if (!site.id || salvandoSiteId) return;
    const anterior = site.ativo;
    const aplicar = (valor: boolean) => {
      setSiteStates((atual) =>
        atual.map((s) => (s.id === site.id ? { ...s, ativo: valor } : s)),
      );
      sitesBase.current = sitesBase.current.map((s) =>
        s.id === site.id ? { ...s, ativo: valor } : s,
      );
    };

    aplicar(ativo);
    setSalvandoSiteId(site.id);
    setSiteAviso(null);
    const resultado = await alterarSiteAtivo(site.id, ativo);
    setSalvandoSiteId(null);

    if (resultado.erro) {
      aplicar(anterior);
      setSiteAviso({ tipo: "erro", texto: resultado.erro });
      return;
    }
    setSiteAviso({
      tipo: "ok",
      texto: `${site.nome} ${ativo ? "ativado" : "desativado"}${
        resultado.aplicadoNaProximaRun ? " — vale na próxima execução" : ""
      }`,
    });
    window.setTimeout(() => setSiteAviso(null), 4000);
  }

  async function salvar() {
    setSalvando(true);
    setErroSalvar(null);

    // 1) .env: converte tipos de volta para string; secret vazio = pular.
    const envPayload: Record<string, string> = {};
    let mudouEnv = false;
    for (const campo of env) {
      if (campo.somenteLeitura) continue;
      const valor = valores[campo.chave];
      if (campo.secreto) {
        if (typeof valor === "string" && valor.trim() !== "") {
          envPayload[campo.chave] = valor;
          mudouEnv = true;
        }
        continue;
      }
      const original = campo.valor;
      // Normaliza ANTES de comparar: inputs numéricos chegam como string,
      // e "10" !== 10 faria PUT do .env (e banner de restart) sem mudança real.
      if (campo.tipo === "numero") {
        const n = Number(valor);
        if (Number.isFinite(n) && n === Number(original)) continue;
      } else if (valor === original || valor === String(original ?? "")) continue;
      if (valor === null || valor === "") continue; // vazio = não tocar
      envPayload[campo.chave] =
        campo.tipo === "booleano" ? (valor ? "true" : "false") : String(valor);
      mudouEnv = true;
    }
    // 1) sites.json PRIMEIRO — o env vai por último porque pode reiniciar o
    // processo e interromper qualquer escrita que ainda esteja em voo.
    const sitesMudou = JSON.stringify(siteStates) !== JSON.stringify(sitesBase.current);
    const erroSites = sitesMudou ? await cfg.salvarSites({ sites: siteStates }) : null;

    let erroEnv: string | null = null;
    let vaiReiniciar = false;
    if (erroSites) {
      // Não grava o .env nem reinicia deixando alterações de sites perdidas.
      erroEnv = `${erroSites} (o .env não foi alterado)`;
    } else if (mudouEnv) {
      if (!envDisponivel) {
        erroEnv = "Sem arquivo .env neste ambiente — edite o .env do host e reinicie o container.";
      } else {
        const resultadoEnv = await cfg.salvarEnv(envPayload);
        erroEnv = resultadoEnv.erro;
        if (!erroEnv) {
          if (resultadoEnv.reiniciando) {
            vaiReiniciar = true;
            setBootIdEsperado(resultadoEnv.bootId);
            setReiniciando(true);
          } else {
            setRestartNeeded(true);
            setMotivoReinicio(resultadoEnv.motivo);
            setMensagemReinicio(resultadoEnv.mensagem);
          }
        }
      }
    }

    setSalvando(false);
    const erro = erroEnv;
    if (erro) {
      setErroSalvar(erro);
      setDirty(true);
      return;
    }
    sitesBase.current = siteStates.map((s) => ({ ...s }));
    setDirty(false);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 3000);
    // Durante o restart o backend cai; o polling abaixo recarrega ao voltar.
    if (!vaiReiniciar) await cfg.recarregar();
  }

  const campo = (chave: string): CampoEnv | undefined =>
    env.find((c) => c.chave === chave);

  const rotulo = (c: CampoEnv) => ROTULOS_ENV[c.chave] ?? { label: c.chave };

  const renderNumero = (c: CampoEnv, hint?: string) => {
    const r = rotulo(c);
    return (
      <Field
        key={c.chave}
        label={r.label}
        technicalName={c.chave}
        type="number"
        value={String(valores[c.chave] ?? "")}
        unit={r.unit}
        hint={hint ?? r.hint}
        disabled={c.somenteLeitura}
        badge={c.somenteLeitura ? "somente leitura" : undefined}
        onChange={(v) => setCampo(c, v)}
      />
    );
  };

  const renderTexto = (c: CampoEnv, hint?: string) => {
    const r = rotulo(c);
    if (c.secreto) {
      return (
        <SecretField
          key={c.chave}
          label={r.label}
          technicalName={c.chave}
          definido={c.definido}
          onChange={(v) => setSecret(c, v)}
        />
      );
    }
    return (
      <Field
        key={c.chave}
        label={r.label}
        technicalName={c.chave}
        value={String(valores[c.chave] ?? "")}
        hint={hint ?? r.hint}
        disabled={c.somenteLeitura}
        badge={c.somenteLeitura ? "somente leitura" : undefined}
        onChange={(v) => setCampo(c, v)}
      />
    );
  };

  // Despacha por tipo declarado do campo — evita SMTP_PORT virar input de
  // texto (o que, somado à comparação fraca, disparava PUT sem mudança real).
  const renderCampo = (c: CampoEnv, hint?: string) => {
    if (c.tipo === "numero") return renderNumero(c, hint);
    if (c.tipo === "booleano") return renderBooleano(c, hint ?? "Ativar");
    return renderTexto(c, hint);
  };
  const renderBooleano = (c: CampoEnv, rotuloPadrao = "Ativar") => {
    const r = ROTULOS_TOGGLE[c.chave] ?? { label: rotuloPadrao, descricao: "" };
    return (
      <div className="toggle-field" key={c.chave}>
        <span>
          <b>
            {r.label}
          </b>
          <small>{r.descricao}</small>
        </span>
        <Toggle
          checked={valores[c.chave] === true}
          disabled={c.somenteLeitura}
          ariaLabel={r.label}
          onChange={(checked) => setCampo(c, checked)}
        />
      </div>
    );
  };

  return (
    <div className="screen-view settings-screen">
      {cfg.erro && !cfg.config && (
        <div className="restart-banner" role="alert">
          <span className="restart-mark">!</span>
          <div>
            <strong>Falha ao carregar as configurações</strong>
            <p>{cfg.erro} — o backend pode estar fora do ar.</p>
          </div>
          <button onClick={() => void cfg.recarregar()}>Tentar de novo</button>
        </div>
      )}
      {cfg.carregando && !cfg.config && (
        <div className="restart-banner" role="status">
          <span className="restart-mark">…</span>
          <div>
            <strong>Carregando configurações</strong>
            <p>Buscando .env e config/sites.json no backend.</p>
          </div>
        </div>
      )}

      <ScreenHeader
        eyebrow="PREFERÊNCIAS DO SISTEMA"
        title="Configurações"
        description="Ajuste como o bot trabalha. As mudanças valem a partir da próxima vez que você iniciar o bot."
      />

      {reiniciando && (
        <div className="restart-banner is-restarting" role="status" aria-live="polite">
          <span className="restart-mark restart-spinner" aria-hidden="true" />
          <div>
            <strong>Reiniciando automaticamente…</strong>
            <p>
              Configurações salvas. O container está sendo recriado e esta tela volta sozinha em
              alguns segundos — não feche a página.
            </p>
          </div>
        </div>
      )}

      {!reiniciando && restartNeeded && (
        <div className="restart-banner">
          <span className="restart-mark">!</span>
          <div>
            <strong>Reinicialização pendente</strong>
            <p>
              {mensagemReinicio ||
                "O .env só é lido na inicialização. Reinicie manualmente para aplicar."}
            </p>
          </div>
          {motivoReinicio === "rodando" && (
            <button
              onClick={() => {
                setRestartNeeded(false);
                onReiniciarBot();
              }}
            >
              Ir para a Run
            </button>
          )}
        </div>
      )}

      {!reiniciando && !!erroSalvar && erroSalvar.includes("ainda não voltou") && (
        <div className="restart-banner" role="alert">
          <span className="restart-mark">!</span>
          <div>
            <strong>Reinício em dúvida</strong>
            <p>{erroSalvar}</p>
          </div>
          <button
            onClick={() => {
              setErroSalvar(null);
              setReiniciando(true);
              setTentativaReinicio((n) => n + 1);
            }}
          >
            Tentar novamente
          </button>
        </div>
      )}

      <div className="settings-layout">
        <FormCard title="Execução" description="Defina limites, ritmo e custo de cada run.">
          <div className="field-grid settings-fields">
            {porGrupo.get("execucao")?.map((c) =>
              c.tipo === "booleano" ? renderBooleano(c) : renderNumero(c),
            )}
          </div>
        </FormCard>

        <FormCard
          title="Agente de navegação"
          description="O modelo de IA que decide o que fazer em cada página. OpenRouter-first — troque o Endereço da API para usar OpenAI nativa ou Ollama."
        >
          <div className="field-grid settings-fields">
            {porGrupo
              .get("agente")
              ?.filter((c) => c.chave !== "AGENT_LLM_MODEL")
              .map((c) => renderCampo(c))}
            {/* ModelCombobox: catálogo real do OpenRouter com busca + filtro
                "somente grátis"; endpoint não-OpenRouter cai em campo manual. */}
            <ModelCombobox
              technicalName="AGENT_LLM_MODEL"
              apiAddress={String(valores.AGENT_LLM_BASE_URL ?? "https://openrouter.ai/api/v1")}
              value={String(valores.AGENT_LLM_MODEL ?? "")}
              onChange={(v) => {
                const c = campo("AGENT_LLM_MODEL");
                if (c) setCampo(c, v);
              }}
            />
          </div>
          <div className="secret-note">
            <Glyph name="lock" size={15} /> Valores secretos nunca são exibidos nem enviados de volta
          </div>
        </FormCard>

        <FormCard
          title="Modelo auxiliar"
          description="Escreve currículo adaptado, carta de apresentação e mensagens. Pode usar outro provedor."
        >
          <div className="field-grid settings-fields">
            <SelectField
              label="Provedor"
              technicalName="LLM_AUX_PROVIDER"
              value={String(valores.LLM_AUX_PROVIDER ?? "openai")}
              // valor atual pode estar fora das 3 opções conhecidas (ex.:
              // "openrouter") — incluí-lo evita o dropdown renderizar em branco
              options={[...new Set(["openai", "ollama", "gemini", String(valores.LLM_AUX_PROVIDER ?? "openai")])]}
              onChange={(v) => {
                const c = campo("LLM_AUX_PROVIDER");
                if (c) setCampo(c, v);
              }}
            />
            <ModelCombobox
              technicalName="LLM_AUX_MODEL"
              apiAddress={String(valores.OPENAI_BASE_URL ?? "https://openrouter.ai/api/v1")}
              value={String(valores.LLM_AUX_MODEL ?? "")}
              onChange={(v) => {
                const c = campo("LLM_AUX_MODEL");
                if (c) setCampo(c, v);
              }}
            />
            {porGrupo
              .get("auxiliar")
              ?.filter((c) => c.chave !== "LLM_AUX_PROVIDER" && c.chave !== "LLM_AUX_MODEL")
              .map((c) => renderCampo(c))}
          </div>
          <div className="secret-note">
            <Glyph name="lock" size={15} /> Valores secretos nunca são exibidos nem enviados de volta
          </div>
        </FormCard>

        <FormCard title="Servidor" description="Endereços locais usados pelo Office Boy.">
          <div className="field-grid settings-fields">
            {porGrupo.get("servidor")?.map((c) => renderCampo(c))}
          </div>
        </FormCard>

        <FormCard title="Notificações" description="Telegram e relatórios por e-mail.">
          <div className="field-grid settings-fields">
            {porGrupo.get("notificacoes")?.map((c) => renderCampo(c))}
          </div>
          <div className="secret-note">
            <Glyph name="lock" size={15} /> Valores secretos nunca são exibidos nem enviados de volta
          </div>
        </FormCard>

        <FormCard title="Agendamento" description="Execução automática em horário definido.">
          <div className="field-grid settings-fields">
            {porGrupo.get("cron")?.map((c) => renderCampo(c))}
          </div>
        </FormCard>

        <FormCard
          title="Sites de vagas"
          description="Fontes consultadas durante cada run."
          className="full-card"
        >
          <div className="sites-list">
            {siteStates.map((site) => (
              <div className="site-row" key={site.id}>
                <div className="site-logo">{site.nome.charAt(0)}</div>
                <div className="site-copy">
                  <strong>{site.nome}</strong>
                  <span>{site.instrucoes}</span>
                  <button
                    type="button"
                    className="site-url-count"
                    onClick={() => setSiteUrlsOpen(site.id)}
                    aria-label={`Gerenciar URLs de busca de ${site.nome}`}
                  >
                    {site.urls_busca.length > 0
                      ? `${site.urls_busca.length} ${site.urls_busca.length === 1 ? "URL" : "URLs"} de busca`
                      : "Adicionar URLs"}
                  </button>
                  {site.ativo && site.urls_busca.length === 0 && (
                    <small className="site-warning">
                      <Glyph name="alert" size={13} /> Sem URLs, este site não buscará vagas.
                    </small>
                  )}
                </div>
                <div className="site-actions">
                  <button
                    type="button"
                    className="icon-button site-manage-button"
                    title="Gerenciar URLs"
                    aria-label={`Gerenciar URLs de ${site.nome}`}
                    onClick={() => setSiteUrlsOpen(site.id)}
                  >
                    <Glyph name="list-edit" size={16} />
                  </button>
                  <Toggle
                    checked={site.ativo}
                    disabled={salvandoSiteId === site.id}
                    ariaLabel={`Ativar ${site.nome}`}
                    onChange={(checked) => void alternarSite(site, checked)}
                  />
                </div>
              </div>
            ))}
          </div>
          {siteAviso && (
            <div
              className={`site-action-feedback ${siteAviso.tipo === "erro" ? "is-error" : "is-ok"}`}
              role={siteAviso.tipo === "erro" ? "alert" : "status"}
            >
              {siteAviso.texto}
            </div>
          )}
        </FormCard>

        <SiteUrlsDialog
          site={siteAberto}
          onSaved={(siteId, urls) => {
            setSiteStates((atual) =>
              atual.map((s) => (s.id === siteId ? { ...s, urls_busca: urls } : s)),
            );
            sitesBase.current = sitesBase.current.map((s) =>
              s.id === siteId ? { ...s, urls_busca: urls } : s,
            );
          }}
          onClose={() => setSiteUrlsOpen(null)}
        />
      </div>

      <ActionBar
        dirty={dirty && !salvando}
        saved={saved}
        erro={erroSalvar}
        saveLabel={salvando ? "Salvando..." : "Salvar configurações"}
        onSave={salvar}
        onDiscard={() => {
          const config = cfg.config;
          if (config) {
            setValores(Object.fromEntries(config.env.map((c) => [c.chave, inicial(c)])));
          }
          // Restaura a última versão PERSISTIDA dos sites (não o GET antigo):
          // toggles/URLs salvos direto pelo card continuam valendo.
          setSiteStates(sitesBase.current.map((s) => ({ ...s })));
          setDirty(false);
          setErroSalvar(null);
        }}
      />
    </div>
  );
}
