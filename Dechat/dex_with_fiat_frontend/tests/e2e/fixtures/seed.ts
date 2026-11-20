/**
 * @fileoverview Deterministic primitives for the full-stack fixture.
 *
 * Every value in the fixture flows from a single string seed through these
 * helpers, so two runs with the same seed produce byte-identical fixtures.
 * Nothing here reads the wall clock, `Math.random()`, or `crypto.random*`;
 * the only external source of entropy is the seed.
 *
 * The PRNG is xmur3 (string → 32-bit state) seeding mulberry32 (32-bit state →
 * float stream), both small, well-understood, and dependency-free.
 */

import { createHash } from 'node:crypto';

/** xmur3: hash an arbitrary string into a 32-bit seed value. */
function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}

/** mulberry32: a 32-bit PRNG returning floats in [0, 1). */
function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A deterministic, seed-scoped random source. */
export class SeededRandom {
  private next32: () => number;
  readonly seed: string;

  constructor(seed: string) {
    this.seed = seed;
    const hash = xmur3(seed);
    this.next32 = mulberry32(hash());
  }

  /** Unsigned 32-bit integer in [0, 2^32). */
  uint32(): number {
    return this.next32() >>> 0;
  }

  /** Float in [0, 1). */
  float(): number {
    return this.next32() / 0x100000000;
  }

  /** Integer in [min, max] inclusive. */
  intRange(min: number, max: number): number {
    if (max < min) throw new Error(`intRange: max (${max}) < min (${min})`);
    return min + (this.uint32() % (max - min + 1));
  }

  /** Deterministically pick one element from a non-empty array. */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('pick: empty array');
    return items[this.uint32() % items.length] as T;
  }

  /** Deterministic boolean with the given probability of being `true`. */
  bool(probability = 0.5): boolean {
    return this.float() < probability;
  }
}

/** Deterministic n-byte buffer from a PRNG. Returns a fresh `Uint8Array`. */
export function randomBytes(rng: SeededRandom, n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = rng.uint32() & 0xff;
  }
  return out;
}

/** Lowercase hex string of the given byte length. */
export function hexString(rng: SeededRandom, bytes: number): string {
  return randomBytes(rng, bytes).reduce(
    (acc, b) => acc + b.toString(16).padStart(2, '0'),
    '',
  );
}

/** Deterministic uppercase hex string (e.g. for hashes displayed to users). */
export function upperHex(rng: SeededRandom, bytes: number): string {
  return hexString(rng, bytes).toUpperCase();
}

/** Deterministic 10-digit NUBAN account number (numeric string, 10 chars). */
export function nuban(rng: SeededRandom): string {
  let s = '';
  for (let i = 0; i < 10; i++) {
    s += rng.uint32() % 10;
  }
  return s;
}

/** Deterministic 3-digit bank code (matches the most common Paystack format). */
export function bankCode(rng: SeededRandom): string {
  return String(rng.intRange(1, 999)).padStart(3, '0');
}

/** Deterministic lowercase slug, `wordCount` syllables joined by `-`. */
export function slug(rng: SeededRandom, wordCount: number): string {
  const parts: string[] = [];
  for (let i = 0; i < wordCount; i++) {
    parts.push(PREFIXES[rng.uint32() % PREFIXES.length]);
  }
  return parts.join('-');
}

const PREFIXES = [
  'alpha',
  'bravo',
  'charlie',
  'delta',
  'echo',
  'foxtrot',
  'golf',
  'hotel',
  'india',
  'juliet',
  'kilo',
  'lima',
  'mike',
  'november',
  'oscar',
  'papa',
];

/** Stable, sorted-key JSON serialization so digests and diffs are reproducible. */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return Object.keys(obj)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = sortKeys(obj[key]);
        return acc;
      }, {});
  }
  return value;
}

/** SHA-256 hex digest of the canonical JSON of `value`. Used to assert that
 * the same seed reproduces the same fixture across runs. */
export function sha256Hex(value: unknown): string {
  return createHash('sha256').update(canonicalStringify(value)).digest('hex');
}
