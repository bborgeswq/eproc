import { getSupabase } from './database.js';
import { logger } from '../utils/logger.js';

const BUCKET_NAME = 'documentos-eproc';

/**
 * Verifica se o bucket existe e está acessível.
 */
export async function checkBucket(): Promise<boolean> {
  const supabase = getSupabase();

  const { data, error } = await supabase.storage.getBucket(BUCKET_NAME);

  if (error) {
    logger.warn('Bucket %s não encontrado ou inacessível: %s', BUCKET_NAME, error.message);
    return false;
  }

  logger.debug('Bucket %s verificado com sucesso', BUCKET_NAME);
  return true;
}

/**
 * Gera o path de armazenamento para um documento.
 * Formato: {numero_cnj}/evento_{numero}/{nome_documento}
 */
export function gerarStoragePath(
  numeroCnj: string,
  eventoNumero: number,
  nomeDocumento: string
): string {
  // Sanitizar o número CNJ (remover caracteres especiais)
  const cnjSanitizado = numeroCnj.replace(/[^0-9]/g, '');
  // Sanitizar nome do documento
  const nomeSanitizado = nomeDocumento.replace(/[^a-zA-Z0-9._-]/g, '_');

  return `${cnjSanitizado}/evento_${eventoNumero}/${nomeSanitizado}`;
}

/**
 * Upload de arquivo para o Supabase Storage.
 * Retorna o path do arquivo no storage.
 */
export async function uploadDocumento(
  fileBuffer: Buffer,
  storagePath: string,
  contentType: string = 'application/pdf'
): Promise<{ path: string; error: string | null }> {
  const supabase = getSupabase();

  logger.debug('Uploading documento para %s/%s', BUCKET_NAME, storagePath);

  const { data, error } = await supabase.storage
    .from(BUCKET_NAME)
    .upload(storagePath, fileBuffer, {
      contentType,
      upsert: true, // Sobrescrever se existir
    });

  if (error) {
    logger.error('Erro ao fazer upload: %s', error.message);
    return { path: '', error: error.message };
  }

  logger.info('Documento uploaded: %s', data.path);
  return { path: data.path, error: null };
}

/**
 * Gera URL assinada para download do documento.
 * URL válida por 1 hora por padrão.
 */
export async function getSignedUrl(
  storagePath: string,
  expiresInSeconds: number = 3600
): Promise<string | null> {
  const supabase = getSupabase();

  const { data, error } = await supabase.storage
    .from(BUCKET_NAME)
    .createSignedUrl(storagePath, expiresInSeconds);

  if (error) {
    logger.error('Erro ao gerar URL assinada: %s', error.message);
    return null;
  }

  return data.signedUrl;
}

/**
 * Gera URL pública (se o bucket for público).
 * Para buckets privados, use getSignedUrl.
 */
export function getPublicUrl(storagePath: string): string {
  const supabase = getSupabase();

  const { data } = supabase.storage.from(BUCKET_NAME).getPublicUrl(storagePath);

  return data.publicUrl;
}

/**
 * Deleta um documento do storage.
 */
export async function deleteDocumento(storagePath: string): Promise<boolean> {
  const supabase = getSupabase();

  const { error } = await supabase.storage.from(BUCKET_NAME).remove([storagePath]);

  if (error) {
    logger.error('Erro ao deletar documento: %s', error.message);
    return false;
  }

  logger.debug('Documento deletado: %s', storagePath);
  return true;
}

/**
 * Lista documentos de um processo no storage.
 */
export async function listDocumentosProcesso(numeroCnj: string): Promise<string[]> {
  const supabase = getSupabase();
  const cnjSanitizado = numeroCnj.replace(/[^0-9]/g, '');

  const { data, error } = await supabase.storage.from(BUCKET_NAME).list(cnjSanitizado, {
    sortBy: { column: 'created_at', order: 'desc' },
  });

  if (error) {
    logger.error('Erro ao listar documentos: %s', error.message);
    return [];
  }

  return data?.map((file) => `${cnjSanitizado}/${file.name}`) ?? [];
}
