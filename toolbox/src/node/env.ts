import { z } from 'zod';

/** Fails at boot with the exact missing keys instead of throwing undefined errors later. */
export function parseEnv<T extends z.ZodRawShape>(schema: z.ZodObject<T>, source = process.env) {
  const result = schema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration.\n${issues}`);
  }
  return result.data;
}

export const commonEnv = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});
