import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { inicializarBanco, fecharBanco, verificarJaAplicou } from '../src/database';
import { criarExecutorDeTools, dominioDe, customToolNames } from '../src/tools';
import type { Perfil, AgenteConfig } from '../src/types';

// Perfil minimo para o executor
function perfilFake(): Perfil {
  return {
    nome: 'Fulano', email: 'f@e.com', telefone: '(34) 90000-0000',
    linkedin: 'https://linkedin.com/in/f', github: 'https://github.com/f', portfolio: '',
    curriculo_path: './cv.pdf', titulo_profissional: 'Dev', anos_experiencia: 3,
    stack_principal: ['Java', 'React'], resumo_profissional: 'Resumo.',
    pretensao_salarial: 'A combinar', modelo_trabalho: ['remoto'], cidade: 'Uberlândia, MG',
    disponibilidade: 'Imediata', palavras_chave_busca: ['Dev'],
  };
}

function configFake(over: Partial<AgenteConfig> = {}): AgenteConfig {
  return {
    agentLlmBaseUrl: 'https://openrouter.ai/api/v1', agentLlmApiKey: 'fake', agentLlmModel: 'google/gemini-2.0-flash-001',
    geminiApiKey: '', geminiModel: '', cdpEndpoint: 'http://localhost:9222',
    limiteDiario: 10, maxPorExecucao: 5, delayMin: 1, delayMax: 2, dryRun: true, scoreMinimo: 6,
    custoMaxUsd: 0, dashboardPort: 3000, dashboardHost: '127.0.0.1',
    telegramBotToken: '', telegramChatId: '', smtpHost: '', smtpPort: 587, smtpUser: '', smtpPass: '',
    emailDestinatario: '', cronAtivo: false, cronHorario: '09:00',
    llmAuxProvider: 'gemini', llmAuxModel: 'gemini-2.5-flash', ollamaUrl: '', openaiApiKey: '', openaiBaseUrl: '',
    ...over,
  };
}

beforeAll(() => {
  inicializarBanco(':memory:');
});
afterAll(() => fecharBanco());

describe('executor — guard de score (gate deterministico)', () => {
  it('NAO registra candidatura com score abaixo do minimo', async () => {
    // Cenário: executor com scoreMinimo 6
    const executar = criarExecutorDeTools(perfilFake(), configFake({ scoreMinimo: 6 }));

    // Ação: tenta registrar vaga com score 3
    const resp = await executar('registrar_candidatura', {
      plataforma: 'Gupy', titulo_vaga: 'Dev', empresa: 'ACME', url: 'https://x/baixo', score: 3,
    });

    // Validação: bloqueado e NADA gravado no banco
    expect(resp).toMatch(/SCORE_ABAIXO_DO_MINIMO|abaixo do minimo/i);
    expect(verificarJaAplicou('https://x/baixo')).toBe(false);
  });

  it('registra candidatura com score igual/acima do minimo', async () => {
    // Cenário
    const executar = criarExecutorDeTools(perfilFake(), configFake({ scoreMinimo: 6, dryRun: false }));

    // Ação
    const resp = await executar('registrar_candidatura', {
      plataforma: 'Gupy', titulo_vaga: 'Dev', empresa: 'ACME', url: 'https://x/ok', score: 8,
    });

    // Validação
    expect(resp).toMatch(/REGISTRADO/i);
    expect(verificarJaAplicou('https://x/ok')).toBe(true);
  });
});

describe('executor — trava tecnica de dry-run (confirmar_envio)', () => {
  it('em dry-run, confirmar_envio BLOQUEIA o envio', async () => {
    // Cenário: dry-run ligado
    const executar = criarExecutorDeTools(perfilFake(), configFake({ dryRun: true }));

    // Ação
    const resp = await executar('confirmar_envio', {
      url_vaga: 'https://x/dry', acao: 'enviar candidatura',
      plataforma: 'Gupy', titulo_vaga: 'Dev Dry', empresa: 'ACME', score: 8,
    });

    // Validação: bloqueio explícito
    const dados = JSON.parse(resp) as { permitido: boolean; registrado?: boolean };
    expect(dados.permitido).toBe(false);
    expect(resp).toMatch(/DRY-RUN|bloqueado/i);
  });

  it('em producao, confirmar_envio LIBERA o envio', async () => {
    // Cenário: dry-run desligado
    const executar = criarExecutorDeTools(perfilFake(), configFake({ dryRun: false }));

    // Ação
    const resp = await executar('confirmar_envio', {
      url_vaga: 'https://x/prod', acao: 'enviar candidatura',
      plataforma: 'Gupy', titulo_vaga: 'Dev Prod', empresa: 'ACME', score: 8,
    });

    // Validação
    expect((JSON.parse(resp) as { permitido: boolean }).permitido).toBe(true);
  });

  it('em producao, confirmar_envio BLOQUEIA vaga já cadastrada', async () => {
    const registrar = criarExecutorDeTools(perfilFake(), configFake({ dryRun: false }));
    await registrar('registrar_candidatura', {
      plataforma: 'Gupy', titulo_vaga: 'Dev Ja Aplicado', empresa: 'ACME',
      url: 'https://x/ok', score: 8,
    });
    const executar = criarExecutorDeTools(perfilFake(), configFake({ dryRun: false }));

    const resp = await executar('confirmar_envio', {
      url_vaga: 'https://x/ok',
      acao: 'enviar candidatura',
      plataforma: 'Gupy', titulo_vaga: 'Dev', empresa: 'ACME', score: 8,
    });

    expect(resp).toMatch(/JA_APLICOU|já possui candidatura/i);
    expect((JSON.parse(resp) as { permitido: boolean }).permitido).toBe(false);
  });

  it('bloqueia envio ao atingir o teto por execucao', async () => {
    // Cenário: produção com teto de 2 envios por execução
    const executar = criarExecutorDeTools(perfilFake(), configFake({ dryRun: false, maxPorExecucao: 2 }));

    // Ação: três tentativas de envio
    const dados = (n: number) => ({
      url_vaga: `https://x/e${n}`,
      plataforma: 'Gupy',
      titulo_vaga: `Vaga ${n}`,
      empresa: `Empresa ${n}`,
      score: 9,
    });
    const r1 = await executar('confirmar_envio', dados(1));
    const r2 = await executar('confirmar_envio', dados(2));
    const r3 = await executar('confirmar_envio', dados(3));

    // Validação: as duas primeiras liberam, a terceira é barrada pelo teto
    expect((JSON.parse(r1) as { permitido: boolean }).permitido).toBe(true);
    expect((JSON.parse(r2) as { permitido: boolean }).permitido).toBe(true);
    expect((JSON.parse(r3) as { permitido: boolean }).permitido).toBe(false);
    expect(r3).toMatch(/TETO_POR_EXECUCAO/);
  });
});

describe('listar_vagas — suporte dedicado a Catho/Indeed', () => {
  it('a tool está registrada no catálogo do agente', () => {
    expect(customToolNames.has('listar_vagas')).toBe(true);
    expect(customToolNames.has('verificar_avaliacao_empresa')).toBe(true);
  });

  it('em site não suportado orienta usar browser_snapshot sem filename', async () => {
    // Sem MCP inicializado o branch de portal é decidido antes de qualquer
    // chamada ao navegador; aqui simulamos apenas o contrato de mensagem.
    const executar = criarExecutorDeTools(perfilFake(), configFake({ dryRun: true }));
    // getMCPClient lança se o MCP não estiver conectado — a tool deve degradar
    // com erro claro em vez de derrubar o run.
    const resp = await executar('listar_vagas', {});
    expect(resp).toMatch(/mensagem|erro/);
    expect(resp).toMatch(/browser_snapshot|MCP/i);
  });
});

describe('formulário em iframe cross-origin', () => {
  it('iframe de MESMA origem / refs expirados continua RETRIÁVEL', async () => {
    const executar = criarExecutorDeTools(perfilFake(), configFake({ dryRun: false }));
    const resp = await executar('reportar_falha', {
      empresa: 'Squadra Digital', plataforma: 'Portal Próprio',
      codigo_falha: 'elemento_nao_encontrado',
      descricao: 'Campo dentro de iframe de mesma origem; refs expiraram, tente de novo depois de novo snapshot.',
      url_vaga: 'https://www.squadra.com.br/vagas/outra',
    });
    expect(resp).toMatch(/RETENTAR/);
    expect(resp).not.toMatch(/iframe_cross_origin/);
  }, 12000);

  it('reportar_falha classifica como PERMANENTE e não gasta 3 tentativas', async () => {
    const executar = criarExecutorDeTools(perfilFake(), configFake({ dryRun: false }));
    const resp = await executar('reportar_falha', {
      empresa: 'Squadra Digital', plataforma: 'Portal Próprio',
      codigo_falha: 'elemento_nao_encontrado',
      descricao: 'SecurityError: Blocked a frame with origin https://www.squadra.com.br. O formulário está em iframe cross-origin.',
      url_vaga: 'https://www.squadra.com.br/vagas/dev-mobile-android',
    });
    expect(resp).toMatch(/iframe_cross_origin/);
    expect(resp).toMatch(/NUNCA tente de novo/);
    expect(resp).not.toMatch(/RETENTAR/);
  });
});

describe('dominioDe — domínio registrável', () => {
  it('agrupa subdomínios pelo domínio raiz', () => {
    // Cenário + Ação + Validação
    expect(dominioDe('https://portal.gupy.io/job/123')).toBe('gupy.io');
    expect(dominioDe('https://empresa.gupy.io/job/9')).toBe('gupy.io');
    expect(dominioDe('https://www.catho.com.br/vaga/1')).toBe('catho.com.br');
    expect(dominioDe('https://br.indeed.com/x')).toBe('indeed.com');
    expect(dominioDe('https://linkedin.com/jobs')).toBe('linkedin.com');
  });

  it('retorna vazio para URL inválida', () => {
    expect(dominioDe('nao-e-url')).toBe('');
  });

  it('retorna o host inteiro para endereço IP (não fabrica TLD)', () => {
    expect(dominioDe('http://192.168.0.1/x')).toBe('192.168.0.1');
  });
});

describe('executor — abandono de portal bloqueado (P7)', () => {
  it('abandona o portal inteiro e pula vagas seguintes do mesmo dominio', async () => {
    // Cenário: dry-run (sem pausa)
    const executar = criarExecutorDeTools(perfilFake(), configFake({ dryRun: true }));

    // Ação: bloqueio na entrada da Gupy
    const r1 = await executar('reportar_falha', {
      url_vaga: 'https://portal.gupy.io/v1', codigo_falha: 'portal_bloqueado', descricao: 'Cloudflare na listagem',
    });
    // Outra vaga do MESMO portal, com falha qualquer
    const r2 = await executar('reportar_falha', {
      url_vaga: 'https://portal.gupy.io/v2', codigo_falha: 'timeout', descricao: 'qualquer',
    });

    // Validação: o portal é abandonado e a vaga seguinte do mesmo domínio é pulada
    expect(r1).toMatch(/PULAR_PORTAL/);
    expect(r2).toMatch(/PULAR_PORTAL/);
  });
});
