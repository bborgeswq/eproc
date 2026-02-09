import type { Page, Browser } from 'puppeteer';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { randomDelay } from '../utils/dates.js';
import { parseListaPrazos, debugTabelaEstrutura } from '../parsers/prazo-list.js';
import { parseEventosProcesso, parseDetalhesProcesso } from '../parsers/eventos.js';
import { saveFullPageHtml, analyzeProcessoCells } from '../utils/debug-html.js';
import { syncEventosProcesso, updateLadoCliente, saveDocumento, documentoJaBaixado } from './database.js';
import { uploadDocumento, gerarStoragePath, getSignedUrl } from './storage.js';
import type { ProcessoAberto, EventoProcesso } from '../types/index.js';

/**
 * Aguarda uma nova aba ser aberta e retorna a Page dela.
 */
async function waitForNewTab(browser: Browser, timeout = 10000): Promise<Page> {
  const startPages = await browser.pages();
  const startCount = startPages.length;

  logger.debug('Aguardando nova aba... (atual: %d abas)', startCount);

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error(`Timeout aguardando nova aba após ${timeout}ms`));
    }, timeout);

    browser.on('targetcreated', async (target) => {
      if (target.type() === 'page') {
        clearTimeout(timeoutId);
        const newPage = await target.page();
        if (newPage) {
          logger.debug('Nova aba detectada!');
          resolve(newPage);
        }
      }
    });
  });
}

/**
 * Navega até o Painel do Advogado no menu lateral.
 */
export async function navegarParaPainelAdvogado(page: Page): Promise<void> {
  logger.info('Navegando para Painel do Advogado...');

  // Clicar no menu "Painel do Advogado" no sidebar
  const clicked = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a'));
    const painelLink = links.find(
      (a) =>
        a.textContent?.includes('Painel do Advogado') ||
        a.href?.includes('painel_advogado')
    );

    if (painelLink) {
      painelLink.click();
      return true;
    }
    return false;
  });

  if (!clicked) {
    if (env.DEBUG_MODE) {
      await page.screenshot({ path: 'debug-no-painel-link.png' });
    }
    throw new Error('Link "Painel do Advogado" não encontrado no menu');
  }

  await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {
    logger.debug('waitForNavigation timeout — verificando estado');
  });

  await randomDelay(1000, 2000);
  logger.info('Painel do Advogado carregado. URL: %s', page.url());

  if (env.DEBUG_MODE) {
    await page.screenshot({ path: 'debug-painel-advogado.png' });
  }
}

/**
 * Clica no número azul de "Processos com prazo em aberto".
 * O EPROC abre em NOVA ABA, então precisamos capturá-la.
 */
export async function navegarParaListaPrazos(page: Page, browser: Browser): Promise<Page> {
  logger.info('Navegando para lista de processos com prazo em aberto...');

  // Preparar listener para nova aba ANTES de clicar
  const newTabPromise = waitForNewTab(browser, 15000);

  // Clicar no link que abre em nova aba
  const clicked = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('table tr'));

    for (const row of rows) {
      const cells = row.querySelectorAll('td');
      if (cells.length >= 2) {
        const tipoText = cells[0]?.textContent?.trim() || '';

        // Linha exata: "Processos com prazo em aberto" (sem "urgente")
        if (tipoText === 'Processos com prazo em aberto') {
          const link = cells[1]?.querySelector('a');
          if (link) {
            link.click();
            return { found: true, text: tipoText, href: link.href };
          }
        }
      }
    }

    // Fallback: qualquer link com "prazos_abertos" ou "citacao_intimacao"
    const allLinks = Array.from(document.querySelectorAll('a'));
    const prazoLink = allLinks.find(
      (a) =>
        a.href?.includes('prazos_abertos') ||
        a.href?.includes('citacao_intimacao')
    );

    if (prazoLink) {
      prazoLink.click();
      return { found: true, text: 'fallback', href: prazoLink.href };
    }

    return { found: false, text: '', href: '' };
  });

  if (!clicked.found) {
    if (env.DEBUG_MODE) {
      await page.screenshot({ path: 'debug-no-prazo-link.png' });
    }
    throw new Error('Link para lista de prazos não encontrado');
  }

  logger.debug('Link clicado: %s → %s', clicked.text, clicked.href);

  // Aguardar a nova aba abrir
  let newPage: Page;
  try {
    newPage = await newTabPromise;
  } catch {
    // Se não abriu nova aba, talvez tenha navegado na mesma aba
    logger.warn('Nova aba não detectada, verificando aba atual...');
    await randomDelay(2000, 3000);

    // Verificar se a URL mudou na aba atual
    const currentUrl = page.url();
    if (currentUrl.includes('prazos_abertos') || currentUrl.includes('citacao_intimacao')) {
      logger.info('Navegação ocorreu na mesma aba');
      return page;
    }

    // Verificar se há outra aba aberta
    const allPages = await browser.pages();
    if (allPages.length > 1) {
      newPage = allPages[allPages.length - 1];
      logger.info('Usando última aba aberta');
    } else {
      throw new Error('Não foi possível detectar a página de prazos');
    }
  }

  // Aguardar a nova aba carregar
  await newPage.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {
    logger.debug('waitForNavigation na nova aba timeout');
  });

  await randomDelay(1500, 2500);
  logger.info('Lista de prazos carregada. URL: %s', newPage.url());

  if (env.DEBUG_MODE) {
    await newPage.screenshot({ path: 'debug-lista-prazos.png' });
    await debugTabelaEstrutura(newPage);
  }

  return newPage;
}

/**
 * Extrai a lista de processos com prazo em aberto.
 */
export async function extrairListaPrazos(page: Page): Promise<ProcessoAberto[]> {
  logger.info('Extraindo lista de processos...');

  // Aguardar tabela carregar
  await page.waitForSelector('table tbody tr', { timeout: 15000 }).catch(() => {
    logger.warn('Timeout aguardando tabela — tentando parse mesmo assim');
  });

  await randomDelay(500, 1000);

  // Verificar quantos registros existem
  const info = await page.evaluate(() => {
    const text = document.body.innerText;
    const match = text.match(/\((\d+)\s*registros?\)/i);
    return {
      totalRegistros: match ? parseInt(match[1], 10) : null,
      url: window.location.href,
    };
  });

  logger.info('Página indica %s registros', info.totalRegistros ?? 'N/A');

  // DEBUG: Salvar HTML e analisar células (apenas em modo debug)
  if (env.DEBUG_MODE) {
    await saveFullPageHtml(page, 'lista-prazos-full.html');
    await analyzeProcessoCells(page);
  }

  // Parsear tabela
  const processos = await parseListaPrazos(page);

  return processos;
}

/**
 * Fluxo completo: navega e extrai lista de prazos.
 * Retorna os processos E a página da lista (para uso na Fase 2).
 */
export async function obterProcessosComPrazoAberto(
  page: Page,
  browser: Browser
): Promise<{ processos: ProcessoAberto[]; listPage: Page }> {
  // 1. Ir para Painel do Advogado
  await navegarParaPainelAdvogado(page);

  // 2. Clicar no número de processos com prazo em aberto (abre nova aba)
  const listPage = await navegarParaListaPrazos(page, browser);

  // 3. Extrair dados da tabela
  const processos = await extrairListaPrazos(listPage);

  // 4. NÃO fechar a aba - será usada na Fase 2 para clicar nos processos
  // A aba será fechada pelo chamador após a Fase 2

  return { processos, listPage };
}

// =============================================
// FASE 2: EXTRAÇÃO DE DETALHES E EVENTOS
// =============================================

/**
 * Navega para a página de detalhes de um processo.
 */
export async function navegarParaDetalhesProcesso(
  page: Page,
  browser: Browser,
  numeroCnj: string
): Promise<Page> {
  logger.debug('Navegando para detalhes do processo %s...', numeroCnj);

  // Preparar listener para nova aba
  const newTabPromise = waitForNewTab(browser, 15000);

  // Clicar no link do processo
  const clicked = await page.evaluate((cnj) => {
    const links = Array.from(document.querySelectorAll('a'));
    const processoLink = links.find((a) => a.textContent?.includes(cnj) || a.href?.includes(cnj.replace(/-|\./g, '')));

    if (processoLink) {
      processoLink.click();
      return { found: true, href: processoLink.href };
    }
    return { found: false, href: '' };
  }, numeroCnj);

  if (!clicked.found) {
    throw new Error(`Link para processo ${numeroCnj} não encontrado`);
  }

  // Aguardar nova aba ou navegação
  let detailPage: Page;
  try {
    detailPage = await newTabPromise;
  } catch {
    // Navegou na mesma aba
    detailPage = page;
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
  }

  await randomDelay(1000, 2000);
  logger.debug('Página de detalhes carregada: %s', detailPage.url());

  return detailPage;
}

/**
 * Normaliza string para comparação.
 */
function normalizar(str: string): string {
  return str
    .toUpperCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

/**
 * Verifica se o advogado está na lista de advogados.
 */
function advogadoNaLista(advogados: string[], advogadoNome: string): boolean {
  const advNorm = normalizar(advogadoNome);
  return advogados.some((adv) => normalizar(adv).includes(advNorm));
}

/**
 * Extrai detalhes, eventos e documentos de um processo individual.
 * Salva apenas eventos relevantes (>= evento_referenciado do prazo aberto).
 */
export async function extrairDetalhesProcesso(
  page: Page,
  browser: Browser,
  processo: ProcessoAberto
): Promise<{ eventos: EventoProcesso[]; ladoAtualizado: boolean; documentosBaixados: number }> {
  const numeroCnj = processo.numero_cnj;
  let ladoAtualizado = false;
  let documentosBaixados = 0;

  try {
    // Navegar para detalhes
    const detailPage = await navegarParaDetalhesProcesso(page, browser, numeroCnj);

    // Extrair TODOS os eventos da página
    const todosEventos = await parseEventosProcesso(detailPage, numeroCnj);

    // Identificar evento de prazo aberto para filtrar eventos relevantes
    const eventoPrazo = todosEventos.find(e => e.is_prazo_aberto);
    const eventoBase = eventoPrazo?.evento_referenciado ?? 0;

    // Filtrar apenas eventos relevantes (>= evento referenciado)
    const eventosRelevantes = eventoBase > 0
      ? todosEventos.filter(e => (e.evento_numero ?? 0) >= eventoBase)
      : todosEventos;

    logger.info(
      'Eventos filtrados: %d de %d (base: evento %d)',
      eventosRelevantes.length,
      todosEventos.length,
      eventoBase
    );

    // Sincronizar apenas eventos relevantes no banco
    if (eventosRelevantes.length > 0) {
      await syncEventosProcesso(numeroCnj, eventosRelevantes);
    }

    // Se lado_cliente ainda não foi determinado, tentar pelos advogados
    if (!processo.lado_cliente) {
      const detalhes = await parseDetalhesProcesso(detailPage);

      // Verificar se o advogado está na lista de advogados do requerente
      if (advogadoNaLista(detalhes.advogadosRequerente, env.ADVOGADO_NAME)) {
        await updateLadoCliente(
          numeroCnj,
          'requerente',
          processo.requerente_nome,
          processo.requerente_cpf
        );
        ladoAtualizado = true;
        logger.info('lado_cliente detectado para %s: requerente', numeroCnj);
      }
      // Verificar se está na lista de advogados do requerido
      else if (advogadoNaLista(detalhes.advogadosRequerido, env.ADVOGADO_NAME)) {
        await updateLadoCliente(
          numeroCnj,
          'requerido',
          processo.requerido_nome,
          processo.requerido_cpf
        );
        ladoAtualizado = true;
        logger.info('lado_cliente detectado para %s: requerido', numeroCnj);
      }
    }

    // FASE 3: Baixar documentos relevantes (baseado em eventos de prazo aberto)
    // Usa todosEventos pois a função já filtra internamente
    if (todosEventos.length > 0) {
      documentosBaixados = await processarDocumentosProcesso(
        detailPage,
        browser,
        numeroCnj,
        todosEventos
      );
    }

    // Fechar aba se for diferente
    if (detailPage !== page) {
      await detailPage.close();
    }

    return { eventos: eventosRelevantes, ladoAtualizado, documentosBaixados };

  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error({ err, numeroCnj }, 'Erro ao extrair detalhes do processo');
    return { eventos: [], ladoAtualizado: false, documentosBaixados: 0 };
  }
}

/**
 * Extrai detalhes, eventos e documentos de múltiplos processos.
 * Limita a quantidade por ciclo para não sobrecarregar.
 * Skip: cruza processos_abertos (Tabela 1) com eventos_processo (Tabela 2).
 */
export async function extrairDetalhesProcessos(
  page: Page,
  browser: Browser,
  processos: ProcessoAberto[],
  maxPorCiclo: number,
  processosComEventos: Set<string>
): Promise<{ totalEventos: number; ladosAtualizados: number; totalDocumentos: number; todosProcessados: boolean }> {
  // Filtrar: excluir processos que já têm eventos na Tabela 2
  const candidatos = processos.filter(p => !processosComEventos.has(p.numero_cnj));

  logger.info(
    'Candidatos para extração: %d (de %d total, %d já têm eventos)',
    candidatos.length,
    processos.length,
    processosComEventos.size
  );

  // Se não há candidatos, todos já foram processados
  if (candidatos.length === 0) {
    logger.info('Todos os processos já foram extraídos!');
    return { totalEventos: 0, ladosAtualizados: 0, totalDocumentos: 0, todosProcessados: true };
  }

  // Selecionar até maxPorCiclo processos
  const ordenados = candidatos.slice(0, maxPorCiclo);

  logger.info('Extraindo detalhes de %d processos', ordenados.length);

  let totalEventos = 0;
  let ladosAtualizados = 0;
  let totalDocumentos = 0;

  for (let i = 0; i < ordenados.length; i++) {
    const processo = ordenados[i];
    logger.info('[%d/%d] Processando %s...', i + 1, ordenados.length, processo.numero_cnj);

    const result = await extrairDetalhesProcesso(page, browser, processo);

    totalEventos += result.eventos.length;
    if (result.ladoAtualizado) ladosAtualizados++;
    totalDocumentos += result.documentosBaixados;

    // Delay entre processos para não sobrecarregar
    await randomDelay(2000, 4000);
  }

  logger.info(
    'Extração concluída: %d eventos, %d lados atualizados, %d docs baixados',
    totalEventos,
    ladosAtualizados,
    totalDocumentos
  );

  // Verificar se ainda há candidatos restantes
  const restantes = candidatos.length - ordenados.length;
  const todosProcessados = restantes === 0;

  if (todosProcessados) {
    logger.info('Todos os processos foram extraídos neste ciclo!');
  } else {
    logger.info('%d processos restantes para próximos ciclos', restantes);
  }

  return { totalEventos, ladosAtualizados, totalDocumentos, todosProcessados };
}

// =============================================
// FASE 3: DOWNLOAD DE DOCUMENTOS
// =============================================

/**
 * Identifica eventos relevantes para download de documentos.
 * Nova lógica: busca evento de PRAZO ABERTO (amarelo), pega o evento referenciado,
 * e baixa documentos de todos os eventos >= evento referenciado.
 */
export function identificarEventosComDocumentos(
  eventos: EventoProcesso[]
): EventoProcesso[] {
  if (eventos.length === 0) return [];

  // 1. Encontrar TODOS os eventos de prazo aberto e usar o menor evento_referenciado.
  // Um processo pode ter múltiplas intimações (ex: eventos 108, 109, 110) para
  // partes diferentes, todas referenciando o mesmo ou diferentes eventos base.
  const prazosAbertos = eventos.filter(
    (e) => e.is_prazo_aberto && e.evento_referenciado !== null
  );

  if (prazosAbertos.length === 0) {
    logger.debug('Nenhum evento de prazo aberto encontrado');
    return [];
  }

  // Usar o menor evento_referenciado para não perder documentos
  const eventoRef = Math.min(...prazosAbertos.map((e) => e.evento_referenciado!));
  logger.info(
    'Prazo aberto: %d intimações encontradas, menor evento referenciado: %d',
    prazosAbertos.length,
    eventoRef
  );

  // 2. Filtrar eventos >= evento referenciado que têm documentos
  const eventosRelevantes = eventos.filter((e) => {
    const num = e.evento_numero ?? 0;
    const temDocs = e.documentos && e.documentos.length > 0;
    return num >= eventoRef && temDocs;
  });

  // Ordenar por número do evento (crescente - do referenciado para cima)
  eventosRelevantes.sort((a, b) => (a.evento_numero ?? 0) - (b.evento_numero ?? 0));

  logger.info(
    'Eventos com documentos a baixar: %d (eventos %d a %d)',
    eventosRelevantes.length,
    eventosRelevantes[0]?.evento_numero ?? 0,
    eventosRelevantes[eventosRelevantes.length - 1]?.evento_numero ?? 0
  );

  return eventosRelevantes;
}

/**
 * Baixa um documento clicando no link e capturando o PDF.
 * Retorna o buffer do arquivo ou null em caso de erro.
 */
export async function baixarDocumento(
  page: Page,
  browser: Browser,
  docUrl: string,
  docNome: string
): Promise<{ buffer: Buffer; contentType: string } | null> {
  logger.debug('Baixando documento: %s', docNome);

  let docPage: Page | null = null;

  try {
    // Abrir nova aba para download (NÃO tocar na página principal)
    docPage = await browser.newPage();

    // Copiar cookies da sessão autenticada
    const cookies = await page.cookies();
    await docPage.setCookie(...cookies);

    // Autenticar proxy na nova aba (se configurado)
    if (env.PROXY_USER && env.PROXY_PASS) {
      await docPage.authenticate({
        username: env.PROXY_USER,
        password: env.PROXY_PASS,
      });
    }

    // Interceptar a resposta HTTP para capturar os bytes brutos do documento.
    // Isso funciona tanto para PDFs nativos quanto para páginas HTML.
    let responseBuffer: Buffer | null = null;
    let responseContentType = 'application/pdf';

    docPage.on('response', async (response) => {
      if (response.url() === docUrl || response.url().startsWith(docUrl.split('?')[0])) {
        try {
          const ct = response.headers()['content-type'] || '';
          if (ct.includes('pdf') || ct.includes('html') || ct.includes('octet-stream')) {
            responseContentType = ct.split(';')[0].trim();
            responseBuffer = Buffer.from(await response.buffer());
          }
        } catch {
          // Resposta já consumida ou indisponível — ignorar
        }
      }
    });

    // Navegar para o documento
    const response = await docPage.goto(docUrl, { waitUntil: 'networkidle2', timeout: 60000 });

    // Tentar capturar do response direto (mais confiável)
    if (!responseBuffer && response) {
      try {
        const ct = response.headers()['content-type'] || '';
        responseContentType = ct.split(';')[0].trim() || 'application/pdf';
        responseBuffer = Buffer.from(await response.buffer());
      } catch {
        // Response buffer indisponível
      }
    }

    // Fallback: se o conteúdo é HTML, renderizar como PDF
    if (!responseBuffer || responseContentType.includes('html')) {
      try {
        const pdfData = await docPage.pdf({ format: 'A4', printBackground: true });
        responseBuffer = Buffer.from(pdfData);
        responseContentType = 'application/pdf';
      } catch {
        // Se pdf() também falhar, usar o que temos do response
      }
    }

    // Fechar aba do documento
    await docPage.close();
    docPage = null;

    if (!responseBuffer || responseBuffer.length === 0) {
      logger.warn('Documento vazio ou não capturado: %s', docNome);
      return null;
    }

    logger.debug('Documento baixado: %s (%d bytes, %s)', docNome, responseBuffer.length, responseContentType);
    return { buffer: responseBuffer, contentType: responseContentType };

  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error({ err }, 'Erro ao baixar documento: %s', docNome);

    // Fechar aba se ainda estiver aberta
    if (docPage) {
      await docPage.close().catch(() => {});
    }

    return null;
  }
}

/**
 * Processa e baixa documentos de eventos relevantes de um processo.
 */
export async function processarDocumentosProcesso(
  page: Page,
  browser: Browser,
  numeroCnj: string,
  eventos: EventoProcesso[]
): Promise<number> {
  const eventosRelevantes = identificarEventosComDocumentos(eventos);

  if (eventosRelevantes.length === 0) {
    logger.debug('Nenhum documento relevante para %s', numeroCnj);
    return 0;
  }

  let documentosBaixados = 0;

  // Log: mostrar documentos encontrados (usar logger.info para visibilidade)
  for (const evento of eventosRelevantes) {
    logger.info(
      'Evento %d: %d documentos encontrados',
      evento.evento_numero ?? 0,
      evento.documentos?.length ?? 0
    );
    if (evento.documentos) {
      for (const d of evento.documentos) {
        logger.info('  - Doc: %s, URL: %s', d.nome, d.url ? d.url.substring(0, 60) + '...' : 'SEM URL');
      }
    }
  }

  logger.info('Iniciando loop de download para %d eventos', eventosRelevantes.length);

  for (const evento of eventosRelevantes) {
    if (!evento.documentos) {
      logger.info('Evento %d sem documentos array', evento.evento_numero ?? 0);
      continue;
    }

    logger.info('Processando %d documentos do evento %d', evento.documentos.length, evento.evento_numero ?? 0);

    for (const doc of evento.documentos) {
      if (!doc.url) {
        logger.warn('Documento sem URL: %s (evento %d)', doc.nome, evento.evento_numero ?? 0);
        continue;
      }

      // Gerar path de armazenamento
      const storagePath = gerarStoragePath(
        numeroCnj,
        evento.evento_numero ?? 0,
        doc.nome + '.pdf'
      );

      logger.info('Verificando se documento já baixado: %s', storagePath);

      // Verificar se já foi baixado
      const jaBaixado = await documentoJaBaixado(storagePath);
      if (jaBaixado) {
        logger.info('Documento já baixado, pulando: %s', storagePath);
        continue;
      }

      logger.info('Baixando documento: %s -> %s', doc.nome, doc.url.substring(0, 80));

      // Baixar documento
      const resultado = await baixarDocumento(page, browser, doc.url, doc.nome);
      if (!resultado) {
        logger.warn('Falha no download do documento: %s', doc.nome);
        continue;
      }

      // Upload para Supabase Storage
      const { path, error } = await uploadDocumento(
        resultado.buffer,
        storagePath,
        resultado.contentType
      );

      if (error) {
        logger.error('Erro no upload: %s', error);
        continue;
      }

      // Gerar URL assinada
      const signedUrl = await getSignedUrl(path);

      // Salvar referência no banco
      await saveDocumento({
        numero_cnj: numeroCnj,
        evento_numero: evento.evento_numero ?? 0,
        evento_data: evento.data_evento,
        nome_original: doc.nome,
        tipo_arquivo: doc.tipo,
        tamanho_bytes: resultado.buffer.length,
        storage_path: path,
        storage_url: signedUrl,
      });

      documentosBaixados++;
      logger.info('Documento salvo: %s -> %s', doc.nome, path);

      // Delay entre downloads
      await randomDelay(1000, 2000);
    }
  }

  return documentosBaixados;
}
