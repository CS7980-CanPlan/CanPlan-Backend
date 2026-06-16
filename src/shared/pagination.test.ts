import { decodeNextToken, encodeNextToken } from './pagination';

describe('pagination tokens', () => {
  it('round-trips a DynamoDB key through encode/decode', () => {
    const key = { PK: 'TASK#t1', SK: '#META', entityType: 'Task', createdAt: '2026-06-15T10:00:00Z' };
    const token = encodeNextToken(key);
    expect(typeof token).toBe('string');
    expect(decodeNextToken(token)).toEqual(key);
  });

  it('encodes a missing key as null (no more pages)', () => {
    expect(encodeNextToken(undefined)).toBeNull();
  });

  it('decodes empty/undefined tokens to undefined (start from the beginning)', () => {
    expect(decodeNextToken(undefined)).toBeUndefined();
    expect(decodeNextToken(null)).toBeUndefined();
    expect(decodeNextToken('')).toBeUndefined();
  });

  it('throws a ValidationError on a malformed token', () => {
    expect(() => decodeNextToken('!!!not-base64-json!!!')).toThrow('invalid nextToken');
  });
});
