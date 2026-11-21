import { describe, it, expect } from 'vitest';
import {
  STATUS_TOKENS,
  WCAG_AA_NORMAL_TEXT,
  relativeLuminance,
  computeContrastRatio,
  meetsAA,
  type StatusKind,
} from './statusContrast';

/**
 * Contrast validation tests for the transaction-status token set (issue #295).
 *
 * Validates that every status token's foreground color meets WCAG 2.1 AA
 * (≥ 4.5 : 1) on its declared surface in both light and dark mode. These run
 * headlessly via `pnpm test:unit` without a DOM so the contrast bar is gating
 * in CI.
 */

describe('WCAG contrast helpers', () => {
  it('relativeLuminance returns 0 for black (#000000)', () => {
    expect(relativeLuminance('#000000')).toBeCloseTo(0, 5);
  });

  it('relativeLuminance returns 1 for white (#ffffff)', () => {
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 5);
  });

  it('computeContrastRatio black-on-white is 21:1', () => {
    expect(computeContrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 0);
  });

  it('computeContrastRatio is symmetric', () => {
    const ratio1 = computeContrastRatio('#2563eb', '#ffffff');
    const ratio2 = computeContrastRatio('#ffffff', '#2563eb');
    expect(ratio1).toBeCloseTo(ratio2, 5);
  });

  it('meetsAA passes for black-on-white', () => {
    expect(meetsAA('#000000', '#ffffff')).toBe(true);
  });

  it('meetsAA fails for a low-contrast pair', () => {
    // green-600 (#16a34a) on white — known ~2.6:1, below AA
    expect(meetsAA('#16a34a', '#ffffff')).toBe(false);
  });
});

describe('STATUS_TOKENS — WCAG AA contrast validation', () => {
  const statusKinds: StatusKind[] = [
    'progress',
    'success',
    'warning',
    'failure',
  ];

  describe('light mode (text on declared surface)', () => {
    for (const kind of statusKinds) {
      it(`${kind} light: text/surface contrast ≥ ${WCAG_AA_NORMAL_TEXT}:1`, () => {
        const token = STATUS_TOKENS[kind];
        const ratio = computeContrastRatio(
          token.light.text,
          token.light.surface,
        );
        expect(ratio).toBeGreaterThanOrEqual(token.light.minContrastRatio);
        expect(meetsAA(token.light.text, token.light.surface)).toBe(true);
      });
    }
  });

  describe('dark mode (text on declared surface)', () => {
    for (const kind of statusKinds) {
      it(`${kind} dark: text/surface contrast ≥ ${WCAG_AA_NORMAL_TEXT}:1`, () => {
        const token = STATUS_TOKENS[kind];
        const ratio = computeContrastRatio(token.dark.text, token.dark.surface);
        expect(ratio).toBeGreaterThanOrEqual(token.dark.minContrastRatio);
        expect(meetsAA(token.dark.text, token.dark.surface)).toBe(true);
      });
    }
  });

  describe('fixture integrity', () => {
    it('every status kind has a label, iconName, and forcedColors class', () => {
      for (const kind of statusKinds) {
        const token = STATUS_TOKENS[kind];
        expect(token.label.length).toBeGreaterThan(0);
        expect(token.iconName.length).toBeGreaterThan(0);
        expect(token.forcedColors.className.length).toBeGreaterThan(0);
      }
    });

    it('light and dark tokens declare distinct surface colors (theme tokens differ)', () => {
      for (const kind of statusKinds) {
        const token = STATUS_TOKENS[kind];
        // Light and dark surfaces must differ so we're really testing both themes.
        expect(token.light.surface.toLowerCase()).not.toBe(
          token.dark.surface.toLowerCase(),
        );
      }
    });
  });
});

describe('STATUS_TOKENS — green/amber/red CSS-var gap documented', () => {
  /**
   * These assertions document the known issue: the raw CSS-var foreground
   * tokens (--color-success/#16a34a, --color-warning/#d97706,
   * --color-danger/#dc2626) fail or are borderline on white. The STATUS_TOKENS
   * use adjusted, AA-compliant values instead.
   */
  it('--color-success (#16a34a) does NOT meet AA on white by itself', () => {
    expect(meetsAA('#16a34a', '#ffffff')).toBe(false);
  });

  it('--color-warning (#d97706) does NOT meet AA on white by itself', () => {
    expect(meetsAA('#d97706', '#ffffff')).toBe(false);
  });

  it('adjusted success text (#15803d green-700) DOES meet AA on white', () => {
    expect(meetsAA('#15803d', '#ffffff')).toBe(true);
  });

  it('adjusted warning text (#92400e amber-800) DOES meet AA on white', () => {
    expect(meetsAA('#92400e', '#ffffff')).toBe(true);
  });

  it('adjusted failure text (#991b1b red-800) DOES meet AA on white', () => {
    expect(meetsAA('#991b1b', '#ffffff')).toBe(true);
  });
});
