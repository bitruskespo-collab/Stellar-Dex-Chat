import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  formatLocalizedDecimal,
  formatProviderCutoff,
  formatUtcInstant,
  parseLocalizedDecimalInput,
  toPersistedUtcIso,
} from './timeDisplay';

describe('timeDisplay UTC instant mapping (#274)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('formats the same persisted UTC instant across non-UTC zones', () => {
    const instant = '2026-03-08T06:30:00.000Z'; // DST spring-forward boundary in US
    const ny = formatUtcInstant(instant, { locale: 'en-US', timeZone: 'America/New_York' });
    const kolkata = formatUtcInstant(instant, { locale: 'en-IN', timeZone: 'Asia/Kolkata' });
    const utc = formatUtcInstant(instant, { locale: 'en-US', timeZone: 'UTC' });

    expect(ny).toContain('01:30:00');
    expect(kolkata).toContain('12:00:00');
    expect(utc).toContain('06:30:00');
    expect(toPersistedUtcIso(ny.replace('01:30:00', '06:30:00'))).toBeNull(); // sanity: display string is not persisted format
    expect(toPersistedUtcIso(instant)).toBe(instant);
  });

  it('handles DST fall-back transition without changing persisted instant', () => {
    const beforeFallback = '2026-11-01T05:30:00.000Z'; // 01:30 EDT
    const afterFallback = '2026-11-01T06:30:00.000Z';  // 01:30 EST
    const before = formatUtcInstant(beforeFallback, { locale: 'en-US', timeZone: 'America/New_York' });
    const after = formatUtcInstant(afterFallback, { locale: 'en-US', timeZone: 'America/New_York' });

    expect(before).toContain('01:30:00');
    expect(after).toContain('01:30:00');
    expect(toPersistedUtcIso(beforeFallback)).not.toBe(toPersistedUtcIso(afterFallback));
  });

  it('formats provider cutoff with explicit timezone and preserves source UTC', () => {
    const cutoff = '2026-11-01T17:00:00.000Z';
    const display = formatProviderCutoff(cutoff, { locale: 'en-GB', timeZone: 'Europe/London' });
    expect(display).toMatch(/^Provider cutoff:/);
    expect(display).toContain('17:00:00');
    expect(toPersistedUtcIso(cutoff)).toBe(cutoff);
  });

  it('returns fallback for invalid instants (boundary/failure)', () => {
    expect(formatUtcInstant('not-a-date', { fallback: 'N/A' })).toBe('N/A');
    expect(formatProviderCutoff('', { fallback: 'Cutoff unavailable' })).toBe('Cutoff unavailable');
    expect(toPersistedUtcIso('')).toBeNull();
  });
});

describe('localized numeric input (#274)', () => {
  it('parses comma-decimal and dot-decimal inputs', () => {
    expect(parseLocalizedDecimalInput('1,25', 'fr-FR')).toBe('1.25');
    expect(parseLocalizedDecimalInput('1.25', 'en-US')).toBe('1.25');
    expect(parseLocalizedDecimalInput('1 234,56', 'fr-FR')).toBe('1234.56');
    expect(parseLocalizedDecimalInput('1,234.56', 'en-US')).toBe('1234.56');
  });

  it('rejects malformed numeric input (failure case)', () => {
    expect(parseLocalizedDecimalInput('1,2,3', 'en-US')).toBeNull();
    expect(parseLocalizedDecimalInput('abc', 'en-US')).toBeNull();
    expect(parseLocalizedDecimalInput('', 'en-US')).toBeNull();
  });

  it('formats localized decimal for display only', () => {
    expect(formatLocalizedDecimal('1234.5', 'fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })).toContain('1');
    expect(formatLocalizedDecimal('1234.5', 'en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })).toBe('1,234.50');
  });
});
