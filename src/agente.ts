import OpenAI from 'openai';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { customTools, ehToolCustomizada, criarExecutorDeTools } from './tools.js';
import { podarHistorico, compactarHistorico, type HistoricoChat } from './historico.js';
import { log } from './logger.js';
import { classificarErroAPI, calcularBackoffRateLimit, MAX_TENTATIVAS, MAX_RATE_LIMIT_CONSECUTIVOS } from './erros.js';
import { notificarErro, enviarTelegram } from './notificacoes.js';
import { registrarUsoTokens, obterCustoTotal } from './token-tracker.js';
import { perfilParaSystemPrompt } from './anonimizacao.js';
import type { AgenteConfig, Perfil, SitesConfig } from './types.js';
import { camposOpenRouter, ehOpenRouter } from './openrouter.js';

/** Mascara qualquer URL em texto livre antes de ir para o log. */
export function mascararTexto(texto: string): string {
  return texto
    .replace(/https?:\/\/\S+/gi, '[URL]')
    .replace(/\burl:[^\s,;)]+/gi, '[URL]');
}

/** Redige URLs e blobs antes de escrever args de tool no log. */
function redigirArgs(args: Record<string, unknown>): Record<string, unknown> {
  const copia: Record<string, unknown> = { ...args };
  for (const chave of Object.keys(copia)) {
    const valor = copia[chave];
    if (typeof valor !== 'string') continue;
    if (/base64|screenshot/i.test(chave)) copia[chave] = '<redigido>';
    // NUNCA usar chaveVaga aqui: o LLM lê este log e copiava `url:host/...`
    // como argumento de browser_navigate (navegações ERR_ABORTED na run de 24/11).
    else if (/url/i.test(chave)) copia[chave] = '[URL]';
  }
  return copia;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Teto de iterações do loop agora é configurável (AgenteConfig.maxIteracoes,
// via MAX_ITERACOES no .env ou campo na UI do control server). Este valor é só
// o fallback quando a config não vier preenchida.
const MAX_ITERACOES_PADRAO = 100;

/** Resolve o teto de iteracoes: valor da config saneado, com fallback seguro. */
function obterMaxIteracoes(config: AgenteConfig): number {
  const v = Number(config.maxIteracoes);
  if (!Number.isFinite(v) || v < 1) return MAX_ITERACOES_PADRAO;
  return Math.floor(Math.min(v, 5000));
}
// Sliding window: mantém só as últimas N mensagens no histórico.
// Mensagens antigas (vagas já processadas, snapshots antigos) são descartadas
// para evitar estouro de contexto, custo excessivo e degradação de qualidade.
const MAX_HISTORICO = 30;
const RECOVERY_PATH = path.resolve(__dirname, '..', 'data', 'recovery.json');

function buildSystemPrompt(perfil: Perfil, sites: SitesConfig, config: AgenteConfig): string {
  const { limiteDiario, dryRun, scoreMinimo, metaCandidaturas } = config;
  return `
Voce e um agente inteligente de candidatura automatica a vagas de emprego.
Voce controla um navegador real (Chrome do usuario, ja logado nos sites) atraves das browser tools.
${dryRun ? '\n** MODO DRY-RUN ATIVO: faca TODO o processo normalmente (navegar, analisar, preencher formularios) mas NAO envie de verdade. O sistema BLOQUEIA o envio e JA registra a candidatura como dry-run quando voce chama confirmar_envio com todos os dados. **\n' : ''}

## Seu Objetivo
Navegar pelos sites configurados, buscar vagas relevantes e se candidatar automaticamente.

## META DA EXECUCAO (critério de encerramento)
- A meta desta execucao e registrar ${metaCandidaturas > 0 ? `${metaCandidaturas} candidatura(s) de qualidade (score >= ${scoreMinimo})` : 'o maximo de candidaturas de qualidade (score >= ' + scoreMinimo + ')'}.
- Ao atingir a meta, o SISTEMA encerra a execucao automaticamente (aviso no retorno de registrar_candidatura OU confirmar_envio). A partir dai NAO se candidate a mais nenhuma vaga.
- confirmar_envio REGISTRA a candidatura no banco no ato do clique. Passe sempre: url_vaga, plataforma, titulo_vaga, empresa e score. Depois de liberado, clique no botao final e NAO precisa chamar registrar_candidatura novamente (seria ignorado como duplicata).
- Enquanto a meta NAO for atingida, NAO PARE: continue navegando pelos sites e paginas restantes.
- TEXTO PURO NUNCA encerra a execucao. Resumo conversacional, desculpa ou "pronto, terminei" sao recusados pelo sistema — so tools avancam o trabalho.

## Fluxo de Trabalho
Para CADA site da lista:
1. Use browser_navigate para ir ate a URL de busca do site
2. Na Catho e no Indeed, use listar_vagas (devolve a lista limpa com URL direta de cada vaga). Nos demais sites, use browser_snapshot (NUNCA passe o parametro "filename")
3. Identifique as vagas listadas (na Catho/Indeed, as de status "nova")
4. Para cada vaga relevante:
   a. Use verificar_vaga_ja_vista para checar se ja analisou essa vaga antes
   b. Se ja foi vista, pule para a proxima
   c. Use verificar_ja_aplicou para checar se ja aplicou nessa URL
   d. Se ja aplicou, pule para a proxima
   e. Use contar_candidaturas_hoje para verificar se atingiu o limite (${limiteDiario})
   f. Se atingiu o limite, PARE e informe
   g. Clique na vaga, analise a descricao
   h. Inicie o processo de candidatura
   i. Use obter_perfil_candidato para obter os dados necessarios
   j. Use obter_respostas_predefinidas para consultar respostas-base para perguntas comuns
   k. Preencha o formulario usando browser_fill_form ou browser_type
   l. Use aguardar entre cada acao (2-5 segundos)

## FORMATO CORRETO DO browser_click E FERRAMENTAS DE ELEMENTO (CRITICO)
As browser tools de acao (browser_click, browser_type, browser_fill_form,
browser_hover, browser_drag, browser_select_option) pedem:
- "element": descricao humana do elemento (ex.: "Botao de candidatar")
- "ref": a REFERENCIA EXATA do snapshot — o valor dentro de [ref=...] da arvore.
  CORRETO:   ref: "e134"   (a ref literal que apareceu no browser_snapshot)
  ERRADO:    ref: "ref=e134"       (nao inclua o prefixo "ref=")
  ERRADO:    ref: "button \"Candidatar-se\""   (a descricao NAO e um seletor)
  ERRADO:    ref: "/url: /vagas/123"           (URLs nao sao alvo de click)
  ERRADO:    usar "target"                     (o argumento chama-se "ref")
Regras:
- Pegue a ref SEMPRE do snapshot MAIS RECENTE. Se a pagina mudou (navegacao,
  modal, nova pagina), faca browser_snapshot de novo antes de clicar — refs
  antigas expiram ("Ref eN not found in the snapshot").
- Resultados de browser_evaluate e de tools customizadas (ex.: listar_vagas)
  NAO contem refs. Nunca use um valor deles como ref de click.
- NUNCA chame browser_snapshot com o parametro "filename": o snapshot vai para
  o arquivo e voce NAO recebe o conteudo da pagina.
   m. ANTES de clicar no botao final de envio/submissao, SEMPRE chame confirmar_envio. Se a resposta bloquear (dry-run ou teto por execucao), NAO clique no botao — siga a instrucao da mensagem.
   n. Apos enviar (ou simular no dry-run), use salvar_screenshot para capturar prova
   o. confirmar_envio ja salva a candidatura no banco (passe plataforma, titulo_vaga, empresa e score). Chame-o ANTES do clique final; NAO precisa chamar registrar_candidatura depois.
   p. Se a vaga foi PULADA (score baixo, localizacao errada), use registrar_vaga_vista para nao reanalisar
5. Se houver botao de "proxima pagina" ou paginacao, navegue para a proxima pagina e repita os passos 3-4
6. Passe para o proximo site

## PORTAIS COM LISTA DEDICADA: Catho e Indeed (CRITICO)
Nestes dois portais a listagem e uma SPA enorme (28-34 mil caracteres, quase tudo
filtro/banner) e os cards do Indeed sao BOTOES sem href. O browser_snapshot da
listagem confunde e leva a clicar na vaga errada. Fluxo correto:

1. browser_navigate para a URL de busca
2. listar_vagas -> JSON com titulo, empresa, local, salario, avaliação da empresa quando disponível, status e a URL DIRETA
3. Para cada vaga com status "nova": browser_navigate DIRETO para a url dela
   (NAO clique em card/ref da listagem) e faca browser_snapshot na pagina da vaga
4. So use refs do snapshot da PAGINA DA VAGA. refs da listagem expiram ao navegar
5. status "ja_vista", "ja_aplicou" ou "bloqueada" -> pule sem abrir

### Catho
- A pagina da vaga (/vagas/<slug>/<id>) mostra a descricao COMPLETA sem login.
- Leia a descricao e chame pontuar_vaga. Se APLICAR, clique em "Quero me candidatar".
- Esse botao leva a login/cadastro da Catho. Se cair em login, o SISTEMA PAUSA o
  run automaticamente — nao tente preencher login e nao insista.
- O "Cadastre-se para ver todas as oportunidades" na busca e aviso de sessao
  anonima, nao um erro da pagina.

### Indeed
- Os cards da busca sao botoes sem href; use SEMPRE as URLs /viewjob?jk=... que
  listar_vagas devolve.
- Antes de pontuar ou iniciar candidatura, use verificar_avaliacao_empresa na
  pagina de detalhe. Se a avaliacao da empresa for <= 2,5, marque a vaga como
  vista/pulada e NAO se candidate. A trava de confirmar_envio tambem bloqueia
  deterministicamente qualquer envio para empresa nessa faixa.
- "Candidate-se facilmente" na vaga = candidatura simplificada no proprio Indeed.
- "Candidatar-se no site da empresa" = abrir o site da empresa e preencher la.
- Se o clique de candidatura redirecionar para secure.indeed.com/auth (login),
  o SISTEMA PAUSA o run — nao tente contornar.

### Regras que valem para os dois
- NUNCA use browser_snapshot com "filename": o conteudo da pagina NAO volta para
  voce e voce fica cego.
- Resultado de browser_evaluate NAO tem "ref": nunca use um valor dele como ref
  de browser_click. Use-o apenas como dado (titulo, url, texto).
- Prefira navegar por URL direta a clicar em cards. Card clicado abre painel
  lateral/detalhe e muda os refs da pagina inteira.

## REGRA DE PAGINACAO
- SEMPRE verifique se existe um botao de "proxima pagina", "proximo", "next", ">", ou paginacao numerada.
- Na Catho/Indeed, listar_vagas devolve "proxima_pagina" quando existe.
- Se existir, navegue para a proxima pagina apos processar todas as vagas da pagina atual.
- Continue ate: nao haver mais paginas, atingir o limite diario, ou nao encontrar mais vagas relevantes.
- Maximo de 5 paginas por site para evitar loops infinitos.

## REGRA CRITICA: NUNCA FECHE ABAS OU O NAVEGADOR
- NUNCA chame browser_close nem browser_tabs com action "close".
- O Chrome pertence ao usuario (janela real na tela dele). Fechar a ultima
  aba ENCERRA O CHROME INTEIRO e o usuario perde a janela.
- Ao terminar o fluxo, apenas informe o relatorio — deixe as abas abertas.
- Navegue sempre na MESMA aba (browser_navigate muda a URL da aba atual);
  nao abra novas abas nem troque de aba entre vagas.

## FILTRO OBRIGATORIO: pontuar_vaga
Antes de se candidatar a QUALQUER vaga, SEMPRE use a tool "pontuar_vaga" passando os dados da vaga: tecnologias_pedidas, senioridade, localizacao, modelo_trabalho e, se a vaga mencionar exigencia de ingles, idioma_exigido.
- A tool retorna: score (1-10), veredicto (APLICAR/PULAR), motivo e eliminatorios.
- Se veredicto == PULAR (por score < ${scoreMinimo} OU por qualquer eliminatorio): PULE a vaga e va para a proxima. NAO insista.
- Se veredicto == APLICAR: prossiga com a candidatura.
- A tool JA considera a cidade, os modelos de trabalho aceitos e o nivel de ingles do candidato (do perfil). Confie no veredicto dela — NAO aplique regras de localizacao manualmente. Se o perfil tiver uma "regra_localizacao" especifica, respeite-a tambem.
- Ao registrar a candidatura, inclua SEMPRE o score (o sistema recusa registros abaixo do minimo).

## Regras de Ouro para Respostas em Formularios

### VARIACAO OBRIGATORIA
- NUNCA escreva a mesma resposta duas vezes. Cada formulario deve ter respostas UNICAS.
- Varie: estrutura frasal, ordem das informacoes, sinonimos, tom (mais formal vs mais direto).
- Exemplo de variacao para "Fale sobre voce":
  * Vez 1: "Atuo como [titulo] ha [anos] anos, com foco em [stack]..."
  * Vez 2: "Minha trajetoria profissional combina [stack] com experiencia em [area]..."
  * Vez 3: "Com [anos] anos construindo solucoes em [stack], trago experiencia solida em..."

### DADOS REAIS
- Use APENAS os dados reais do candidato. Nunca invente experiencias, skills ou empresas.
- Adapte as respostas ao contexto da vaga (ex: destacar React se a vaga e frontend).

### NATURALIDADE
- Escreva como um profissional humano, nao como um bot.
- Evite cliches como "sou apaixonado por tecnologia" ou "busco novos desafios".
- Seja conciso: 2-4 frases para campos curtos, 1 paragrafo para campos longos.

## Regras de Seguranca
- ENVIO (CRITICO): antes de QUALQUER clique de envio final (candidatar-se, enviar, submeter, finalizar) ou de enviar convite/mensagem ao recrutador, SEMPRE chame confirmar_envio primeiro — com url_vaga, plataforma, titulo_vaga, empresa e score. O sistema decide se libera e JA grava a candidatura. NUNCA clique no botao final sem passar por confirmar_envio.
- Se encontrar CAPTCHA ou desafio anti-bot: use resolver_captcha_telegram para pedir resolucao MANUAL do humano. (reCAPTCHA/Turnstile NAO tem "solucao de texto" para digitar — quem resolve e o humano, no proprio Chrome aberto.)
  1. Tire screenshot com browser_take_screenshot
  2. Chame resolver_captcha_telegram passando o base64 e a URL (o humano resolve no Chrome e responde OK ou PULAR)
  3. Se status == RESOLVIDO: use browser_snapshot para REVERIFICAR a pagina e, se o desafio sumiu, continue a candidatura
  4. Se status == PULAR ou TIMEOUT: use reportar_falha com codigo "captcha" (ou "portal_bloqueado" se o bloqueio foi na pagina de busca) para pular
  5. Se Telegram NAO estiver configurado: use reportar_falha com codigo "captcha"/"portal_bloqueado"
- Se encontrar pagina de login: NAO preencha nada. O sistema detecta e PAUSA o run automaticamente para o usuario logar no Chrome do bot. Só use reportar_falha com codigo "sessao_expirada" se a pausa automatica estiver desligada (PAUSAR_EM_LOGIN=false)
- Se um formulario pedir informacao que voce NAO tem no perfil: pule o campo ou use "A combinar"
- NUNCA insira dados falsos ou inventados
- Aguarde SEMPRE entre acoes (tool aguardar) para simular comportamento humano

## PAGINA DE LOGIN = PEDIDO DE AJUDA HUMANA (IMPORTANTE)
Se o navegador cair numa pagina de login/cadastro ("Sign in", "Log in", "Entrar",
"Cadastre-se", "Crie sua conta", "secure.indeed.com/auth"):
- NAO tente preencher formulario de login, NAO clique em campos de usuario/senha.
- O sistema detecta login em QUALQUER portal (inclusive Catho/Indeed, que so
  pedem conta na hora de candidatar) e PAUSA o run automaticamente: o usuario
  recebe aviso na UI/Telegram, loga manualmente no Chrome do bot e clica RETOMAR.
- Enquanto pausado, apenas aguarde. NAO fique navegando nem tentando contornar.
- Só use reportar_falha com codigo "sessao_expirada" se a pausa automatica
  estiver desligada (PAUSAR_EM_LOGIN=false) — nesse caso pule o site.

## TOLERANCIA A ERROS DE SELETOR (ANTI-LOOP — LEIA COM ATENCAO)
Erros de seletor/elemento ("ERRO_TOOL", "selector", "locator", "element not found",
"strict mode violation", "not visible", "not attached") significam que a pagina mudou
ou a referencia expirou. Regras duras:
- NUNCA repita a mesma chamada com os mesmos argumentos apos um erro de seletor.
- Ordem de reacao: (1) use browser_snapshot para REVER a pagina e obter referencias
  atualizadas; (2) tente uma estrategia diferente (outro ref/seletor, scroll antes,
  aguardar o carregamento); (3) se falhar 2x no MESMO elemento, DESISTA dele —
  use reportar_falha (codigo "elemento_nao_encontrado") e avance para a proxima
  vaga/acao. Ficar retentando o mesmo elemento queima a cota de requisicoes sem
  nenhum progresso e pode travar a execucao inteira.
- Se varios elementos da mesma pagina falharem em sequencia, a pagina provavelmente
  nao carregou: use browser_navigate para recarregar ou volte para a listagem.

## Regras de Screenshot (IMPORTANTE)
- APOS cada candidatura (enviada ou simulada no dry-run), use browser_take_screenshot para capturar a tela.
- Em seguida, use salvar_screenshot passando o base64, a URL da vaga e o nome da empresa.
- Isso serve como prova de que a candidatura foi feita.

## Respostas Pre-Definidas (IMPORTANTE)
- Use obter_respostas_predefinidas no INICIO da execucao para carregar as respostas-base.
- Para perguntas comuns (pretensao salarial, disponibilidade, pontos fortes, etc.), use essas respostas como BASE.
- VARIE a forma de escrever (sinonimos, estrutura frasal), mas mantenha o conteudo fiel.
- Se o formulario pedir algo que NAO esta nas respostas pre-definidas, use os dados do perfil do candidato.

## Cache de Respostas (ECONOMIZA TOKENS)
Para CADA campo de formulario, siga esta ordem:
1. Use buscar_resposta_cache passando o texto da pergunta e o tipo do campo.
2. Se retornar cache HIT: use a resposta cacheada (pode variar levemente).
3. Se retornar candidatas: verifique se alguma e semanticamente equivalente. Se sim, reutilize.
4. Se cache MISS: gere a resposta normalmente e depois use salvar_resposta_cache para guardar.
- NAO salve no cache: cover letters, respostas que mencionam o nome da empresa, campos de data.
- O cache persiste entre execucoes — quanto mais usar, mais rapido fica.

## Carta de Apresentacao / Cover Letter (IMPORTANTE)
- Se o formulario tiver campo de "carta de apresentacao", "cover letter", "por que voce quer trabalhar aqui" (campo de texto longo), ou "apresente-se":
  - Use gerar_cover_letter passando a descricao da vaga, titulo e empresa.
  - A tool retorna texto personalizado pronto para colar no campo.
  - O texto usa APENAS dados reais do candidato.
- Para campos CURTOS (1-2 linhas), NAO use a cover letter — responda diretamente com base no perfil.

## Filtro de Vagas Ja Vistas
- SEMPRE use verificar_vaga_ja_vista ANTES de analisar uma vaga em detalhe.
- Se a vaga ja foi vista (mesmo que nao tenha sido aplicada), PULE para a proxima.
- Ao PULAR uma vaga (por qualquer motivo), use registrar_vaga_vista para marcar como vista.
- Isso economiza tempo evitando reanalisar vagas ja descartadas em execucoes anteriores.

## Regras de Upload de Curriculo (IMPORTANTE)
O sistema gera um curriculo PERSONALIZADO para cada vaga usando IA.
- ANTES de fazer upload, SEMPRE tente usar "gerar_curriculo_tailored" passando a descricao COMPLETA da vaga.
  - Copie o maximo de detalhes da vaga (requisitos, responsabilidades, tecnologias) para o campo descricao_vaga.
  - A tool gera um PDF otimizado para ATS destacando as skills relevantes para AQUELA vaga.
  - O curriculo so usa dados REAIS do candidato — nunca inventa skills.
- Se gerar_curriculo_tailored FALHAR, use "escolher_curriculo" como fallback (seleciona entre curriculos pre-prontos).
- Use browser_upload_file com o caminho retornado pela tool.
- Se browser_upload_file nao estiver disponivel, informe o caminho para upload manual.

## Dados do Candidato (PII de contato omitido — use obter_perfil_candidato para email, telefone, links)
${JSON.stringify(perfilParaSystemPrompt(perfil), null, 2)}

## Sites para Processar
${JSON.stringify(sites.sites.filter(s => s.ativo), null, 2)}

## Mensagem para Recrutadores (LinkedIn)
APOS se candidatar a uma vaga com score ALTO (>= 8) no LinkedIn, tente contatar o recrutador/hiring manager:

### Quando enviar:
- SOMENTE para vagas com score >= 8 (alta compatibilidade)
- SOMENTE no LinkedIn (onde e possivel ver o recrutador)
- MAXIMO 5 mensagens por dia (a tool controla automaticamente)
- NUNCA enviar para o mesmo recrutador duas vezes

### Como encontrar o recrutador:
1. Na pagina da vaga no LinkedIn, procure "Quem publicou" ou nome do recrutador
2. Se nao aparecer na vaga, procure na pagina da empresa por cargos como "Recruiter", "HR", "Talent Acquisition"
3. Se nao encontrar ninguem, PULE — nao perca tempo buscando

### Fluxo de envio:
1. Use verificar_recrutador_ja_contatado com a URL do perfil
2. Se JA_CONTATADO: pule
3. Use gerar_mensagem_recrutador passando os dados da vaga e do recrutador
4. Navegue ate o perfil do recrutador no LinkedIn
5. Clique em "Conectar" → "Adicionar nota"
6. Cole o texto com browser_type
7. ANTES de clicar em "Enviar", chame confirmar_envio (acao: "mensagem ao recrutador"). Se bloquear (dry-run ou teto), NAO envie o convite e siga.
8. Clique em "Enviar"
9. Use registrar_mensagem_recrutador para salvar no banco

### Prioridade:
- A candidatura TEM PRIORIDADE sobre a mensagem ao recrutador
- Se o tempo estiver curto ou o limite diario de candidaturas proximo, PULE a mensagem
- A mensagem e um BONUS, nao uma obrigacao

## Classificacao de Falhas (IMPORTANTE)
Quando encontrar um problema durante a candidatura, use a tool "reportar_falha" com o codigo apropriado.
O sistema classifica automaticamente e decide se deve pular ou retentar.

### Falhas PERMANENTES (nunca retentar):
- vaga_expirada: A vaga nao esta mais disponivel
- captcha: CAPTCHA detectado na pagina
- sessao_expirada: Sessao expirou, precisa relogar
- localizacao_inelegivel: Vaga presencial/hibrida fora da regra de localizacao do candidato
- ja_aplicou: Candidato ja se candidatou (detectado pelo site, nao pelo banco)
- conta_necessaria: Exige cadastro em plataforma especifica
- nao_e_vaga: A pagina nao e uma vaga de emprego
- sso_obrigatorio: Requer login SSO (Google, Microsoft)
- site_bloqueado: Site bloqueou o acesso
- cloudflare: Protecao anti-bot ativa
- portal_bloqueado: Bloqueio (Cloudflare/CAPTCHA/login) na PAGINA DE BUSCA/LISTAGEM, antes de ver as vagas. O sistema ABANDONA o portal inteiro e voce vai para o proximo site — NAO insista em outras URLs/paginas deste portal. (Se o bloqueio for numa vaga especifica, use o codigo especifico como captcha.)
- formulario_incompativel: Formulario que voce nao consegue preencher
- vaga_interna: Exclusiva para funcionarios
- idioma_incompativel: Exige idioma que o candidato nao tem

### Falhas RETRIAVEIS (tente novamente, max ${MAX_TENTATIVAS}x):
- timeout: Pagina demorou para carregar
- erro_rede: Erro de conexao
- pagina_nao_carregou: Pagina carregou incompleta
- erro_servidor: Erro 500/502/503 do site
- elemento_nao_encontrado: Botao ou campo sumiu da pagina
- erro_upload: Falha ao enviar curriculo/arquivo
- erro_mcp: Erro de comunicacao com o navegador

### Como usar:
1. Encontrou problema → use reportar_falha com url_vaga + codigo_falha + descricao
2. Se a resposta disser PULAR → passe para a proxima vaga
3. Se a resposta disser RETENTAR → tente a mesma acao novamente (backoff ja foi aplicado)
4. NAO tente resolver falhas permanentes — pule e siga em frente

## Ao Finalizar
O run encerra por acao do SISTEMA (meta de qualidade atingida ou teto de iteracoes) — nao por texto seu. Faca o resumo final APENAS quando o sistema avisar a meta atingida no retorno de confirmar_envio (ou registrar_candidatura); inclua:
- Quantas candidaturas foram feitas
- Em quais empresas/vagas
- Se houve algum erro ou bloqueio (inclua os codigos de falha)
`;
}

// ========== CLIENT OPENAI (agnóstico a provedor) ==========

/**
 * Cria o client do LLM de navegação no padrão OpenAI SDK.
 *
 * Funciona com qualquer endpoint OpenAI-compatible — basta configurar:
 * - `AGENT_LLM_BASE_URL` (ex: https://openrouter.ai/api/v1, https://api.openai.com/v1, http://localhost:11434/v1)
 * - `AGENT_LLM_API_KEY` (chave do provedor; Ollama local aceita qualquer valor)
 * - `AGENT_LLM_MODEL` (ex: deepseek/deepseek-v4-flash-0731, google/gemini-2.0-flash-001, gpt-4o-mini, llama3.1)
 */
export function criarClientAgente(config: AgenteConfig): OpenAI {
  const baseURL = config.agentLlmBaseUrl || 'https://openrouter.ai/api/v1';
  // OpenRouter recomenda identificar o app — inofensivo para outros provedores.
  const defaultHeaders = ehOpenRouter(baseURL)
    ? { 'HTTP-Referer': 'https://github.com/MiguelDK17/office-boy', 'X-Title': 'officeboy' }
    : undefined;
  return new OpenAI({
    baseURL,
    apiKey: config.agentLlmApiKey,
    ...(defaultHeaders ? { defaultHeaders } : {}),
  });
}

// ========== CONVERSÃO DE TOOLS MCP → OPENAI ==========

/** Formato mínimo esperado de uma tool listada via MCP. */
export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

/**
 * Converte uma tool do Playwright MCP para `ChatCompletionTool` do OpenAI.
 * O `inputSchema` do MCP já é JSON Schema — é repassado intacto como
 * `parameters`, preservando o payload/contrato original da tool.
 */
export function converterMcpToolParaOpenAI(
  tool: McpToolInfo,
): OpenAI.Chat.Completions.ChatCompletionTool {
  const parameters =
    tool.inputSchema && typeof tool.inputSchema === 'object'
      ? (tool.inputSchema as Record<string, unknown>)
      : { type: 'object', properties: {} };
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description ?? '',
      parameters,
    },
  };
}

/**
 * Tools MCP que fecham aba/navegador — BLOQUEADAS de propósito.
 *
 * O Chrome é do USUÁRIO (anexado via CDP, janela real na tela). Quando o
 * agente fecha a última aba (`browser_close` ou `browser_tabs` com
 * action "close"), o Chrome sai INTEIRO — exit 0, sem crash. Isso matou
 * o navegador 3x no fim de runs (o modelo "arruma a casa" ao terminar e
 * fecha a própria janela). O agente não tem por que fechar abas: deixamos
 * todas abertas e a limpeza é feita por nós no fim do run (limparAbasCDP).
 */
export const TOOLS_MCP_BLOQUEADAS: ReadonlySet<string> = new Set([
  'browser_close',
  'browser_tabs',
]);

/**
 * Monta o array completo de `tools` no padrão oficial OpenAI
 * (`{ type: "function", ... }`): tools do navegador (MCP) + tools
 * customizadas do bot. É este array que vai em
 * `openai.chat.completions.create({ tools })`.
 */
export function montarToolsAgente(
  mcpTools: McpToolInfo[],
): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return [
    ...mcpTools.filter(t => !TOOLS_MCP_BLOQUEADAS.has(t.name)).map(converterMcpToolParaOpenAI),
    ...customTools,
  ];
}

// ========== RESILIÊNCIA A ERROS DE SELETOR ==========

const PADRAO_ERRO_SELETOR =
  /selector|seletor|locator|strict mode|element.{0,30}not found|no.{0,20}element found|elemento n[aã]o encontrado|invalid selector|not attached|not visible|outside of the viewport/i;

// Página de login + extração de texto MCP: movidos para src/sessao.ts
// (módulo de sessão — guard com verificação + health check pré-run).
// Re-exportados aqui para manter os imports existentes (e testes) funcionando.
export { ehPaginaDeLogin, exigeLoginParaCandidatar, extrairTextoMcp, construirAvisoVerificacaoLogin } from './sessao.js';
import { ehPaginaDeLogin, exigeLoginParaCandidatar, extrairTextoMcp, construirAvisoVerificacaoLogin } from './sessao.js';

/**
 * Detecta se o resultado de uma tool indica falha de seletor/CSS ou elemento
 * não encontrado — o caso que mais causava loops infinitos de retentativa
 * (queimando a cota diária em minutos). Usado para anexar orientação de
 * recuperação ao resultado reinjetado no histórico.
 */
export function ehErroDeSeletor(texto: string): boolean {
  return PADRAO_ERRO_SELETOR.test(texto);
}

// ========== PARADA SUAVE (stop cooperativo) ==========
//
// O control server envia SIGTERM ao processo quando o usuário pede "Parar
// bot". Em vez de morrer no meio de uma iteração (com tool calls em
// andamento, formulário preenchido pela metade etc.), o handler em
// src/index.ts marca a parada aqui e o loop do agente encerra na PRÓXIMA
// fronteira de iteração — a iteração atual termina por completo (chamada LLM
// + tools + compactação de histórico) e sai pelo caminho normal (recovery
// salvo, banco fechado, notificações enviadas).
let paradaSolicitada = false;

/** Marca a execução para parar na próxima fronteira de iteração (stop suave). */
export function solicitarParadaAgente(): void {
  paradaSolicitada = true;
}

/** Indica se já foi pedida a parada suave (uso do handler de sinais). */
export function paradaAgenteSolicitada(): boolean {
  return paradaSolicitada;
}

// Pausa real: o processo fica VIVO e o loop aguarda entre iterações — o
// navegador e a sessão são preservados, e o botão "Retomar" faz o run
// continuar de onde parou (sem recomeçar). Também só efetiva na fronteira de
// iteração, como a parada suave.
let pausaAtiva = false;

/** Coloca a run em pausa na próxima fronteira de iteração. */
export function solicitarPausaAgente(): void {
  pausaAtiva = true;
}

/** Retoma a run pausada na próxima fronteira de iteração. */
export function retomarAgente(): void {
  pausaAtiva = false;
}

/** Indica se a run está (ou será) pausada. */
export function pausaAgenteAtiva(): boolean {
  return pausaAtiva;
}

export async function executarAgente(
  mcpClient: Client,
  perfil: Perfil,
  sites: SitesConfig,
  config: AgenteConfig,
  sitesBloqueados: string[] = [],
): Promise<string> {
  const client = criarClientAgente(config);
  // Sinalizador que o executor de tools seta quando a meta de qualidade é
  // atingida — o loop checa em cada fronteira de iteração (100% determinístico).
  const sinais = { metaAtingida: false };

  // Sites cuja sessão morreu no health check não entram na rodada: abrir a
  // busca e descobrir no botão "Enviar" que exige login queima dezenas de
  // iterações (foi o que aconteceu com Indeed/Catho). O filtro precisa vir
  // ANTES do prompt — se os sites bloqueados aparecerem na lista, o LLM
  // navega até eles de qualquer jeito.
  const bloqueados = new Set(sitesBloqueados.map(n => n.toLowerCase()));
  const sitesAtivos = sites.sites.filter(s => s.ativo && !bloqueados.has(s.nome.toLowerCase()));
  if (sitesAtivos.length === 0) {
    return 'Nenhum site ativo com sessão válida. Faça login manual no Chrome do bot e tente novamente.';
  }
  if (bloqueados.size > 0) {
    log('AGENTE', `Sites ignorados (sessão inválida): ${[...bloqueados].join(', ')}`);
  }
  const systemPrompt = buildSystemPrompt(perfil, { ...sites, sites: sitesAtivos }, config);
  // Mesma lista em forma de domínio para a barreira determinística do executor.
  const dominiosBloqueados = sites.sites
    .filter(s => bloqueados.has(s.nome.toLowerCase()) && s.urls_busca.length > 0)
    .map(s => {
      try { return new URL(s.urls_busca[0]).hostname.toLowerCase(); } catch { return ''; }
    })
    .filter(Boolean);
  const executarTool = criarExecutorDeTools(perfil, config, sinais, dominiosBloqueados);

  log('AGENTE', `Iniciando com ${sitesAtivos.length} site(s) ativo(s)`);
  log('AGENTE', `Limite diario: ${config.limiteDiario} candidaturas`);
  log('AGENTE', `Limites de iteracao: ${obterMaxIteracoes(config)} (custo max: ${config.custoMaxUsd > 0 ? `$${config.custoMaxUsd.toFixed(2)}` : 'off'})`);
  log('AGENTE', `Meta de qualidade: ${config.metaCandidaturas > 0 ? `${config.metaCandidaturas} candidatura(s) — encerra o run com sucesso` : 'off (só teto/custo encerram)'}`);
  log('AGENTE', `LLM: ${config.agentLlmModel} via ${config.agentLlmBaseUrl}`);

  // Descobre as tools do Playwright MCP UMA vez e converte para o padrão
  // OpenAI — o loop abaixo só despacha tool_calls contra este array.
  const { tools: mcpTools } = await mcpClient.listTools();
  const tools = montarToolsAgente(mcpTools as McpToolInfo[]);
  log('AGENTE', `${mcpTools.length} tool(s) MCP + ${customTools.length} customizada(s)`);

  // Historico de mensagens para manter contexto entre iteracoes.
  // É `let` porque o sliding window (podarHistorico) substitui o array por uma
  // versão podada e válida quando ele cresce demais.
  let history: HistoricoChat = [
    { role: 'system', content: systemPrompt },
  ];

  // Tentar restaurar estado de uma execucao anterior interrompida.
  // Não reidratamos o histórico bruto (snapshots antigos não ajudam e poderiam
  // quebrar o pareamento de tool calls); em vez disso, avisamos o agente de
  // que houve interrupção. O dedup real vem do banco (vagas_vistas/candidaturas).
  const estadoRecuperado = carregarRecovery();
  let avisoRecovery = '';
  if (estadoRecuperado) {
    log('AGENTE', `Estado anterior encontrado: ${estadoRecuperado.iteracao} iteracao(oes), ultimo site: ${estadoRecuperado.ultimoSite}`);
    avisoRecovery = `\n\nATENCAO: uma execucao anterior foi interrompida (ultimo site: ${estadoRecuperado.ultimoSite}). As vagas ja vistas/aplicadas estao registradas no banco e serao puladas — use verificar_vaga_ja_vista e verificar_ja_aplicou normalmente para continuar de onde parou.`;
  }

  // Mensagem inicial que dispara o agente
  const mensagemInicial = (`
Inicie o processo de candidatura. Comece pelo primeiro site da lista.
Lembre-se: use aguardar entre cada acao, verifique duplicatas, e varie as respostas.
` + avisoRecovery).trim();

  history.push({ role: 'user', content: mensagemInicial });

  // Assinatura (tool+args) → nº de falhas de seletor consecutivas. Evita que o
  // modelo queime a cota retentando o mesmo elemento indefinidamente.
  const falhasSeletor = new Map<string, number>();
  // Mesma ideia, mas para QUALQUER chamada repetida sem efeito (o modelo
  // reexecutando a mesma tool com os mesmos argumentos em sequência).
  const chamadasRepetidas = new Map<string, number>();
  // Quantas vezes o navegador devolveu página de login nesta execução.
  let paginasLogin = 0;
  // Última URL pedida via browser_navigate — é para ela que o guard de login
  // manda o agente voltar ao verificar a sessão (bounce de SSO vs. sessão morta).
  let ultimaUrlNavegada: string | null = null;

  let iteracao = 0;
  let respostaFinal = '';
  let errosConsecutivos = 0;
  let saiuComErroFatal = false;
  let anunciouPausa = false;

  const maxIter = obterMaxIteracoes(config);

  // GUARDA ANTI-ABANDONO: modelos fracos (vários free no OpenRouter) encerram
  // o run no meio respondendo só-texto — às vezes com texto degenerado em
  // loop ("vou tentar novamente" ×9), às vezes com uma resposta de chat
  // off-topic ("não posso ajudar com carreira..."). O fusível antigo aceitava
  // a desistência como "resposta final" após N nudges — isso ENCERRAVA o run
  // por texto, que é justamente o que não pode. Texto NUNCA encerra o run:
  // toda resposta só-texto é recusada com um aviso `user` e o loop continua.
  // Os únicos encerramentos válidos são determinísticos: meta de qualidade,
  // teto de iterações, custo máximo, erro fatal ou parada/pausa do usuário.
  let nudgesAbandono = 0;

  while (iteracao < maxIter) {
    // Pausa real: aguarda aqui, com o processo vivo (navegador/sessão
    // preservados), até a retomada — ou até um stop chegar, que tem
    // precedência. Efetiva na fronteira da iteração: a atual termina
    // por completo antes de o loop entrar em espera.
    if (pausaAgenteAtiva() && !paradaSolicitada) {
      if (!anunciouPausa) {
        log('AGENTE', `Run pausada (apos ${iteracao} iteracoes). Aguardando retomada...`);
        anunciouPausa = true;
      }
      await new Promise(resolve => setTimeout(resolve, 500));
      continue;
    }
    if (anunciouPausa) {
      anunciouPausa = false;
      log('AGENTE', 'Run retomada.');
    }

    // Stop suave: chegou pedido de parada? Encerra ANTES de abrir a próxima
    // iteração — a anterior terminou por completo, então o recovery deste
    // ponto está atualizado. `saiuComErroFatal` reutilizado de propósito:
    // o efeito desejado é o mesmo (preservar o recovery, sem limpá-lo).
    if (paradaSolicitada) {
      log('AGENTE', `Parada suave solicitada (SIGTERM). Finalizando apos ${iteracao} iteracao(oes) — o progresso foi salvo.`);
      salvarRecovery(iteracao, sitesAtivos.map(s => s.nome));
      respostaFinal = `Execucao interrompida a pedido do usuario (parada suave) apos ${iteracao} iteracao(oes). As vagas ja vistas/aplicadas estao no banco e serao puladas na proxima execucao.`;
      saiuComErroFatal = true;
      break;
    }

    iteracao++;
    log('AGENTE', `Iteracao ${iteracao}/${maxIter}`);

    try {
      const requestBody = {
        model: config.agentLlmModel,
        messages: history,
        tools,
        tool_choice: 'auto',
      } as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;
      // O SDK Node não suporta `extra_body` como o SDK Python. Passamos o
      // body final por RequestOptions para que `provider` fique no nível raiz
      // do JSON enviado ao OpenRouter.
      const completion = await client.chat.completions.create(
        requestBody,
        ehOpenRouter(config.agentLlmBaseUrl)
          ? { body: { ...requestBody, ...camposOpenRouter(config.agentLlmBaseUrl, 'price', config.openRouterSessionId) } }
          : undefined,
      );

      // Reset do contador — iteração bem sucedida
      errosConsecutivos = 0;

      // Registra uso de tokens desta chamada (usage OpenAI → formato interno).
      // Inclui cached_tokens do provedor (ex.: prompt caching do OpenRouter):
      // sem isso, tokens cacheados (bem mais baratos) eram precificados a
      // preço cheio e o custo estimado ficava inflado.
      // CUSTO DINÂMICO: o OpenRouter devolve em `usage.cost` o valor EXATO
      // cobrado naquela execution — quando presente, ele é usado no lugar da
      // tabela estática (que vira fallback só para provedores que não
      // reportam custo). Comparação com `number` (e não truthiness) para não
      // descartar custo 0 (modelos gratuitos).
      const usage = completion.usage;
      if (usage) {
        const custoReal = (usage as unknown as { cost?: unknown }).cost;
        registrarUsoTokens(
          config.agentLlmModel,
          {
            promptTokenCount: usage.prompt_tokens,
            candidatesTokenCount: usage.completion_tokens,
            totalTokenCount: usage.total_tokens,
            cachedContentTokenCount: usage.prompt_tokens_details?.cached_tokens ?? 0,
          },
          'agente',
          typeof custoReal === 'number' ? custoReal : undefined,
        );
      }

      // Circuito de parada por custo: limite economico complementar ao
      // MAX_ITERACOES (so ativo se CUSTO_MAX_USD > 0). Evita queimar dezenas de
      // chamadas caras num loop improdutivo. Limite soft (avaliado entre iteracoes).
      if (config.custoMaxUsd > 0 && obterCustoTotal() > config.custoMaxUsd) {
        log('AGENTE', `Custo maximo atingido ($${obterCustoTotal().toFixed(4)} > $${config.custoMaxUsd} USD). Finalizando.`);
        respostaFinal = `Execucao interrompida: custo maximo de $${config.custoMaxUsd} USD atingido.`;
        break;
      }

      const message = completion.choices[0]?.message;
      if (!message) {
        log('AGENTE', 'Resposta vazia do modelo. Finalizando.');
        break;
      }

      // Adiciona resposta do modelo ao historico (preservando tool_calls)
      history.push({
        role: 'assistant',
        content: message.content,
        ...(message.tool_calls && message.tool_calls.length > 0
          ? { tool_calls: message.tool_calls }
          : {}),
      } as OpenAI.Chat.Completions.ChatCompletionMessageParam);

      // Verifica se tem tool calls — resposta só-texto NÃO trava a máquina de
      // estados: encerra normalmente como resposta final do modelo.
      // (Filtra por type === 'function': o SDK também tipa custom tool calls.)
      const toolCalls = (message.tool_calls ?? []).filter(
        (
          tc,
        ): tc is OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall =>
          tc.type === 'function',
      );

      if (!toolCalls || toolCalls.length === 0) {
        // Sem tool calls = modelo respondeu só texto. NUNCA encerra o run:
        // desistência, papo off-topic ou resumo prematuro são recusados e o
        // controle volta ao modelo com um aviso `user`. Cada recusa consome
        // uma iteração do teto, então um modelo biruto queima iterações/custo
        // até os backstops — nunca "vence" o run por desistência.
        nudgesAbandono++;
        const textoModelo = message.content || '';
        log('AGENTE', `Guarda anti-abandono (nudge ${nudgesAbandono}): resposta so-texto na iteracao ${iteracao}. Recusando — texto NAO encerra o run.`);
        log('AGENTE', `Texto recusado:\n${textoModelo.substring(0, 400)}`);
        history.push({
          role: 'user',
          content:
            'AVISO_DO_SISTEMA: voce respondeu APENAS TEXTO, sem nenhuma tool call. A execucao NAO terminou — ainda ha vagas e sites a processar. ' +
            'Respostas conversacionais, desculpas, planos ("vou tentar novamente...") ou resumos NAO encerram o run. ' +
            'Use as tools agora (browser_navigate, browser_snapshot, verificar_vaga_ja_vista, pontuar_vaga, fluxo de candidatura etc.) e continue o trabalho. ' +
            'A execucao so encerra quando a meta de candidaturas de qualidade for atingida (o sistema avisa no retorno de registrar_candidatura) ' +
            'ou pelo teto de iteracoes — em ambos os casos, por acao do sistema, NAO por texto seu. Continue trabalhando.',
        });
        continue;
      }

      // Processa as tool calls SEQUENCIALMENTE.
      // As tools do Playwright MCP (browser_*) operam no MESMO navegador/aba;
      // executá-las em paralelo causaria race conditions (navegar enquanto digita,
      // screenshot de página meio-carregada, elemento sumindo do DOM). A ordem
      // também importa no preenchimento de formulários. O custo de serializar é
      // desprezível perto do risco de estados intercalados.
      log('AGENTE', `Executando ${toolCalls.length} tool(s) em sequencia...`);

      for (const tc of toolCalls) {
        const toolName = tc.function.name ?? 'unknown';
        let toolArgs: Record<string, unknown> = {};
        try {
          toolArgs = JSON.parse(tc.function.arguments || '{}') as Record<string, unknown>;
        } catch {
          log('ERRO', `Argumentos invalidos para ${toolName}: ${mascararTexto((tc.function.arguments || '').substring(0, 100))}`);
        }
        // Barreira determinística: browser_snapshot com "filename" grava o
        // snapshot em arquivo e devolve SÓ o caminho — o modelo fica cego para
        // a página (aconteceu na run de 24/11, na Catho). O parâmetro é
        // removido e o conteúdo continua voltando no resultado da tool.
        let avisoTool = '';
        if (toolName === 'browser_snapshot' && typeof toolArgs.filename === 'string') {
          delete toolArgs.filename;
          avisoTool =
            '\n\nAVISO_DO_SISTEMA: o parametro "filename" foi IGNORADO de proposito. ' +
            'O snapshot precisa voltar no resultado para voce enxergar a pagina. ' +
            'Use browser_snapshot SEM filename.';
        }

        log('TOOL', `${toolName}(${JSON.stringify(redigirArgs(toolArgs)).substring(0, 100)}...)`);

        // Rastreia a última URL pedida — o guard de login usa para mandar o
        // agente voltar exatamente à página que estava processando.
        if (toolName === 'browser_navigate' && typeof toolArgs.url === 'string') {
          ultimaUrlNavegada = toolArgs.url;
        }

        let resultado: string;

        // try/catch por tool: uma tool que lança NÃO derruba as demais nem o
        // agente — vira um resultado de erro que o modelo consegue tratar.
        try {
          if (TOOLS_MCP_BLOQUEADAS.has(toolName)) {
            // O modelo pode alucinar uma tool bloqueada (nem está no array de
            // tools que ele recebe). Responde com orientação em vez de executar:
            // fechar aba/navegador encerraria o Chrome do usuário (janela real).
            resultado =
              'Tool bloqueada: este agente NAO fecha abas nem o navegador (browser_close/browser_tabs). ' +
              'Deixe as abas abertas e siga o fluxo — para trocar de pagina use browser_navigate na mesma aba.';
            log('AGENTE', `Tool ${toolName} bloqueada (protecao do Chrome do usuario)`);
          } else if (ehToolCustomizada(toolName)) {
            resultado = await executarTool(toolName, toolArgs);
          } else {
            // Tool do Playwright MCP — executa via mcpClient
            const mcpResult = await mcpClient.callTool({
              name: toolName,
              arguments: toolArgs,
            });

            const content = (mcpResult as { content?: unknown }).content;
            resultado = extrairTextoMcp(content);
          }
        } catch (toolError) {
          resultado = `ERRO_TOOL: ${toolError instanceof Error ? toolError.message : String(toolError)}`;
          log('ERRO', `Tool ${toolName} falhou: ${mascararTexto(resultado)}`);
        }

        if (avisoTool) resultado += avisoTool;
        log('TOOL', `Resultado: ${mascararTexto(resultado.substring(0, 150))}...`);

        // Guarda anti-loop genérica: a MESMA chamada repetida não traz
        // progresso e só queima cota. A partir da 3ª repetição, o aviso entra
        // no resultado para o modelo avançar.
        const assinatura = `${toolName}:${JSON.stringify(toolArgs).substring(0, 120)}`;
        const repeticoes = (chamadasRepetidas.get(assinatura) || 0) + 1;
        chamadasRepetidas.set(assinatura, repeticoes);
        if (repeticoes >= 3) {
          resultado +=
            `\n\nAVISO_DO_SISTEMA: esta chamada ja foi repetida ${repeticoes}x sem resultado. ` +
            `NAO repita. Avance para a proxima acao, vaga ou site.`;
        }

        // Sessão expirada / nunca logado: o navegador caiu numa página de
        // login. Guard determinístico com VERIFICAÇÃO: em vez de mandar o
        // modelo desistir na hora (ele pulava vagas que só precisavam do
        // bounce automático de SSO — ex.: redirect signin → vaga da Gupy),
        // pede o teste: re-navegar a URL alvo; só reporta `sessao_expirada`
        // se cair no login DE NOVO. A partir de 3 páginas de login seguidas,
        // a sessão é considerada quebrada e o aviso manda pular direto.
        // Site inferido da última URL navegada para o detector de login
        // "silencioso" (Catho/Indeed abrem a busca sem login e só exigem conta
        // ao candidatar-se — ehPaginaDeLogin não pega esse caso).
        let siteAtual = '';
        try {
          const host = new URL(ultimaUrlNavegada ?? 'http://localhost').hostname.toLowerCase();
          const candidato = sitesAtivos.find(s =>
            s.urls_busca.some(u => {
              try { return new URL(u).hostname.toLowerCase() === host; } catch { return false; }
            }),
          );
          siteAtual = candidato?.nome ?? host;
        } catch { /* sem URL navegada ainda */ }

        const loginDetectado = ehPaginaDeLogin(resultado)
          || exigeLoginParaCandidatar(siteAtual, resultado);
        if (loginDetectado) {
          paginasLogin++;
          resultado += construirAvisoVerificacaoLogin(ultimaUrlNavegada, paginasLogin);

          // PAUSA AUTOMÁTICA NO LOGIN: os portais deslogam o perfil para frear
          // automação — iterar contra o muro só queima cota (LLM e risco de
          // banimento). Em vez disso, a run PAUSA na fronteira desta iteração
          // (processo vivo, navegador/sessão preservados), a UI toca o som e
          // o Telegram avisa: o usuário loga manualmente no Chrome do bot e
          // clica "Retomar" — a sessão volta e o run continua de onde parou.
          if (config.pausarEmLogin) {
            solicitarPausaAgente();
            log('AGENTE', 'LOGIN exigido detectado — pausando o run automaticamente. Faca login no Chrome do bot e clique Retomar.');
            await enviarTelegram(
              '🟡 Página de login detectada\n' +
              'O run foi PAUSADO automaticamente (a sessão pode ter expirado).\n' +
              'Faça login manualmente no Chrome do bot e clique RETOMAR na UI.',
            );
          }
        }

        // Resiliência a seletores: se a tool falhou por seletor/elemento não
        // encontrado, anexa orientação explícita ao resultado para o modelo NÃO
        // retentar o mesmo elemento — e escala o aviso a cada repetição.
        if (ehErroDeSeletor(resultado)) {
          const assinaturaSeletor = `${toolName}:${JSON.stringify(toolArgs).substring(0, 120)}`;
          const repeticoesSeletor = (falhasSeletor.get(assinaturaSeletor) || 0) + 1;
          falhasSeletor.set(assinaturaSeletor, repeticoesSeletor);
          resultado +=
            `\n\nAVISO_DO_SISTEMA: esta acao falhou por seletor/elemento nao encontrado (${repeticoesSeletor}x). ` +
            `NAO repita a mesma chamada. Use browser_snapshot para obter referencias atualizadas e tente outra estrategia. ` +
            `Se falhar de novo, use reportar_falha (codigo "elemento_nao_encontrado") e avance para a proxima vaga.`;
          if (repeticoesSeletor >= 3) {
            resultado +=
              ` ATENCAO: ${repeticoesSeletor} falhas identicas — DESISTA deste elemento agora ` +
              `(reportar_falha + proxima vaga). Continuar retentando queima a cota de requisicoes sem progresso.`;
          }
        }

        // Reinjeta o retorno no histórico no padrão OpenAI
        // ({ role: "tool", tool_call_id, content })
        history.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: resultado,
        });
      }

      // META DE QUALIDADE: o gate de registrar_candidatura sinalizou que a
      // meta do run foi atingida. Encerramento de SUCESSO em fronteira de
      // iteração — determinístico, não depende do modelo encerrar por texto
      // (que a guarda anti-abandono jamais aceita). Recovery limpo: a próxima
      // execução NÃO vê aviso de interrupção, pois este run terminou completo.
      if (sinais.metaAtingida) {
        respostaFinal = `Execucao concluida com sucesso: meta de ${config.metaCandidaturas} candidatura(s) de qualidade atingida apos ${iteracao} iteracao(oes).`;
        log('AGENTE', `META DE QUALIDADE ATINGIDA — ${respostaFinal}`);
        limparRecovery();
        break;
      }

      // Compactação: trunca snapshots antigos mantendo o pareamento
      // tool_calls ↔ tool válido (ver src/historico.ts). Sem isso, cada
      // chamada reenvia todos os snapshots na íntegra (~50k tokens/call).
      history = compactarHistorico(history);

      // Sliding window: poda mensagens antigas preservando a validade do
      // histórico para a API OpenAI (ver src/historico.ts).
      if (history.length > MAX_HISTORICO) {
        const antes = history.length;
        history = podarHistorico(history, MAX_HISTORICO);
        log('AGENTE', `Sliding window: ${antes - history.length} mensagens antigas descartadas (historico: ${history.length})`);
      }

      // Salva estado para recovery a cada 5 iteracoes
      if (iteracao % 5 === 0) {
        salvarRecovery(iteracao, sitesAtivos.map(s => s.nome));
      }

    } catch (error) {
      const mensagemErro = error instanceof Error ? error.message : String(error);
      log('ERRO', `Erro na iteracao ${iteracao}: ${mensagemErro}`);

      const tipoErro = classificarErroAPI(mensagemErro);

      if (tipoErro === 'rate_limit') {
        errosConsecutivos++;
        // Teto anti-espera-infinita: após N rate limits seguidos, a cota
        // provavelmente não vai voltar tão cedo — avisa no Telegram e PARA,
        // em vez de acumular backoffs (30s, 60s, 120s...) indefinidamente.
        if (errosConsecutivos >= MAX_RATE_LIMIT_CONSECUTIVOS) {
          const msg = `Rate limit persistente no LLM do agente (${errosConsecutivos}x consecutivos, modelo ${config.agentLlmModel}). Execucao interrompida na iteracao ${iteracao} para preservar a cota. Verifique o plano/limites do provedor e rode novamente — o progresso foi salvo (vagas vistas/aplicadas estao no banco).`;
          log('AGENTE', msg);
          salvarRecovery(iteracao, sitesAtivos.map(s => s.nome));
          respostaFinal = `Erro durante execucao: ${msg}`;
          saiuComErroFatal = true;
          await notificarErro(`Office Boy parado: rate limit persistente (${errosConsecutivos}x) no modelo ${config.agentLlmModel}. ${respostaFinal}`);
          break;
        }
        const backoff = calcularBackoffRateLimit(errosConsecutivos);
        log('AGENTE', `Rate limit atingido (${errosConsecutivos}x). Aguardando ${Math.round(backoff / 1000)}s...`);
        await new Promise(resolve => setTimeout(resolve, backoff));
        continue;
      }

      if (tipoErro === 'rede') {
        errosConsecutivos++;
        if (errosConsecutivos <= MAX_TENTATIVAS) {
          const backoff = 5000 * Math.pow(2, errosConsecutivos - 1);
          log('AGENTE', `Erro de rede (${errosConsecutivos}/${MAX_TENTATIVAS}). Retentando em ${Math.round(backoff / 1000)}s...`);
          await new Promise(resolve => setTimeout(resolve, backoff));
          continue;
        }
        log('AGENTE', `Erro de rede persistente apos ${errosConsecutivos} tentativas. Finalizando.`);
      }

      // Erro fatal ou tentativas esgotadas
      salvarRecovery(iteracao, sitesAtivos.map(s => s.nome));
      respostaFinal = `Erro durante execucao: ${mensagemErro}`;
      saiuComErroFatal = true;
      break;
    }
  }

  if (iteracao >= maxIter) {
    respostaFinal = `Agente atingiu o limite maximo de ${maxIter} iteracoes.`;
  }

  // Só limpa o recovery se NÃO saímos por erro fatal — assim o aviso de
  // "execução anterior interrompida" sobrevive para a próxima execução.
  if (!saiuComErroFatal) {
    limparRecovery();
  }
  log('AGENTE', `Finalizado apos ${iteracao} iteracoes.`);
  return respostaFinal;
}

// ========== RECOVERY (persistencia de estado) ==========

interface RecoveryState {
  iteracao: number;
  ultimoSite: string;
  timestamp: string;
}

function salvarRecovery(iteracao: number, sites: string[]): void {
  try {
    const estado: RecoveryState = {
      iteracao,
      ultimoSite: sites[sites.length - 1] || '',
      timestamp: new Date().toISOString(),
    };
    writeFileSync(RECOVERY_PATH, JSON.stringify(estado, null, 2));
  } catch {
    // Silencioso
  }
}

function carregarRecovery(): RecoveryState | null {
  try {
    if (!existsSync(RECOVERY_PATH)) return null;
    const conteudo = readFileSync(RECOVERY_PATH, 'utf-8');
    return JSON.parse(conteudo) as RecoveryState;
  } catch {
    return null;
  }
}

function limparRecovery(): void {
  try {
    if (existsSync(RECOVERY_PATH)) {
      // Remove o arquivo de fato. Antes era gravada uma string vazia, o que
      // fazia carregarRecovery() sempre lançar em JSON.parse('') e nunca
      // distinguir "sem recovery" de "recovery limpo".
      unlinkSync(RECOVERY_PATH);
    }
  } catch {
    // Silencioso — não quebrar o fluxo por erro de limpeza.
  }
}
