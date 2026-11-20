import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const mockEnv = { ADMIN_SECRET: 'test-admin-secret' };
vi.mock('@/lib/serverEnv', () => ({
  get serverEnv() {
    return mockEnv;
  },
}));

vi.mock('@/lib/security', () => ({
  enforceAdminIpAllowlist: () => null,
}));

vi.mock('@/lib/payout/reconciliation', () => ({
  reconcileStalePayouts: vi.fn().mockResolvedValue({
    processed: 2,
    transitioned: 1,
    noChange: 1,
    providerUnavailable: 0,
    errors: 0,
    results: [],
    timestamp: 123456789,
  }),
}));

const mockSloSummary = {
  generatedAt: 123456789,
  totals: {
    unresolvedCount: 2,
    amountAtRiskMinor: 150000,
    currency: 'USD',
    oldestAgeMs: 900000,
    breachCount: 1,
  },
  slo: {
    targetAgeMs: 600000,
    warningAgeMs: 300000,
    breached: true,
  },
  items: [
    {
      payoutId: 'payout_synthetic_1',
      status: 'pending',
      ageMs: 900000,
      amountMinor: 100000,
      currency: 'USD',
      nextAction: 'Reconcile with provider',
      runbookUrl: '/docs/runbooks/payout-reconciliation#stale-pending',
      evidence: { source: 'provider_ledger', reference: 'synthetic-ref-1' },
    },
    {
      payoutId: 'payout_synthetic_2',
      status: 'processing',
      ageMs: 120000,
      amountMinor: 50000,
      currency: 'USD',
      nextAction: 'Await provider confirmation',
      runbookUrl: '/docs/runbooks/payout-reconciliation#processing',
      evidence: { source: 'provider_ledger', reference: 'synthetic-ref-2' },
    },
  ],
  dbVerification: {
    verified: true,
    mismatch: false,
    queriedUnresolvedCount: 2,
    queriedAmountAtRiskMinor: 150000,
  },
};

vi.mock('@/lib/payout/reconciliationSlo', () => ({
  getReconciliationSloSummary: vi.fn().mockImplementation(async () => mockSloSummary),
}));

import { GET, POST } from './route';
import { getReconciliationSloSummary } from '@/lib/payout/reconciliationSlo';
=======

describe('Admin Reconciliation Route', () => {
  beforeEach(() => {
    mockEnv.ADMIN_SECRET = 'test-admin-secret';
    vi.clearAllMocks();
  });

  describe('GET /api/admin/reconciliation', () => {
    it('returns 401 when no authentication is provided', async () => {
      const req = new NextRequest('http://localhost/api/admin/reconciliation');
      const res = await GET(req);
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toMatch(/Unauthorized/i);
    });

    it('returns 401 when invalid token is provided in x-admin-token', async () => {
      const req = new NextRequest('http://localhost/api/admin/reconciliation', {
        headers: { 'x-admin-token': 'wrong-secret' },
      });
      const res = await GET(req);
      expect(res.status).toBe(401);
    });

    it('returns 200 when valid token is provided in x-admin-token', async () => {
      const req = new NextRequest('http://localhost/api/admin/reconciliation', {
        headers: { 'x-admin-token': 'test-admin-secret' },
      });
      const res = await GET(req);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
    });

    it('returns 200 when valid bearer token is provided', async () => {
      const req = new NextRequest('http://localhost/api/admin/reconciliation', {
        headers: { authorization: 'Bearer test-admin-secret' },
      });
      const res = await GET(req);
      expect(res.status).toBe(200);
    });

    it('returns SLO summary with age, amount at risk, next action and runbook links', async () => {
      const req = new NextRequest('http://localhost/api/admin/reconciliation', {
        headers: { 'x-admin-token': 'test-admin-secret' },
      });
      const res = await GET(req);
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.slo).toEqual(mockSloSummary.slo);
      expect(body.totals.unresolvedCount).toBe(2);
      expect(body.totals.amountAtRiskMinor).toBe(150000);
      expect(body.totals.oldestAgeMs).toBe(900000);

      expect(body.items).toHaveLength(2);
      for (const item of body.items) {
        expect(typeof item.ageMs).toBe('number');
        expect(typeof item.amountMinor).toBe('number');
        expect(typeof item.nextAction).toBe('string');
        expect(item.nextAction.length).toBeGreaterThan(0);
        expect(item.runbookUrl).toMatch(/^\/docs\/runbooks\//);
        expect(item.evidence).toBeDefined();
        expect(typeof item.evidence.source).toBe('string');
      }
    });

    it('reports DB-verified totals as matching when queries agree', async () => {
      const req = new NextRequest('http://localhost/api/admin/reconciliation', {
        headers: { 'x-admin-token': 'test-admin-secret' },
      });
      const res = await GET(req);
      const body = await res.json();

      expect(body.dbVerification.verified).toBe(true);
      expect(body.dbVerification.mismatch).toBe(false);
      expect(body.dbVerification.queriedUnresolvedCount).toBe(body.totals.unresolvedCount);
      expect(body.dbVerification.queriedAmountAtRiskMinor).toBe(body.totals.amountAtRiskMinor);
    });

    it('flags a mismatch when DB-verified totals disagree with displayed totals', async () => {
      vi.mocked(getReconciliationSloSummary).mockResolvedValueOnce({
        ...mockSloSummary,
        dbVerification: {
          verified: false,
          mismatch: true,
          queriedUnresolvedCount: 3,
          queriedAmountAtRiskMinor: 175000,
        },
      });

      const req = new NextRequest('http://localhost/api/admin/reconciliation', {
        headers: { 'x-admin-token': 'test-admin-secret' },
      });
      const res = await GET(req);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.dbVerification.mismatch).toBe(true);
      expect(body.dbVerification.verified).toBe(false);
    });

    it('returns 500 when the SLO summary computation fails', async () => {
      vi.mocked(getReconciliationSloSummary).mockRejectedValueOnce(
        new Error('db unavailable'),
      );

      const req = new NextRequest('http://localhost/api/admin/reconciliation', {
        headers: { 'x-admin-token': 'test-admin-secret' },
      });
      const res = await GET(req);
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBeDefined();
    });
  });

  describe('POST /api/admin/reconciliation', () => {
    it('returns 401 when unauthenticated', async () => {
      const req = new NextRequest('http://localhost/api/admin/reconciliation', {
        method: 'POST',
      });
      const res = await POST(req);
      expect(res.status).toBe(401);
    });

    it('triggers reconciliation when authenticated and returns summary', async () => {
      const req = new NextRequest('http://localhost/api/admin/reconciliation', {
        method: 'POST',
        headers: {
          'x-admin-token': 'test-admin-secret',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ staleAgeMs: 300000, batchSize: 20 }),
      });

      const res = await POST(req);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.processed).toBe(2);
      expect(body.data.transitioned).toBe(1);
    });

    it('returns 400 for invalid JSON body', async () => {
      const req = new NextRequest('http://localhost/api/admin/reconciliation', {
        method: 'POST',
        headers: {
          'x-admin-token': 'test-admin-secret',
          'content-type': 'application/json',
        },
        body: '{not-json',
      });

      const res = await POST(req);
      expect(res.status).toBe(400);
    });

    it('returns 500 when reconciliation throws', async () => {
      const { reconcileStalePayouts } = await import('@/lib/payout/reconciliation');
      vi.mocked(reconcileStalePayouts).mockRejectedValueOnce(new Error('provider down'));

      const req = new NextRequest('http://localhost/api/admin/reconciliation', {
        method: 'POST',
        headers: {
          'x-admin-token': 'test-admin-secret',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ staleAgeMs: 300000, batchSize: 20 }),
      });

      const res = await POST(req);
      expect(res.status).toBe(500);
    });
  });
});
