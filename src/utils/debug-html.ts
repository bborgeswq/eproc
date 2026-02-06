import type { Page } from 'puppeteer';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { logger } from './logger.js';

const DEBUG_DIR = 'debug-output';

/**
 * Cria diretório de debug se não existir
 */
function ensureDebugDir(): void {
  try {
    mkdirSync(DEBUG_DIR, { recursive: true });
  } catch {
    // já existe
  }
}

/**
 * Salva HTML completo da página para análise
 */
export async function saveFullPageHtml(page: Page, filename: string): Promise<string> {
  ensureDebugDir();
  const html = await page.content();
  const filepath = join(DEBUG_DIR, filename);
  writeFileSync(filepath, html, 'utf-8');
  logger.info('HTML da página salvo em: %s', filepath);
  return filepath;
}

/**
 * Analisa e salva debug detalhado de cada célula de processo
 */
export async function analyzeProcessoCells(page: Page): Promise<void> {
  ensureDebugDir();

  const analysis = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('table.infraTable tbody tr'));
    const results: Array<{
      index: number;
      numero_cnj: string;
      raw_html: string;
      extracted: {
        juizo: string | null;
        parteAtiva: { tipo: string; nome: string; cpf: string } | null;
        partePassiva: { tipo: string; nome: string; cpf: string } | null;
      };
      issues: string[];
    }> = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const cells = Array.from(row.querySelectorAll('td'));
      if (cells.length < 7) continue;

      const processoCell = cells[1]?.innerHTML || '';

      // Extrair número CNJ
      const numeroMatch = processoCell.match(/(\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4})/);
      const numeroCnj = numeroMatch ? numeroMatch[1] : 'NÃO ENCONTRADO';

      const issues: string[] = [];

      // Extrair juízo
      const juizoMatch = processoCell.match(/Ju[íi]zo:\s*<\/b>\s*([A-Z0-9]+)/i);
      const juizo = juizoMatch ? juizoMatch[1] : null;
      if (!juizo) issues.push('JUIZO_NAO_ENCONTRADO');

      // Extrair parte ativa (inclui Suscitante, Embargante)
      const parteAtivaMatch = processoCell.match(
        /<b>(Autor|Requerente|Exequente|Suscitante|Embargante)<\/b>(?:<br>|\s)*(?:<[^>]+>)?([^<]+)(?:<\/[^>]+>)?(?:<br>|\s)*(?:\((\d+)\))?/i
      );
      let parteAtiva: { tipo: string; nome: string; cpf: string } | null = null;
      if (parteAtivaMatch) {
        parteAtiva = {
          tipo: parteAtivaMatch[1],
          nome: parteAtivaMatch[2].trim(),
          cpf: parteAtivaMatch[3] || '',
        };
      } else {
        issues.push('PARTE_ATIVA_NAO_ENCONTRADA');
      }

      // Extrair parte passiva (inclui Suscitado, Embargado)
      const partePassivaMatch = processoCell.match(
        /<b>(R[ée]u|Requerido|Executado|Suscitado|Embargado)<\/b>(?:<br>|\s)*(?:<[^>]+>)?([^<]+)(?:<\/[^>]+>)?(?:<br>|\s)*(?:\((\d+)\))?/i
      );
      let partePassiva: { tipo: string; nome: string; cpf: string } | null = null;
      if (partePassivaMatch) {
        partePassiva = {
          tipo: partePassivaMatch[1],
          nome: partePassivaMatch[2].trim(),
          cpf: partePassivaMatch[3] || '',
        };
      } else {
        issues.push('PARTE_PASSIVA_NAO_ENCONTRADA');
      }

      results.push({
        index: i,
        numero_cnj: numeroCnj,
        raw_html: processoCell,
        extracted: { juizo, parteAtiva, partePassiva },
        issues,
      });
    }

    return results;
  });

  // Separar processos com problemas
  const withIssues = analysis.filter((a) => a.issues.length > 0);
  const withoutIssues = analysis.filter((a) => a.issues.length === 0);

  logger.info('=== ANÁLISE DE DEBUG ===');
  logger.info('Total de processos: %d', analysis.length);
  logger.info('Processos OK: %d', withoutIssues.length);
  logger.info('Processos com problemas: %d', withIssues.length);

  // Agrupar por tipo de problema
  const issueTypes: Record<string, number> = {};
  for (const item of withIssues) {
    for (const issue of item.issues) {
      issueTypes[issue] = (issueTypes[issue] || 0) + 1;
    }
  }

  logger.info('Tipos de problemas encontrados:');
  for (const [issue, count] of Object.entries(issueTypes)) {
    logger.info('  - %s: %d ocorrências', issue, count);
  }

  // Salvar relatório completo
  const report = {
    timestamp: new Date().toISOString(),
    summary: {
      total: analysis.length,
      ok: withoutIssues.length,
      withIssues: withIssues.length,
      issueTypes,
    },
    processosComProblemas: withIssues.map((item) => ({
      index: item.index,
      numero_cnj: item.numero_cnj,
      issues: item.issues,
      raw_html: item.raw_html,
    })),
  };

  const reportPath = join(DEBUG_DIR, 'analysis-report.json');
  writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');
  logger.info('Relatório salvo em: %s', reportPath);

  // Salvar HTML dos processos com problemas para análise manual
  if (withIssues.length > 0) {
    let htmlReport = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Debug - Processos com Problemas</title>
  <style>
    body { font-family: monospace; padding: 20px; }
    .processo { border: 1px solid #ccc; margin: 20px 0; padding: 15px; }
    .processo.has-issues { border-color: red; background: #fff0f0; }
    .issue { color: red; font-weight: bold; }
    .raw-html { background: #f5f5f5; padding: 10px; overflow-x: auto; white-space: pre-wrap; word-break: break-all; }
    .extracted { background: #e8f5e9; padding: 10px; margin-top: 10px; }
    h2 { color: #333; }
    h3 { color: #666; margin-top: 0; }
  </style>
</head>
<body>
  <h1>Debug - Processos com Problemas de Parse</h1>
  <p>Total: ${withIssues.length} processos</p>
  <p>Tipos de problemas: ${Object.entries(issueTypes).map(([k, v]) => `${k}: ${v}`).join(', ')}</p>
`;

    for (const item of withIssues) {
      htmlReport += `
  <div class="processo has-issues">
    <h3>#${item.index} - ${item.numero_cnj}</h3>
    <p class="issue">Problemas: ${item.issues.join(', ')}</p>
    <h4>HTML Bruto:</h4>
    <div class="raw-html">${escapeHtml(item.raw_html)}</div>
    <h4>Dados Extraídos:</h4>
    <div class="extracted">
      <pre>${JSON.stringify(item.extracted, null, 2)}</pre>
    </div>
  </div>
`;
    }

    htmlReport += `
</body>
</html>`;

    const htmlReportPath = join(DEBUG_DIR, 'problemas-parse.html');
    writeFileSync(htmlReportPath, htmlReport, 'utf-8');
    logger.info('Relatório HTML salvo em: %s', htmlReportPath);
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
