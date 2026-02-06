import type { Page } from 'puppeteer';
import { logger } from '../utils/logger.js';
import { parseBrazilianDateTime } from '../utils/dates.js';
import type { ProcessoAberto } from '../types/index.js';
import { ADVOGADO_NOME } from '../types/index.js';

/**
 * Extrai prazo em dias de uma string.
 * Ex: "15 dias" → 15
 */
function parsePrazoDias(texto: string): number | null {
  const match = texto.match(/(\d+)\s*dias?/i);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Converte data brasileira para ISO string.
 * Ex: "12/12/2025 16:31:22" → "2025-12-12T16:31:22.000Z"
 */
function toISODate(dateStr: string | null): string | null {
  if (!dateStr) return null;
  const parsed = parseBrazilianDateTime(dateStr);
  return parsed ? parsed.toISOString() : null;
}

/**
 * Normaliza string para comparação: uppercase, remove acentos.
 */
function normalizar(str: string): string {
  return str
    .toUpperCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

/**
 * Verifica se o nome do advogado ou variações aparecem no nome da parte.
 */
function nomeContemAdvogado(nomeParte: string, advogadoNome: string): boolean {
  const parteNorm = normalizar(nomeParte);
  const advNorm = normalizar(advogadoNome);

  // Verificar nome exato
  if (parteNorm.includes(advNorm)) return true;

  // Verificar variação com "SOCIEDADE INDIVIDUAL DE ADVOCACIA"
  const sociedade = `${advNorm} SOCIEDADE INDIVIDUAL DE ADVOCACIA`;
  if (parteNorm.includes(sociedade)) return true;

  // Verificar se a parte contém "SOCIEDADE" e o nome do advogado
  if (parteNorm.includes('ADVOCACIA') && parteNorm.includes(advNorm.split(' ')[0])) {
    return true;
  }

  return false;
}

/**
 * Determina qual lado o advogado representa baseado nas partes.
 * Verifica se o nome do advogado (ou variações como sociedade de advocacia)
 * aparece como uma das partes.
 * Retorna 'requerente', 'requerido' ou null se não conseguir determinar.
 */
function determinarLadoCliente(
  requerenteNome: string,
  requeridoNome: string,
  advogadoNome: string
): 'requerente' | 'requerido' | null {
  // Verificar se o advogado/sociedade aparece como requerente
  if (nomeContemAdvogado(requerenteNome, advogadoNome)) {
    return 'requerente';
  }

  // Verificar se o advogado/sociedade aparece como requerido
  if (nomeContemAdvogado(requeridoNome, advogadoNome)) {
    return 'requerido';
  }

  // Não foi possível determinar pela lista - será determinado na extração de detalhes
  return null;
}

/**
 * Parseia a tabela de processos com prazo em aberto.
 * Retorna array de ProcessoAberto.
 */
export async function parseListaPrazos(page: Page): Promise<ProcessoAberto[]> {
  logger.info('Iniciando parse da lista de prazos...');

  // Extrair dados da tabela via page.evaluate
  const rawData = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('table.infraTable tbody tr'));
    const processos: Array<Record<string, string>> = [];

    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll('td'));
      if (cells.length < 7) continue; // Pular linhas inválidas

      // Estrutura da tabela:
      // [0] Checkbox
      // [1] Processo (número, juízo, partes)
      // [2] Classe
      // [3] Assunto
      // [4] Evento e Prazo
      // [5] Data envio requisição
      // [6] Início Prazo
      // [7] Final Prazo

      const processoCell = cells[1]?.innerHTML || '';
      const classeCell = cells[2]?.textContent?.trim() || '';
      const assuntoCell = cells[3]?.textContent?.trim() || '';
      const eventoCell = cells[4]?.textContent?.trim() || '';
      const dataEnvioCell = cells[5]?.textContent?.trim() || '';
      const inicioCell = cells[6]?.textContent?.trim() || '';
      const finalCell = cells[7]?.textContent?.trim() || '';

      // Extrair número do processo (link)
      const numeroMatch = processoCell.match(/(\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4})/);
      const numeroCnj = numeroMatch ? numeroMatch[1] : '';

      if (!numeroCnj) continue; // Pular se não encontrar número

      // Extrair juízo - formato: <b>Juízo: </b>CRM1CIV1J
      const juizoMatch = processoCell.match(/Ju[íi]zo:\s*<\/b>\s*([A-Z0-9]+)/i);
      const juizo = juizoMatch ? juizoMatch[1] : '';

      // Extrair parte ativa (Autor, Requerente, Exequente, Suscitante, Embargante)
      // Formato: <b>Autor</b><br> NOME<br>(CPF)
      // ou: <b>Autor</b><br><span...>NOME</span><br>(CPF)
      // CPF é opcional (órgãos públicos não têm)
      const parteAtivaRegex = /<b>(Autor|Requerente|Exequente|Suscitante|Embargante)<\/b>(?:<br>|\s)*(?:<[^>]+>)?([^<]+)(?:<\/[^>]+>)?(?:<br>|\s)*(?:\((\d+)\))?/i;
      const parteAtivaMatch = processoCell.match(parteAtivaRegex);
      const parteAtivaTipo = parteAtivaMatch ? parteAtivaMatch[1] : '';
      const parteAtivaNome = parteAtivaMatch ? parteAtivaMatch[2].trim() : '';
      const parteAtivaCpf = parteAtivaMatch && parteAtivaMatch[3] ? parteAtivaMatch[3] : '';

      // Extrair parte passiva (Réu, Requerido, Executado, Suscitado, Embargado)
      // Formato similar ao acima
      // CPF é opcional (órgãos públicos não têm)
      const partePassivaRegex = /<b>(R[ée]u|Requerido|Executado|Suscitado|Embargado)<\/b>(?:<br>|\s)*(?:<[^>]+>)?([^<]+)(?:<\/[^>]+>)?(?:<br>|\s)*(?:\((\d+)\))?/i;
      const partePassivaMatch = processoCell.match(partePassivaRegex);
      const partePassivaTipo = partePassivaMatch ? partePassivaMatch[1] : '';
      const partePassivaNome = partePassivaMatch ? partePassivaMatch[2].trim() : '';
      const partePassivaCpf = partePassivaMatch && partePassivaMatch[3] ? partePassivaMatch[3] : '';

      processos.push({
        numero_cnj: numeroCnj,
        juizo,
        parte_ativa_tipo: parteAtivaTipo,
        parte_ativa_nome: parteAtivaNome,
        parte_ativa_cpf: parteAtivaCpf,
        parte_passiva_tipo: partePassivaTipo,
        parte_passiva_nome: partePassivaNome,
        parte_passiva_cpf: partePassivaCpf,
        classe: classeCell,
        assunto: assuntoCell,
        evento_prazo: eventoCell,
        data_envio: dataEnvioCell,
        inicio_prazo: inicioCell,
        final_prazo: finalCell,
        raw_html: processoCell,
      });
    }

    return processos;
  });

  logger.info('Extraídas %d linhas da tabela', rawData.length);

  // Debug: mostrar dados extraídos da primeira célula
  if (rawData.length > 0) {
    const sample = rawData[0];
    logger.info({
      numero_cnj: sample.numero_cnj,
      juizo: sample.juizo,
      parte_ativa: `${sample.parte_ativa_tipo}: ${sample.parte_ativa_nome} (${sample.parte_ativa_cpf})`,
      parte_passiva: `${sample.parte_passiva_tipo}: ${sample.parte_passiva_nome} (${sample.parte_passiva_cpf})`,
    }, 'Amostra de dados extraídos');
  }

  // Processar dados brutos
  const processos: ProcessoAberto[] = [];

  for (const raw of rawData) {
    // Parte ativa = requerente (Autor, Requerente, Exequente)
    // Parte passiva = requerido (Réu, Requerido, Executado)
    const requerenteNome = raw.parte_ativa_nome;
    const requerenteCpf = raw.parte_ativa_cpf;
    const requeridoNome = raw.parte_passiva_nome;
    const requeridoCpf = raw.parte_passiva_cpf;

    const lado = determinarLadoCliente(requerenteNome, requeridoNome, ADVOGADO_NOME);

    const processo: ProcessoAberto = {
      numero_cnj: raw.numero_cnj,
      juizo: raw.juizo,
      requerente_nome: requerenteNome,
      requerente_cpf: requerenteCpf,
      requerido_nome: requeridoNome,
      requerido_cpf: requeridoCpf,
      lado_cliente: lado,
      cliente_nome: lado === 'requerente' ? requerenteNome : lado === 'requerido' ? requeridoNome : null,
      cliente_cpf: lado === 'requerente' ? requerenteCpf : lado === 'requerido' ? requeridoCpf : null,
      classe: raw.classe,
      assunto: raw.assunto,
      evento_prazo: raw.evento_prazo,
      prazo_dias: parsePrazoDias(raw.evento_prazo),
      data_envio_requisicao: toISODate(raw.data_envio),
      data_inicio_prazo: toISODate(raw.inicio_prazo),
      data_final_prazo: toISODate(raw.final_prazo),
      raw_data: { raw_html: raw.raw_html },
    };

    processos.push(processo);
  }

  // Estatísticas de detecção de lado_cliente
  const comLado = processos.filter((p) => p.lado_cliente !== null).length;
  const semLado = processos.length - comLado;
  logger.info(
    'Parse completo: %d processos extraídos (lado_cliente detectado: %d, pendente: %d)',
    processos.length,
    comLado,
    semLado
  );

  return processos;
}

/**
 * Debug: lista estrutura da tabela encontrada na página.
 */
export async function debugTabelaEstrutura(page: Page): Promise<void> {
  const info = await page.evaluate(() => {
    const tables = Array.from(document.querySelectorAll('table'));
    return tables.map((t, i) => {
      const headers = Array.from(t.querySelectorAll('th')).map((th) => th.textContent?.trim());
      const rowCount = t.querySelectorAll('tbody tr').length;
      return { index: i, headers, rowCount, id: t.id, class: t.className };
    });
  });

  logger.info({ tabelas: info }, 'Tabelas encontradas na página');
}
