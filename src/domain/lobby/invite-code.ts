import { fail, failure, ok, type Result } from '../shared/result.ts';

/**
 * Crockford's base32 alphabet: I, L, O and U are absent. The first three are
 * the ones people confuse with 1 and 0, and U is left out so a random code
 * cannot spell anything unfortunate. Codes get read out loud and typed by
 * someone impatient to play, so the confusable characters are simply not in
 * the set — and the ones that get typed anyway are folded in by
 * `normaliseInviteCode` rather than rejected.
 */
export const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const CODE_LENGTH = 4;

/** A short, shareable room key. Always upper case, always valid. */
export type InviteCode = string & { readonly __inviteCode: unique symbol };

const PATTERN = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`);

/** How a mistyped character folds onto the one the player meant. */
const FOLD: Readonly<Record<string, string>> = { I: '1', L: '1', O: '0', U: 'V' };

/**
 * Cleans up what someone actually typed: lower case, stray spaces and
 * hyphens from a copied link, and the I/L/O/U substitutions.
 */
export function normaliseInviteCode(raw: string): string {
  let out = '';
  for (const char of raw.toUpperCase()) {
    const folded = FOLD[char] ?? char;
    if (CODE_ALPHABET.includes(folded)) out += folded;
    if (out.length === CODE_LENGTH) break;
  }
  return out;
}

export function parseInviteCode(raw: string): Result<InviteCode> {
  const cleaned = normaliseInviteCode(raw);
  if (cleaned.length < CODE_LENGTH) {
    return fail(failure('invalid-invite-code', `A room code is ${CODE_LENGTH} characters long.`));
  }
  return ok(cleaned as InviteCode);
}

export const isInviteCode = (raw: string): raw is InviteCode => PATTERN.test(raw);

/**
 * @param random injected rather than reaching for Math.random, so the
 *   generator is deterministic under test.
 */
export function generateInviteCode(random: () => number = Math.random): InviteCode {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    // Clamped rather than trusting `random() < 1`: a stubbed generator that
    // returns exactly 1 would otherwise index past the end of the alphabet.
    const index = Math.min(CODE_ALPHABET.length - 1, Math.floor(random() * CODE_ALPHABET.length));
    code += CODE_ALPHABET.charAt(index);
  }
  return code as InviteCode;
}
