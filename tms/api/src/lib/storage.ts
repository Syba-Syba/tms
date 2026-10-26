import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from './env';
import { allowsLocalDrivers, secretFor } from './mode';

/**
 * Every document and photo goes through here instead of a handler-owned S3Client.
 *
 * The point is the same as the pglite database driver: the whole feature set has to work on a
 * laptop with nothing installed. With handlers talking to S3 directly, every upload, PDF and
 * photo failed locally, which silently excluded a third of the product from development.
 */
export interface Storage {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  /** Returns the object size, or null when the key does not exist. */
  sizeOf(key: string): Promise<number | null>;
  presignPut(key: string, contentType: string, expiresInSeconds: number): Promise<string>;
  presignGet(key: string, expiresInSeconds: number): Promise<string>;
}

const s3Driver = (): Storage => {
  const s3 = new S3Client({ region: env.AWS_REGION });
  const Bucket = env.DOCS_BUCKET;
  return {
    async put(key, body, contentType) {
      await s3.send(
        new PutObjectCommand({
          Bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
          ServerSideEncryption: 'aws:kms',
        }),
      );
    },
    async get(key) {
      const object = await s3.send(new GetObjectCommand({ Bucket, Key: key }));
      return new Uint8Array(await object.Body!.transformToByteArray());
    },
    async sizeOf(key) {
      try {
        const head = await s3.send(new HeadObjectCommand({ Bucket, Key: key }));
        return head.ContentLength ?? 0;
      } catch {
        return null;
      }
    },
    presignPut(key, contentType, expiresIn) {
      return getSignedUrl(
        s3,
        new PutObjectCommand({
          Bucket,
          Key: key,
          ContentType: contentType,
          ServerSideEncryption: 'aws:kms',
        }),
        { expiresIn },
      );
    },
    presignGet(key, expiresIn) {
      return getSignedUrl(s3, new GetObjectCommand({ Bucket, Key: key }), { expiresIn });
    },
  };
};

// Local URLs are still signed so an expired or tampered link fails the same way it would on S3.
export const localSignature = (method: 'GET' | 'PUT', key: string, expires: number) =>
  createHmac('sha256', secretFor('STORAGE_SECRET', 'local-development-only'))
    .update(`${method}\n${key}\n${expires}`)
    .digest('hex');

export const verifyLocalSignature = (
  method: 'GET' | 'PUT',
  key: string,
  expires: number,
  signature: string,
) => {
  if (!Number.isFinite(expires) || expires * 1000 < Date.now()) return false;
  const expected = localSignature(method, key, expires);
  return (
    signature.length === expected.length &&
    timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  );
};

export const localStorageRoot = () => resolve(process.cwd(), process.env.STORAGE_DIR ?? '.storage');

/** Maps a key to a path under the storage root and refuses anything that escapes it. */
export const localPathFor = (key: string) => {
  const root = localStorageRoot();
  const path = resolve(root, key);
  if (path !== root && !path.startsWith(root + sep)) {
    throw new Error(`Storage key escapes the storage directory: ${key}`);
  }
  return path;
};

const localDriver = (): Storage => {
  const base = process.env.PUBLIC_API_URL ?? `http://localhost:${process.env.PORT ?? 3001}`;
  const url = (method: 'GET' | 'PUT', key: string, expiresIn: number) => {
    const expires = Math.floor(Date.now() / 1000) + expiresIn;
    const encoded = key.split('/').map(encodeURIComponent).join('/');
    return `${base}/files/${encoded}?exp=${expires}&sig=${localSignature(method, key, expires)}`;
  };
  return {
    async put(key, body) {
      const path = localPathFor(key);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, body);
    },
    async get(key) {
      return new Uint8Array(await readFile(localPathFor(key)));
    },
    async sizeOf(key) {
      try {
        return (await stat(localPathFor(key))).size;
      } catch {
        return null;
      }
    },
    presignPut: async (key, _contentType, expiresIn) => url('PUT', key, expiresIn),
    presignGet: async (key, expiresIn) => url('GET', key, expiresIn),
  };
};

let instance: Storage | undefined;

export function storage(): Storage {
  if (instance) return instance;
  if (process.env.STORAGE_DRIVER === 'local') {
    // Same rule as the database TLS switch: a convenience driver never reaches AWS, where
    // S3 exists and this would be a silent downgrade. Self-hosted has no S3 to downgrade from.
    if (!allowsLocalDrivers()) {
      throw new Error('STORAGE_DRIVER=local is not permitted in aws mode. Unset it, or set APP_MODE=self-hosted.');
    }
    instance = localDriver();
  } else {
    instance = s3Driver();
  }
  return instance;
}
