/**
 * Deterministic Transaction Amount and Asset Parser
 * Addresses Issue #74: Use rules-based parser for numeric values, symbols, and currencies
 * before asking the model to interpret conversational context.
 */

export interface ParsedAssetAmount {
  raw: string;
  amount: string | null;
  asset: string | null;
  currencyType: 'crypto' | 'fiat' | null;
  isAmbiguous: boolean;
  unsupportedSymbol?: string;
  confidence: number;
}

const SUPPORTED_CRYPTO = new Set(['XLM', 'USDC', 'BTC', 'ETH']);
const SUPPORTED_FIAT = new Set(['NGN', 'USD', 'EUR', 'GBP']);

const CURRENCY_SYMBOLS: Record<string, { code: string; type: 'crypto' | 'fiat' }> = {
  '$': { code: 'USD', type: 'fiat' },
  '₦': { code: 'NGN', type: 'fiat' },
  '€': { code: 'EUR', type: 'fiat' },
  '£': { code: 'GBP', type: 'fiat' },
};

/**
 * Deterministically extracts numbers, assets, and currencies from a user prompt.
 */
export function parseTransactionAmountAndAsset(input: string): ParsedAssetAmount {
  if (!input || typeof input !== 'string') {
    return { raw: input, amount: null, asset: null, currencyType: null, isAmbiguous: false, confidence: 0 };
  }

  const trimmed = input.trim();

  // Check currency symbols
  let detectedSymbolCode: string | null = null;
  let detectedSymbolType: 'crypto' | 'fiat' | null = null;

  for (const [sym, info] of Object.entries(CURRENCY_SYMBOLS)) {
    if (trimmed.includes(sym)) {
      if (detectedSymbolCode && detectedSymbolCode !== info.code) {
        // Conflicting symbols present
        return {
          raw: trimmed,
          amount: null,
          asset: null,
          currencyType: null,
          isAmbiguous: true,
          confidence: 0.2,
        };
      }
      detectedSymbolCode = info.code;
      detectedSymbolType = info.type;
    }
  }

  // Regex for numeric amounts (handles integers, decimals with . or ,)
  const amountRegex = /(?:^|\s)(?:[$₦€£])?\s*([0-9]+(?:[.,][0-9]+)?)\s*(?:[$₦€£])?(?:\s|$)/;
  const amountMatch = trimmed.match(amountRegex);

  let parsedAmount: string | null = null;
  if (amountMatch) {
    // Canonicalize decimal point
    parsedAmount = amountMatch[1].replace(',', '.');
    // Reject negative numbers or multiple decimal points
    if (isNaN(Number(parsedAmount)) || Number(parsedAmount) <= 0) {
      parsedAmount = null;
    }
  }

  // Regex for token / currency ticker
  const words = trimmed.toUpperCase().split(/[^A-Z0-9$₦€£]+/);
  let detectedAsset: string | null = detectedSymbolCode;
  let detectedType: 'crypto' | 'fiat' | null = detectedSymbolType;
  let unsupportedSymbol: string | undefined = undefined;

  for (const word of words) {
    if (SUPPORTED_CRYPTO.has(word)) {
      if (detectedAsset && detectedAsset !== word) {
        return {
          raw: trimmed,
          amount: parsedAmount,
          asset: null,
          currencyType: null,
          isAmbiguous: true,
          confidence: 0.3,
        };
      }
      detectedAsset = word;
      detectedType = 'crypto';
    } else if (SUPPORTED_FIAT.has(word)) {
      if (detectedAsset && detectedAsset !== word) {
        return {
          raw: trimmed,
          amount: parsedAmount,
          asset: null,
          currencyType: null,
          isAmbiguous: true,
          confidence: 0.3,
        };
      }
      detectedAsset = word;
      detectedType = 'fiat';
    } else if (['DOGE', 'SHIB', 'SOL', 'ADA', 'XRP'].includes(word)) {
      unsupportedSymbol = word;
    }
  }

  if (unsupportedSymbol && !detectedAsset) {
    return {
      raw: trimmed,
      amount: parsedAmount,
      asset: null,
      currencyType: null,
      isAmbiguous: false,
      unsupportedSymbol,
      confidence: 0.1,
    };
  }

  const confidence = (parsedAmount ? 0.5 : 0) + (detectedAsset ? 0.5 : 0);

  return {
    raw: trimmed,
    amount: parsedAmount,
    asset: detectedAsset,
    currencyType: detectedType,
    isAmbiguous: false,
    confidence,
  };
}

/**
 * Merge deterministic parser results with model output.
 * Deterministic parser always takes precedence for value-bearing fields.
 */
export function mergeWithModelIntent(
  parserResult: ParsedAssetAmount,
  modelOutput: { amount?: string; asset?: string; destination?: string }
): { amount: string | null; asset: string | null; destination: string | null; isAmbiguous: boolean } {
  return {
    amount: parserResult.amount || modelOutput.amount || null,
    asset: parserResult.asset || modelOutput.asset || null,
    destination: modelOutput.destination || null,
    isAmbiguous: parserResult.isAmbiguous,
  };
}
