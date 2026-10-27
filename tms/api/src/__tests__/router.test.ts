import { describe, expect, it } from 'vitest';
import { match, routeCount } from '../router';

describe('router', () => {
  it('carries every route', () => {
    expect(routeCount).toBe(51);
  });

  it('matches a static route', () => {
    expect(match('GET', '/applications')).not.toBeNull();
    expect(match('POST', '/applications')).not.toBeNull();
  });

  it('separates methods on the same path', () => {
    expect(match('DELETE', '/applications')).toBeNull();
    expect(match('GET', '/notifications/preferences')).not.toBeNull();
    expect(match('PUT', '/notifications/preferences')).not.toBeNull();
  });

  it('pulls a single path parameter out', () => {
    const found = match('POST', '/leases/abc-123/payments');
    expect(found?.params).toEqual({ id: 'abc-123' });
  });

  it('pulls several parameters out of one path', () => {
    const found = match('DELETE', '/terminations/t-1/deductions/d-2');
    expect(found?.params).toEqual({ id: 't-1', deductionId: 'd-2' });
  });

  it('prefers a literal segment over a parameter', () => {
    // /notifications/preferences must never be captured by a route ending in a parameter.
    const found = match('GET', '/notifications/preferences');
    expect(found?.params).toEqual({});
  });

  it('decodes an encoded parameter', () => {
    const found = match('POST', '/leases/lease%3A123/payments');
    expect(found?.params.id).toBe('lease:123');
  });

  it('refuses a parameter that spans a slash', () => {
    expect(match('POST', '/leases/a/b/payments')).toBeNull();
  });

  it('returns nothing for an unknown path', () => {
    expect(match('GET', '/does-not-exist')).toBeNull();
    expect(match('GET', '/')).toBeNull();
  });
});
