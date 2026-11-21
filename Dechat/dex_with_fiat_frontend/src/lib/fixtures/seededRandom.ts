/**
 * Deterministic seeded PRNG for synthetic test fixtures.
 * Uses mulberry32 - fast, small, deterministic for a given 32-bit seed.
 */
export function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class SeededRandom {
  private readonly next: () => number;

  constructor(seed: number) {
    this.next = createSeededRandom(seed);
  }

  float(): number {
    return this.next();
  }

  int(min: number, max: number): number {
    if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) {
      throw new Error(`Invalid int range: [${min}, ${max}]`);
    }
    return Math.floor(this.float() * (max - min + 1)) + min;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('Cannot pick from empty array');
    return items[this.int(0, items.length - 1)];
  }

  hex(bytes: number): string {
    if (!Number.isInteger(bytes) || bytes < 0) throw new Error(`Invalid byte length: ${bytes}`);
    let out = '';
    for (let i = 0; i < bytes; i++) out += this.int(0, 255).toString(16).padStart(2, '0');
    return out;
  }

  digits(length: number): string {
    if (!Number.isInteger(length) || length < 0) throw new Error(`Invalid digit length: ${length}`);
    let out = '';
    for (let i = 0; i < length; i++) out += String(this.int(0, 9));
    return out;
  }

  id(prefix: string, length = 12): string {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let suffix = '';
    for (let i = 0; i < length; i++) suffix += chars[this.int(0, chars.length - 1)];
    return `${prefix}_${suffix}`;
  }
}

export const DEFAULT_FIXTURE_SEED = 20260321;
