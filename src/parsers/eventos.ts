import type { Page } from 'puppeteer';
import { logger } from '../utils/logger.js';
import { parseBrazilianDateTime } from '../utils/dates.js';
import type { EventoProcesso, DocumentoAnexo } from '../types/index.js';
import { COR_PRAZO_ABERTO } from '../types/index.js';

/**
 * Converte data brasileira para ISO string.
 */
function toISODate(dateStr: string | null): string | null {
  if (!dateStr) return null;
  const parsed = parseBrazilianDateTime(dateStr);
  return parsed ? parsed.toISOString() : null;
}

/**
 * Extrai eventos/movimentações da página de detalhes de um processo.
 * Estrutura da tabela EPROC: Evento | Data/Hora | Descrição | Usuário | Documentos
 * Retorna array de EventoProcesso.
 */
export async function parseEventosProcesso(page: Page, numeroCnj: string): Promise<EventoProcesso[]> {
  logger.debug('Extraindo eventos do processo %s...', numeroCnj);

  const rawEventos = await page.evaluate(() => {
    const eventos: Array<{
      eventoNumero: number | null;
      data: string;
      descricao: string;
      usuario: string;
      documentos: Array<{ nome: string; tipo: string; url: string }>;
      rawHtml: string;
      descricaoBgColor: string;
      eventoReferenciado: number | null;
    }> = [];

    // Buscar tabela de eventos - procurar por caption ou th com "Eventos"
    const tabelas = Array.from(document.querySelectorAll('table'));
    let tabelaEventos: Element | null = null;

    for (const tabela of tabelas) {
      const caption = tabela.querySelector('caption');
      const headers = tabela.querySelectorAll('th');
      const headerText = Array.from(headers).map((h) => h.textContent || '').join(' ');

      if (
        caption?.textContent?.toLowerCase().includes('eventos') ||
        headerText.toLowerCase().includes('evento')
      ) {
        tabelaEventos = tabela;
        break;
      }
    }

    if (!tabelaEventos) {
      return eventos;
    }

    // Processar linhas da tabela
    const linhas = Array.from(tabelaEventos.querySelectorAll('tbody tr, tr:not(:first-child)'));

    for (const linha of linhas) {
      const celulas = Array.from(linha.querySelectorAll('td'));
      if (celulas.length < 3) continue;

      // Estrutura: [Evento, Data/Hora, Descrição, Usuário, Documentos]
      // Índices podem variar, vamos detectar pelo conteúdo

      // Primeira célula geralmente tem o número do evento
      const primeiracelula = celulas[0]?.textContent?.trim() || '';
      const eventoMatch = primeiracelula.match(/^(\d+)/);
      const eventoNumero = eventoMatch ? parseInt(eventoMatch[1], 10) : null;

      // Segunda célula: Data/Hora
      const dataTexto = celulas[1]?.textContent?.trim() || '';

      // Terceira célula: Descrição (pode conter tipo do evento destacado)
      const descricaoCell = celulas[2] as HTMLElement;
      const descricao = descricaoCell?.textContent?.trim() || '';

      // Extrair cor de fundo da célula de descrição (para detectar prazo aberto)
      const descricaoBgColor = descricaoCell
        ? window.getComputedStyle(descricaoCell).backgroundColor
        : '';

      // Extrair evento referenciado do texto (ex: "Refer. ao Evento 91")
      const refMatch = descricao.match(/Refer\.\s*ao\s*Evento\s*(\d+)/i);
      const eventoReferenciado = refMatch ? parseInt(refMatch[1], 10) : null;

      // Quarta célula: Usuário
      const usuario = celulas[3]?.textContent?.trim() || '';

      // Quinta célula ou links na linha: Documentos
      const docs: Array<{ nome: string; tipo: string; url: string }> = [];

      // Buscar links de documentos em TODA a linha (mais robusto)
      // No EPROC, documentos podem estar em qualquer célula e têm padrões específicos
      const todosLinks = Array.from(linha.querySelectorAll('a'));

      for (const link of todosLinks) {
        const anchor = link as HTMLAnchorElement;
        const href = anchor.href || '';
        const nome = link.textContent?.trim() || '';
        const onclick = anchor.getAttribute('onclick') || '';

        // Ignorar links que não são documentos
        if (!href || href === '#') continue;
        if (nome.length < 2) continue;

        // Padrões de links de documentos no EPROC:
        // 1. URL contém 'documento', 'anexo', 'download'
        // 2. Nome contém padrões como 'PET', 'SENT', 'DEC', 'ATO', etc.
        // 3. Link tem onclick com 'abrirDocumento' ou similar
        const isDocUrl = /documento|anexo|download|acao=acessar/i.test(href);
        const isDocNome = /^(PET|SENT|DEC|ATO|DESP|CERT|MAND|OFIC|CONT|PROC|EMBDEC|APELA|EMAIL|ATOORD|DESPADEC|EXTATO)\d*/i.test(nome);
        const isDocOnclick = /abrirDocumento|visualizar/i.test(onclick);

        if (isDocUrl || isDocNome || isDocOnclick) {
          const tipo = href.toLowerCase().includes('.pdf') ? 'pdf' : 'outro';
          docs.push({ nome, tipo, url: href });
        }
      }

      if (eventoNumero || dataTexto || descricao) {
        eventos.push({
          eventoNumero,
          data: dataTexto,
          descricao,
          usuario,
          documentos: docs,
          rawHtml: linha.innerHTML,
          descricaoBgColor,
          eventoReferenciado,
        });
      }
    }

    return eventos;
  });

  // Processar dados brutos
  const eventos: EventoProcesso[] = rawEventos.map((raw) => ({
    numero_cnj: numeroCnj,
    evento_numero: raw.eventoNumero,
    usuario: raw.usuario || null,
    data_evento: toISODate(raw.data),
    tipo_evento: null, // Tipo está embutido na descrição
    descricao: raw.descricao || null,
    documentos: raw.documentos.length > 0 ? raw.documentos : null,
    raw_data: { raw_html: raw.rawHtml },
    // Campos de prazo: amarelo = prazo aberto
    is_prazo_aberto: raw.descricaoBgColor === COR_PRAZO_ABERTO,
    evento_referenciado: raw.eventoReferenciado,
  }));

  // Log de debug: mostrar eventos de prazo aberto encontrados
  const eventosComPrazoAberto = eventos.filter((e) => e.is_prazo_aberto);
  if (eventosComPrazoAberto.length > 0) {
    for (const e of eventosComPrazoAberto) {
      logger.info(
        'Prazo ABERTO detectado: evento %d referencia evento %d',
        e.evento_numero ?? 0,
        e.evento_referenciado ?? 0
      );
    }
  }

  logger.debug('Extraídos %d eventos do processo %s', eventos.length, numeroCnj);
  return eventos;
}

/**
 * Extrai informações detalhadas do processo incluindo advogados de cada parte.
 * Retorna objeto com informações para determinar lado_cliente.
 */
export async function parseDetalhesProcesso(page: Page): Promise<{
  advogadosRequerente: string[];
  advogadosRequerido: string[];
}> {
  const detalhes = await page.evaluate(() => {
    const advogadosRequerente: string[] = [];
    const advogadosRequerido: string[] = [];

    // Buscar por padrões no HTML
    const html = document.body.innerHTML;

    // Padrão EPROC: <b>Autor</b> ... <b>Advogado</b> NOME
    const regexAtivo = /<b>\s*(Autor|Requerente|Exequente|Embargante|Suscitante)\s*<\/b>[\s\S]*?<b>\s*Advogad[oa]\s*<\/b>\s*:?\s*([^<\n]+)/gi;
    let match;
    while ((match = regexAtivo.exec(html)) !== null) {
      const advNome = match[2].trim();
      if (advNome.length > 3) {
        advogadosRequerente.push(advNome);
      }
    }

    // Buscar seções de partes passivas (réu/requerido)
    const regexPassivo = /<b>\s*(R[eé]u|Requerido|Executado|Embargado|Suscitado)\s*<\/b>[\s\S]*?<b>\s*Advogad[oa]\s*<\/b>\s*:?\s*([^<\n]+)/gi;
    while ((match = regexPassivo.exec(html)) !== null) {
      const advNome = match[2].trim();
      if (advNome.length > 3) {
        advogadosRequerido.push(advNome);
      }
    }

    // Estratégia alternativa: buscar no texto com estrutura linha a linha
    if (advogadosRequerente.length === 0 && advogadosRequerido.length === 0) {
      const texto = document.body.innerText;
      const linhas = texto.split('\n');

      let parteAtual: 'requerente' | 'requerido' | null = null;

      for (let i = 0; i < linhas.length; i++) {
        const linha = linhas[i].trim();

        // Detectar parte ativa
        if (/^(Autor|Requerente|Exequente|Embargante|Suscitante)/i.test(linha)) {
          parteAtual = 'requerente';
        }
        // Detectar parte passiva
        else if (/^(R[eé]u|Requerido|Executado|Embargado|Suscitado)/i.test(linha)) {
          parteAtual = 'requerido';
        }
        // Detectar advogado
        else if (/^Advogad[oa]/i.test(linha) && parteAtual) {
          // Nome pode estar na mesma linha ou na próxima
          let nomeAdv = linha.replace(/^Advogad[oa]\s*:?\s*/i, '').trim();
          if (nomeAdv.length < 3 && i + 1 < linhas.length) {
            nomeAdv = linhas[i + 1].trim();
          }

          if (nomeAdv.length > 3) {
            if (parteAtual === 'requerente') {
              advogadosRequerente.push(nomeAdv);
            } else {
              advogadosRequerido.push(nomeAdv);
            }
          }
        }
      }
    }

    return { advogadosRequerente, advogadosRequerido };
  });

  // Log: mostrar advogados encontrados (usar logger.info para visibilidade)
  if (detalhes.advogadosRequerente.length > 0 || detalhes.advogadosRequerido.length > 0) {
    logger.info('Advogados encontrados: requerente=%j, requerido=%j',
      detalhes.advogadosRequerente,
      detalhes.advogadosRequerido
    );
  } else {
    logger.info('Nenhum advogado encontrado na página de detalhes');
  }

  return detalhes;
}
