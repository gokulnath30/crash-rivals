import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLIPS } from '@games/ashen-ring/render/clip-timing.ts';
import { ROSTER, findRoster, rivalFor, DEFAULT_PICK } from '@games/ashen-ring/roster.ts';

/**
 * Every file Ashen Ring asks the browser for has to exist under `public/`,
 * and has to be a real GLB. A typo in a path fails silently in the game (the
 * fighter simply never appears), so it fails loudly here instead.
 */
const publicDir = resolve(__dirname, '../public');

const isGlb = (path: string): boolean => {
  const header = Buffer.alloc(4);
  const bytes = readFileSync(path).subarray(0, 4);
  bytes.copy(header);
  return header.toString('ascii') === 'glTF';
};

describe('the roster', () => {
  it('points every fighter at a model that exists and is a GLB', () => {
    for (const entry of ROSTER) {
      const path = resolve(publicDir, entry.model);
      expect(existsSync(path), `${entry.name}: ${entry.model}`).toBe(true);
      expect(isGlb(path), `${entry.name}: ${entry.model} is not a GLB`).toBe(true);
      expect(statSync(path).size).toBeGreaterThan(100_000);
    }
  });

  it('gives every fighter a unique id and a relative model path', () => {
    const ids = ROSTER.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of ROSTER) expect(entry.model.startsWith('/')).toBe(false);
  });

  it('opens on Sable, and never puts the machine in the same skin', () => {
    expect(findRoster(DEFAULT_PICK).id).toBe('sable');
    for (const entry of ROSTER) expect(rivalFor(entry.id).model).not.toBe(entry.model);
  });

  it('falls back to the default for anything unknown', () => {
    expect(findRoster('nobody').id).toBe(DEFAULT_PICK);
    expect(findRoster(null).id).toBe(DEFAULT_PICK);
  });
});

describe('the recorded clips', () => {
  it('exist, are GLBs, and are animation-only files of a sane size', () => {
    for (const [name, segment] of Object.entries(CLIPS)) {
      const path = resolve(publicDir, segment.file);
      expect(existsSync(path), `${name}: ${segment.file}`).toBe(true);
      expect(isGlb(path)).toBe(true);
      // A stripped clip is tens of kilobytes; a full avatar is fourteen
      // megabytes. Shipping the latter by mistake would be an expensive typo.
      expect(statSync(path).size).toBeLessThan(500_000);
    }
  });

  it('puts every contact frame inside its clip', () => {
    for (const segment of Object.values(CLIPS)) {
      if (segment.impact === null) continue;
      expect(segment.impact).toBeGreaterThan(0);
      expect(segment.impact).toBeLessThan(2);
    }
  });
});
