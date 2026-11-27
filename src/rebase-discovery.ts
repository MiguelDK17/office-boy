import { conectarRebaseJobsMCP, desconectarMCP } from './mcp-client.js';
import { extrairTextoMcp } from './sessao.js';
import { inserirVagaNaFila } from './database.js';
import { pontuarVaga } from './scoring.js';
import { estaNaBlacklist } from './blacklist.js';
import type { AgenteConfig, Perfil, VagaFila } from './types.js';

interface RebaseToolInfo {
  name: string;
  inputSchema?: { properties?: Record<string, unknown> };
}

function texto(valor: unknown): string {
  return typeof valor === 'string' ? valor.trim() : valor == null ? '' : String(valor).trim();
}

function primeiro(obj: Record<string, unknown>, chaves: string[]): string {
  for (const chave of chaves) {
    const valor = texto(obj[chave]);
    if (valor) return valor;
  }
  return '';
}

function extrairJson(textoBruto: string): unknown {
  const cercado = textoBruto.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1];
  const candidatos = [cercado, textoBruto.trim()].filter(Boolean) as string[];
  for (const candidato of candidatos) {
    try { return JSON.parse(candidato); } catch { /* tenta o próximo formato */ }
    const inicioArray = candidato.indexOf('[');
    const fimArray = candidato.lastIndexOf(']');
    if (inicioArray >= 0 && fimArray > inicioArray) {
      try { return JSON.parse(candidato.slice(inicioArray, fimArray + 1)); } catch { /* segue */ }
    }
    const inicioObjeto = candidato.indexOf('{');
    const fimObjeto = candidato.lastIndexOf('}');
    if (inicioObjeto >= 0 && fimObjeto > inicioObjeto) {
      try { return JSON.parse(candidato.slice(inicioObjeto, fimObjeto + 1)); } catch { /* segue */ }
    }
  }
  return null;
}

function localizarLista(valor: unknown): Record<string, unknown>[] {
  if (Array.isArray(valor)) return valor.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'));
  if (!valor || typeof valor !== 'object') return [];
  const obj = valor as Record<string, unknown>;
  for (const chave of ['vagas', 'jobs', 'results', 'data', 'items']) {
    const lista = localizarLista(obj[chave]);
    if (lista.length > 0) return lista;
  }
  return [obj];
}

function urlDaVaga(obj: Record<string, unknown>): string {
  const direta = primeiro(obj, ['url_candidatura', 'application_url', 'apply_url', 'url_externa', 'external_url', 'url_empresa', 'url', 'link', 'href']);
  if (direta) return direta;
  const slug = primeiro(obj, ['slug', 'id']);
  return slug && /^https?:\/\//i.test(slug) ? slug : '';
}

function montarArgumentosBusca(tool: RebaseToolInfo, perfil: Perfil): Record<string, unknown> {
  const propriedades = tool.inputSchema?.properties ?? {};
  const consulta = [...new Set([
    ...perfil.palavras_chave_busca,
    ...perfil.stack_principal,
    perfil.titulo_profissional,
  ].map(v => v.trim()).filter(Boolean))].join(' ');
  const args: Record<string, unknown> = {};
  if ('q' in propriedades) args.q = consulta;
  else if ('query' in propriedades) args.query = consulta;
  else if ('busca' in propriedades) args.busca = consulta;
  if ('limite' in propriedades) args.limite = 50;
  else if ('limit' in propriedades) args.limit = 50;
  if ('skill' in propriedades) args.skill = perfil.stack_principal.join(', ');
  return args;
}

type VagaDiscovery = VagaFila & { senioridade?: string; modelo_trabalho?: string; idioma_exigido?: string };

function normalizarVaga(obj: Record<string, unknown>): VagaDiscovery | null {
  const url = urlDaVaga(obj);
  const titulo = primeiro(obj, ['titulo_vaga', 'titulo', 'title', 'cargo', 'name']);
  const empresa = primeiro(obj, ['empresa', 'company', 'company_name', 'employer']);
  if (!url || !/^https?:\/\//i.test(url) || !titulo || !empresa) return null;
  const descricao = primeiro(obj, ['descricao', 'description', 'anuncio', 'body', 'content']);
  const localizacao = primeiro(obj, ['localizacao', 'local', 'location', 'modelo_trabalho', 'work_model']);
  return {
    url, titulo_vaga: titulo, empresa, plataforma: 'Rebase Jobs', descricao, localizacao, status: 'pendente',
    senioridade: primeiro(obj, ['senioridade', 'nivel', 'level']),
    modelo_trabalho: primeiro(obj, ['modelo_trabalho', 'work_model', 'modelo', 'contrato']),
    idioma_exigido: primeiro(obj, ['idioma_exigido', 'ingles', 'english_level']),
  };
}

export interface ResultadoDiscovery {
  encontradas: number;
  enfileiradas: number;
  puladas: number;
}

/** Busca vagas no Rebase e grava apenas o resultado da triagem na fila local. */
export async function executarDiscoveryRebase(perfil: Perfil, config: AgenteConfig): Promise<ResultadoDiscovery> {
  if (!config.rebaseJobsToken) throw new Error('REBASE_JOBS_TOKEN nao definida');
  const client = await conectarRebaseJobsMCP(config.rebaseJobsMcpUrl, config.rebaseJobsToken);
  try {
    const { tools } = await client.listTools();
    const buscar = (tools as RebaseToolInfo[]).find(t => t.name === 'buscar_vagas');
    if (!buscar) throw new Error('Rebase Jobs nao publicou a tool buscar_vagas');
    const resposta = await client.callTool({ name: buscar.name, arguments: montarArgumentosBusca(buscar, perfil) });
    const dados = localizarLista(extrairJson(extrairTextoMcp((resposta as { content?: unknown }).content)));
    let enfileiradas = 0;
    let puladas = 0;
    for (const bruto of dados) {
      const vaga = normalizarVaga(bruto);
      if (!vaga) continue;
      const textoAnalise = `${vaga.titulo_vaga} ${vaga.empresa} ${vaga.descricao ?? ''} ${vaga.localizacao ?? ''}`;
      const blacklist = estaNaBlacklist(vaga.empresa, vaga.titulo_vaga, perfil.blacklist_empresas, perfil.blacklist_termos_titulo);
      const pontuacao = pontuarVaga(
        {
          tecnologias_pedidas: textoAnalise,
          senioridade: vaga.senioridade,
          localizacao: vaga.localizacao,
          modelo_trabalho: vaga.modelo_trabalho || vaga.localizacao,
          idioma_exigido: vaga.idioma_exigido,
        },
        {
          stackPrincipal: perfil.stack_principal,
          cidade: perfil.cidade,
          modelosAceitos: perfil.modelo_trabalho,
          nivelIngles: perfil.nivel_ingles,
          regraLocalizacao: perfil.regra_localizacao,
          localizacoesPresencialHibrido: perfil.localizacoes_presencial_hibrido,
        },
        config.scoreMinimo,
      );
      const aplicavel = !blacklist.bloqueado && pontuacao.veredicto === 'APLICAR';
      const inserida = inserirVagaNaFila({
        ...vaga,
        score: pontuacao.score,
        status: aplicavel ? 'pendente' : 'pulada',
        motivo: blacklist.bloqueado ? blacklist.motivo : pontuacao.motivo,
      });
      if (inserida && aplicavel) enfileiradas++;
      else if (inserida) puladas++;
    }
    return { encontradas: dados.length, enfileiradas, puladas };
  } finally {
    await desconectarMCP();
  }
}
