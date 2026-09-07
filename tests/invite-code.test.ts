import { describe, expect, it } from 'vitest';
import {
  CODE_LENGTH,
  generateInviteCode,
  isInviteCode,
  normaliseInviteCode,
  parseInviteCode,
} from '@domain/lobby/invite-code.ts';

describe('invite codes', () => {
  it('accepts a well-formed code', () => {
    const result = parseInviteCode('7K2M');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe('7K2M');
  });

  it('upper-cases what the player typed', () => {
    const result = parseInviteCode('a1b2');
    expect(result.ok && result.value).toBe('A1B2');
  });

  it('folds the characters people confuse, rather than rejecting them', () => {
    // I and L are meant as 1; O is meant as 0; U is meant as V.
    expect(normaliseInviteCode('ILOU')).toBe('110V');
  });

  it('ignores separators from a pasted link', () => {
    expect(normaliseInviteCode('  7k-2m ')).toBe('7K2M');
  });

  it('stops at the code length so trailing junk cannot shift it', () => {
    expect(normaliseInviteCode('7K2MZZZZ')).toBe('7K2M');
  });

  it('rejects anything too short to be a code', () => {
    const result = parseInviteCode('7K');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-invite-code');
  });

  it('rejects a string with nothing usable in it', () => {
    expect(parseInviteCode('!!!').ok).toBe(false);
  });

  describe('generation', () => {
    it('produces codes of the right length that parse back', () => {
      for (let i = 0; i < 200; i++) {
        const code = generateInviteCode();
        expect(code).toHaveLength(CODE_LENGTH);
        expect(isInviteCode(code)).toBe(true);
      }
    });

    it('is deterministic when the randomness is', () => {
      const fixed = () => 0;
      expect(generateInviteCode(fixed)).toBe('0000');
    });

    it('cannot run off the end of the alphabet when random() returns 1', () => {
      // Math.random is specified as < 1, but a stubbed one might not be, and
      // an out-of-range index would silently produce "undefined" in the code.
      const code = generateInviteCode(() => 1);
      expect(isInviteCode(code)).toBe(true);
      expect(code).toBe('ZZZZ');
    });
  });
});
