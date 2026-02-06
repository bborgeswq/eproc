import { parse, isValid } from 'date-fns';

/**
 * Parse data no formato brasileiro "dd/MM/yyyy HH:mm:ss" para Date.
 */
export function parseBrazilianDateTime(dateStr: string): Date | null {
  const trimmed = dateStr.trim();
  const parsed = parse(trimmed, 'dd/MM/yyyy HH:mm:ss', new Date());
  return isValid(parsed) ? parsed : null;
}

/**
 * Parse data no formato "dd/MM/yyyy" para Date.
 */
export function parseBrazilianDate(dateStr: string): Date | null {
  const trimmed = dateStr.trim();
  const parsed = parse(trimmed, 'dd/MM/yyyy', new Date());
  return isValid(parsed) ? parsed : null;
}

/**
 * Delay aleatório para simular comportamento humano.
 */
export function randomDelay(minMs: number, maxMs: number): Promise<void> {
  const delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise((resolve) => setTimeout(resolve, delay));
}
