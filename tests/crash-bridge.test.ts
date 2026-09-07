import { describe, expect, it } from 'vitest';
import { channelFor } from '@games/crash-rivals/index.ts';

/**
 * How the framed game's traffic is split across the two data channels.
 *
 * Getting this wrong is quiet rather than loud: put the 20 Hz state on the
 * reliable channel and a single dropped packet stalls every packet behind it,
 * so the race goes rubbery; put the one-shot events on the unreliable one and
 * a lost 'go' leaves a player on the start line forever.
 */
describe('routing the framed game onto the store connection', () => {
  it('sends the host world snapshot unreliably', () => {
    // Superseded ~20 times a second; a resend arrives after the frame that
    // replaced it, so resending is worse than dropping.
    expect(channelFor({ t: 's', st: 'race', a: [], b: [] })).toBe('fast');
  });

  it('sends guest input unreliably', () => {
    expect(channelFor({ t: 'i', k: { f: 1, b: 0, l: 0, r: 0, h: 0 } })).toBe('fast');
  });

  it('sends the race start reliably', () => {
    // Lose this one and the guest never leaves the grid.
    expect(channelFor({ t: 'go' })).toBe('sure');
  });

  it('sends the result reliably', () => {
    expect(channelFor({ t: 'over', w: 1, s: 'Crossed the line first' })).toBe('sure');
  });

  it('defaults to reliable for anything it does not recognise', () => {
    // The safe default: a message we cannot classify is one we cannot afford
    // to lose.
    expect(channelFor({ t: 'something-new' })).toBe('sure');
    expect(channelFor({})).toBe('sure');
    expect(channelFor(null)).toBe('sure');
    expect(channelFor('not an object')).toBe('sure');
  });
});
