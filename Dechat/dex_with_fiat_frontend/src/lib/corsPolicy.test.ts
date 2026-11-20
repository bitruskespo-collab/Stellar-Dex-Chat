import { describe, it, expect } from 'vitest';
import {
  resolveCorsPolicy,
  isOriginAllowed,
  evaluatePreflight,
  evaluateStateChangingRequest,
  type CorsRoute,
  type CorsEnvironment,
} from './corsPolicy';

const FINANCIAL_ROUTES: CorsRoute[] = [
  '/api/financial/transfer',
  '/api/financial/withdraw',
  '/api/financial/deposit',
  '/api/financial/balance',
];

const PRODUCTION_ENV: CorsEnvironment = {
  nodeEnv: 'production',
  allowedOrigins: ['https://app.example.com', 'https://admin.example.com'],
  localDevOrigins: [],
};

const LOCAL_DEV_ENV: CorsEnvironment = {
  nodeEnv: 'development',
  allowedOrigins: ['https://app.example.com'],
  localDevOrigins: ['http://localhost:3000', 'http://127.0.0.1:3000'],
};

describe('resolveCorsPolicy', () => {
  it('returns restrictive credential policy for financial routes in production', () => {
    for (const route of FINANCIAL_ROUTES) {
      const policy = resolveCorsPolicy(route, PRODUCTION_ENV);
      expect(policy.allowCredentials).toBe(true);
      expect(policy.allowedOrigins).toEqual([
        'https://app.example.com',
        'https://admin.example.com',
      ]);
      expect(policy.allowedOrigins).not.toContain('*');
    }
  });

  it('includes local dev origins only in local development', () => {
    const devPolicy = resolveCorsPolicy('/api/financial/transfer', LOCAL_DEV_ENV);
    expect(devPolicy.allowedOrigins).toContain('http://localhost:3000');
    expect(devPolicy.allowedOrigins).toContain('http://127.0.0.1:3000');
    expect(devPolicy.allowCredentials).toBe(true);

    const prodPolicy = resolveCorsPolicy('/api/financial/transfer', PRODUCTION_ENV);
    expect(prodPolicy.allowedOrigins).not.toContain('http://localhost:3000');
    expect(prodPolicy.allowedOrigins).not.toContain('http://127.0.0.1:3000');
  });

  it('never allows wildcard origins on financial routes', () => {
    for (const route of FINANCIAL_ROUTES) {
      const policy = resolveCorsPolicy(route, PRODUCTION_ENV);
      expect(policy.allowedOrigins).not.toContain('*');
    }
  });
});

describe('isOriginAllowed', () => {
  it('allows configured production origins', () => {
    const policy = resolveCorsPolicy('/api/financial/transfer', PRODUCTION_ENV);
    expect(isOriginAllowed('https://app.example.com', policy)).toBe(true);
    expect(isOriginAllowed('https://admin.example.com', policy)).toBe(true);
  });

  it('rejects untrusted origins in production', () => {
    const policy = resolveCorsPolicy('/api/financial/transfer', PRODUCTION_ENV);
    expect(isOriginAllowed('https://evil.example.com', policy)).toBe(false);
    expect(isOriginAllowed('http://localhost:3000', policy)).toBe(false);
    expect(isOriginAllowed('null', policy)).toBe(false);
    expect(isOriginAllowed('', policy)).toBe(false);
  });

  it('allows local dev origins only in local development', () => {
    const devPolicy = resolveCorsPolicy('/api/financial/transfer', LOCAL_DEV_ENV);
    expect(isOriginAllowed('http://localhost:3000', devPolicy)).toBe(true);
    expect(isOriginAllowed('http://127.0.0.1:3000', devPolicy)).toBe(true);
    expect(isOriginAllowed('https://evil.example.com', devPolicy)).toBe(false);
  });

  it('rejects origins with mismatched scheme or port', () => {
    const policy = resolveCorsPolicy('/api/financial/transfer', PRODUCTION_ENV);
    expect(isOriginAllowed('http://app.example.com', policy)).toBe(false);
    expect(isOriginAllowed('https://app.example.com:8443', policy)).toBe(false);
    expect(isOriginAllowed('https://sub.app.example.com', policy)).toBe(false);
  });
});

describe('evaluatePreflight', () => {
  it('accepts preflight from trusted origin with allowed method', () => {
    const policy = resolveCorsPolicy('/api/financial/transfer', PRODUCTION_ENV);
    const result = evaluatePreflight(
      {
        origin: 'https://app.example.com',
        method: 'POST',
        requestedHeaders: ['content-type', 'authorization'],
      },
      policy,
    );
    expect(result.allowed).toBe(true);
    expect(result.headers['Access-Control-Allow-Origin']).toBe('https://app.example.com');
    expect(result.headers['Access-Control-Allow-Credentials']).toBe('true');
    expect(result.headers['Access-Control-Allow-Origin']).not.toBe('*');
  });

  it('rejects preflight from untrusted origin', () => {
    const policy = resolveCorsPolicy('/api/financial/transfer', PRODUCTION_ENV);
    const result = evaluatePreflight(
      {
        origin: 'https://evil.example.com',
        method: 'POST',
        requestedHeaders: ['content-type'],
      },
      policy,
    );
    expect(result.allowed).toBe(false);
    expect(result.headers['Access-Control-Allow-Origin']).toBeUndefined();
    expect(result.headers['Access-Control-Allow-Credentials']).toBeUndefined();
  });

  it('rejects preflight with disallowed method', () => {
    const policy = resolveCorsPolicy('/api/financial/transfer', PRODUCTION_ENV);
    const result = evaluatePreflight(
      {
        origin: 'https://app.example.com',
        method: 'DELETE',
        requestedHeaders: ['content-type'],
      },
      policy,
    );
    expect(result.allowed).toBe(false);
  });

  it('rejects preflight with disallowed headers', () => {
    const policy = resolveCorsPolicy('/api/financial/transfer', PRODUCTION_ENV);
    const result = evaluatePreflight(
      {
        origin: 'https://app.example.com',
        method: 'POST',
        requestedHeaders: ['x-evil-header'],
      },
      policy,
    );
    expect(result.allowed).toBe(false);
  });

  it('rejects preflight with missing origin', () => {
    const policy = resolveCorsPolicy('/api/financial/transfer', PRODUCTION_ENV);
    const result = evaluatePreflight(
      {
        origin: '',
        method: 'POST',
        requestedHeaders: ['content-type'],
      },
      policy,
    );
    expect(result.allowed).toBe(false);
  });
});

describe('evaluateStateChangingRequest', () => {
  it('allows state-changing request from trusted origin', () => {
    const policy = resolveCorsPolicy('/api/financial/transfer', PRODUCTION_ENV);
    const result = evaluateStateChangingRequest(
      {
        origin: 'https://app.example.com',
        method: 'POST',
      },
      policy,
    );
    expect(result.allowed).toBe(true);
    expect(result.headers['Access-Control-Allow-Origin']).toBe('https://app.example.com');
    expect(result.headers['Access-Control-Allow-Credentials']).toBe('true');
  });

  it('rejects state-changing request from untrusted origin', () => {
    const policy = resolveCorsPolicy('/api/financial/transfer', PRODUCTION_ENV);
    const result = evaluateStateChangingRequest(
      {
        origin: 'https://evil.example.com',
        method: 'POST',
      },
      policy,
    );
    expect(result.allowed).toBe(false);
    expect(result.headers['Access-Control-Allow-Origin']).toBeUndefined();
  });

  it('rejects state-changing request with missing origin', () => {
    const policy = resolveCorsPolicy('/api/financial/transfer', PRODUCTION_ENV);
    const result = evaluateStateChangingRequest(
      {
        origin: '',
        method: 'POST',
      },
      policy,
    );
    expect(result.allowed).toBe(false);
  });

  it('rejects state-changing request with null origin', () => {
    const policy = resolveCorsPolicy('/api/financial/transfer', PRODUCTION_ENV);
    const result = evaluateStateChangingRequest(
      {
        origin: 'null',
        method: 'POST',
      },
      policy,
    );
    expect(result.allowed).toBe(false);
  });

  it('allows local dev origin in local development only', () => {
    const devPolicy = resolveCorsPolicy('/api/financial/transfer', LOCAL_DEV_ENV);
    const devResult = evaluateStateChangingRequest(
      {
        origin: 'http://localhost:3000',
        method: 'POST',
      },
      devPolicy,
    );
    expect(devResult.allowed).toBe(true);

    const prodPolicy = resolveCorsPolicy('/api/financial/transfer', PRODUCTION_ENV);
    const prodResult = evaluateStateChangingRequest(
      {
        origin: 'http://localhost:3000',
        method: 'POST',
      },
      prodPolicy,
    );
    expect(prodResult.allowed).toBe(false);
  });
});