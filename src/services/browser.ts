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

  // Build browser args
  const browserArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-accelerated-2d-canvas',
    '--disable-gpu',
    '--disable-software-rasterizer',
    '--disable-background-networking',
    '--disable-default-apps',
    '--disable-extensions',
    '--disable-sync',
    '--disable-translate',
    '--disable-breakpad',
    '--disable-crash-reporter',
    '--disable-crashpad',
    '--no-first-run',
    '--no-zygote',
    '--single-process',
    '--window-size=1920,1080',
    '--lang=pt-BR',
  ];

  // Add proxy if configured
  if (env.PROXY_HOST && env.PROXY_PORT) {
    browserArgs.push(`--proxy-server=${env.PROXY_HOST}:${env.PROXY_PORT}`);
    logger.info('Usando proxy: %s:%d', env.PROXY_HOST, env.PROXY_PORT);
  }

  browser = await puppeteer.launch({
    headless: env.HEADLESS,
    args: browserArgs,
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

  // Authenticate proxy if configured
  if (env.PROXY_USER && env.PROXY_PASS) {
    await page.authenticate({
      username: env.PROXY_USER,
      password: env.PROXY_PASS,
    });
    logger.debug('Proxy autenticado');
  }

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
