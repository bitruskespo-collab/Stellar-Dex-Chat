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

export interface PayoutProvenanceSnapshot {
  snapshotId: string;
  quote: FxQuoteRecord;
  breakdown: AmountBreakdown;
  createdOn: number;
}

/**
 * Validates quote expiry and calculates exact integer minor unit breakdown.
 */
export function calculatePayoutBreakdown(
  grossAmount: number,
  currency: string,
  quote: FxQuoteRecord,
  feePercentage: number = 0.015 // 1.5% fee
): { isValid: boolean; snapshot?: PayoutProvenanceSnapshot; error?: string } {
  const now = Date.now();
  if (now > quote.expiresAt) {
    return { isValid: false, error: 'FX Quote has expired. Please refresh quotes before proceeding.' };
  }

  // Integer arithmetic in minor units (e.g. kobo for NGN or cents for USD: 2 decimals)
  const multiplier = BigInt(10 ** quote.precisionDecimals);
  const grossMinor = BigInt(Math.round(grossAmount * 100));
  const bridgeFeeMinor = (grossMinor * BigInt(Math.round(feePercentage * 1000))) / BigInt(1000);
  const providerFeeMinor = BigInt(5000); // Flat provider fee in minor units (50.00)
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

  const snapshot: PayoutProvenanceSnapshot = {
    snapshotId: `snap_${quote.quoteId}_${now}`,
    quote,
    breakdown,
    createdOn: now,
  };

  return { isValid: true, snapshot };
}
