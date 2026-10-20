import { describe, it, expect } from 'vitest';
import {
  countrySchema,
  bankCodeSchema,
  paystackBankCodeSchema,
  accountNumberSchema,
  nubanAccountNumberSchema,
  beneficiaryNameSchema,
  strictVerifyAccountSchema,
  strictCreateRecipientSchema,
  validateCountryBankAccount,
} from './bankAccountSchemas';

describe('Bank Account Validation Schemas (#46)', () => {
  describe('Country Schema', () => {
    it('accepts and normalizes valid supported countries', () => {
      expect(countrySchema.parse(' Nigeria ')).toBe('nigeria');
      expect(countrySchema.parse('GHANA')).toBe('ghana');
      expect(countrySchema.parse('kenya')).toBe('kenya');
      expect(countrySchema.parse('South-Africa')).toBe('south-africa');
      expect(countrySchema.parse(' NG ')).toBe('ng');
    });

    it('rejects malformed encodings and control characters', () => {
      expect(() => countrySchema.parse('nigeria\x00')).toThrow();
      expect(() => countrySchema.parse('ghana\x08')).toThrow();
      expect(() => countrySchema.parse('kenya\x1F')).toThrow();
    });

    it('rejects boundary length violations', () => {
      expect(() => countrySchema.parse('n')).toThrow(/at least 2 characters/i);
      expect(() => countrySchema.parse('a'.repeat(51))).toThrow(/too long/i);
    });

    it('rejects invalid character sets in country', () => {
      expect(() => countrySchema.parse('nigeria123')).toThrow();
      expect(() => countrySchema.parse('ghana<script>')).toThrow();
    });
  });

  describe('Bank Code Schema', () => {
    it('accepts and trims valid bank codes', () => {
      expect(bankCodeSchema.parse(' 058 ')).toBe('058');
      expect(bankCodeSchema.parse('GH123')).toBe('GH123');
      expect(paystackBankCodeSchema.parse(' 044 ')).toBe('044');
    });

    it('rejects malformed encodings and invalid characters', () => {
      expect(() => bankCodeSchema.parse('058\x00')).toThrow();
      expect(() => paystackBankCodeSchema.parse('058a')).toThrow(/3-6 digits/i);
      expect(() => paystackBankCodeSchema.parse('05')).toThrow(/at least 3 digits/i);
      expect(() => paystackBankCodeSchema.parse('01234567')).toThrow(/at most 6 digits/i);
    });

    it('validates boundary lengths', () => {
      expect(bankCodeSchema.parse('123')).toBe('123');
      expect(bankCodeSchema.parse('1234567890')).toBe('1234567890');
      expect(() => bankCodeSchema.parse('12')).toThrow(/at least 3 characters/i);
      expect(() => bankCodeSchema.parse('12345678901')).toThrow(/too long/i);
    });
  });

  describe('Account Number Schema', () => {
    it('accepts and trims valid account numbers without altering valid identifiers', () => {
      expect(nubanAccountNumberSchema.parse(' 0123456789 ')).toBe('0123456789');
      expect(accountNumberSchema.parse(' 1234567890 ')).toBe('1234567890');
    });

    it('rejects malformed encodings, non-digits, and control characters', () => {
      expect(() => nubanAccountNumberSchema.parse('012345678\x00')).toThrow();
      expect(() => nubanAccountNumberSchema.parse('012345678a')).toThrow(/exactly 10 digits/i);
      expect(() => accountNumberSchema.parse('12345\x1F')).toThrow();
    });

    it('validates boundary lengths for NUBAN', () => {
      expect(() => nubanAccountNumberSchema.parse('123456789')).toThrow(/exactly 10 digits/i);
      expect(() => nubanAccountNumberSchema.parse('12345678901')).toThrow(/exactly 10 digits/i);
      expect(nubanAccountNumberSchema.parse('1234567890')).toBe('1234567890');
    });
  });

  describe('Beneficiary Name Schema', () => {
    it('normalizes internal multi-whitespace and trims', () => {
      expect(beneficiaryNameSchema.parse('  Ada   Lovelace  ')).toBe('Ada Lovelace');
      expect(beneficiaryNameSchema.parse('O\'Connor-Smith, Jr.')).toBe('O\'Connor-Smith, Jr.');
    });

    it('rejects injection characters, control chars, and malformed encodings', () => {
      expect(() => beneficiaryNameSchema.parse('Ada<script>')).toThrow();
      expect(() => beneficiaryNameSchema.parse('Ada; DROP TABLE;')).toThrow();
      expect(() => beneficiaryNameSchema.parse('Ada\x00Lovelace')).toThrow();
    });

    it('validates boundary lengths', () => {
      expect(() => beneficiaryNameSchema.parse('')).toThrow();
      expect(() => beneficiaryNameSchema.parse('A'.repeat(101))).toThrow(/too long/i);
      expect(beneficiaryNameSchema.parse('A'.repeat(100))).toBe('A'.repeat(100));
    });
  });

  describe('Strict Endpoint Schemas & Unknown Field Rejection', () => {
    it('strictVerifyAccountSchema rejects unknown fields', () => {
      const valid = {
        accountNumber: '0123456789',
        bankCode: '058',
      };
      expect(strictVerifyAccountSchema.safeParse(valid).success).toBe(true);

      const withUnknown = {
        ...valid,
        unknownField: 'malicious-data',
        extraParam: 123,
      };
      const res = strictVerifyAccountSchema.safeParse(withUnknown);
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.error.issues[0].code).toBe('unrecognized_keys');
      }
    });

    it('strictCreateRecipientSchema rejects unknown fields', () => {
      const valid = {
        type: 'nuban',
        name: 'Ada Lovelace',
        account_number: '0123456789',
        bank_code: '058',
        currency: 'NGN',
      };
      expect(strictCreateRecipientSchema.safeParse(valid).success).toBe(true);

      const withUnknown = {
        ...valid,
        role: 'admin',
        bypass: true,
      };
      const res = strictCreateRecipientSchema.safeParse(withUnknown);
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.error.issues[0].code).toBe('unrecognized_keys');
      }
    });
  });

  describe('Country-Specific Valid Fixtures & Non-Revealing Errors', () => {
    it('validates Nigeria fixture (10 digits NUBAN, 3-6 digit bank code)', () => {
      const valid = validateCountryBankAccount({
        country: 'nigeria',
        accountNumber: ' 0123456789 ',
        bankCode: ' 058 ',
      });
      expect(valid.success).toBe(true);
      expect(valid.normalized?.accountNumber).toBe('0123456789');
      expect(valid.normalized?.bankCode).toBe('058');

      const invalid = validateCountryBankAccount({
        country: 'nigeria',
        accountNumber: '12345',
        bankCode: '1',
      });
      expect(invalid.success).toBe(false);
      // Field-level error that does not reveal account existence
      expect(invalid.errors?.[0].message).toBe(
        'Nigerian account numbers must be exactly 10 digits',
      );
    });

    it('validates Ghana fixture (9-16 digits)', () => {
      const valid = validateCountryBankAccount({
        country: 'ghana',
        accountNumber: '123456789012',
        bankCode: 'GCB01',
      });
      expect(valid.success).toBe(true);

      const invalid = validateCountryBankAccount({
        country: 'ghana',
        accountNumber: '123',
        bankCode: 'GCB01',
      });
      expect(invalid.success).toBe(false);
      expect(invalid.errors?.[0].message).toContain('9-16 digits');
    });

    it('validates Kenya fixture (10-12 digits)', () => {
      const valid = validateCountryBankAccount({
        country: 'kenya',
        accountNumber: '12345678901',
        bankCode: 'KCB01',
      });
      expect(valid.success).toBe(true);

      const invalid = validateCountryBankAccount({
        country: 'kenya',
        accountNumber: '12345678',
        bankCode: 'KCB01',
      });
      expect(invalid.success).toBe(false);
      expect(invalid.errors?.[0].message).toContain('10-12 digits');
    });

    it('validates South Africa fixture (9-11 digits, 6 digit bank code)', () => {
      const valid = validateCountryBankAccount({
        country: 'south-africa',
        accountNumber: '1234567890',
        bankCode: '632005',
      });
      expect(valid.success).toBe(true);

      const invalid = validateCountryBankAccount({
        country: 'south-africa',
        accountNumber: '1234',
        bankCode: '12',
      });
      expect(invalid.success).toBe(false);
      expect(invalid.errors?.[0].message).toContain('9-11 digits');
      expect(invalid.errors?.[1].message).toContain('6 digits');
    });
  });
});
