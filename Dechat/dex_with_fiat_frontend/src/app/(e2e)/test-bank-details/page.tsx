'use client';

import { useState } from 'react';
import BankDetailsModal from '@/components/BankDetailsModal';

// Property-test helpers for amount parsing, rounding, and locale boundaries.
// These exercise token precision, fiat minor units, and locale separators
// without changing the existing page surface.

const TOKEN_PRECISIONS = [0, 2, 6, 7, 8, 18] as const;
const FIAT_MINOR_UNITS = [0, 2, 3] as const;
const LOCALE_SEPARATORS = [',', '.', ' ', '\u00a0', "'"] as const;

function parseAmount(raw: string, precision: number): number | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(trimmed)) return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return null;
  const scaled = value * 10 ** precision;
  if (Math.abs(scaled - Math.round(scaled)) > 1e-9) return null;
  return value;
}

function formatAmount(value: number, precision: number, separator: string): string {
  const fixed = value.toFixed(precision);
  const [intPart, fracPart] = fixed.split('.');
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, separator);
  return fracPart ? `${grouped}.${fracPart}` : grouped;
}

function runPropertyTests(): string[] {
  const failures: string[] = [];
  const validSamples = ['0', '1', '100', '0.1', '0.00000001', '123456789012345678', '1e6', '  42  ', '007'];
  const invalidSamples = ['', '  ', 'abc', '1.2.3', '1,2', '--1', '1e', 'NaN', 'Infinity', '0x10'];

  for (const precision of TOKEN_PRECISIONS) {
    for (const sample of validSamples) {
      const parsed = parseAmount(sample, precision);
      if (parsed === null) {
        failures.push(`valid rejected: ${sample} @ ${precision}`);
        continue;
      }
      const roundTrip = parseAmount(formatAmount(parsed, precision, ','), precision);
      if (roundTrip === null || Math.abs(roundTrip - parsed) > 10 ** -precision) {
        failures.push(`round trip failed: ${sample} @ ${precision}`);
      }
    }
    for (const sample of invalidSamples) {
      if (parseAmount(sample, precision) !== null) {
        failures.push(`invalid accepted: ${sample} @ ${precision}`);
      }
    }
  }

  for (const minorUnits of FIAT_MINOR_UNITS) {
    for (const separator of LOCALE_SEPARATORS) {
      const formatted = formatAmount(1234567.89, minorUnits, separator);
      if (formatted.includes('NaN') || formatted.includes('undefined')) {
        failures.push(`bad format: ${minorUnits} @ ${separator}`);
      }
    }
  }

  // Precision overflow must be rejected.
  if (parseAmount('0.001', 2) !== null) failures.push('overflow accepted: 0.001 @ 2');
  if (parseAmount('1.000000001', 8) !== null) failures.push('overflow accepted: 1.000000001 @ 8');

  return failures;
}

export default function TestBankDetailsPage() {
  const [open, setOpen] = useState(true);
  const [failures] = useState<string[]>(() => runPropertyTests());

  return (
    <>
      {failures.length > 0 && (
        <pre data-testid="amount-property-failures">{failures.join('\n')}</pre>
      )}
      <BankDetailsModal
        isOpen={open}
        onClose={() => setOpen(false)}
        xlmAmount={100}
      />
    </>
  );
}
