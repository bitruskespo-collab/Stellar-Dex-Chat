import { describe, it, expect } from 'vitest';
import {
  redact,
  redactString,
  REDACTED,
  isSensitiveKey,
  containsSensitiveValue,
} from './redaction';

describe('redaction boundary', () => {
  describe('isSensitiveKey', () => {
    it('detects sensitive keys case-insensitively', () => {
      expect(isSensitiveKey('password')).toBe(true);
      expect(isSensitiveKey('PASSWORD')).toBe(true);
      expect(isSensitiveKey('PassWord')).toBe(true);
      expect(isSensitiveKey('apiKey')).toBe(true);
      expect(isSensitiveKey('API_KEY')).toBe(true);
      expect(isSensitiveKey('iban')).toBe(true);
      expect(isSensitiveKey('IBAN')).toBe(true);
      expect(isSensitiveKey('accountNumber')).toBe(true);
      expect(isSensitiveKey('walletAddress')).toBe(true);
      expect(isSensitiveKey('sessionToken')).toBe(true);
      expect(isSensitiveKey('prompt')).toBe(true);
      expect(isSensitiveKey('providerPayload')).toBe(true);
    });

    it('does not flag non-sensitive keys', () => {
      expect(isSensitiveKey('username')).toBe(false);
      expect(isSensitiveKey('amount')).toBe(false);
      expect(isSensitiveKey('currency')).toBe(false);
      expect(isSensitiveKey('status')).toBe(false);
      expect(isSensitiveKey('id')).toBe(false);
    });
  });

  describe('redactString', () => {
    it('redacts base64-encoded sensitive values', () => {
      const secret = 'fixture-secret-value-123';
      const encoded = Buffer.from(secret, 'utf8').toString('base64');
      const out = redactString(`token=${encoded}`);
      expect(out).not.toContain(encoded);
      expect(out).toContain(REDACTED);
    });

    it('redacts URL-encoded sensitive values', () => {
      const secret = 'fixture-secret-value-123';
      const encoded = encodeURIComponent(secret);
      const out = redactString(`value=${encoded}`);
      expect(out).not.toContain(encoded);
      expect(out).toContain(REDACTED);
    });

    it('redacts bearer tokens', () => {
      const out = redactString('Authorization: Bearer fixture-token-abc');
      expect(out).not.toContain('fixture-token-abc');
      expect(out).toContain(REDACTED);
    });

    it('preserves non-sensitive text', () => {
      const out = redactString('user logged in successfully');
      expect(out).toBe('user logged in successfully');
    });
  });

  describe('redact', () => {
    it('redacts top-level sensitive fields', () => {
      const input = {
        username: 'fixture-user',
        password: 'fixture-password',
        apiKey: 'fixture-api-key',
      };
      const out = redact(input) as Record<string, unknown>;
      expect(out.username).toBe('fixture-user');
      expect(out.password).toBe(REDACTED);
      expect(out.apiKey).toBe(REDACTED);
    });

    it('redacts nested objects and arrays', () => {
      const input = {
        user: {
          name: 'fixture-user',
          credentials: {
            password: 'fixture-password',
            token: 'fixture-token',
          },
        },
        accounts: [
          { iban: 'DE00FIXTURE0000000000', balance: 100 },
          { iban: 'DE00FIXTURE1111111111', balance: 200 },
        ],
      };
      const out = redact(input) as any;
      expect(out.user.name).toBe('fixture-user');
      expect(out.user.credentials.password).toBe(REDACTED);
      expect(out.user.credentials.token).toBe(REDACTED);
      expect(out.accounts[0].iban).toBe(REDACTED);
      expect(out.accounts[0].balance).toBe(100);
      expect(out.accounts[1].iban).toBe(REDACTED);
      expect(out.accounts[1].balance).toBe(200);
    });

    it('redacts mixed-case keys', () => {
      const input = {
        Password: 'fixture-password',
        API_KEY: 'fixture-api-key',
        SessionToken: 'fixture-session',
        WalletAddress: 'fixture-wallet',
      };
      const out = redact(input) as Record<string, unknown>;
      expect(out.Password).toBe(REDACTED);
      expect(out.API_KEY).toBe(REDACTED);
      expect(out.SessionToken).toBe(REDACTED);
      expect(out.WalletAddress).toBe(REDACTED);
    });

    it('redacts provider payloads and prompt content', () => {
      const input = {
        providerPayload: { raw: 'fixture-provider-raw' },
        prompt: 'fixture prompt content',
        messages: [{ role: 'user', content: 'fixture prompt content' }],
      };
      const out = redact(input) as any;
      expect(out.providerPayload).toBe(REDACTED);
      expect(out.prompt).toBe(REDACTED);
      expect(JSON.stringify(out)).not.toContain('fixture-provider-raw');
      expect(JSON.stringify(out)).not.toContain('fixture prompt content');
    });

    it('redacts wallet and session tokens', () => {
      const input = {
        wallet: { address: 'fixture-wallet-address', privateKey: 'fixture-private-key' },
        session: { token: 'fixture-session-token', id: 'fixture-session-id' },
      };
      const out = redact(input) as any;
      expect(out.wallet.privateKey).toBe(REDACTED);
      expect(out.session.token).toBe(REDACTED);
      expect(out.session.id).toBe('fixture-session-id');
    });

    it('redacts encoded sensitive values inside strings', () => {
      const secret = 'fixture-secret-value-123';
      const b64 = Buffer.from(secret, 'utf8').toString('base64');
      const url = encodeURIComponent(secret);
      const input = {
        note: `encoded=${b64}`,
        link: `https://example.test/?v=${url}`,
      };
      const out = redact(input) as Record<string, unknown>;
      expect(String(out.note)).not.toContain(b64);
      expect(String(out.link)).not.toContain(url);
    });

    it('preserves non-sensitive fields', () => {
      const input = {
        id: 'fixture-id',
        amount: 42,
        currency: 'EUR',
        status: 'ok',
        nested: { count: 3, active: true },
      };
      const out = redact(input);
      expect(out).toEqual(input);
    });

    it('handles null and undefined', () => {
      const input = { a: null, b: undefined, password: null };
      const out = redact(input) as Record<string, unknown>;
      expect(out.a).toBeNull();
      expect(out.b).toBeUndefined();
      expect(out.password).toBe(REDACTED);
    });

    it('handles non-string primitives', () => {
      const input = {
        count: 5,
        ratio: 1.5,
        active: true,
        big: BigInt(10),
        password: 12345,
      };
      const out = redact(input) as Record<string, unknown>;
      expect(out.count).toBe(5);
      expect(out.ratio).toBe(1.5);
      expect(out.active).toBe(true);
      expect(out.big).toBe(BigInt(10));
      expect(out.password).toBe(REDACTED);
    });

    it('handles circular references without throwing', () => {
      const input: any = { name: 'fixture', password: 'fixture-password' };
      input.self = input;
      const out = redact(input) as any;
      expect(out.name).toBe('fixture');
      expect(out.password).toBe(REDACTED);
      expect(out.self).toBeDefined();
    });

    it('handles arrays at the top level', () => {
      const input = [
        { token: 'fixture-token-1', id: 1 },
        { token: 'fixture-token-2', id: 2 },
      ];
      const out = redact(input) as any[];
      expect(out[0].token).toBe(REDACTED);
      expect(out[0].id).toBe(1);
      expect(out[1].token).toBe(REDACTED);
      expect(out[1].id).toBe(2);
    });

    it('produces output with no raw sensitive values', () => {
      const input = {
        password: 'fixture-password',
        nested: { apiKey: 'fixture-api-key', token: 'fixture-token' },
        list: [{ iban: 'DE00FIXTURE0000000000' }],
        prompt: 'fixture prompt content',
        providerPayload: { raw: 'fixture-provider-raw' },
      };
      const serialized = JSON.stringify(redact(input));
      expect(serialized).not.toContain('fixture-password');
      expect(serialized).not.toContain('fixture-api-key');
      expect(serialized).not.toContain('fixture-token');
      expect(serialized).not.toContain('DE00FIXTURE0000000000');
      expect(serialized).not.toContain('fixture prompt content');
      expect(serialized).not.toContain('fixture-provider-raw');
    });
  });

  describe('containsSensitiveValue', () => {
    it('detects sensitive values in strings', () => {
      expect(containsSensitiveValue('password=fixture')).toBe(true);
      expect(containsSensitiveValue('Bearer fixture-token')).toBe(true);
      expect(containsSensitiveValue('just some text')).toBe(false);
    });
  });
});