import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { payoutAuditLedger } from '@/lib/payout/auditLedger';

const mockRequireAdminAuth = vi.fn();

vi.mock('@/app/api/admin/_utils/requireAdminAuth', () => ({
  requireAdminAuth: (req: unknown) => mockRequireAdminAuth(req),
}));

const { GET, POST, PUT, DELETE, PATCH } = await import('./route');

describe('/api/admin/payout-audit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    payoutAuditLedger._resetForTest();
    mockRequireAdminAuth.mockReturnValue(null); // Authorized by default
  });

  it('rejects unauthorized requests', async () => {
    mockRequireAdminAuth.mockReturnValue(
      new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
    );

    const req = new NextRequest(
      new Request('http://localhost/api/admin/payout-audit'),
    );
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it('returns paginated JSON audit entries', async () => {
    payoutAuditLedger.recordEvent({
      payoutId: 'PO-1',
      action: 'payout_initiated',
      actor: 'client:test',
    });
    payoutAuditLedger.recordEvent({
      payoutId: 'PO-2',
      action: 'payout_succeeded',
      actor: 'webhook:paystack',
    });

    const req = new NextRequest(
      new Request('http://localhost/api/admin/payout-audit?page=1&limit=10'),
    );
    const res = await GET(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.total).toBe(2);
    expect(body.entries).toHaveLength(2);
    expect(body.page).toBe(1);
  });

  it('exports CSV formatted records for finance reconciliation', async () => {
    payoutAuditLedger.recordEvent({
      payoutId: 'PO-CSV',
      action: 'payout_succeeded',
      actor: 'system',
    });

    const req = new NextRequest(
      new Request('http://localhost/api/admin/payout-audit?format=csv'),
    );
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('content-disposition')).toContain(
      'attachment; filename="payout-audit-ledger.csv"',
    );

    const csvText = await res.text();
    expect(csvText).toContain('PO-CSV');
    expect(csvText).toContain('payout_succeeded');
  });

  it('returns valid=true when verifying an untampered ledger', async () => {
    payoutAuditLedger.recordEvent({
      payoutId: 'PO-VERIFY-1',
      action: 'payout_initiated',
      actor: 'client:test',
    });
    payoutAuditLedger.recordEvent({
      payoutId: 'PO-VERIFY-2',
      action: 'payout_succeeded',
      actor: 'webhook:paystack',
    });

    const req = new NextRequest(
      new Request('http://localhost/api/admin/payout-audit?verify=true'),
    );
    const res = await GET(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.valid).toBe(true);
    expect(body.reason).toBeUndefined();
    expect(body.checkedEntries).toBe(2);
  });

  it('returns valid=false with a failure reason when the ledger is tampered', async () => {
    payoutAuditLedger.recordEvent({
      payoutId: 'PO-TAMPER-1',
      action: 'payout_initiated',
      actor: 'client:test',
    });
    payoutAuditLedger.recordEvent({
      payoutId: 'PO-TAMPER-2',
      action: 'payout_succeeded',
      actor: 'webhook:paystack',
    });

    // Simulate an attacker rewriting a historical payload without re-chaining.
    const entries = payoutAuditLedger.listEntries();
    entries[0].action = 'payout_failed';

    const req = new NextRequest(
      new Request('http://localhost/api/admin/payout-audit?verify=true'),
    );
    const res = await GET(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.valid).toBe(false);
    expect(typeof body.reason).toBe('string');
    expect(body.reason.length).toBeGreaterThan(0);
  });

  it('enforces authorization before running ledger verification', async () => {
    mockRequireAdminAuth.mockReturnValue(
      new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
    );

    const req = new NextRequest(
      new Request('http://localhost/api/admin/payout-audit?verify=true'),
    );
    const res = await GET(req);
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.error).toBe('Unauthorized');
  });

  it('rejects POST, PUT, DELETE, and PATCH methods with 405 Method Not Allowed to preserve append-only ledger', async () => {
    const postRes = await POST();
    const putRes = await PUT();
    const deleteRes = await DELETE();
    const patchRes = await PATCH();

    expect(postRes.status).toBe(405);
    expect(putRes.status).toBe(405);
    expect(deleteRes.status).toBe(405);
    expect(patchRes.status).toBe(405);
  });
});
