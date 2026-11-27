import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { log } from './logger.js';
import { chaveVaga } from './chave-vaga.js';
import type { Candidatura, StatusFilaVaga, VagaFila } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, '..', 'data', 'candidaturas.db');

let db: Database.Database;

/**
 * Preenche a chave canônica nos registros antigos e cria índice único.
 * Se o banco já tiver duas candidaturas para a mesma vaga (URLs diferentes),
 * mantém os registros e usa índice comum — a verificação em código continua
 * bloqueando. Nunca apaga histórico silently.
 */
function migrarChaveVaga(): void {
  for (const tabela of ['candidaturas', 'vagas_vistas']) {
    const colunas = db.prepare(`PRAGMA table_info(${tabela})`).all() as { name: string }[];
    if (!colunas.some((c) => c.name === 'chave_vaga')) {
      db.exec(`ALTER TABLE ${tabela} ADD COLUMN chave_vaga TEXT`);
    }
    const linhas = db.prepare(`SELECT id, url FROM ${tabela} WHERE chave_vaga IS NULL`).all() as {
      id: number;
      url: string;
    }[];
    const atualizar = db.prepare(`UPDATE ${tabela} SET chave_vaga = ? WHERE id = ?`);
    for (const linha of linhas) atualizar.run(chaveVaga(linha.url), linha.id);

    try {
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_${tabela}_chave ON ${tabela}(chave_vaga) WHERE chave_vaga IS NOT NULL`);
    } catch {
      log('WARN', `Banco: ${tabela} tem chaves repetidas no histórico — usando índice não único`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_${tabela}_chave ON ${tabela}(chave_vaga)`);
    }
  }
}

export function inicializarBanco(dbPath: string = DB_PATH): Database.Database {
  // better-sqlite3 NÃO cria o diretório pai do arquivo .db. Como data/ está no
  // .gitignore, num clone limpo o diretório não existe e o bot crashava com
  // "unable to open database file". Garantimos a existência aqui.
  // O parâmetro dbPath (default = DB_PATH) permite testes com um caminho próprio.
  mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);

  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS candidaturas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plataforma TEXT NOT NULL,
      titulo_vaga TEXT NOT NULL,
      empresa TEXT NOT NULL,
      url TEXT UNIQUE NOT NULL,
      data_aplicacao TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      mensagem_enviada INTEGER DEFAULT 0,
      status TEXT DEFAULT 'aplicado',
      score INTEGER DEFAULT 0,
      chave_vaga TEXT
    )
  `);

  // Migracoes (adicionar colunas novas em bancos existentes)
  const migracoes = [
    'ALTER TABLE candidaturas ADD COLUMN score INTEGER DEFAULT 0',
    'ALTER TABLE candidaturas ADD COLUMN screenshot_path TEXT',
    "ALTER TABLE candidaturas ADD COLUMN resultado TEXT DEFAULT 'aguardando'",
  ];
  for (const sql of migracoes) {
    try { db.exec(sql); } catch { /* Coluna ja existe */ }
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS vagas_vistas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT UNIQUE NOT NULL,
      titulo_vaga TEXT,
      empresa TEXT,
      plataforma TEXT,
      score INTEGER DEFAULT 0,
      motivo_pulo TEXT,
      data_vista TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      chave_vaga TEXT
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS fila_vagas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT UNIQUE NOT NULL,
      chave_vaga TEXT,
      titulo_vaga TEXT NOT NULL,
      empresa TEXT NOT NULL,
      plataforma TEXT NOT NULL DEFAULT 'Rebase Jobs',
      descricao TEXT,
      localizacao TEXT,
      score INTEGER DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pendente',
      motivo TEXT,
      data_criacao TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_fila_vagas_status ON fila_vagas(status, data_criacao)');

  db.exec(`
    CREATE TABLE IF NOT EXISTS cache_respostas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tipo_campo TEXT NOT NULL,
      pergunta_sanitizada TEXT NOT NULL,
      resposta TEXT NOT NULL,
      vezes_usada INTEGER DEFAULT 1,
      data_criacao TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      data_ultimo_uso TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_cache_pergunta ON cache_respostas(pergunta_sanitizada);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS mensagens_recrutadores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome_recrutador TEXT NOT NULL,
      cargo_recrutador TEXT,
      empresa TEXT NOT NULL,
      url_perfil TEXT UNIQUE NOT NULL,
      url_vaga TEXT,
      titulo_vaga TEXT,
      mensagem TEXT NOT NULL,
      plataforma TEXT DEFAULT 'linkedin',
      score_vaga INTEGER DEFAULT 0,
      data_envio TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS log_execucoes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      data_execucao TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      total_candidaturas INTEGER DEFAULT 0,
      sites_processados TEXT,
      erros TEXT
    )
  `);

  // Depois de TODAS as tabelas criadas: preenche as chaves antigas e cria os
  // índices únicos. Chamar antes deixava o banco sem vagas_vistas.
  migrarChaveVaga();

  return db;
}

export function verificarJaAplicou(url: string): boolean {
  const chave = chaveVaga(url);
  // Dry-run NUNCA bloqueia uma execução real. Pendente bloqueia (clique em
  // andamento), mas é limpo se o envio falhar.
  const row = db.prepare(`
    SELECT id FROM candidaturas
    WHERE (chave_vaga = ? OR url = ?) AND status <> 'dry-run'
    LIMIT 1
  `).get(chave, url);
  return !!row;
}

/** Confirma um registro 'pendente' depois que o clique de envio sucedeu. */
export function confirmarRegistroPendente(url: string): boolean {
  const chave = chaveVaga(url);
  try {
    const r = db.prepare(`
      UPDATE candidaturas SET status = 'aplicado'
      WHERE (chave_vaga = ? OR url = ?) AND status = 'pendente'
    `).run(chave, url);
    return r.changes > 0;
  } catch (error) {
    log('ERRO', `confirmarRegistroPendente falhou: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/** Desfaz o registro provisório se o clique falhou (erro_mcp, CAPTCHA...). */
export function removerPendente(url: string): boolean {
  const chave = chaveVaga(url);
  try {
    return db.prepare("DELETE FROM candidaturas WHERE chave_vaga = ? AND status = 'pendente'").run(chave).changes > 0;
  } catch (error) {
    log('ERRO', `removerPendente falhou: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/** Pendentes órfãos (processo morreu entre confirmar e clicar) expiram em 15 min. */
export function limparPendentesAntigos(): number {
  return db.prepare(`
    DELETE FROM candidaturas
    WHERE status = 'pendente'
      AND datetime(data_aplicacao) < datetime('now', 'localtime', '-15 minutes')
  `).run().changes;
}

export function registrarCandidatura(candidatura: Omit<Candidatura, 'id' | 'data_aplicacao'>): boolean {
  const chave = chaveVaga(candidatura.url);
  try {
    // Verficação dentro da mesma transação do insert: mesmo sem índice único
    // (banco com chaves históricas repetidas) não entra duplicata.
    return db.transaction(() => {
      const existe = db.prepare(`
        SELECT id, status FROM candidaturas
        WHERE chave_vaga = ? OR url = ?
        LIMIT 1
      `).get(chave, candidatura.url) as { id: number; status: string } | undefined;
      if (existe) {
        // Uma simulação não pode bloquear a vida real: promove o registro.
        if (existe.status === 'dry-run' && candidatura.status !== 'dry-run') {
          db.prepare(`
            UPDATE candidaturas SET plataforma = ?, titulo_vaga = ?, empresa = ?, url = ?,
              mensagem_enviada = ?, status = ?, score = ? WHERE id = ?
          `).run(
            candidatura.plataforma, candidatura.titulo_vaga, candidatura.empresa,
            candidatura.url, candidatura.mensagem_enviada, candidatura.status,
            candidatura.score ?? 0, existe.id,
          );
          return true;
        }
        return false;
      }
      const result = db.prepare(`
        INSERT INTO candidaturas (plataforma, titulo_vaga, empresa, url, mensagem_enviada, status, score, screenshot_path, chave_vaga)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        candidatura.plataforma,
        candidatura.titulo_vaga,
        candidatura.empresa,
        candidatura.url,
        candidatura.mensagem_enviada,
        candidatura.status,
        candidatura.score ?? 0,
        candidatura.screenshot_path ?? null,
        chave
      );
      return result.changes > 0;
    })();
  } catch (error) {
    log('ERRO', `registrarCandidatura falhou: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/** Motivo permanente registrado antes para esta mesma vaga (ou null). */
export function verificarBloqueioPermanente(url: string): string | null {
  const chave = chaveVaga(url);
  const row = db.prepare(`
    SELECT motivo_pulo FROM vagas_vistas
    WHERE (chave_vaga = ? OR url = ?)
      AND (motivo_pulo LIKE 'PERMANENTE:%' OR motivo_pulo LIKE 'ESGOTADO:%')
    LIMIT 1
  `).get(chave, url) as { motivo_pulo: string } | undefined;
  return row?.motivo_pulo ?? null;
}

export function registrarVagaVista(dados: {
  url: string;
  titulo_vaga?: string;
  empresa?: string;
  plataforma?: string;
  score?: number;
  motivo_pulo?: string;
}): boolean {
  try {
    const chave = chaveVaga(dados.url);
    const bloqueio = verificarBloqueioPermanente(dados.url);
    if (bloqueio) {
      log('AGENTE', `Vaga revisitada ignorada (já reprovada permanentemente): [URL] — ${bloqueio.slice(0, 80)}`);
      return false;
    }
    db.prepare(`
      INSERT OR IGNORE INTO vagas_vistas (url, titulo_vaga, empresa, plataforma, score, motivo_pulo, chave_vaga)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      dados.url,
      dados.titulo_vaga ?? null,
      dados.empresa ?? null,
      dados.plataforma ?? null,
      dados.score ?? 0,
      dados.motivo_pulo ?? null,
      chave
    );
    return true;
  } catch (error) {
    log('ERRO', `registrarVagaVista falhou: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

export interface VagaVistaRelatorio {
  titulo_vaga: string;
  empresa: string;
  plataforma: string;
  url: string;
  score: number;
  motivo_pulo: string;
  data_vista: string;
}

/** Vagas de score alto puladas desde o início da execução atual. */
export function listarVagasVistasDesde(dataInicio: string, scoreMinimo = 8): VagaVistaRelatorio[] {
  return db.prepare(`
    SELECT titulo_vaga, empresa, plataforma, url, score, motivo_pulo, data_vista
    FROM vagas_vistas
    WHERE data_vista >= ? AND score >= ? AND motivo_pulo IS NOT NULL AND TRIM(motivo_pulo) <> ''
    ORDER BY id ASC
  `).all(dataInicio, scoreMinimo) as VagaVistaRelatorio[];
}

export function verificarVagaJaVista(url: string): boolean {
  const chave = chaveVaga(url);
  const row = db.prepare('SELECT id FROM vagas_vistas WHERE chave_vaga = ? OR url = ?').get(chave, url);
  return !!row;
}

export function inserirVagaNaFila(vaga: Omit<VagaFila, 'id' | 'status'> & { status?: StatusFilaVaga }): boolean {
  try {
    const chave = chaveVaga(vaga.url);
    const existente = db.prepare('SELECT id, status FROM fila_vagas WHERE chave_vaga = ? OR url = ? LIMIT 1')
      .get(chave, vaga.url) as { id: number; status: StatusFilaVaga } | undefined;
    if (existente) {
      const status = existente.status === 'pendente' ? (vaga.status ?? 'pendente') : existente.status;
      return db.prepare(`
        UPDATE fila_vagas SET url = ?, chave_vaga = ?, titulo_vaga = ?, empresa = ?, plataforma = ?,
          descricao = COALESCE(?, descricao), localizacao = COALESCE(?, localizacao),
          score = CASE WHEN status = 'pendente' THEN ? ELSE score END, status = ?, motivo = COALESCE(?, motivo)
        WHERE id = ?
      `).run(
        vaga.url, chave, vaga.titulo_vaga, vaga.empresa, vaga.plataforma,
        vaga.descricao ?? null, vaga.localizacao ?? null, vaga.score ?? 0,
        status, vaga.motivo ?? null, existente.id,
      ).changes > 0;
    }
    return db.prepare(`
      INSERT INTO fila_vagas
        (url, chave_vaga, titulo_vaga, empresa, plataforma, descricao, localizacao, score, status, motivo)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      vaga.url, chave, vaga.titulo_vaga, vaga.empresa, vaga.plataforma,
      vaga.descricao ?? null, vaga.localizacao ?? null, vaga.score ?? 0,
      vaga.status ?? 'pendente', vaga.motivo ?? null,
    ).changes > 0;
  } catch (error) {
    log('ERRO', `inserirVagaNaFila falhou: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

export function listarVagasFila(limite = 25, status: StatusFilaVaga = 'pendente'): VagaFila[] {
  const n = Math.min(Math.max(Math.floor(limite) || 25, 1), 100);
  return db.prepare(`
    SELECT id, url, titulo_vaga, empresa, plataforma, descricao, localizacao, score, status, motivo, data_criacao
    FROM fila_vagas WHERE status = ? ORDER BY score DESC, data_criacao DESC LIMIT ?
  `).all(status, n) as VagaFila[];
}

/** Reserva vagas para uma execução apply; claims antigos são recuperáveis. */
export function reivindicarVagasFila(limite = 25): VagaFila[] {
  const n = Math.min(Math.max(Math.floor(limite) || 25, 1), 100);
  return db.transaction(() => {
    db.prepare("UPDATE fila_vagas SET status = 'pendente' WHERE status = 'processando' AND datetime(data_criacao) < datetime('now', 'localtime', '-2 hours')").run();
    const vagas = db.prepare(`
      SELECT id, url, titulo_vaga, empresa, plataforma, descricao, localizacao, score, status, motivo, data_criacao
      FROM fila_vagas WHERE status = 'pendente' ORDER BY score DESC, data_criacao DESC LIMIT ?
    `).all(n) as VagaFila[];
    const marcar = db.prepare("UPDATE fila_vagas SET status = 'processando' WHERE id = ? AND status = 'pendente'");
    const reservadas: VagaFila[] = [];
    for (const vaga of vagas) {
      if (marcar.run(vaga.id).changes > 0) reservadas.push({ ...vaga, status: 'processando' });
    }
    return reservadas;
  })();
}

export function atualizarStatusVagaFila(url: string, status: StatusFilaVaga, motivo?: string): boolean {
  try {
    return db.prepare('UPDATE fila_vagas SET status = ?, motivo = COALESCE(?, motivo) WHERE url = ? OR chave_vaga = ?')
      .run(status, motivo ?? null, url, chaveVaga(url)).changes > 0;
  } catch (error) {
    log('ERRO', `atualizarStatusVagaFila falhou: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

export function atualizarScreenshot(url: string, screenshotPath: string): void {
  db.prepare('UPDATE candidaturas SET screenshot_path = ? WHERE url = ?').run(screenshotPath, url);
}

// Vocabulário fechado de desfecho de uma candidatura — fecha o loop de feedback
// (antes a candidatura morria em 'aplicado' e nunca se sabia o resultado).
export const RESULTADOS_VALIDOS = [
  'aguardando', 'respondido', 'entrevista', 'oferta', 'rejeitado', 'sem_resposta',
] as const;
export type ResultadoCandidatura = (typeof RESULTADOS_VALIDOS)[number];

/**
 * Marca o desfecho de uma candidatura pelo id.
 * Retorna false se o resultado for inválido (vocabulário fechado) ou se o id
 * não existir (nenhuma linha afetada).
 */
export function atualizarResultado(id: number, resultado: string): boolean {
  if (!RESULTADOS_VALIDOS.includes(resultado as ResultadoCandidatura)) return false;
  try {
    const r = db.prepare('UPDATE candidaturas SET resultado = ? WHERE id = ?').run(resultado, id);
    return r.changes > 0;
  } catch (error) {
    log('ERRO', `atualizarResultado falhou: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

export function obterEstatisticas() {
  const hoje = db.prepare(`
    SELECT COUNT(*) as total, AVG(score) as score_medio
    FROM candidaturas WHERE date(data_aplicacao) = date('now', 'localtime')
  `).get() as { total: number; score_medio: number | null };

  const total = db.prepare('SELECT COUNT(*) as total FROM candidaturas').get() as { total: number };

  const porPlataforma = db.prepare(`
    SELECT plataforma, COUNT(*) as total, AVG(score) as score_medio
    FROM candidaturas GROUP BY plataforma ORDER BY total DESC
  `).all() as Array<{ plataforma: string; total: number; score_medio: number | null }>;

  const porStatus = db.prepare(`
    SELECT status, COUNT(*) as total
    FROM candidaturas GROUP BY status
  `).all() as Array<{ status: string; total: number }>;

  // Funil de resultados (só candidaturas reais, não dry-run) para metricas de retorno.
  const porResultado = db.prepare(`
    SELECT resultado, COUNT(*) as total
    FROM candidaturas WHERE status != 'dry-run' GROUP BY resultado
  `).all() as Array<{ resultado: string; total: number }>;

  return { hoje, total: total.total, porPlataforma, porStatus, porResultado };
}

export function contarCandidaturasHoje(): number {
  const row = db.prepare(`
    SELECT COUNT(*) as total FROM candidaturas
    WHERE date(data_aplicacao) = date('now', 'localtime') AND status <> 'dry-run'
  `).get() as { total: number };
  return row.total;
}

export function listarCandidaturas(limite: number = 50): Candidatura[] {
  return db.prepare(`
    SELECT * FROM candidaturas ORDER BY data_aplicacao DESC LIMIT ?
  `).all(limite) as Candidatura[];
}

/** Candidaturas reais registradas a partir de um timestamp local "YYYY-MM-DD HH:MM:SS". */
export function contarCandidaturasDesde(tsLocal: string): number {
  const row = db.prepare(`
    SELECT COUNT(*) as total FROM candidaturas WHERE data_aplicacao >= ? AND status <> 'dry-run'
  `).get(tsLocal) as { total: number };
  return row.total;
}

export function registrarExecucao(totalCandidaturas: number, sitesProcessados: string[], erros: string[]): void {
  db.prepare(`
    INSERT INTO log_execucoes (total_candidaturas, sites_processados, erros)
    VALUES (?, ?, ?)
  `).run(totalCandidaturas, JSON.stringify(sitesProcessados), JSON.stringify(erros));
}

// ========== MENSAGENS PARA RECRUTADORES ==========

export function verificarRecrutadorJaContatado(urlPerfil: string): boolean {
  const row = db.prepare('SELECT id FROM mensagens_recrutadores WHERE url_perfil = ?').get(urlPerfil);
  return !!row;
}

export function registrarMensagemRecrutador(dados: {
  nome_recrutador: string;
  cargo_recrutador?: string;
  empresa: string;
  url_perfil: string;
  url_vaga?: string;
  titulo_vaga?: string;
  mensagem: string;
  plataforma?: string;
  score_vaga?: number;
}): boolean {
  try {
    const result = db.prepare(`
      INSERT OR IGNORE INTO mensagens_recrutadores
        (nome_recrutador, cargo_recrutador, empresa, url_perfil, url_vaga, titulo_vaga, mensagem, plataforma, score_vaga)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      dados.nome_recrutador,
      dados.cargo_recrutador ?? null,
      dados.empresa,
      dados.url_perfil,
      dados.url_vaga ?? null,
      dados.titulo_vaga ?? null,
      dados.mensagem,
      dados.plataforma ?? 'linkedin',
      dados.score_vaga ?? 0,
    );
    // changes === 0 = recrutador já contatado (url_perfil UNIQUE), não erro.
    return result.changes > 0;
  } catch (error) {
    log('ERRO', `registrarMensagemRecrutador falhou: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

export function contarMensagensHoje(): number {
  const row = db.prepare(`
    SELECT COUNT(*) as total FROM mensagens_recrutadores
    WHERE date(data_envio) = date('now', 'localtime')
  `).get() as { total: number };
  return row.total;
}

// ========== CACHE DE RESPOSTAS ==========

export interface CacheResposta {
  id: number;
  tipo_campo: string;
  pergunta_sanitizada: string;
  resposta: string;
  vezes_usada: number;
}

export function sanitizarPergunta(texto: string): string {
  return texto
    .toLowerCase()
    .trim()
    .replace(/['"\\]/g, '')
    .replace(/[\x00-\x1F\x7F]/g, '')
    .replace(/\n/g, ' ')
    .replace(/\r/g, '')
    .replace(/\s+/g, ' ')
    .replace(/,\s*$/, '');
}

export function buscarRespostaCache(pergunta: string, tipoCampo: string): CacheResposta | null {
  const sanitizada = sanitizarPergunta(pergunta);

  // 1. Exact match (como o AIHawk)
  const exata = db.prepare(
    'SELECT * FROM cache_respostas WHERE pergunta_sanitizada = ? AND tipo_campo = ?',
  ).get(sanitizada, tipoCampo) as CacheResposta | undefined;

  if (exata) {
    // Atualizar contador e data de uso
    db.prepare(
      `UPDATE cache_respostas SET vezes_usada = vezes_usada + 1, data_ultimo_uso = datetime('now', 'localtime') WHERE id = ?`,
    ).run(exata.id);
    return exata;
  }

  // 2. Substring match (para dropdowns/radios, como o AIHawk usa 'in')
  if (tipoCampo === 'dropdown' || tipoCampo === 'radio') {
    const todas = db.prepare(
      'SELECT * FROM cache_respostas WHERE tipo_campo = ?',
    ).all(tipoCampo) as CacheResposta[];

    for (const item of todas) {
      if (sanitizada.includes(item.pergunta_sanitizada) || item.pergunta_sanitizada.includes(sanitizada)) {
        db.prepare(
          `UPDATE cache_respostas SET vezes_usada = vezes_usada + 1, data_ultimo_uso = datetime('now', 'localtime') WHERE id = ?`,
        ).run(item.id);
        return item;
      }
    }
  }

  return null;
}

export function buscarCandidatasCache(pergunta: string, limite: number = 10): CacheResposta[] {
  const sanitizada = sanitizarPergunta(pergunta);
  // Busca perguntas que compartilham palavras-chave para matching semântico via LLM
  const palavras = sanitizada.split(' ').filter(p => p.length > 3);
  if (palavras.length === 0) return [];

  const condicoes = palavras.map(() => 'pergunta_sanitizada LIKE ?').join(' OR ');
  const params = palavras.map(p => `%${p}%`);

  return db.prepare(
    `SELECT * FROM cache_respostas WHERE ${condicoes} ORDER BY vezes_usada DESC LIMIT ?`,
  ).all(...params, limite) as CacheResposta[];
}

export function salvarRespostaCache(pergunta: string, tipoCampo: string, resposta: string): boolean {
  const sanitizada = sanitizarPergunta(pergunta);

  // Verificar se já existe
  const existe = db.prepare(
    'SELECT id FROM cache_respostas WHERE pergunta_sanitizada = ? AND tipo_campo = ?',
  ).get(sanitizada, tipoCampo);

  if (existe) return false;

  try {
    db.prepare(
      'INSERT INTO cache_respostas (tipo_campo, pergunta_sanitizada, resposta) VALUES (?, ?, ?)',
    ).run(tipoCampo, sanitizada, resposta);
    return true;
  } catch (error) {
    log('ERRO', `salvarRespostaCache falhou: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

export function contarCacheRespostas(): number {
  const row = db.prepare('SELECT COUNT(*) as total FROM cache_respostas').get() as { total: number };
  return row.total;
}

/** Timestamp no mesmo relógio/formato usado pelos defaults das tabelas. */
export function obterAgoraBanco(): string {
  return (db.prepare("SELECT datetime('now', 'localtime') AS agora").get() as { agora: string }).agora;
}

export function fecharBanco(): void {
  if (db) {
    db.close();
  }
}
