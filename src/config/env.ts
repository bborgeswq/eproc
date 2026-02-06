import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const envSchema = z.object({
  // EPROC
  EPROC_USER: z.string().min(1),
  EPROC_PASSWORD: z.string().min(1),
  EPROC_TOTP_SECRET: z.string().min(1),

  // Advogado - para identificar eventos do advogado no EPROC
  ADVOGADO_USER_ID: z.string().min(1),

  // Supabase
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_KEY: z.string().min(1),

  // Execution
  SCRAPER_INTERVAL_MINUTES: z.coerce.number().int().positive().default(15),
  MAX_PROCESSES_PER_CYCLE: z.coerce.number().int().positive().default(3),

  // Browser
  HEADLESS: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  BROWSER_TIMEOUT_MS: z.coerce.number().int().positive().default(60000),

  // Logging
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),

  // Debug
  DEBUG_MODE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

function loadEnv() {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error('❌ Variáveis de ambiente inválidas:');
    for (const issue of result.error.issues) {
      console.error(`   ${issue.path.join('.')}: ${issue.message}`);
    }
    process.exit(1);
  }
  return result.data;
}

export const env = loadEnv();
export type Env = z.infer<typeof envSchema>;
