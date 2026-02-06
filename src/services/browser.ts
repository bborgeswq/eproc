import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { Browser, Page } from 'puppeteer';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

puppeteer.use(StealthPlugin());

let browser: Browser | null = null;

export async function launchBrowser(): Promise<Browser> {
  if (browser && browser.connected) {
    logger.debug('Browser já está ativo, reutilizando');
    return browser;
  }

  logger.info('Iniciando browser...');

  browser = await puppeteer.launch({
    headless: env.HEADLESS,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
      '--window-size=1920,1080',
      '--lang=pt-BR',
    ],
    defaultViewport: {
      width: 1920,
      height: 1080,
    },
    timeout: env.BROWSER_TIMEOUT_MS,
  });

  logger.info('Browser iniciado com sucesso');
  return browser;
}

export async function newPage(browserInstance: Browser): Promise<Page> {
  const page = await browserInstance.newPage();

  await page.setExtraHTTPHeaders({
    'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
  });

  page.setDefaultTimeout(env.BROWSER_TIMEOUT_MS);
  page.setDefaultNavigationTimeout(env.BROWSER_TIMEOUT_MS);

  return page;
}

export async function closeBrowser(): Promise<void> {
  if (browser) {
    logger.info('Fechando browser...');
    await browser.close();
    browser = null;
    logger.info('Browser fechado');
  }
}
