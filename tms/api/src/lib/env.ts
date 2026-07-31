import { z } from 'zod';

const schema = z.object({
  DB_HOST: z.string(),
  DB_NAME: z.string(),
  DB_SECRET_ARN: z.string(),
  DOCS_BUCKET: z.string(),
  KMS_KEY_ID: z.string(),
  AWS_REGION: z.string().default('af-south-1'),
});

// Fails at cold start with the exact missing keys rather than throwing undefined errors mid request.
export const env = schema.parse(process.env);
