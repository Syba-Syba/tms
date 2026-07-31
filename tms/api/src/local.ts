// The dev server is only ever development; setting it here keeps the npm script Windows-safe.
process.env.NODE_ENV ??= 'development';

import { createServer } from 'node:http';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { handler as api } from './api';
import { routeList } from './router';

/**
 * Runs the whole API as an ordinary HTTP server. This is the payoff for collapsing 30 routes
 * into one function: the same code that runs in Lambda runs here, with no emulator.
 *
 * Identity is faked from headers so you can switch sides without signing in:
 *   x-dev-sub     who you are      (default sub-landlord)
 *   x-dev-groups  space separated  (default landlord)
 *
 * It refuses to start unless NODE_ENV is development, because nothing here checks a password.
 */
if (process.env.NODE_ENV !== 'development') {
  console.error('src/local.ts is a development server. Set NODE_ENV=development to run it.');
  process.exit(1);
}

const PORT = Number(process.env.PORT ?? 3001);

const readBody = (request: import('node:http').IncomingMessage) =>
  new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });

const FILE_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
};

createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://localhost:${PORT}`);

  // The browser preflights anything with an Authorization header.
  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'access-control-allow-headers': 'content-type,authorization,x-dev-sub,x-dev-groups',
    });
    response.end();
    return;
  }

  // Landing on a bare 404 tells a newcomer nothing. Production keeps the 404; this is the
  // development server, so the root lists what actually exists.
  if (url.pathname === '/' || url.pathname === '/routes') {
    const body = JSON.stringify(
      {
        api: 'running',
        actingAs: request.headers['x-dev-sub'] ?? 'sub-landlord',
        hint: 'Send x-dev-sub and x-dev-groups to act as someone else.',
        routes: routeList(),
      },
      null,
      2,
    );
    response.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    response.end(body);
    return;
  }

  // Local storage: signed GET and PUT under /files, standing in for presigned S3 URLs.
  // POST /files/view is an API route, so only the transfer verbs are intercepted.
  if (url.pathname.startsWith('/files/') && ['GET', 'PUT'].includes(request.method ?? '')) {
    const { verifyLocalSignature, localPathFor } = await import('./lib/storage');
    const key = url.pathname
      .slice('/files/'.length)
      .split('/')
      .map(decodeURIComponent)
      .join('/');
    const method = request.method === 'PUT' ? 'PUT' : 'GET';
    const ok = verifyLocalSignature(
      method,
      key,
      Number(url.searchParams.get('exp')),
      url.searchParams.get('sig') ?? '',
    );
    if (!ok) {
      response.writeHead(403, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      response.end(JSON.stringify({ error: 'bad_signature', message: 'The link is invalid or expired.' }));
      return;
    }
    try {
      const { mkdir, readFile, writeFile } = await import('node:fs/promises');
      const { dirname } = await import('node:path');
      const path = localPathFor(key);
      if (method === 'PUT') {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, await readBody(request));
        response.writeHead(200, { 'access-control-allow-origin': '*' });
        response.end();
      } else {
        const bytes = await readFile(path);
        const extension = key.split('.').pop() ?? '';
        response.writeHead(200, {
          'content-type': FILE_TYPES[extension] ?? 'application/octet-stream',
          'content-length': bytes.length,
          'access-control-allow-origin': '*',
        });
        response.end(bytes);
      }
    } catch {
      response.writeHead(404, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      response.end(JSON.stringify({ error: 'not_found', message: 'No such file.' }));
    }
    return;
  }

  const headers = Object.fromEntries(
    Object.entries(request.headers).map(([key, value]) => [
      key,
      Array.isArray(value) ? value.join(',') : (value ?? ''),
    ]),
  );

  const bearer = (headers['authorization'] ?? '').replace(/^Bearer\s+/i, '');
  const tokenUser = bearer ? (await import('./lib/authtoken')).verifyToken(bearer) : null;
  const identity = tokenUser
    ? { sub: tokenUser.sub, groups: tokenUser.role }
    : { sub: headers['x-dev-sub'] ?? 'sub-landlord', groups: headers['x-dev-groups'] ?? 'landlord' };

  const event = {
    version: '2.0',
    rawPath: url.pathname,
    rawQueryString: url.search.slice(1),
    headers,
    queryStringParameters: Object.fromEntries(url.searchParams),
    pathParameters: {},
    body: ['GET', 'HEAD'].includes(request.method ?? '')
      ? undefined
      : (await readBody(request)).toString('utf8'),
    isBase64Encoded: false,
    requestContext: {
      http: {
        method: request.method ?? 'GET',
        path: url.pathname,
        sourceIp: request.socket.remoteAddress ?? '127.0.0.1',
        userAgent: headers['user-agent'] ?? 'local',
      },
      authorizer: {
        jwt: {
          claims: {
            sub: identity.sub,
            // Matches how API Gateway flattens the array claim, brackets included, so the
            // parser gets exercised locally exactly as it will in production.
            'cognito:groups': `[${identity.groups}]`,
          },
          scopes: [],
        },
      },
    },
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;

  const started = Date.now();
  try {
    const result = (await api(event)) as {
      statusCode: number;
      headers?: Record<string, string>;
      body?: string;
    };
    response.writeHead(result.statusCode, {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      ...result.headers,
    });
    response.end(result.body ?? '');
    console.log(`${request.method} ${url.pathname} ${result.statusCode} ${Date.now() - started}ms`);
  } catch (error) {
    console.error(`${request.method} ${url.pathname} threw`, error);
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'server_error' }));
  }
}).listen(PORT, () => {
  console.log(`API on http://localhost:${PORT}`);
  console.log('Acting as the landlord. Send x-dev-sub and x-dev-groups to be someone else.');
});
