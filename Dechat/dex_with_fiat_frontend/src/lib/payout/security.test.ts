import { describe, it, expect, beforeEach } from 'vitest';
import {
  createKeyRegistry,
  encryptField,
  decryptField,
  reencryptField,
  rotateActiveKey,
  retireKey,
  isKeyRetired,
  getActiveKeyId,
  getPreviousKeyId,
  type KeyRegistry,
  type EncryptedField,
} from './security';

// Test-only key material. These are deterministic, non-secret fixtures used
// solely to exercise rotation logic. They must never be used in production.
const TEST_KEY_A = 'test-key-material-aaaaaaaaaaaaaaaaaaaaaaaa';
const TEST_KEY_B = 'test-key-material-bbbbbbbbbbbbbbbbbbbbbbbb';
const TEST_KEY_C = 'test-key-material-cccccccccccccccccccccccc';

const KEY_ID_A = 'key-a';
const KEY_ID_B = 'key-b';
const KEY_ID_C = 'key-c';

function makeRegistry(): KeyRegistry {
  return createKeyRegistry({
    activeKeyId: KEY_ID_A,
    keys: {
      [KEY_ID_A]: TEST_KEY_A,
    },
  });
}

describe('payout field encryption key rotation', () => {
  let registry: KeyRegistry;

  beforeEach(() => {
    registry = makeRegistry();
  });

  describe('encryption with the active key', () => {
    it('encrypts a field and stores only the key identifier', () => {
      const plaintext = 'payout-account-1234567890';
      const encrypted = encryptField(registry, plaintext);

      expect(encrypted.keyId).toBe(KEY_ID_A);
      expect(encrypted.ciphertext).toBeTruthy();
      expect(encrypted.ciphertext).not.toBe(plaintext);

      // Stored record must never contain key material.
      const serialized = JSON.stringify(encrypted);
      expect(serialized).not.toContain(TEST_KEY_A);
      expect(serialized).not.toContain(TEST_KEY_B);
      expect(serialized).not.toContain(TEST_KEY_C);
      expect(Object.keys(encrypted).sort()).toEqual(
        ['ciphertext', 'iv', 'keyId'].sort(),
      );
    });

    it('round-trips through the active key', () => {
      const plaintext = 'routing-021000021';
      const encrypted = encryptField(registry, plaintext);
      expect(decryptField(registry, encrypted)).toBe(plaintext);
    });
  });

  describe('decryption with active and previous keys', () => {
    it('decrypts data encrypted under the previous key after rotation', () => {
      const plaintext = 'payout-account-abcdef';
      const encryptedWithA = encryptField(registry, plaintext);

      // Rotate to B; A becomes the previous key.
      registry = rotateActiveKey(registry, KEY_ID_B, TEST_KEY_B);

      expect(getActiveKeyId(registry)).toBe(KEY_ID_B);
      expect(getPreviousKeyId(registry)).toBe(KEY_ID_A);

      // Old ciphertext still decrypts using the previous key.
      expect(decryptField(registry, encryptedWithA)).toBe(plaintext);

      // New ciphertext uses the active key.
      const encryptedWithB = encryptField(registry, plaintext);
      expect(encryptedWithB.keyId).toBe(KEY_ID_B);
      expect(decryptField(registry, encryptedWithB)).toBe(plaintext);
    });

    it('decrypts data encrypted under the active key', () => {
      const plaintext = 'payout-account-active';
      const encrypted = encryptField(registry, plaintext);
      expect(encrypted.keyId).toBe(KEY_ID_A);
      expect(decryptField(registry, encrypted)).toBe(plaintext);
    });
  });

  describe('incremental re-encryption progress', () => {
    it('re-encrypts a single field from previous to active key', () => {
      const plaintext = 'payout-account-reencrypt';
      const encryptedWithA = encryptField(registry, plaintext);

      registry = rotateActiveKey(registry, KEY_ID_B, TEST_KEY_B);

      const reencrypted = reencryptField(registry, encryptedWithA);
      expect(reencrypted.keyId).toBe(KEY_ID_B);
      expect(reencrypted.ciphertext).not.toBe(encryptedWithA.ciphertext);
      expect(decryptField(registry, reencrypted)).toBe(plaintext);
    });

    it('reports progress across a batch of fields', () => {
      const fields: EncryptedField[] = [
        encryptField(registry, 'field-1'),
        encryptField(registry, 'field-2'),
        encryptField(registry, 'field-3'),
      ];

      registry = rotateActiveKey(registry, KEY_ID_B, TEST_KEY_B);

      const progress: Array<{ keyId: string }> = [];
      const reencrypted = fields.map((field) => {
        const next = reencryptField(registry, field);
        progress.push({ keyId: next.keyId });
        return next;
      });

      expect(progress).toHaveLength(3);
      expect(progress.every((p) => p.keyId === KEY_ID_B)).toBe(true);
      expect(reencrypted.map((f) => decryptField(registry, f))).toEqual([
        'field-1',
        'field-2',
        'field-3',
      ]);
    });

    it('is idempotent when re-encrypting an already-active field', () => {
      const plaintext = 'payout-account-idempotent';
      const encrypted = encryptField(registry, plaintext);
      const reencrypted = reencryptField(registry, encrypted);
      expect(reencrypted.keyId).toBe(KEY_ID_A);
      expect(decryptField(registry, reencrypted)).toBe(plaintext);
    });
  });

  describe('rollback to the previous key', () => {
    it('restores the previous key as active and decrypts both generations', () => {
      const plaintext = 'payout-account-rollback';
      const encryptedWithA = encryptField(registry, plaintext);

      registry = rotateActiveKey(registry, KEY_ID_B, TEST_KEY_B);
      const encryptedWithB = encryptField(registry, plaintext);

      // Roll back: B becomes previous, A becomes active again.
      registry = rotateActiveKey(registry, KEY_ID_A, TEST_KEY_A);

      expect(getActiveKeyId(registry)).toBe(KEY_ID_A);
      expect(getPreviousKeyId(registry)).toBe(KEY_ID_B);

      expect(decryptField(registry, encryptedWithA)).toBe(plaintext);
      expect(decryptField(registry, encryptedWithB)).toBe(plaintext);
    });
  });

  describe('retirement of old keys', () => {
    it('marks a key retired and rejects decryption with it', () => {
      const plaintext = 'payout-account-retire';
      const encryptedWithA = encryptField(registry, plaintext);

      registry = rotateActiveKey(registry, KEY_ID_B, TEST_KEY_B);
      registry = retireKey(registry, KEY_ID_A);

      expect(isKeyRetired(registry, KEY_ID_A)).toBe(true);
      expect(() => decryptField(registry, encryptedWithA)).toThrow(
        /retired/i,
      );
    });

    it('allows decryption with the active key after retiring the previous key', () => {
      registry = rotateActiveKey(registry, KEY_ID_B, TEST_KEY_B);
      registry = retireKey(registry, KEY_ID_A);

      const encryptedWithB = encryptField(registry, 'payout-account-live');
      expect(decryptField(registry, encryptedWithB)).toBe(
        'payout-account-live',
      );
    });

    it('does not expose retired key material in stored records', () => {
      const encryptedWithA = encryptField(registry, 'payout-account-secret');
      registry = rotateActiveKey(registry, KEY_ID_B, TEST_KEY_B);
      registry = retireKey(registry, KEY_ID_A);

      const serialized = JSON.stringify(encryptedWithA);
      expect(serialized).not.toContain(TEST_KEY_A);
      expect(serialized).not.toContain(TEST_KEY_B);
      expect(encryptedWithA.keyId).toBe(KEY_ID_A);
    });
  });

  describe('failure cases', () => {
    it('rejects decryption with an unknown key id', () => {
      const encrypted = encryptField(registry, 'payout-account-unknown');
      const tampered: EncryptedField = { ...encrypted, keyId: 'key-unknown' };
      expect(() => decryptField(registry, tampered)).toThrow(/unknown/i);
    });

    it('rejects decryption with a retired key id', () => {
      const encrypted = encryptField(registry, 'payout-account-retired');
      registry = rotateActiveKey(registry, KEY_ID_B, TEST_KEY_B);
      registry = retireKey(registry, KEY_ID_A);
      expect(() => decryptField(registry, encrypted)).toThrow(/retired/i);
    });

    it('rejects decryption of corrupted ciphertext', () => {
      const encrypted = encryptField(registry, 'payout-account-corrupt');
      const corrupted: EncryptedField = {
        ...encrypted,
        ciphertext: encrypted.ciphertext.slice(0, -2) + 'xx',
      };
      expect(() => decryptField(registry, corrupted)).toThrow();
    });

    it('rejects decryption of corrupted iv', () => {
      const encrypted = encryptField(registry, 'payout-account-corrupt-iv');
      const corrupted: EncryptedField = {
        ...encrypted,
        iv: encrypted.iv.slice(0, -2) + 'yy',
      };
      expect(() => decryptField(registry, corrupted)).toThrow();
    });

    it('rejects re-encryption of corrupted ciphertext', () => {
      const encrypted = encryptField(registry, 'payout-account-corrupt-re');
      registry = rotateActiveKey(registry, KEY_ID_B, TEST_KEY_B);
      const corrupted: EncryptedField = {
        ...encrypted,
        ciphertext: encrypted.ciphertext.slice(0, -2) + 'zz',
      };
      expect(() => reencryptField(registry, corrupted)).toThrow();
    });

    it('rejects rotation to a key id without key material', () => {
      expect(() =>
        rotateActiveKey(registry, KEY_ID_C, undefined as unknown as string),
      ).toThrow();
    });
  });
});