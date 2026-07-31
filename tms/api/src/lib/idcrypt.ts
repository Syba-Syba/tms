import { createCipheriv, randomBytes, scryptSync } from 'node:crypto';
import { EncryptCommand, KMSClient } from '@aws-sdk/client-kms';
import { env } from './env';

/**
 * PoPIA requires the ID number stored unreadable, and nothing in the system ever decrypts it,
 * so encryption only has to be one-way from the application's point of view. KMS does it in
 * production. Locally there is no KMS, which made submitting an application impossible on a
 * laptop, so development uses AES-GCM under a throwaway key with the same bytea shape.
 */
export async function encryptIdNumber(plain: string): Promise<Buffer> {
  if (process.env.KMS_DRIVER === 'local') {
    if (process.env.NODE_ENV !== 'development') {
      throw new Error('KMS_DRIVER=local is a development setting. Unset it in production.');
    }
    const key = scryptSync(process.env.STORAGE_SECRET ?? 'local-development-only', 'id-number', 32);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return Buffer.concat([Buffer.from('local:'), iv, cipher.getAuthTag(), encrypted]);
  }
  const kms = new KMSClient({ region: env.AWS_REGION });
  const result = await kms.send(
    new EncryptCommand({ KeyId: env.KMS_KEY_ID, Plaintext: Buffer.from(plain) }),
  );
  return Buffer.from(result.CiphertextBlob!);
}
