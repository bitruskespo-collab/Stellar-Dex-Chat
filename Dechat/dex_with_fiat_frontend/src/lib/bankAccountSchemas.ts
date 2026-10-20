import { z } from 'zod';

/**
 * Normalization and sanitization helpers for bank account details.
 */
export function normalizeString(val: unknown): string {
  if (typeof val !== 'string') return '';
  return val.trim();
}

export function normalizeWhitespace(val: unknown): string {
  if (typeof val !== 'string') return '';
  return val.trim().replace(/\s+/g, ' ');
}

/**
 * Rejects strings containing control characters, null bytes, or malformed encodings.
 */
export function containsMalformedCharacters(val: string): boolean {
  // Reject null bytes and non-printable control characters (ASCII 0-31, 127) except tab/newline if any
  return /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(val);
}

/**
 * Supported country identifiers (case-insensitive names and 2-letter ISO codes).
 */
export const SUPPORTED_COUNTRIES = [
  'nigeria',
  'ghana',
  'kenya',
  'south-africa',
  'ng',
  'gh',
  'ke',
  'za',
] as const;

export type SupportedCountry = (typeof SUPPORTED_COUNTRIES)[number];

/**
 * Zod schema for country:
 * Normalizes whitespace and case; validates bounded length and character set.
 */
export const countrySchema = z.preprocess(
  (val) => {
    if (typeof val !== 'string') return val;
    return val.trim().toLowerCase();
  },
  z
    .string()
    .min(2, 'Country must be at least 2 characters')
    .max(50, 'Country is too long')
    .refine((val) => !containsMalformedCharacters(val), 'Invalid characters in country')
    .refine(
      (val) =>
        SUPPORTED_COUNTRIES.includes(val as SupportedCountry) ||
        /^[a-z\-]{2,50}$/.test(val),
      'Unsupported country',
    ),
);

/**
 * Zod schema for bank code:
 * 3 to 10 characters, alphanumeric only, with whitespace trimmed.
 */
export const bankCodeSchema = z.preprocess(
  (val) => (typeof val === 'string' ? val.trim() : val),
  z
    .string()
    .min(3, 'Bank code must be at least 3 characters')
    .max(10, 'Bank code is too long')
    .refine((val) => !containsMalformedCharacters(val), 'Invalid characters in bank code')
    .regex(/^[0-9a-zA-Z]{3,10}$/, 'Bank code must contain only letters and digits'),
);

/**
 * Paystack/NUBAN bank code schema (specifically 3-6 digits).
 */
export const paystackBankCodeSchema = z.preprocess(
  (val) => (typeof val === 'string' ? val.trim() : val),
  z
    .string()
    .min(3, 'Bank code must be at least 3 digits')
    .max(6, 'Bank code must be at most 6 digits')
    .regex(/^\d{3,6}$/, 'Bank code must be 3-6 digits'),
);

/**
 * General account number schema:
 * 6 to 34 characters, digits only, with whitespace trimmed.
 */
export const accountNumberSchema = z.preprocess(
  (val) => (typeof val === 'string' ? val.trim() : val),
  z
    .string()
    .min(6, 'Account number must be at least 6 digits')
    .max(34, 'Account number is too long')
    .refine((val) => !containsMalformedCharacters(val), 'Invalid characters in account number')
    .regex(/^\d+$/, 'Account number must contain only digits'),
);

/**
 * Nigerian NUBAN account number (exactly 10 digits).
 */
export const nubanAccountNumberSchema = z.preprocess(
  (val) => (typeof val === 'string' ? val.trim() : val),
  z
    .string()
    .regex(/^\d{10}$/, 'Account number must be exactly 10 digits'),
);

/**
 * Beneficiary name schema:
 * 2 to 100 characters, whitespace normalized, letters, digits, spaces, hyphens, periods, apostrophes.
 * Rejects control chars and HTML/script injection characters.
 */
export const beneficiaryNameSchema = z.preprocess(
  (val) => (typeof val === 'string' ? normalizeWhitespace(val) : val),
  z
    .string()
    .min(1, 'Beneficiary name is required')
    .max(100, 'Beneficiary name is too long')
    .refine(
      (val) => !containsMalformedCharacters(val),
      'Invalid characters in beneficiary name',
    )
    .refine(
      (val) => !/[<>;{}]/.test(val),
      'Beneficiary name contains disallowed characters',
    )
    .refine(
      (val) => /^[\p{L}\p{N}\s\-',.]+$/u.test(val),
      'Beneficiary name contains invalid characters',
    ),
);

/**
 * Beneficiary type schema (e.g. nuban, mobile_money, basa).
 */
export const beneficiaryTypeSchema = z.preprocess(
  (val) => (typeof val === 'string' ? val.trim().toLowerCase() : val),
  z
    .string()
    .min(1, 'Type is required')
    .max(50, 'Type is too long')
    .refine((val) => !containsMalformedCharacters(val), 'Invalid characters in type')
    .regex(/^[a-z0-9_\-]+$/, 'Type contains invalid characters'),
);

/**
 * Beneficiary currency schema.
 */
export const beneficiaryCurrencySchema = z.preprocess(
  (val) => (typeof val === 'string' ? val.trim().toUpperCase() : val),
  z.enum(['NGN', 'GHS', 'KES', 'ZAR', 'USD']),
);

/**
 * Strict schema for verify-account endpoint.
 * Rejects unknown fields and normalizes whitespace.
 */
export const strictVerifyAccountSchema = z
  .object({
    accountNumber: nubanAccountNumberSchema,
    bankCode: paystackBankCodeSchema,
    country: countrySchema.optional(),
  })
  .strict();

export type StrictVerifyAccountInput = z.infer<typeof strictVerifyAccountSchema>;

/**
 * Strict schema for create-recipient endpoint.
 * Rejects unknown fields and normalizes whitespace and characters.
 */
export const strictCreateRecipientSchema = z
  .object({
    type: beneficiaryTypeSchema,
    name: beneficiaryNameSchema,
    account_number: nubanAccountNumberSchema,
    bank_code: paystackBankCodeSchema,
    currency: beneficiaryCurrencySchema,
    country: countrySchema.optional(),
    description: z
      .preprocess(
        (val) => (typeof val === 'string' ? normalizeWhitespace(val) : val),
        z.string().max(200, 'Description is too long'),
      )
      .optional(),
  })
  .strict();

export type StrictCreateRecipientInput = z.infer<
  typeof strictCreateRecipientSchema
>;

/**
 * Country-specific account number rules.
 */
export interface CountryAccountRule {
  country: string;
  accountNumberPattern: RegExp;
  accountNumberDescription: string;
  bankCodePattern: RegExp;
  bankCodeDescription: string;
}

export const COUNTRY_ACCOUNT_RULES: Record<string, CountryAccountRule> = {
  nigeria: {
    country: 'nigeria',
    accountNumberPattern: /^\d{10}$/,
    accountNumberDescription: 'Nigerian account numbers must be exactly 10 digits',
    bankCodePattern: /^\d{3,6}$/,
    bankCodeDescription: 'Nigerian bank codes must be 3-6 digits',
  },
  ghana: {
    country: 'ghana',
    accountNumberPattern: /^\d{9,16}$/,
    accountNumberDescription: 'Ghanaian account numbers must be 9-16 digits',
    bankCodePattern: /^[0-9a-zA-Z]{3,8}$/,
    bankCodeDescription: 'Ghanaian bank codes must be 3-8 alphanumeric characters',
  },
  kenya: {
    country: 'kenya',
    accountNumberPattern: /^\d{10,12}$/,
    accountNumberDescription: 'Kenyan account numbers must be 10-12 digits',
    bankCodePattern: /^[0-9a-zA-Z]{3,8}$/,
    bankCodeDescription: 'Kenyan bank codes must be 3-8 alphanumeric characters',
  },
  'south-africa': {
    country: 'south-africa',
    accountNumberPattern: /^\d{9,11}$/,
    accountNumberDescription: 'South African account numbers must be 9-11 digits',
    bankCodePattern: /^\d{6}$/,
    bankCodeDescription: 'South African bank codes must be 6 digits',
  },
};

/**
 * Validates country-specific bank account details.
 * Returns field-level errors that do NOT reveal whether an account exists.
 */
export function validateCountryBankAccount(input: {
  country?: string;
  accountNumber: string;
  bankCode: string;
}): {
  success: boolean;
  errors?: Array<{ field: string; message: string }>;
  normalized?: {
    country: string;
    accountNumber: string;
    bankCode: string;
  };
} {
  const normCountry = (input.country ? input.country.trim().toLowerCase() : 'nigeria');
  const normAccount = input.accountNumber.trim();
  const normBank = input.bankCode.trim();

  const errors: Array<{ field: string; message: string }> = [];

  const rule =
    COUNTRY_ACCOUNT_RULES[normCountry] ??
    (normCountry === 'ng' ? COUNTRY_ACCOUNT_RULES.nigeria : null);

  if (!rule) {
    if (!SUPPORTED_COUNTRIES.includes(normCountry as SupportedCountry)) {
      errors.push({ field: 'country', message: 'Unsupported country' });
    }
  } else {
    if (!rule.accountNumberPattern.test(normAccount)) {
      errors.push({
        field: 'accountNumber',
        message: rule.accountNumberDescription,
      });
    }
    if (!rule.bankCodePattern.test(normBank)) {
      errors.push({
        field: 'bankCode',
        message: rule.bankCodeDescription,
      });
    }
  }

  if (errors.length > 0) {
    return { success: false, errors };
  }

  return {
    success: true,
    normalized: {
      country: normCountry,
      accountNumber: normAccount,
      bankCode: normBank,
    },
  };
}
