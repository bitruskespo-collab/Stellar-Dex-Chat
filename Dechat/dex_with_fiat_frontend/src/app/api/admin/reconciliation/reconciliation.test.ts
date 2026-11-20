import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const mockEnv = { ADMIN_SECRET: 'test-admin-secret' };
vi.mock('@/lib/serverEnv', () => ({
  get serverEnv() {
    return mockEnv;
  },
}));

const mockAllowlist = vi.hoisted(() => ({
  enforceAdminIpAllowlist: vi.fn(() => null as Response | null),
}));

vi.mock('@/lib/security', () => ({
  enforceAdminIpAllowlist: mockAllowlist.enforceAdminIpAllowlist,
}));

const mockReconciliation = vi.hoisted(() => ({
  reconcileStalePayouts: vi.fn(),
}));

vi.mock('@/lib/payout/reconciliation', () => ({
  reconcileStalePayouts: mockReconciliation.reconcileStalePayouts,
}));

import { GET, POST } from './route';

const reconciliationSummary = {
  processed: 2,
  transitioned: 1,
  noChange: 1,
  providerUnavailable: 0,
  errors: 0,
  results: [],
  timestamp: 123456789,
};

describe('Admin Reconciliation Route', () => {
  beforeEach(() => {
    mockEnv.ADMIN_SECRET = 'test-admin-secret';
    vi.clearAllMocks();
    mockAllowlist.enforceAdminIpAllowlist.mockReturnValue(null);
    mockReconciliation.reconcileStalePayouts.mockResolvedValue(reconciliationSummary);
  });

  describe('authorization matrix', () => {
    it('denies unauthenticated GET with 401 and never reads reconciliation data', async () => {
      const req = new NextRequest('http://localhost/api/admin/reconciliation');
      const res = await GET(req);
      expect(res.status).toBe(401);
      expect(mockReconciliation.reconcileStalePayouts).not.toHaveBeenCalled();
    });

    it('denies unauthenticated POST with 401 and never triggers reconciliation', async () => {
      const req = new NextRequest('http://localhost/api/admin/reconciliation', {
        method: 'POST',
      });
      const res = await POST(req);
      expect(res.status).toBe(401);
      expect(mockReconciliation.reconcileStalePayouts).not.toHaveBeenCalled();
    });

    it('denies non-admin session (no admin token) with 401', async () => {
      const req = new NextRequest('http://localhost/api/admin/reconciliation', {
        headers: { cookie: 'session=regular-user-session' },
      });
      const res = await GET(req);
      expect([401, 403]).toContain(res.status);
      expect(mockReconciliation.reconcileStalePayouts).not.toHaveBeenCalled();
    });

    it('denies requests rejected by the IP allowlist with 403', async () => {
      mockAllowlist.enforceAdminIpAllowlist.mockReturnValue(
        new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 }),
      );
      const req = new NextRequest('http://localhost/api/admin/reconciliation', {
        headers: { 'x-admin-token': 'test-admin-secret' },
      });
      const res = await GET(req);
      expect(res.status).toBe(403);
      expect(mockReconciliation.reconcileStalePayouts).not.toHaveBeenCalled();
    });

    it('allows an authorized admin to receive the reconciliation report', async () => {
      const req = new NextRequest('http://localhost/api/admin/reconciliation', {
        headers: { 'x-admin-token': 'test-admin-secret' },
      });
      const res = await GET(req);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
    });
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
  });
});
