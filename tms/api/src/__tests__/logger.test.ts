import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../lib/logger';
import { requestLogger } from '../lib/http';

/** Lines are written straight to the streams, so the streams are what a test reads. */
const captured: string[] = [];
let outSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  captured.length = 0;
  const collect = (chunk: unknown) => {
    captured.push(String(chunk));
    return true;
  };
  outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(collect as never);
  errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(collect as never);
});

afterEach(() => {
  outSpy.mockRestore();
  errSpy.mockRestore();
});

const lastLine = () => JSON.parse(captured[captured.length - 1]!);

describe('structured logging', () => {
  it('writes one JSON object per line', () => {
    createLogger().info('Something happened.', { count: 2 });
    const line = lastLine();
    expect(line.level).toBe('info');
    expect(line.message).toBe('Something happened.');
    expect(line.count).toBe(2);
    expect(typeof line.time).toBe('string');
  });

  it('carries its context onto every line, and a child adds to it', () => {
    const log = createLogger({ requestId: 'req-1' });
    log.child({ leaseId: 'lease-9' }).warn('Careful.');
    const line = lastLine();
    expect(line.requestId).toBe('req-1');
    expect(line.leaseId).toBe('lease-9');
  });

  it('sends warn and error to stderr, everything else to stdout', () => {
    const log = createLogger();
    log.info('one');
    expect(outSpy).toHaveBeenCalled();
    log.error('two');
    expect(errSpy).toHaveBeenCalled();
  });
});

describe('redaction', () => {
  // This API handles ID numbers, payslips and bank details. A log group is discoverable by
  // anyone with CloudWatch read, so none of it belongs there.
  it('redacts anything that looks like a secret or PoPIA material', () => {
    createLogger().info('Body received.', {
      password: 'hunter2',
      token: 'ey.jwt.value',
      authorization: 'Bearer abc',
      idNumber: '9001015009086',
      id_number_enc: 'binary',
      accountNumber: '1234567890',
      signatureBase64: 'data:image/png;base64,AAAA',
      occupants: 3,
    });
    const line = lastLine();
    expect(line.password).toBe('[redacted]');
    expect(line.token).toBe('[redacted]');
    expect(line.authorization).toBe('[redacted]');
    expect(line.idNumber).toBe('[redacted]');
    expect(line.id_number_enc).toBe('[redacted]');
    expect(line.accountNumber).toBe('[redacted]');
    expect(line.signatureBase64).toBe('[redacted]');
    // Anything not sensitive still comes through, or the logs are useless.
    expect(line.occupants).toBe(3);
  });

  it('redacts nested and arrayed values too', () => {
    createLogger().info('Nested.', {
      applicant: { name: 'Naledi', idNumber: '9001015009086' },
      documents: [{ kind: 'payslip', accountNumber: '999' }],
    });
    const line = lastLine();
    expect(line.applicant.name).toBe('Naledi');
    expect(line.applicant.idNumber).toBe('[redacted]');
    expect(line.documents[0].accountNumber).toBe('[redacted]');
  });

  it('keeps an Error readable rather than serialising it to an empty object', () => {
    createLogger().error('It broke.', { error: new Error('connection refused') });
    const line = lastLine();
    expect(line.error.message).toBe('connection refused');
    expect(line.error.name).toBe('Error');
    expect(typeof line.error.stack).toBe('string');
  });

  it('does not recurse forever on a self-referencing object', () => {
    const loop: Record<string, unknown> = { name: 'loop' };
    loop.self = loop;
    expect(() => createLogger().info('Cycle.', { loop })).not.toThrow();
  });
});

describe('request context', () => {
  it('stamps the request id, route and caller so one request can be followed', () => {
    const event = {
      headers: { 'x-amzn-trace-id': 'Root=1-abc' },
      requestContext: {
        requestId: 'req-42',
        http: { method: 'POST', path: '/leases/9/payments' },
        authorizer: { jwt: { claims: { sub: 'sub-landlord' } } },
      },
    } as never;

    requestLogger(event).info('Handled.');
    const line = lastLine();
    expect(line.requestId).toBe('req-42');
    expect(line.traceId).toBe('Root=1-abc');
    expect(line.method).toBe('POST');
    expect(line.path).toBe('/leases/9/payments');
    expect(line.userSub).toBe('sub-landlord');
  });

  it('survives an event with no request context, as the scheduled jobs have', () => {
    expect(() => requestLogger({} as never).info('No context.')).not.toThrow();
  });
});
