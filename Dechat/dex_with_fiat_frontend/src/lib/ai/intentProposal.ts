/**
 * Typed Intent Proposal & Validation Module
 * Addresses Issue #72: Separate language understanding from transaction execution
 * so model-generated prose cannot directly authorize or populate a wallet transaction.
 */

export const INTENT_SCHEMA_VERSION = 1;

export type SupportedIntentType = 'deposit' | 'withdraw' | 'transfer' | 'fiat_bridge';

export interface TypedIntentProposal {
  version: number;
  intentType: SupportedIntentType;
  asset: string;
  amount: string;
  destination: string;
  confidence: number;
  missingFields: string[];
  userConfirmed: boolean;
  timestamp: number;
}

const ALLOWED_INTENT_TYPES = new Set<SupportedIntentType>([
  'deposit',
  'withdraw',
  'transfer',
  'fiat_bridge',
]);

const ALLOWED_PROPOSAL_KEYS = new Set([
  'version',
  'intentType',
  'asset',
  'amount',
  'destination',
  'confidence',
  'missingFields',
  'userConfirmed',
  'timestamp',
]);

/**
 * Validates untrusted model output against the strict TypedIntentProposal schema.
 * Rejects extra/unknown fields, malformed amounts, and unauthorized bypasses.
 */
export function validateIntentProposal(raw: unknown): {
  valid: boolean;
  proposal?: TypedIntentProposal;
  errors: string[];
} {
  const errors: string[] = [];

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { valid: false, errors: ['Intent proposal must be a valid JSON object.'] };
  }

  const obj = raw as Record<string, unknown>;

  // Check for unknown or injected fields
  for (const key of Object.keys(obj)) {
    if (!ALLOWED_PROPOSAL_KEYS.has(key)) {
      errors.push(`Disallowed field detected: '${key}'.`);
    }
  }

  // Schema version
  if (obj.version !== INTENT_SCHEMA_VERSION) {
    errors.push(`Invalid schema version: expected ${INTENT_SCHEMA_VERSION}, got ${obj.version}.`);
  }

  // Intent type
  if (!obj.intentType || typeof obj.intentType !== 'string' || !ALLOWED_INTENT_TYPES.has(obj.intentType as SupportedIntentType)) {
    errors.push(`Invalid or unsupported intentType: '${obj.intentType}'.`);
  }

  // Asset validation
  if (!obj.asset || typeof obj.asset !== 'string' || !/^[A-Z0-9]{2,12}$/.test(obj.asset)) {
    errors.push('Asset must be a valid token symbol (2-12 alphanumeric uppercase characters).');
  }

  // Amount validation (decimal string > 0)
  if (!obj.amount || typeof obj.amount !== 'string' || isNaN(Number(obj.amount)) || Number(obj.amount) <= 0) {
    errors.push('Amount must be a positive numeric decimal string.');
  }

  // Destination validation (basic sanity check)
  if (obj.destination && typeof obj.destination !== 'string') {
    errors.push('Destination must be a string.');
  }

  // Missing fields array
  if (!Array.isArray(obj.missingFields)) {
    errors.push('missingFields must be an array of strings.');
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  const proposal: TypedIntentProposal = {
    version: INTENT_SCHEMA_VERSION,
    intentType: obj.intentType as SupportedIntentType,
    asset: (obj.asset as string).toUpperCase(),
    amount: obj.amount as string,
    destination: (obj.destination as string) || '',
    confidence: typeof obj.confidence === 'number' ? Math.max(0, Math.min(1, obj.confidence)) : 0.5,
    missingFields: (obj.missingFields as string[]) || [],
    // Crucial security invariant: model output NEVER has userConfirmed = true
    userConfirmed: false,
    timestamp: typeof obj.timestamp === 'number' ? obj.timestamp : Date.now(),
  };

  return { valid: true, proposal, errors: [] };
}

/**
 * Enforces explicit user confirmation gate before signing.
 * No transaction can proceed to wallet signing without passing this check.
 */
export function authorizeExecution(proposal: TypedIntentProposal, userHasApproved: boolean): boolean {
  if (!userHasApproved) {
    return false;
  }
  if (proposal.missingFields.length > 0) {
    return false;
  }
  if (proposal.confidence < 0.7) {
    return false;
  }
  return true;
}
