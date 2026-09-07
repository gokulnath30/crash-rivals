import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MATCH_STALE_AFTER_MS, MAX_SEATS, MIN_TO_BEGIN } from '@domain/lobby/match.ts';

/**
 * The security rules restate three numbers the domain owns.
 *
 * They have to: a `.rules` file cannot import TypeScript, so `staleAfterMs()`,
 * `minSeats()` and `maxSeats()` are hand-copied constants. Hand-copied
 * constants drift, and when these drift the failure is remote and confusing —
 * a room that the domain thinks is joinable and the database rejects with
 * permission-denied, or a four-seat room that cannot seat its fourth player.
 *
 * So rather than restating the numbers a third time in a test, this reads the
 * rules file and holds it to the domain.
 */
const RULES = readFileSync('firebase/firestore.rules', 'utf8');

/** Pulls the body of a zero-argument rules function that returns a number. */
function ruleNumber(name: string): number {
  const match = new RegExp(`function\\s+${name}\\(\\)\\s*\\{\\s*return\\s+([^;]+);`).exec(RULES);
  if (!match?.[1]) throw new Error(`firestore.rules has no ${name}() returning a number`);
  const expression = match[1].trim();
  if (!/^[\d\s*+]+$/.test(expression)) {
    throw new Error(`${name}() is not a plain arithmetic constant: ${expression}`);
  }
  // Sums of products, evaluated by hand. The rules file writes these as
  // readable arithmetic (`30 * 60 * 1000`) and reading them back should not
  // need an evaluator that could run anything else.
  return expression
    .split('+')
    .reduce((total, term) => total + term.split('*').reduce((n, f) => n * Number(f.trim()), 1), 0);
}

describe('the security rules and the domain', () => {
  it('agree on when a room goes stale', () => {
    expect(ruleNumber('staleAfterMs')).toBe(MATCH_STALE_AFTER_MS);
  });

  it('agree on the smallest room', () => {
    expect(ruleNumber('minSeats')).toBe(MIN_TO_BEGIN);
  });

  it('agree on the largest room', () => {
    expect(ruleNumber('maxSeats')).toBe(MAX_SEATS);
  });

  it('checks every seat a room can hold', () => {
    // `everyoneStaysPut` cannot loop, so it enumerates seats. If MAX_SEATS
    // ever grows, that enumeration has to grow with it — otherwise a joining
    // player could quietly move whoever is in the seats beyond the last one
    // checked.
    for (let seat = 0; seat < MAX_SEATS; seat += 1) {
      expect(RULES).toContain(`seatKept(${String(seat)})`);
    }
    for (let seat = 1; seat < MAX_SEATS; seat += 1) {
      expect(RULES).toContain(`incomingSeatEmpty(${String(seat)})`);
    }
  });

  it('never mentions the fields the seats array replaced', () => {
    // `incoming().guest` on a document that has no `guest` is not an error in
    // the rules language — it is null, so a comparison against it quietly
    // passes and the check it was doing is simply gone.
    expect(RULES).not.toMatch(/\(\)\.guest\b/);
    expect(RULES).not.toMatch(/\(\)\.host\b/);
  });
});
