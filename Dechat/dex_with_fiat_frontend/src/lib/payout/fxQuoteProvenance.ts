/**
 * FX Quote Provenance and Payout Amount Breakdowns
 * Addresses Issue #102: Make quote, fee, and rounding decisions explainable after settlement.
 */

export interface FxQuoteRecord {
  quoteId: string;
  source: string; // e.g. "binance_oracle", "central_bank"
  pair: string;   // e.g. "XLM/NGN"
  exchangeRateDecimal: string;
  quotedAt: number;
  expiresAt: number;
  precisionDecimals: number;
}

export interface AmountBreakdown {
  currency: string;
  grossMinorUnits: bigint;
  bridgeFeeMinorUnits: bigint;
  providerFeeMinorUnits: bigint;
  netMinorUnits: bigint;
}

/**
 * Version of the calculation logic that produced a snapshot. Bump whenever the
 * arithmetic in `calculatePayoutBreakdown` changes so auditors can detect
 * amounts computed by superseded logic.
 */
export const CALCULATION_VERSION = 'fx-payout-v1';

export type RoundingMode = 'half_up' | 'floor';

export interface CalculationLineage {
  calculationVersion: string;
  /** Identifiers of every input used (quote source, provider fee schedule, etc.). */
  inputSourceIds: string[];
  /** Version of the currency metadata (decimals, symbol, minor unit) used. */
  currencyMetadataVersion: string;
  roundingMode: RoundingMode;
  /** Signed difference (minor units) introduced by rounding the gross input. */
  roundingDelta: bigint;
  /** Raw inputs captured so the calculation can be replayed exactly. */
  inputs: {
    grossAmount: number;
    currency: string;
    feePercentage: number;
    providerFeeMinorUnits: bigint;
    precisionDecimals: number;
  };
}

export interface PayoutProvenanceSnapshot {
  snapshotId: string;
  quote: FxQuoteRecord;
  breakdown: AmountBreakdown;
  lineage: CalculationLineage;
  createdOn: number;
}

const PROVIDER_FEE_MINOR_UNITS = BigInt(5000); // Flat provider fee in minor units (50.00)

/**
 * Rounds a non-negative decimal amount to an integer using the given mode.
 * Returns the rounded integer and the signed delta applied.
 */
function roundToInteger(value: number, mode: RoundingMode): { rounded: number; delta: number } {
  const rounded = mode === 'floor' ? Math.floor(value) : Math.floor(value + 0.5);
  return { rounded, delta: rounded - value };
}

/**
 * Validates quote expiry and calculates exact integer minor unit breakdown.
 */
export function calculatePayoutBreakdown(
  grossAmount: number,
  currency: string,
  quote: FxQuoteRecord,
  feePercentage: number = 0.015, // 1.5% fee
  roundingMode: RoundingMode = 'half_up',
  currencyMetadataVersion: string = 'currency-metadata-v1'
): { isValid: boolean; snapshot?: PayoutProvenanceSnapshot; error?: string } {
  const now = Date.now();
  if (now > quote.expiresAt) {
    return { isValid: false, error: 'FX Quote has expired. Please refresh quotes before proceeding.' };
  }

  if (!Number.isFinite(grossAmount) || grossAmount < 0) {
    return { isValid: false, error: 'Gross payout amount must be a non-negative finite number.' };
  }

  // Integer arithmetic in minor units (e.g. kobo for NGN or cents for USD: 2 decimals)
  const rawGrossMinor = grossAmount * 100;
  const { rounded: grossMinorNumber, delta: roundingDelta } = roundToInteger(rawGrossMinor, roundingMode);
  const grossMinor = BigInt(grossMinorNumber);
  const bridgeFeeMinor = (grossMinor * BigInt(Math.round(feePercentage * 1000))) / BigInt(1000);
  const providerFeeMinor = PROVIDER_FEE_MINOR_UNITS;
  const netMinor = grossMinor - bridgeFeeMinor - providerFeeMinor;

  if (netMinor <= BigInt(0)) {
    return { isValid: false, error: 'Gross payout amount is too small to cover fees.' };
  }

  const breakdown: AmountBreakdown = {
    currency,
    grossMinorUnits: grossMinor,
    bridgeFeeMinorUnits: bridgeFeeMinor,
    providerFeeMinorUnits: providerFeeMinor,
    netMinorUnits: netMinor,
  };

  const lineage: CalculationLineage = {
    calculationVersion: CALCULATION_VERSION,
    inputSourceIds: [
      `quote:${quote.quoteId}`,
      `quote_source:${quote.source}`,
      `pair:${quote.pair}`,
      `fee_schedule:bridge-${Math.round(feePercentage * 1000)}bps`,
      'fee_schedule:provider-flat',
    ],
    currencyMetadataVersion,
    roundingMode,
    roundingDelta: BigInt(roundingDelta),
    inputs: {
      grossAmount,
      currency,
      feePercentage,
      providerFeeMinorUnits: providerFeeMinor,
      precisionDecimals: quote.precisionDecimals,
    },
  };

  const snapshot: PayoutProvenanceSnapshot = {
    snapshotId: `snap_${quote.quoteId}_${now}`,
    quote,
    breakdown,
    lineage,
    createdOn: now,
  };

  return { isValid: true, snapshot };
}

/**
 * Replays a stored snapshot's lineage inputs and asserts the recomputed
 * breakdown matches the stored amounts. Used by auditors to verify that every
 * displayed/paid amount is reproducible from persisted data.
 */
export function recomputeFromLineage(
  snapshot: PayoutProvenanceSnapshot
): { matches: boolean; recomputed?: AmountBreakdown; error?: string } {
  const lineage = snapshot?.lineage;
  if (!lineage || !lineage.inputs) {
    return { matches: false, error: 'Missing calculation lineage; cannot recompute amount.' };
  }

  if (lineage.calculationVersion !== CALCULATION_VERSION) {
    return {
      matches: false,
      error: `Unsupported calculation version: ${lineage.calculationVersion}.`,
    };
  }

  const { grossAmount, currency, feePercentage, providerFeeMinorUnits } = lineage.inputs;
  const { rounded: grossMinorNumber, delta } = roundToInteger(grossAmount * 100, lineage.roundingMode);

  if (BigInt(delta) !== lineage.roundingDelta) {
    return { matches: false, error: 'Rounding delta does not match stored lineage.' };
  }

  const grossMinor = BigInt(grossMinorNumber);
  const bridgeFeeMinor = (grossMinor * BigInt(Math.round(feePercentage * 1000))) / BigInt(1000);
  const netMinor = grossMinor - bridgeFeeMinor - providerFeeMinorUnits;

  const recomputed: AmountBreakdown = {
    currency,
    grossMinorUnits: grossMinor,
    bridgeFeeMinorUnits: bridgeFeeMinor,
    providerFeeMinorUnits,
    netMinorUnits: netMinor,
  };

  const stored = snapshot.breakdown;
  const matches =
    stored.currency === recomputed.currency &&
    stored.grossMinorUnits === recomputed.grossMinorUnits &&
    stored.bridgeFeeMinorUnits === recomputed.bridgeFeeMinorUnits &&
    stored.providerFeeMinorUnits === recomputed.providerFeeMinorUnits &&
    stored.netMinorUnits === recomputed.netMinorUnits;

  if (!matches) {
    return { matches: false, recomputed, error: 'Recomputed amount does not match stored breakdown.' };
  }

  return { matches: true, recomputed };
}
