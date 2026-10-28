import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { handler as api } from './api';
import { match } from './router';
import { credentialVersion, verifyToken } from './lib/authtoken';
import { query } from './lib/db';
import { logger } from './lib/logger';
import { assertSelfHostedConfig, mode } from './lib/mode';
import { startScheduler } from './lib/scheduler';
import { localPathFor, verifyLocalSignature } from './lib/storage';

/**
 * The self-hosted server. Same handlers as Lambda, same handlers as the dev server, but this
 * one checks a password.
 *
 * The dev server in src/local.ts falls back to `x-dev-sub` when there is no token, so whoever
 * reaches the port is whoever they say they are. That is fine for a laptop and unusable for
 * anything else, which is why it refuses to run outside development. Nothing here has a
 * fallback: no token means 401, on every route but the ones that issue tokens or reset a password.
 */
if (mode() !== 'self-hosted') {
  console.error(
    'src/server.ts runs in self-hosted mode. Set NODE_ENV=production and APP_MODE=self-hosted.\n' +
      'For a development server with faked identity, use `npm run dev` instead.',
  );
  process.exit(1);
}

// Fails here rather than on the first request that happens to need a secret.
assertSelfHostedConfig();

const PORT = Number(process.env.PORT ?? 3001);
// Loopback unless someone deliberately opens it up. Binding 0.0.0.0 by default would put a
// tenant database on the local network the first time anyone ran this.
const HOST = process.env.HOST ?? '127.0.0.1';
const WEB_ROOT = resolve(process.env.WEB_ROOT ?? '../app/dist');
/**
 * Behind a reverse proxy every connection comes from the proxy's own address, so the sign-in
 * rate limit locked everyone out together and every signature recorded the proxy. Only on
 * an explicit opt-in: a client can write any X-Forwarded-For it likes when there is no proxy.
 */
const TRUST_PROXY = process.env.TRUST_PROXY === 'true';
const RUN_JOBS = process.env.RUN_JOBS !== 'false';

/**
 * A signature and an expiry only say the token was issued once. This also says it was issued
 * against the password the account has now, so changing a password, or deleting an account,
 * ends every session that came before. A token from before tokens carried the fingerprint has
 * none, and is refused: its owner signs in once more.
 */
async function currentUser(token: string) {
  const user = verifyToken(token);
  if (!user?.pv) return null;
  const [row] = await query<{ password_hash: string; session_epoch: number }>(
    'select password_hash, session_epoch from local_credential where sub = $1',
    [user.sub],
  );
  return row && credentialVersion(row.password_hash, row.session_epoch) === user.pv ? user : null;
}

/** The only routes that answer without a token, because they are how you get one. */
const PUBLIC_ROUTES = new Set([
  // For the uptime monitor and the container health check. Says nothing about anyone.
  'GET /health',
  // The operator's name and registration details, for the public terms page.
  'GET /company',
  // A landlord's public listings page: vacant units and their photos, nothing about people.
  'GET /listings',
  'POST /auth/login',
  'POST /auth/register',
  'POST /auth/reset/request',
  'POST /auth/reset/confirm',
  // The token in the body is the credential: it only ever opens its own invitation.
  'POST /invites/lookup',
  'POST /invites/accept',
  // PayFast's notifications. Trusted on its own checks, not a sign-in.
  'POST /billing/notify',
]);

/**
 * On every response. There were none, so the app could be framed by any page (a sign-in form
 * under someone else's overlay), and a stored upload could be sniffed into running as HTML.
 * no-referrer keeps a signed document link, signature included, from leaking to another site.
 */
const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'geolocation=(), microphone=(), payment=()',
  'cross-origin-opener-policy': 'same-origin',
};

/**
 * Only on pages. The built app loads nothing from another origin and has no inline script,
 * so 'self' is the whole list. Styles allow inline because the dialog components inject a
 * <style> element to lock scrolling.
 */
const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.pdf': 'application/pdf',
  '.webmanifest': 'application/manifest+json',
};

/**
 * Bodies were read whole with no ceiling, so one large request could exhaust memory. It is also
 * the input zod's open advisory needs (GHSA-mrhx-c7xc-m3w5: oversized collections), and that
 * cannot reach the validator past this.
 */
const JSON_LIMIT = 1024 * 1024;
// Photos and PDFs come in through signed PUTs; a phone photo is a few megabytes.
const FILE_LIMIT = 15 * 1024 * 1024;

class BodyTooLarge extends Error {}

const readBody = (request: IncomingMessage, limit: number) =>
  new Promise<Buffer>((resolve_, reject) => {
    const declared = Number(request.headers['content-length'] ?? 0);
    if (declared > limit) {
      reject(new BodyTooLarge());
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        // A lying or absent content-length is caught here, mid-stream. The stream is paused,
        // not destroyed, so the 413 reaches the client before the socket goes.
        request.pause();
        reject(new BodyTooLarge());
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve_(Buffer.concat(chunks)));
    request.on('error', reject);
    request.on('aborted', () => reject(new Error('Request aborted by the client.')));
  });

const sendJson = (response: ServerResponse, status: number, body: unknown) => {
  if (response.headersSent) return;
  const text = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  response.end(text);
};

const tooLarge = (request: IncomingMessage, response: ServerResponse, limit: number) => {
  sendJson(response, 413, {
    error: { code: 'too_large', message: `Requests are limited to ${Math.round(limit / 1024 / 1024)} MB.` },
  });
  // The rest of the body is never read; close once the answer is on the wire.
  response.once('finish', () => request.destroy());
};

/**
 * The address a request came from, as the rate limiter and the signature records see it.
 * Proxies append to X-Forwarded-For, so only the last entry is the one our own proxy wrote;
 * anything to its left came from the client and can be forged. This assumes one proxy hop.
 */
function clientAddress(request: IncomingMessage): string {
  if (TRUST_PROXY) {
    const hops = String(request.headers['x-forwarded-for'] ?? '')
      .split(',')
      .map((hop) => hop.trim())
      .filter(Boolean);
    const forwarded = hops[hops.length - 1];
    if (forwarded) return forwarded;
  }
  return request.socket.remoteAddress ?? '127.0.0.1';
}

/** A top-level page load or refresh, as opposed to a fetch() from the running app. */
function isPageLoad(request: Pick<IncomingMessage, 'headers'>): boolean {
  const fetchMode = request.headers['sec-fetch-mode'];
  if (fetchMode) return fetchMode === 'navigate';
  // Older browsers send no fetch metadata; a page load is the only GET that asks for HTML first.
  return /^text\/html/i.test(String(request.headers.accept ?? ''));
}

/** Serves the built SPA. Unknown paths fall through to index.html so client routing works. */
async function serveWeb(pathname: string, response: ServerResponse) {
  const candidate = resolve(WEB_ROOT, `.${pathname}`);
  // A request for ../../etc/passwd must not escape the web root.
  const inside = candidate === WEB_ROOT || candidate.startsWith(WEB_ROOT + sep);
  const file = inside && extname(candidate) ? candidate : join(WEB_ROOT, 'index.html');
  try {
    const bytes = await readFile(file);
    response.writeHead(200, {
      'content-type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream',
      'content-length': bytes.length,
      // The SPA is fingerprinted by Vite except for index.html, which must never be stale.
      'cache-control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable',
      ...(file.endsWith('.html') ? { 'content-security-policy': PAGE_CSP } : {}),
    });
    response.end(bytes);
  } catch {
    sendJson(response, 404, { error: 'not_found', message: 'No such page.' });
  }
}

/** Signed GET and PUT under /files, the on-disk stand-in for presigned S3 URLs. */
async function serveFile(request: IncomingMessage, response: ServerResponse, url: URL) {
  const key = url.pathname.slice('/files/'.length).split('/').map(decodeURIComponent).join('/');
  const method = request.method === 'PUT' ? 'PUT' : 'GET';
  const ok = verifyLocalSignature(
    method,
    key,
    Number(url.searchParams.get('exp')),
    url.searchParams.get('sig') ?? '',
  );
  if (!ok) {
    sendJson(response, 403, { error: 'bad_signature', message: 'The link is invalid or expired.' });
    return;
  }
  try {
    const path = localPathFor(key);
    if (method === 'PUT') {
      await mkdir(dirname(path), { recursive: true });
      let body: Buffer;
      try {
        body = await readBody(request, FILE_LIMIT);
      } catch (error) {
        if (error instanceof BodyTooLarge) return tooLarge(request, response, FILE_LIMIT);
        throw error;
      }
      await writeFile(path, body);
      response.writeHead(204);
      response.end();
    } else {
      const bytes = await readFile(path);
      response.writeHead(200, {
        'content-type': CONTENT_TYPES[extname(key)] ?? 'application/octet-stream',
        'content-length': bytes.length,
        // A signed link to someone's lease must not be cached by a shared proxy.
        'cache-control': 'private, no-store',
        // Uploads are displayed by the app, never run as a page. An HTML or SVG file that
        // reached storage under a photo's key must not execute on this origin.
        'content-security-policy': "default-src 'none'; sandbox",
      });
      response.end(bytes);
    }
  } catch {
    sendJson(response, 404, { error: 'not_found', message: 'No such file.' });
  }
}

async function handle(request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  const method = request.method ?? 'GET';
  const started = Date.now();
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.setHeader(name, value);

  // The SPA is served from this same origin, so there is no cross-origin call to preflight.
  if (method === 'OPTIONS') {
    response.writeHead(204, { allow: 'GET,POST,PUT,PATCH,DELETE,OPTIONS' });
    response.end();
    return;
  }

  if (url.pathname.startsWith('/files/') && (method === 'GET' || method === 'PUT')) {
    await serveFile(request, response, url);
    return;
  }

  // Screens and endpoints share paths (/applications, /tickets, /leases/{id}), so a refresh
  // on one of those screens used to come back as the API's JSON. A browser loading a page
  // says so; the app's own fetch() calls do not, so they still reach the API.
  if (method === 'GET' && isPageLoad(request)) {
    await serveWeb(url.pathname, response);
    return;
  }

  const found = match(method, url.pathname);
  if (!found) {
    // Anything the API does not claim is the web app, so a deep link works on a refresh.
    if (method === 'GET') await serveWeb(url.pathname, response);
    else sendJson(response, 404, { error: 'not_found', message: 'No such endpoint.' });
    return;
  }

  const headers = Object.fromEntries(
    Object.entries(request.headers).map(([key, value]) => [
      key,
      Array.isArray(value) ? value.join(',') : (value ?? ''),
    ]),
  );

  const bearer = (headers['authorization'] ?? '').replace(/^Bearer\s+/i, '');
  const user = bearer ? await currentUser(bearer) : null;
  if (!user && !PUBLIC_ROUTES.has(`${method} ${url.pathname}`)) {
    // The dev server would have guessed an identity here. This is the whole difference.
    sendJson(response, 401, { error: { code: 'unauthorised', message: 'Sign in to continue.' } });
    logger.info('Request refused.', { status: 401, method, path: url.pathname });
    return;
  }

  let body: string | undefined;
  if (!['GET', 'HEAD'].includes(method)) {
    try {
      body = (await readBody(request, JSON_LIMIT)).toString('utf8');
    } catch (error) {
      if (error instanceof BodyTooLarge) return tooLarge(request, response, JSON_LIMIT);
      throw error;
    }
  }

  const event = {
    version: '2.0',
    rawPath: url.pathname,
    rawQueryString: url.search.slice(1),
    headers,
    queryStringParameters: Object.fromEntries(url.searchParams),
    pathParameters: {},
    body,
    isBase64Encoded: false,
    requestContext: {
      requestId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      http: {
        method,
        path: url.pathname,
        sourceIp: clientAddress(request),
        userAgent: headers['user-agent'] ?? 'self-hosted',
      },
      authorizer: user
        ? {
            jwt: {
              // The same claim shape API Gateway produces, so lib/auth.ts parses one thing.
              claims: { sub: user.sub, email: user.email, 'cognito:groups': `[${user.role}]` },
              scopes: [],
            },
          }
        : undefined,
    },
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;

  const result = (await api(event)) as {
    statusCode: number;
    headers?: Record<string, string>;
    body?: string;
  };
  response.writeHead(result.statusCode, {
    'content-type': 'application/json',
    // The API answers with data belonging to one signed-in person.
    'cache-control': 'private, no-store',
    ...result.headers,
  });
  response.end(result.body ?? '');
  logger.info('Request completed.', {
    status: result.statusCode,
    method,
    path: url.pathname,
    durationMs: Date.now() - started,
  });
}

/**
 * Everything a request does runs inside this one catch. The URL parse, the static file reads
 * and the body read all used to sit outside the try block around the API call, so a malformed
 * path or a connection dropped mid-upload became an unhandled rejection, and Node's answer to
 * that is to exit: one bad request took the whole site down for every tenant.
 */
const server = createServer((request, response) => {
  handle(request, response).catch((error: unknown) => {
    logger.error('Unhandled failure.', { error, method: request.method, path: request.url });
    sendJson(response, 500, {
      error: { code: 'internal_error', message: 'Something went wrong on our side.' },
    });
    if (!response.writableEnded) response.end();
  });
});

// A client that sends garbage before the request line gets a plain 400 instead of an
// exception on the server; a socket that errors is just closed.
server.on('clientError', (error: NodeJS.ErrnoException, socket) => {
  if (error.code === 'ECONNRESET' || !socket.writable) {
    socket.destroy();
    return;
  }
  socket.end('HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n');
});

// Belt and braces: nothing above should reach here, and if something does the log line is
// worth more than a dead process.
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection.', { error: reason });
});
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception.', { error });
});

server.listen(PORT, HOST, () => {
  logger.info('Self-hosted API and web app started.', {
    url: `http://${HOST}:${PORT}`,
    webRoot: WEB_ROOT,
    database: process.env.DB_DRIVER === 'pglite' ? 'pglite' : 'postgres',
    trustProxy: TRUST_PROXY,
    jobs: RUN_JOBS ? 'in-process' : 'external (RUN_JOBS=false)',
  });
  if (RUN_JOBS) startScheduler();
});

const shutdown = (signal: string) => {
  logger.info('Stopping.', { signal });
  server.close(() => process.exit(0));
  // In-flight requests get a moment; a stuck one does not get to keep the port.
  setTimeout(() => process.exit(0), 5_000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
