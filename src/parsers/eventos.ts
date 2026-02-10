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
 * Parseia a tabela "Partes e Representantes" do EPROC que tem colunas
 * (ex: EXEQUENTE | EXECUTADO) com advogados listados como "NOME  RS053253".
 */
export async function parseDetalhesProcesso(page: Page): Promise<{
  advogadosRequerente: string[];
  advogadosRequerido: string[];
}> {
  const detalhes = await page.evaluate(() => {
    const advogadosRequerente: string[] = [];
    const advogadosRequerido: string[] = [];

    // Termos que indicam parte ativa (→ lado requerente)
    const termosAtivo = ['AUTOR', 'REQUERENTE', 'EXEQUENTE', 'EMBARGANTE', 'SUSCITANTE', 'IMPETRANTE', 'RECLAMANTE'];
    // Termos que indicam parte passiva (→ lado requerido)
    const termosPassivo = ['REU', 'RÉU', 'REQUERIDO', 'EXECUTADO', 'EMBARGADO', 'SUSCITADO', 'IMPETRADO', 'RECLAMADO'];

    function classificarLado(texto: string): 'requerente' | 'requerido' | null {
      const upper = texto.toUpperCase().trim();
      if (termosAtivo.some(t => upper.includes(t))) return 'requerente';
      if (termosPassivo.some(t => upper.includes(t))) return 'requerido';
      return null;
    }

    // Regex para detectar número OAB: sigla seccional (2 letras) + 5-6 dígitos
    const oabRegex = /\b([A-Z]{2})\s*(\d{5,6})\b/;

    function extrairNomeAdvogado(texto: string): string | null {
      const match = texto.match(oabRegex);
      if (!match) return null;
      const rawNome = texto.substring(0, match.index).trim();
      if (rawNome.length <= 3) return null;
      // Limpar prefixos como ") - Pessoa Jurídica" separados por 2+ espaços
      const partes = rawNome.split(/\s{2,}/);
      const nome = partes[partes.length - 1].trim();
      return nome.length > 3 ? nome : null;
    }

    // ============================================================
    // ESTRATÉGIA 1: Parsear tabela "Partes e Representantes"
    // A tabela tem th com os tipos de parte (EXEQUENTE, EXECUTADO)
    // e td com nomes de partes + advogados (NOME  RS053253)
    // ============================================================
    const tabelas = Array.from(document.querySelectorAll('table'));

    for (const tabela of tabelas) {
      const headers = Array.from(tabela.querySelectorAll('th'));
      if (headers.length < 2) continue;

      // Verificar se esta tabela tem headers de partes processuais
      const headerLados = headers.map(h => classificarLado(h.textContent || ''));
      const temPartesProcessuais = headerLados.some(l => l !== null);
      if (!temPartesProcessuais) continue;

      // Percorrer linhas da tabela
      const linhas = Array.from(tabela.querySelectorAll('tbody tr, tr'));
      for (const linha of linhas) {
        const celulas = Array.from(linha.querySelectorAll('td'));

        for (let colIdx = 0; colIdx < celulas.length; colIdx++) {
          const lado = headerLados[colIdx];
          if (!lado) continue;

          // Extrair texto da célula e buscar padrões OAB
          const celulaTexto = celulas[colIdx].textContent || '';
          const linhasTexto = celulaTexto.split('\n');

          for (const lt of linhasTexto) {
            const trimmed = lt.trim();
            if (!trimmed) continue;

            const nomeAdv = extrairNomeAdvogado(trimmed);
            if (nomeAdv) {
              if (lado === 'requerente') {
                advogadosRequerente.push(nomeAdv);
              } else {
                advogadosRequerido.push(nomeAdv);
              }
            }
          }
        }
      }

      // Se encontrou a tabela de partes, não precisa continuar
      if (advogadosRequerente.length > 0 || advogadosRequerido.length > 0) break;
    }

    // ============================================================
    // ESTRATÉGIA 2 (Fallback): Buscar no texto da página inteira
    // Para processos com layout diferente
    // ============================================================
    if (advogadosRequerente.length === 0 && advogadosRequerido.length === 0) {
      const texto = document.body.innerText;
      const linhas = texto.split('\n');

      let parteAtual: 'requerente' | 'requerido' | null = null;

      for (const linha of linhas) {
        const trimmed = linha.trim();
        if (!trimmed) continue;

        // Detectar mudança de seção
        const lado = classificarLado(trimmed);
        if (lado) {
          parteAtual = lado;
          continue;
        }

        // Dentro de uma seção de parte, buscar advogados por OAB
        if (parteAtual) {
          const nomeAdv = extrairNomeAdvogado(trimmed);
          if (nomeAdv) {
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
