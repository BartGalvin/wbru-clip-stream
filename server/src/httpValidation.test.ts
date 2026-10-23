import { describe, expect, it } from 'vitest';
import {
  isRequestBody,
  parseBoundedIntegerQuery,
  parseOptionalIntegerQuery,
  parseScalarQuery,
} from './httpValidation';

describe('HTTP request validation', () => {
  it('accepts absent and scalar query values but rejects repeated values', () => {
    expect(parseScalarQuery(undefined)).toBeUndefined();
    expect(parseScalarQuery('one')).toBe('one');
    expect(parseScalarQuery(['one', 'two'])).toBeNull();
    expect(parseScalarQuery({ nested: 'one' })).toBeNull();
  });

  it('uses the default for an absent bounded integer', () => {
    expect(parseBoundedIntegerQuery(undefined, 4, 1, 50)).toBe(4);
  });

  it.each(['', ' ', '1.5', 'NaN', 'Infinity', '-Infinity'])(
    'rejects malformed integer %j',
    (value) => {
      expect(parseBoundedIntegerQuery(value, 4, 1, 50)).toBeNull();
    },
  );

  it('rejects repeated bounded integers', () => {
    expect(parseBoundedIntegerQuery(['1', '2'], 4, 1, 50)).toBeNull();
  });

  it('clamps valid out-of-range integers', () => {
    expect(parseBoundedIntegerQuery('0', 4, 1, 50)).toBe(1);
    expect(parseBoundedIntegerQuery('51', 4, 1, 50)).toBe(50);
  });

  it('parses optional positive integer cursors', () => {
    expect(parseOptionalIntegerQuery(undefined)).toBeUndefined();
    expect(parseOptionalIntegerQuery('42')).toBe(42);
    expect(parseOptionalIntegerQuery('0', 0)).toBe(0);
    expect(parseOptionalIntegerQuery('-1', 0)).toBeNull();
    for (const value of ['', '0', '-1', '1.5', 'NaN', '9007199254740992', ['1', '2']]) {
      expect(parseOptionalIntegerQuery(value)).toBeNull();
    }
  });

  it('accepts only plain JSON object shapes as request bodies', () => {
    expect(isRequestBody({ source: null })).toBe(true);
    expect(isRequestBody(null)).toBe(false);
    expect(isRequestBody([])).toBe(false);
    expect(isRequestBody('source')).toBe(false);
  });
});
