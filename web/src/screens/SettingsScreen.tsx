// Tela de CONFIGURAÇÕES — portada do Figma Make, com os valores REAIS do .env
// (GET /api/config → PUT /api/config/env) e dos sites (config/sites.json).
//
// OpenRouter-first (decisão do projeto):
//   • O agente é "via OpenRouter" por padrão — a API OpenAI nativa é só uma
//     das opções (o .env.example documenta as duas).
//   • As vars legadas de Gemini do agente saíram da tela — o agente não usa
//     mais Gemini; o auxiliar continua suportando o provider.
//   • Portas do Docker/BOT_* são somente leitura (definidas no compose).
//
// Save de .env exige REINICIALIZAÇÃO (dotenv lê uma vez só) — banner amarelo.

import { useEffect, useMemo, useState } from "react";
import type { CampoEnv, Configuracao, SiteConfig } from "../lib/types";
import type { UseConfig } from "../hooks/useConfig";
import {
  ActionBar,
  Field,
  FormCard,
  Glyph,
  ScreenHeader,
  SecretField,
  SelectField,
  Toggle,
} from "../components/form";

type Valores = Record<string, string | number | boolean | null>;

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

  // Hidrata a partir do config real; rehidrata no Descartar/Recarregar.
  useEffect(() => {
    const config = cfg.config;
    if (!config) return;
    setValores(Object.fromEntries(config.env.map((campo) => [campo.chave, inicial(campo)])));
    setSiteStates(config.sites.sites.map((s) => ({ ...s })));
    setDirty(false);
  }, [cfg.config]);

  const env = cfg.config?.env ?? [];
  const envDisponivel = cfg.config?.envDisponivel ?? false;

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
  const setSecret = (campo: CampoEnv, valor: string) => {
    setValores((atual) => ({ ...atual, [campo.chave]: valor }));
    marcarDirty();
  };

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
      if (valor === original) continue;
      if (valor === null || valor === "") continue; // vazio = não tocar
      envPayload[campo.chave] =
        campo.tipo === "booleano" ? (valor ? "true" : "false") : String(valor);
      mudouEnv = true;
    }
    let erroEnv: string | null = null;
    if (mudouEnv) {
      if (!envDisponivel) {
        erroEnv = "Sem arquivo .env neste ambiente — edite o .env do host e reinicie o container.";
      } else {
        erroEnv = await cfg.salvarEnv(envPayload);
        if (!erroEnv) setRestartNeeded(true);
      }
    }

    // 2) sites.json (toggles ativo/inativo + instruções editáveis abaixo)
    const erroSites = await cfg.salvarSites({ sites: siteStates });

    setSalvando(false);
    const erro = erroEnv ?? erroSites;
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

  const campo = (chave: string): CampoEnv | undefined =>
    env.find((c) => c.chave === chave);

  const renderNumero = (c: CampoEnv, hint?: string) => (
    <Field
      key={c.chave}
      label={c.chave}
      type="number"
      value={String(valores[c.chave] ?? "")}
      hint={hint}
      disabled={c.somenteLeitura}
      badge={c.somenteLeitura ? "somente leitura" : undefined}
      onChange={(v) => setCampo(c, v)}
    />
  );

  const renderTexto = (c: CampoEnv, hint?: string) =>
    c.secreto ? (
      <SecretField
        key={c.chave}
        label={`${c.chave}${c.definido ? " · definido" : " · não definido"}`}
        definido={c.definido}
        onChange={(v) => setSecret(c, v)}
      />
    ) : (
      <Field
        key={c.chave}
        label={c.chave}
        value={String(valores[c.chave] ?? "")}
        hint={hint}
        disabled={c.somenteLeitura}
        badge={c.somenteLeitura ? "somente leitura" : undefined}
        onChange={(v) => setCampo(c, v)}
      />
    );

  const renderBooleano = (c: CampoEnv, descricao: string) => (
    <div className="toggle-field" key={c.chave}>
      <span>
        <b>{c.chave}</b>
        <small>{descricao}</small>
      </span>
      <Toggle
        checked={valores[c.chave] === true}
        disabled={c.somenteLeitura}
        onChange={(checked) => setCampo(c, checked)}
      />
    </div>
  );

  return (
    <div className="screen-view settings-screen">
      <ScreenHeader
        eyebrow="PREFERÊNCIAS DO SISTEMA"
        title="Configurações"
        description="Valores reais do arquivo .env. Alterações entram em vigor na próxima inicialização do bot."
      />

      {restartNeeded && (
        <div className="restart-banner">
          <span className="restart-mark">!</span>
          <div>
            <strong>Reinicialização necessária</strong>
            <p>
              O .env só é lido na inicialização. Parar o bot e iniciá-lo de novo aplica os novos
              valores.
            </p>
          </div>
          <button
            onClick={() => {
              setRestartNeeded(false);
              onReiniciarBot();
            }}
          >
            Ir para a Run
          </button>
        </div>
      )}

      <div className="settings-layout">
        <FormCard title="Execução" description="Limites, ritmo e comportamento de cada run.">
          <div className="field-grid settings-fields">
            {porGrupo.get("execucao")?.map((c) =>
              c.tipo === "booleano"
                ? renderBooleano(
                    c,
                    c.chave === "DRY_RUN"
                      ? "Simula sem enviar"
                      : "Pausa ao detectar login",
                  )
                : renderNumero(c, c.chave === "CUSTO_MAX_USD" ? "USD por run (0 = off)" : c.chave === "META_CANDIDATURAS" ? "Encerra o run com sucesso (0 = off)" : undefined),
            )}
          </div>
        </FormCard>

        <FormCard
          title="Agente de navegação"
          description="Modelo principal via OpenRouter (API compatível com OpenAI — troque AGENT_LLM_BASE_URL para usar OpenAI nativa ou Ollama local)."
        >
          <div className="field-grid settings-fields">
            {porGrupo.get("agente")?.map((c) => renderTexto(c, c.chave === "AGENT_LLM_MODEL" ? "Formato openrouter: provedor/modelo" : undefined))}
          </div>
          <div className="secret-note">
            <Glyph name="lock" size={15} /> Valores secretos nunca são exibidos nem enviados de volta
          </div>
        </FormCard>

        <FormCard
          title="Modelo auxiliar"
          description="Gera currículo tailored, cover letter e mensagens (pode ser um provedor diferente do agente)."
        >
          <div className="field-grid settings-fields">
            <SelectField
              label="LLM_AUX_PROVIDER"
              value={String(valores.LLM_AUX_PROVIDER ?? "openai")}
              options={["openai", "ollama", "gemini"]}
              onChange={(v) => {
                const c = campo("LLM_AUX_PROVIDER");
                if (c) setCampo(c, v);
              }}
            />
            {porGrupo
              .get("auxiliar")
              ?.filter((c) => c.chave !== "LLM_AUX_PROVIDER")
              .map((c) =>
                renderTexto(
                  c,
                  c.chave === "OPENAI_BASE_URL"
                    ? "Endpoint OpenAI-compatible (OpenRouter é o padrão do projeto)"
                    : undefined,
                ),
              )}
          </div>
          <div className="secret-note">
            <Glyph name="lock" size={15} /> Valores secretos nunca são exibidos nem enviados de volta
          </div>
        </FormCard>

        <FormCard title="Servidor" description="Portas e endpoints locais do Office Boy.">
          <div className="field-grid settings-fields">
            {porGrupo.get("servidor")?.map((c) =>
              c.tipo === "booleano"
                ? renderBooleano(c, "Definido pelo docker compose")
                : renderTexto(
                    c,
                    c.chave === "CDP_ENDPOINT" ? "Chrome remoto do bot" : undefined,
                  ),
            )}
          </div>
        </FormCard>

        <FormCard title="Notificações" description="Telegram e relatórios por e-mail.">
          <div className="field-grid settings-fields">
            {porGrupo.get("notificacoes")?.map((c) => renderTexto(c))}
          </div>
          <div className="secret-note">
            <Glyph name="lock" size={15} /> Valores secretos nunca são exibidos nem enviados de volta
          </div>
        </FormCard>

        <FormCard title="Agendamento" description="Execução automática em horário definido.">
          <div className="field-grid settings-fields">
            {porGrupo.get("cron")?.map((c) =>
              c.tipo === "booleano"
                ? renderBooleano(c, "Agendamento automático")
                : renderTexto(c, "Formato HH:MM"),
            )}
          </div>
        </FormCard>

        <FormCard
          title="Sites de vagas"
          description="Fontes consultadas durante cada run (config/sites.json)."
          className="full-card"
        >
          <div className="sites-list">
            {siteStates.map((site, index) => (
              <div className="site-row" key={site.nome}>
                <div className="site-logo">{site.nome.charAt(0)}</div>
                <div className="site-copy">
                  <strong>{site.nome}</strong>
                  <span>{site.instrucoes}</span>
                  <small>
                    {site.tipo} · {site.urls_busca.length} URL(s) de busca
                  </small>
                </div>
                <Toggle
                  checked={site.ativo}
                  onChange={(checked) => {
                    setSiteStates((atual) =>
                      atual.map((s, i) => (i === index ? { ...s, ativo: checked } : s)),
                    );
                    marcarDirty();
                  }}
                />
              </div>
            ))}
          </div>
          <p className="field-hint" style={{ marginTop: 10 }}>
            Para editar instruções e URLs de busca de cada portal, ajuste{" "}
            <code>config/sites.json</code> — os campos de texto por URL ficam fora da UI de propósito
            (URLs do LinkedIn/Gupy têm query strings fáceis de estragar).
          </p>
        </FormCard>
      </div>

      <ActionBar
        dirty={dirty && !salvando}
        saved={saved}
        erro={erroSalvar}
        saveLabel={salvando ? "Salvando..." : "Salvar configurações"}
        onSave={salvar}
        onDiscard={() => {
          const config: Configuracao | null = cfg.config;
          if (config) {
            setValores(Object.fromEntries(config.env.map((c) => [c.chave, inicial(c)])));
            setSiteStates(config.sites.sites.map((s) => ({ ...s })));
          }
          setDirty(false);
          setErroSalvar(null);
        }}
      />
    </div>
  );
}
