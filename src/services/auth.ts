import type { Page } from 'puppeteer';
import { generateSync } from 'otplib';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { randomDelay } from '../utils/dates.js';
import { withRetry } from '../utils/retry.js';
import { EPROC_URLS } from '../types/index.js';

/**
 * Sanitiza a secret TOTP removendo caracteres inválidos para Base32.
 * Base32 aceita apenas: A-Z e 2-7.
 */
function sanitizeTotpSecret(secret: string): string {
  // Remover espaços, hífens, underscores e converter para maiúsculo
  const clean = secret.replace(/[\s_-]/g, '').toUpperCase();
  logger.debug('TOTP secret sanitizado (%d → %d chars)', secret.length, clean.length);
  return clean;
}

function generateTOTP(): string {
  const secret = sanitizeTotpSecret(env.EPROC_TOTP_SECRET);
  const token = generateSync({ secret });
  logger.debug('Código TOTP gerado');
  return token;
}

/**
 * Registra handler de dialogs (alert/confirm/prompt) para evitar travamento.
 */
function setupDialogHandler(page: Page): void {
  page.on('dialog', async (dialog) => {
    logger.debug(
      { type: dialog.type(), message: dialog.message() },
      'Dialog interceptado, aceitando...'
    );
    await dialog.accept();
  });
}

/**
 * Preenche um input via JavaScript (bypass de visibilidade).
 * Tenta múltiplos seletores em ordem.
 */
async function fillInput(
  page: Page,
  selectors: string[],
  value: string,
  label: string
): Promise<boolean> {
  const filled = await page.evaluate(
    (sels: string[], val: string) => {
      for (const sel of sels) {
        const el = document.querySelector(sel) as HTMLInputElement | null;
        if (el) {
          el.focus();
          el.value = val;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return { selector: sel, found: true };
        }
      }
      return { selector: null, found: false };
    },
    selectors,
    value
  );

  if (filled.found) {
    logger.debug('%s preenchido via seletor: %s', label, filled.selector);
    return true;
  }

  logger.warn('%s: nenhum seletor encontrado entre: %s', label, selectors.join(', '));
  return false;
}

/**
 * Clica num botão via JavaScript. Tenta múltiplos seletores.
 */
async function clickButton(
  page: Page,
  selectors: string[],
  fallbackText?: string
): Promise<boolean> {
  const clicked = await page.evaluate(
    (sels: string[], text?: string) => {
      for (const sel of sels) {
        const el = document.querySelector(sel) as HTMLElement | null;
        if (el) {
          el.click();
          return { selector: sel, method: 'selector' };
        }
      }

      if (text) {
        const buttons = Array.from(
          document.querySelectorAll('button, input[type="submit"], a.btn')
        );
        const match = buttons.find((b) =>
          b.textContent?.trim().toLowerCase().includes(text.toLowerCase())
        );
        if (match) {
          (match as HTMLElement).click();
          return { selector: text, method: 'text' };
        }
      }

      return null;
    },
    selectors,
    fallbackText
  );

  if (clicked) {
    logger.debug('Botão clicado via %s: %s', clicked.method, clicked.selector);
    return true;
  }

  return false;
}

/**
 * Realiza login no EPROC via Keycloak SSO.
 *
 * Fluxo real descoberto:
 * 1. Navegar para EPROC login → redireciona para Keycloak
 * 2. Keycloak mostra: #username + #password (masked) + #kc-login
 * 3. Após submit → pode pedir TOTP em tela separada
 * 4. Após TOTP → redireciona de volta para EPROC autenticado
 */
export async function login(page: Page): Promise<boolean> {
  setupDialogHandler(page);

  return withRetry(
    async () => {
      logger.info('Iniciando processo de login...');

      // 1. Navegar para a página de login (vai redirecionar para Keycloak)
      await page.goto(EPROC_URLS.login, {
        waitUntil: 'networkidle2',
        timeout: env.BROWSER_TIMEOUT_MS,
      });

      // Aguardar dialogs e redirecionamentos
      await randomDelay(2000, 3000);

      const urlAfterNav = page.url();
      logger.info('Página carregada. URL: %s', urlAfterNav);

      // Aguardar inputs carregarem
      await page.waitForSelector('input', { timeout: 10000 }).catch(() => {
        logger.warn('Timeout aguardando inputs na página');
      });

      // Log HTML completo para debug
      const pageHtml = await page.content();
      const htmlPreview = pageHtml.substring(0, 3000).replace(/\s+/g, ' ');
      logger.info('HTML da página (preview): %s', htmlPreview);

      // Verificar se há iframes
      const iframes = await page.$$('iframe');
      logger.info('Iframes encontrados: %d', iframes.length);

      // Se houver iframe, tentar entrar nele
      if (iframes.length > 0) {
        const frame = await iframes[0].contentFrame();
        if (frame) {
          logger.info('Entrando no iframe...');
          const frameHtml = await frame.content();
          logger.info('HTML do iframe (preview): %s', frameHtml.substring(0, 2000).replace(/\s+/g, ' '));
        }
      }

      // 2. Preencher usuário — tenta vários seletores
      const userFilled = await fillInput(
        page,
        [
          '#username',
          'input[name="username"]',
          '#txtUsuario',
          'input[name="txtUsuario"]',
          '#txtLogin',
          'input[name="txtLogin"]',
          '#login',
          'input[name="login"]',
          'input[type="text"]:not([name=""])',
        ],
        env.EPROC_USER,
        'Usuário'
      );

      if (!userFilled) {
        await page.screenshot({ path: 'debug-no-user-field.png' });
        throw new Error('Campo de usuário não encontrado');
      }

      await randomDelay(300, 700);

      // 3. Preencher senha — Keycloak usa #password (type="text" com classe "masked")
      //    Há também um input[type="password"][name="password"] hidden.
      //    O visível é: input#password.masked (type="text")
      const passFilled = await fillInput(
        page,
        [
          'input#password.masked',
          'input#password[type="text"]',
          'input[type="password"][name="password"]',
          '#pwdSenha',
          'input[type="password"]',
        ],
        env.EPROC_PASSWORD,
        'Senha'
      );

      if (!passFilled) {
        await page.screenshot({ path: 'debug-no-pass-field.png' });
        throw new Error('Campo de senha não encontrado');
      }

      await randomDelay(300, 700);

      // 4. TOTP — tentar na mesma tela (pode não existir aqui)
      const totpSelectors = [
        '#txtToken',
        'input[name="txtToken"]',
        'input[name="token"]',
        'input[name="otp"]',
        '#otp',
      ];

      const totpExists = await page.evaluate((sels: string[]) => {
        return sels.some((sel) => !!document.querySelector(sel));
      }, totpSelectors);

      if (totpExists) {
        await fillInput(page, totpSelectors, generateTOTP(), 'TOTP');
      } else {
        logger.debug('Campo TOTP não encontrado na tela de login (esperado)');
      }

      await randomDelay(300, 700);

      // 5. Submeter — Keycloak usa #kc-login (input type="submit")
      const submitted = await clickButton(
        page,
        [
          '#kc-login',
          'input#kc-login',
          'input[name="login"]',
          '#btnEntrar',
          'input[type="submit"]',
          'button[type="submit"]',
        ],
        'entrar'
      );

      if (!submitted) {
        logger.warn('Botão de submit não encontrado, pressionando Enter');
        await page.keyboard.press('Enter');
      }

      logger.info('Formulário submetido, aguardando navegação...');

      // 6. Aguardar resposta
      await page.waitForNavigation({
        waitUntil: 'networkidle2',
        timeout: 30000,
      }).catch(() => {
        logger.debug('waitForNavigation timeout — verificando estado');
      });

      await randomDelay(1500, 2500);

      const urlAfterSubmit = page.url();
      logger.info('Após submit. URL: %s', urlAfterSubmit);

      // 7. Tela de TOTP separada? (Keycloak pode pedir OTP em segunda tela)
      const totpAfter = await page.evaluate((sels: string[]) => {
        return sels.some((sel) => !!document.querySelector(sel));
      }, totpSelectors);

      if (totpAfter) {
        logger.info('Tela de TOTP detectada, preenchendo...');
        await fillInput(page, totpSelectors, generateTOTP(), 'TOTP (2ª tela)');

        await randomDelay(300, 700);

        const submitted2 = await clickButton(
          page,
          ['#kc-login', 'input[type="submit"]', 'button[type="submit"]'],
          'entrar'
        );
        if (!submitted2) {
          await page.keyboard.press('Enter');
        }

        await page.waitForNavigation({
          waitUntil: 'networkidle2',
          timeout: 30000,
        }).catch(() => {
          logger.debug('waitForNavigation timeout após TOTP');
        });

        await randomDelay(1500, 2500);
        logger.info('Após TOTP. URL: %s', page.url());
      }

      // 8. Verificar resultado
      const finalUrl = page.url();

      // Checar erro visível (Keycloak usa .alert-error)
      const errorText = await page.evaluate(() => {
        const el = document.querySelector(
          '.alert-error, .alert-danger, .mensagem-erro, .kc-feedback-text, .erro'
        );
        return el?.textContent?.trim() || null;
      });

      if (errorText) {
        throw new Error(`Login falhou: ${errorText}`);
      }

      // Sucesso = saiu do Keycloak e voltou para EPROC
      const isStillLogin =
        finalUrl.includes('keycloak') ||
        finalUrl.includes('usuario_login_form') ||
        finalUrl.includes('acao=principal');

      if (!isStillLogin) {
        logger.info('Login realizado com sucesso! URL: %s', finalUrl);
        return true;
      }

      throw new Error(`Login falhou: ainda na página de login. URL: ${finalUrl}`);
    },
    {
      maxRetries: 1,
      initialDelay: 5000,
      label: 'login',
    }
  );
}
