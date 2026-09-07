import { describe, expect, it } from 'vitest';
import { canonicalUrl, type OriginFacts } from '@adapters/firebase/canonical-origin.ts';

/**
 * The rule that decides whether the app moves itself to another domain.
 *
 * Worth testing carefully in both directions. Failing to move leaves Google
 * sign-in silently broken on every Apple device; moving when it should not
 * takes a visitor off the domain they opened, or — worse — to a domain that
 * does not serve this app at all.
 */

const facts = (over: Partial<OriginFacts> = {}): OriginFacts => ({
  authDomain: 'games-6b049.firebaseapp.com',
  host: 'games-6b049.web.app',
  rest: '/',
  alreadyMoved: false,
  ...over,
});

describe('the canonical sign-in origin', () => {
  it('moves between the two hosting domains of one project', () => {
    expect(canonicalUrl(facts())).toBe('https://games-6b049.firebaseapp.com/');
  });

  it('moves the other way round too', () => {
    // Whichever of the two is configured is the one that works, because it is
    // the one Google has an authorised redirect URI for.
    expect(
      canonicalUrl(facts({ authDomain: 'games-6b049.web.app', host: 'games-6b049.firebaseapp.com' })),
    ).toBe('https://games-6b049.web.app/');
  });

  it('stays put when it is already on the right origin', () => {
    expect(canonicalUrl(facts({ host: 'games-6b049.firebaseapp.com' }))).toBeNull();
  });

  it('ignores the case of either host', () => {
    expect(canonicalUrl(facts({ host: 'GAMES-6B049.FirebaseApp.com' }))).toBeNull();
  });

  it('carries an invite link across intact', () => {
    // A player opening a shared link on an iPhone is precisely the case this
    // exists for, so losing the code in the move would trade one broken
    // journey for another.
    const moved = canonicalUrl(facts({ rest: '/?join=R4CE' }));
    expect(moved).toBe('https://games-6b049.firebaseapp.com/?join=R4CE');
  });

  it('carries a path and a hash as well', () => {
    expect(canonicalUrl(facts({ rest: '/somewhere?a=1#deep' }))).toBe(
      'https://games-6b049.firebaseapp.com/somewhere?a=1#deep',
    );
  });

  it('never moves twice', () => {
    // The one guard against a redirect loop, which would be a page that never
    // loads at all — a far worse failure than the one being fixed.
    expect(canonicalUrl(facts({ alreadyMoved: true }))).toBeNull();
  });

  it('leaves a custom domain alone', () => {
    // Someone who put the arcade on their own domain chose it. Moving them off
    // it would be presumptuous, and their fix is the console one.
    expect(canonicalUrl(facts({ host: 'arcade.example.com' }))).toBeNull();
  });

  it('does not move to a custom authDomain', () => {
    // A custom authDomain need not serve this app, so redirecting there could
    // land the visitor on something else entirely.
    expect(canonicalUrl(facts({ authDomain: 'auth.example.com' }))).toBeNull();
  });

  it('never crosses between two different projects', () => {
    expect(
      canonicalUrl(facts({ host: 'other-project.web.app', authDomain: 'games-6b049.firebaseapp.com' })),
    ).toBeNull();
  });

  it('leaves a preview channel alone', () => {
    // `project--channel-hash.web.app` is a preview deploy and may be a
    // different build entirely; bouncing it to the live domain would silently
    // test the wrong thing.
    expect(canonicalUrl(facts({ host: 'games-6b049--pr12-a1b2c3.web.app' }))).toBeNull();
  });

  it('does nothing without an authDomain', () => {
    expect(canonicalUrl(facts({ authDomain: '' }))).toBeNull();
  });

  it('is not fooled by a lookalike domain', () => {
    // `games-6b049.web.app.evil.com` ends with neither suffix, and must not be
    // read as a hosting domain for this project.
    expect(canonicalUrl(facts({ host: 'games-6b049.web.app.evil.com' }))).toBeNull();
  });
});
