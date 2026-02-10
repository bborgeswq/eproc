import cron from 'node-cron';
import { env } from './config/env.js';
import { logger } from './utils/logger.js';
import { launchBrowser, newPage, closeBrowser } from './services/browser.js';
import { login } from './services/auth.js';
import { obterProcessosComPrazoAberto, extrairDetalhesProcessos, backfillLadoCliente } from './services/scraper.js';
import {
  getAllProcessosAbertos,
  getProcessosComEventos,
  getProcessosSemClienteNome,
  syncProcessos,
  createScraperRun,
  updateScraperRun,
} from './services/database.js';

// Flag para evitar execuções simultâneas
let isRunning = false;

// Referência para a tarefa agendada (para poder parar)
let scheduledTask: ReturnType<typeof cron.schedule> | null = null;

async function executarCiclo(): Promise<boolean> {
  // Evitar execuções simultâneas
  if (isRunning) {
    logger.warn('Ciclo anterior ainda em execução, pulando...');
    return false;
  }

  isRunning = true;
  let todosProcessados = false;
  const runId = await createScraperRun();

  try {
    logger.info('=== EPROC Scraper — Iniciando ciclo ===');

    // 1. Iniciar browser
    const browser = await launchBrowser();
    const page = await newPage(browser);

    // 2. Login
    const loginOk = await login(page);
    if (!loginOk) {
      throw new Error('Falha no login');
    }

    // 3. Obter lista de processos com prazo aberto do EPROC
    // Retorna também a página da lista para usar na Fase 2
    const { processos: processosEproc, listPage } = await obterProcessosComPrazoAberto(page, browser);
    logger.info('Extraídos %d processos do EPROC', processosEproc.length);

    // 4. Obter lista atual do banco de dados
    const processosDb = await getAllProcessosAbertos();
    logger.info('Carregados %d processos do banco de dados', processosDb.size);

    // 5. Sincronizar: inserir novos, remover fechados
    const { inserted, deleted } = await syncProcessos(processosEproc, processosDb);

    // 6. Carregar processos que já têm eventos (para skip por cruzamento de tabelas)
    const processosComEventos = await getProcessosComEventos();
    logger.info('Processos com eventos na Tabela 2: %d', processosComEventos.size);

    // 7. FASE 2 + 3: Extrair detalhes, eventos e documentos dos processos
    logger.info('=== Iniciando Fase 2+3: Extração de detalhes e documentos ===');
    const resultado = await extrairDetalhesProcessos(
      listPage,
      browser,
      processosEproc,
      env.MAX_PROCESSES_PER_CYCLE,
      processosComEventos
    );

    // 8. FASE 4: Backfill lado_cliente para processos sem cliente_nome
    const processosSemLado = await getProcessosSemClienteNome();
    let ladosBackfill = 0;
    let todosLadosPreenchidos = true;

    if (processosSemLado.length > 0) {
      logger.info('=== Iniciando Fase 4: Backfill lado_cliente ===');
      const backfill = await backfillLadoCliente(
        listPage,
        browser,
        processosSemLado,
        env.MAX_PROCESSES_PER_CYCLE
      );
      ladosBackfill = backfill.atualizados;
      todosLadosPreenchidos = backfill.todosPreenchidos;
    }

    // Só entra em recesso quando eventos E lado_cliente estão completos
    todosProcessados = resultado.todosProcessados && todosLadosPreenchidos;

    // 9. Fechar a aba da lista após Fases 2+3+4
    if (listPage !== page) {
      await listPage.close();
      logger.debug('Aba de prazos fechada');
    }

    // 10. Atualizar registro de execução
    await updateScraperRun(runId, {
      status: 'success',
      processos_encontrados: processosEproc.length,
      processos_novos: inserted,
      processos_removidos: deleted,
    });

    logger.info('=== Ciclo concluído com sucesso ===');
    logger.info(
      'Resumo: %d encontrados, %d novos, %d removidos, %d eventos, %d lados (fase2), %d lados (backfill), %d docs',
      processosEproc.length,
      inserted,
      deleted,
      resultado.totalEventos,
      resultado.ladosAtualizados,
      ladosBackfill,
      resultado.totalDocumentos
    );

  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error({ err }, 'Erro no ciclo do scraper');

    await updateScraperRun(runId, {
      status: 'error',
      error_message: err.message,
      error_stack: err.stack,
    });

  } finally {
    await closeBrowser();
    isRunning = false;
  }

  return todosProcessados;
}

/**
 * Gera expressao cron para intervalo em minutos.
 * Ex: 15 minutos -> "* /15 * * * *" (sem espaco)
 */
function gerarCronExpression(intervalMinutes: number): string {
  if (intervalMinutes <= 0 || intervalMinutes > 60) {
    throw new Error(`Intervalo inválido: ${intervalMinutes}. Use entre 1 e 60 minutos.`);
  }
  return `*/${intervalMinutes} * * * *`;
}

/**
 * Encerramento gracioso do scraper.
 */
function gracefulShutdown(signal: string) {
  logger.info('Recebido sinal %s, encerrando...', signal);

  if (scheduledTask) {
    scheduledTask.stop();
    logger.info('Agendamento cron parado');
  }

  if (recessoTimeout) {
    clearTimeout(recessoTimeout);
    logger.info('Timeout de recesso cancelado');
  }

  // Se houver um ciclo em execução, aguardar
  if (isRunning) {
    logger.info('Aguardando ciclo em execução terminar...');
    const checkInterval = setInterval(() => {
      if (!isRunning) {
        clearInterval(checkInterval);
        logger.info('Ciclo finalizado. Encerrando processo.');
        process.exit(0);
      }
    }, 1000);

    // Timeout de segurança (2 minutos)
    setTimeout(() => {
      logger.warn('Timeout aguardando ciclo. Forçando encerramento.');
      process.exit(1);
    }, 120000);
  } else {
    process.exit(0);
  }
}

// Intervalo de recesso (24 horas em ms)
const RECESSO_INTERVAL_MS = 24 * 60 * 60 * 1000;

// Referência para timeout de recesso
let recessoTimeout: NodeJS.Timeout | null = null;

/**
 * Agenda o próximo ciclo baseado no estado.
 * Se todos processados: modo recesso (24h)
 * Senão: continuar com intervalo normal (15min)
 */
function agendarProximoCiclo(todosProcessados: boolean) {
  // Cancelar agendamentos anteriores
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
  }
  if (recessoTimeout) {
    clearTimeout(recessoTimeout);
    recessoTimeout = null;
  }

  if (todosProcessados) {
    // Modo recesso: esperar 24h
    logger.info('=== MODO RECESSO: Todos processados, próximo ciclo em 24h ===');
    recessoTimeout = setTimeout(async () => {
      logger.info('--- Saindo do recesso, iniciando novo ciclo ---');
      const todos = await executarCiclo();
      agendarProximoCiclo(todos);
    }, RECESSO_INTERVAL_MS);
  } else {
    // Modo normal: cron a cada 15 minutos
    const cronExpression = gerarCronExpression(env.SCRAPER_INTERVAL_MINUTES);
    logger.info('Agendando ciclos com expressão cron: %s', cronExpression);

    scheduledTask = cron.schedule(cronExpression, async () => {
      logger.info('--- Ciclo agendado iniciado ---');
      const todos = await executarCiclo();

      // Se todos foram processados, mudar para modo recesso
      if (todos) {
        agendarProximoCiclo(true);
      }
    });
  }
}

// Entry point
async function main() {
  logger.info('=== EPROC Scraper v1.0 ===');
  logger.info('Intervalo configurado: %d minutos', env.SCRAPER_INTERVAL_MINUTES);

  // Configurar handlers de encerramento
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

  // Executar primeiro ciclo imediatamente
  const todosProcessados = await executarCiclo();

  // Agendar próximos ciclos baseado no resultado
  agendarProximoCiclo(todosProcessados);

  logger.info('Scraper rodando. Pressione Ctrl+C para parar.');
}

main().catch((err) => {
  logger.fatal({ err }, 'Erro fatal');
  process.exit(1);
});
