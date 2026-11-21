/**
 * Time display helpers for persisted UTC instants.
 *
 * Persistence stays in UTC ISO/epoch; display is explicit and testable for
 * non-UTC zones and DST transitions.
 */

export type PersistedInstant = string | number | Date;

export interface FormatUtcInstantOptions {
  locale?: string | string[];
  timeZone?: string;
  includeTimeZoneName?: boolean;
  fallback?: string;
}

export function toUtcDate(instant: PersistedInstant): Date | null {
  if (instant instanceof Date) {
    return Number.isNaN(instant.getTime()) ? null : instant;
  }
  if (typeof instant === 'number') {
    const d = new Date(instant);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof instant === 'string') {
    const trimmed = instant.trim();
    if (!trimmed) return null;
    const d = new Date(trimmed);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

export function toPersistedUtcIso(instant: PersistedInstant): string | null {
  const d = toUtcDate(instant);
  return d ? d.toISOString() : null;
}

/**
 * Formats a persisted UTC instant for display in a specific IANA timezone.
 * The source instant is not mutated; callers should persist `toPersistedUtcIso`.
 */
export function formatUtcInstant(
  instant: PersistedInstant,
  {
    locale = 'en-US',
    timeZone,
    includeTimeZoneName = true,
    fallback = '—',
  }: FormatUtcInstantOptions = {},
): string {
  const d = toUtcDate(instant);
  if (!d) return fallback;
  const options: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    ...(includeTimeZoneName ? { timeZoneName: 'short' } : {}),
    ...(timeZone ? { timeZone } : {}),
  };
  return new Intl.DateTimeFormat(locale, options).format(d);
}

export function formatProviderCutoff(
  cutoffInstant: PersistedInstant,
  {
    locale = 'en-US',
    timeZone,
    fallback = 'Cutoff unavailable',
  }: Omit<FormatUtcInstantOptions, 'includeTimeZoneName'> = {},
): string {
  const formatted = formatUtcInstant(cutoffInstant, {
    locale,
    timeZone,
    includeTimeZoneName: true,
    fallback: '',
  });
  if (!formatted) return fallback;
  return `Provider cutoff: ${formatted}`;
}

/**
 * Parses localized numeric input (including comma decimal locales) into canonical
 * decimal string. Does not accept ambiguous mixed separators unless unambiguous.
 */
export function parseLocalizedDecimalInput(
  raw: string,
  locale: string = 'en-US',
): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Remove spaces/NBSP used as grouping separators
  let s = trimmed.replace(/[\s\u00A0]/g, '');
  const hasDot = s.includes('.');
  const hasComma = s.includes(',');

  if (hasDot && hasComma) {
    // Last separator is decimal; other is grouping.
    const lastDot = s.lastIndexOf('.');
    const lastComma = s.lastIndexOf(',');
    const decimalSep = lastDot > lastComma ? '.' : ',';
    const groupSep = decimalSep === '.' ? ',' : '.';
    const parts = s.split(decimalSep);
    if (parts.length !== 2) return null;
    const intPart = parts[0].split(groupSep).join('');
    const fracPart = parts[1];
    if (groupSep && parts[0].includes(groupSep) && !/^\d{1,3}(\d{3})*$/.test(intPart.replace(/^-/, ''))) {
      // allow simple grouped ints; fall through to normal validation
    }
    s = `${intPart}.${fracPart}`;
  } else if (hasComma && !hasDot) {
    // Locale-sensitive: comma decimal for many locales, grouping for en-US.
    const commaDecimalLocales = /^(fr|de|es|it|pt|nl|pl|ru|tr|id|vi)(-|$)/i;
    const parts = s.split(',');
    if (parts.length === 2) {
      if (commaDecimalLocales.test(locale) || parts[1].length !== 3) {
        s = `${parts[0]}.${parts[1]}`;
      } else {
        // likely grouping like 1,234
        s = parts.join('');
      }
    } else {
      // multiple commas: grouping
      if (parts.slice(1).every((p) => p.length === 3)) s = parts.join('');
      else return null;
    }
  } else if (hasDot && !hasComma) {
    const parts = s.split('.');
    if (parts.length > 2) {
      if (parts.slice(1).every((p) => p.length === 3)) s = parts.join('');
      else return null;
    }
  }

  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return s;
}

export function formatLocalizedDecimal(
  value: string | number,
  locale: string = 'en-US',
  options: Intl.NumberFormatOptions = {},
): string {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return '';
  return new Intl.NumberFormat(locale, options).format(n);
}
