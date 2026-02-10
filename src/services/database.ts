import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import type { ProcessoAberto, EventoProcesso, DocumentoProcesso, ScraperRun, ScraperRunStatus } from '../types/index.js';

let supabase: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (!supabase) {
    supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
    logger.debug('Cliente Supabase inicializado');
  }
  return supabase;
}

// =============================================
// PROCESSOS_ABERTOS
// =============================================

/**
 * Busca todos os processos abertos no banco de dados.
 * Retorna um Map com numero_cnj como chave para fácil comparação.
 */
export async function getAllProcessosAbertos(): Promise<Map<string, ProcessoAberto>> {
  const db = getSupabase();
  const { data, error } = await db
    .from('processos_abertos')
    .select('*');

  if (error) {
    throw new Error(`Erro ao buscar processos_abertos: ${error.message}`);
  }

  const map = new Map<string, ProcessoAberto>();
  for (const row of data ?? []) {
    map.set(row.numero_cnj, row as ProcessoAberto);
  }

  logger.debug('Carregados %d processos do banco', map.size);
  return map;
}

/**
 * Insere um novo processo aberto no banco.
 */
export async function insertProcessoAberto(processo: ProcessoAberto): Promise<void> {
  const db = getSupabase();
  const { error } = await db
    .from('processos_abertos')
    .insert({
      numero_cnj: processo.numero_cnj,
      juizo: processo.juizo,
      requerente_nome: processo.requerente_nome,
      requerente_cpf: processo.requerente_cpf,
      requerido_nome: processo.requerido_nome,
      requerido_cpf: processo.requerido_cpf,
      lado_cliente: processo.lado_cliente,
      cliente_nome: processo.cliente_nome,
      cliente_cpf: processo.cliente_cpf,
      classe: processo.classe,
      assunto: processo.assunto,
      evento_prazo: processo.evento_prazo,
      prazo_dias: processo.prazo_dias,
      data_envio_requisicao: processo.data_envio_requisicao,
      data_inicio_prazo: processo.data_inicio_prazo,
      data_final_prazo: processo.data_final_prazo,
      raw_data: processo.raw_data ?? null,
    });

  if (error) {
    throw new Error(`Erro ao inserir processo ${processo.numero_cnj}: ${error.message}`);
  }

  logger.info('Processo inserido: %s', processo.numero_cnj);
}

/**
 * Insere ou atualiza múltiplos processos de uma vez.
 * Usa upsert para atualizar registros existentes.
 */
export async function insertProcessosAbertos(processos: ProcessoAberto[]): Promise<number> {
  if (processos.length === 0) return 0;

  // Deduplicar por numero_cnj (manter o último em caso de duplicata)
  const uniqueMap = new Map<string, ProcessoAberto>();
  for (const p of processos) {
    uniqueMap.set(p.numero_cnj, p);
  }
  const uniqueProcessos = Array.from(uniqueMap.values());

  if (uniqueProcessos.length !== processos.length) {
    logger.warn('%d duplicatas removidas', processos.length - uniqueProcessos.length);
  }

  const db = getSupabase();
  const { data, error } = await db
    .from('processos_abertos')
    .upsert(
      uniqueProcessos.map((p) => ({
        numero_cnj: p.numero_cnj,
        juizo: p.juizo,
        requerente_nome: p.requerente_nome,
        requerente_cpf: p.requerente_cpf,
        requerido_nome: p.requerido_nome,
        requerido_cpf: p.requerido_cpf,
        // lado_cliente, cliente_nome, cliente_cpf são gerenciados
        // exclusivamente por updateLadoCliente() no backfill
        classe: p.classe,
        assunto: p.assunto,
        evento_prazo: p.evento_prazo,
        prazo_dias: p.prazo_dias,
        data_envio_requisicao: p.data_envio_requisicao,
        data_inicio_prazo: p.data_inicio_prazo,
        data_final_prazo: p.data_final_prazo,
        raw_data: p.raw_data ?? null,
      })),
      { onConflict: 'numero_cnj' }
    )
    .select('numero_cnj');

  if (error) {
    throw new Error(`Erro ao inserir processos em batch: ${error.message}`);
  }

  const insertedCount = data?.length ?? 0;
  logger.info('%d processos upserted (de %d únicos)', insertedCount, uniqueProcessos.length);
  return insertedCount;
}

/**
 * Deleta um processo aberto pelo numero_cnj.
 * Os eventos vinculados são deletados automaticamente (CASCADE).
 */
export async function deleteProcessoAberto(numero_cnj: string): Promise<void> {
  const db = getSupabase();
  const { error } = await db
    .from('processos_abertos')
    .delete()
    .eq('numero_cnj', numero_cnj);

  if (error) {
    throw new Error(`Erro ao deletar processo ${numero_cnj}: ${error.message}`);
  }

  logger.info('Processo removido: %s', numero_cnj);
}

/**
 * Deleta múltiplos processos de uma vez.
 */
export async function deleteProcessosAbertos(numeros_cnj: string[]): Promise<number> {
  if (numeros_cnj.length === 0) return 0;

  const db = getSupabase();
  const { error } = await db
    .from('processos_abertos')
    .delete()
    .in('numero_cnj', numeros_cnj);

  if (error) {
    throw new Error(`Erro ao deletar processos em batch: ${error.message}`);
  }

  logger.info('%d processos removidos', numeros_cnj.length);
  return numeros_cnj.length;
}

// =============================================
// SCRAPER_RUNS
// =============================================

/**
 * Cria um novo registro de execução do scraper.
 */
export async function createScraperRun(): Promise<string> {
  const db = getSupabase();
  const { data, error } = await db
    .from('scraper_runs')
    .insert({ status: 'running' })
    .select('id')
    .single();

  if (error) {
    throw new Error(`Erro ao criar scraper_run: ${error.message}`);
  }

  logger.info({ runId: data.id }, 'Scraper run criado');
  return data.id;
}

/**
 * Atualiza um registro de execução do scraper.
 */
export async function updateScraperRun(
  runId: string,
  updates: {
    status?: ScraperRunStatus;
    processos_encontrados?: number;
    processos_novos?: number;
    processos_removidos?: number;
    error_message?: string;
    error_stack?: string;
  }
): Promise<void> {
  const db = getSupabase();

  const payload: Record<string, unknown> = { ...updates };

  if (updates.status && updates.status !== 'running') {
    payload.finished_at = new Date().toISOString();
  }

  const { error } = await db
    .from('scraper_runs')
    .update(payload)
    .eq('id', runId);

  if (error) {
    logger.error({ err: error.message, runId }, 'Erro ao atualizar scraper_run');
  }
}

// =============================================
// SYNC: Comparação EPROC vs DB
// =============================================

export interface SyncResult {
  novos: ProcessoAberto[];
  removidos: string[];
}

/**
 * Compara a lista do EPROC com o banco de dados.
 * Retorna quais processos são novos e quais devem ser removidos.
 */
export function compareProcessos(
  eprocList: ProcessoAberto[],
  dbMap: Map<string, ProcessoAberto>
): SyncResult {
  const eprocSet = new Set(eprocList.map((p) => p.numero_cnj));

  // Novos: estão no EPROC mas não no DB
  const novos = eprocList.filter((p) => !dbMap.has(p.numero_cnj));

  // Removidos: estão no DB mas não no EPROC
  const removidos: string[] = [];
  for (const numero_cnj of dbMap.keys()) {
    if (!eprocSet.has(numero_cnj)) {
      removidos.push(numero_cnj);
    }
  }

  logger.info(
    'Comparação: %d no EPROC, %d no DB → %d novos, %d removidos',
    eprocList.length,
    dbMap.size,
    novos.length,
    removidos.length
  );

  return { novos, removidos };
}

/**
 * Executa a sincronização completa: upsert de todos e remove fechados.
 */
export async function syncProcessos(
  eprocList: ProcessoAberto[],
  dbMap: Map<string, ProcessoAberto>
): Promise<{ inserted: number; deleted: number }> {
  const { removidos } = compareProcessos(eprocList, dbMap);

  // Upsert de TODOS os processos (insere novos, atualiza existentes)
  const inserted = await insertProcessosAbertos(eprocList);
  const deleted = await deleteProcessosAbertos(removidos);

  return { inserted, deleted };
}

/**
 * Retorna processos que têm lado_cliente = null (para backfill).
 */
export async function getProcessosSemClienteNome(): Promise<ProcessoAberto[]> {
  const db = getSupabase();
  const { data, error } = await db
    .from('processos_abertos')
    .select('*')
    .is('cliente_nome', null);

  if (error) {
    logger.error('Erro ao buscar processos sem cliente_nome: %s', error.message);
    return [];
  }

  return (data ?? []) as ProcessoAberto[];
}

// =============================================
// EVENTOS_PROCESSO
// =============================================

/**
 * Retorna Set de numero_cnj que já têm eventos na tabela eventos_processo.
 * Usado para skip: cruzar com processos_abertos para saber quais já foram extraídos.
 */
export async function getProcessosComEventos(): Promise<Set<string>> {
  const db = getSupabase();
  const { data, error } = await db
    .from('eventos_processo')
    .select('numero_cnj');

  if (error) {
    logger.error('Erro ao buscar processos com eventos: %s', error.message);
    return new Set();
  }

  // Retornar Set de numero_cnj únicos
  return new Set(data?.map(d => d.numero_cnj) ?? []);
}

/**
 * Busca eventos de um processo pelo numero_cnj.
 */
export async function getEventosByProcesso(numero_cnj: string): Promise<EventoProcesso[]> {
  const db = getSupabase();
  const { data, error } = await db
    .from('eventos_processo')
    .select('*')
    .eq('numero_cnj', numero_cnj)
    .order('data_evento', { ascending: false });

  if (error) {
    throw new Error(`Erro ao buscar eventos do processo ${numero_cnj}: ${error.message}`);
  }

  return data ?? [];
}

/**
 * Insere múltiplos eventos de um processo.
 * Primeiro deleta eventos existentes para evitar duplicatas.
 */
export async function syncEventosProcesso(
  numero_cnj: string,
  eventos: EventoProcesso[]
): Promise<number> {
  if (eventos.length === 0) return 0;

  const db = getSupabase();

  // Deletar eventos existentes do processo
  const { error: deleteError } = await db
    .from('eventos_processo')
    .delete()
    .eq('numero_cnj', numero_cnj);

  if (deleteError) {
    logger.warn('Erro ao deletar eventos antigos de %s: %s', numero_cnj, deleteError.message);
  }

  // Inserir novos eventos
  const { data, error } = await db
    .from('eventos_processo')
    .insert(
      eventos.map((e) => ({
        numero_cnj: e.numero_cnj,
        evento_numero: e.evento_numero,
        usuario: e.usuario,
        data_evento: e.data_evento,
        tipo_evento: e.tipo_evento,
        descricao: e.descricao,
        documentos: e.documentos,
        raw_data: e.raw_data ?? null,
      }))
    )
    .select('id');

  if (error) {
    throw new Error(`Erro ao inserir eventos do processo ${numero_cnj}: ${error.message}`);
  }

  const insertedCount = data?.length ?? 0;
  logger.debug('%d eventos inseridos para processo %s', insertedCount, numero_cnj);
  return insertedCount;
}

/**
 * Atualiza o lado_cliente de um processo com base nos advogados detectados.
 */
export async function updateLadoCliente(
  numero_cnj: string,
  lado_cliente: 'requerente' | 'requerido' | 'nao_identificado',
  cliente_nome: string,
  cliente_cpf: string
): Promise<void> {
  const db = getSupabase();
  const { error } = await db
    .from('processos_abertos')
    .update({
      lado_cliente,
      cliente_nome,
      cliente_cpf,
    })
    .eq('numero_cnj', numero_cnj);

  if (error) {
    throw new Error(`Erro ao atualizar lado_cliente de ${numero_cnj}: ${error.message}`);
  }

  logger.debug('lado_cliente atualizado para %s: %s', numero_cnj, lado_cliente);
}

// =============================================
// DOCUMENTOS_PROCESSO
// =============================================

/**
 * Salva referência de documento baixado no banco.
 */
export async function saveDocumento(doc: Omit<DocumentoProcesso, 'id' | 'created_at'>): Promise<string | null> {
  const db = getSupabase();

  const { data, error } = await db
    .from('documentos_processo')
    .insert({
      numero_cnj: doc.numero_cnj,
      evento_numero: doc.evento_numero,
      evento_data: doc.evento_data,
      nome_original: doc.nome_original,
      tipo_arquivo: doc.tipo_arquivo,
      tamanho_bytes: doc.tamanho_bytes,
      storage_path: doc.storage_path,
      storage_url: doc.storage_url,
    })
    .select('id')
    .single();

  if (error) {
    logger.error('Erro ao salvar documento: %s', error.message);
    return null;
  }

  logger.debug('Documento salvo: %s -> %s', doc.nome_original, doc.storage_path);
  return data.id;
}

/**
 * Busca documentos de um processo.
 */
export async function getDocumentosByProcesso(numero_cnj: string): Promise<DocumentoProcesso[]> {
  const db = getSupabase();

  const { data, error } = await db
    .from('documentos_processo')
    .select('*')
    .eq('numero_cnj', numero_cnj)
    .order('evento_numero', { ascending: false });

  if (error) {
    logger.error('Erro ao buscar documentos: %s', error.message);
    return [];
  }

  return data ?? [];
}

/**
 * Verifica se um documento já foi baixado (pelo path).
 */
export async function documentoJaBaixado(storagePath: string): Promise<boolean> {
  const db = getSupabase();

  const { data, error } = await db
    .from('documentos_processo')
    .select('id')
    .eq('storage_path', storagePath)
    .limit(1);

  if (error) {
    return false;
  }

  return (data?.length ?? 0) > 0;
}

/**
 * Deleta referências de documentos de um processo (usado quando processo é removido).
 * Os arquivos no storage são deletados via CASCADE ou manualmente.
 */
export async function deleteDocumentosProcesso(numero_cnj: string): Promise<number> {
  const db = getSupabase();

  const { data, error } = await db
    .from('documentos_processo')
    .delete()
    .eq('numero_cnj', numero_cnj)
    .select('id');

  if (error) {
    logger.error('Erro ao deletar documentos: %s', error.message);
    return 0;
  }

  const count = data?.length ?? 0;
  if (count > 0) {
    logger.debug('%d documentos removidos do processo %s', count, numero_cnj);
  }
  return count;
}
