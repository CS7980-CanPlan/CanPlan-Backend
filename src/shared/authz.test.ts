import { assertCallerOwns, requireCaller } from './authz';

describe('requireCaller', () => {
  it('returns the caller sub when present', () => {
    expect(requireCaller({ sub: ' u1 ' })).toBe('u1');
  });

  it('throws for an unauthenticated caller', () => {
    expect(() => requireCaller(undefined)).toThrow('authenticated user is required');
    expect(() => requireCaller({ sub: '   ' })).toThrow('authenticated user is required');
  });
});

describe('assertCallerOwns', () => {
  it('passes when the caller is the owner', () => {
    expect(assertCallerOwns({ sub: 'u1' }, 'u1')).toBe('u1');
  });

  it('rejects a foreign owner', () => {
    expect(() => assertCallerOwns({ sub: 'u1' }, 'u2')).toThrow('does not own this resource');
  });

  it('rejects an unauthenticated caller', () => {
    expect(() => assertCallerOwns(undefined, 'u1')).toThrow('authenticated user is required');
  });
});
