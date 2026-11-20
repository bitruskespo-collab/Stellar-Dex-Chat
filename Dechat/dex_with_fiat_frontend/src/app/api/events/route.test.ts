import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const applyRateLimitMock = vi.fn<(...args: unknown[]) => null>(() => null);

vi.mock('@/lib/rateLimit', () => ({
  applyRateLimit: (...args: Parameters<typeof import('@/lib/rateLimit').applyRateLimit>) => applyRateLimitMock(...args),
  getClientIp: vi.fn(() => '127.0.0.1'),
}));

vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(),
  },
}));

const { GET } = await import('./route');

function makeRequest(query: string) {
  return new NextRequest(new Request(`http://localhost/api/events${query}`));
}

describe('GET /api/events', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    applyRateLimitMock.mockReturnValue(null);
  });

  it('returns 400 for a non-numeric limit', async () => {
    const req = makeRequest('?limit=not-a-number');
    const res = await GET(req);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.success).toBe(false);
  });

  it('returns 400 for a negative offset', async () => {
    const req = makeRequest('?offset=-1');
    const res = await GET(req);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.success).toBe(false);
  });

  it('returns 400 when limit exceeds the maximum', async () => {
    const req = makeRequest('?limit=1000');
    const res = await GET(req);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.success).toBe(false);
  });

  it('defaults limit and offset when omitted', async () => {
    const req = makeRequest('');
    const res = await GET(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.events).toEqual([]);
  });

  it('returns 429 when the rate limit is exceeded', async () => {
    applyRateLimitMock.mockReturnValueOnce(
      new Response(JSON.stringify({ success: false, retryAfter: 60 }), {
        status: 429,
      }) as never,
    );

    const req = makeRequest('');
    const res = await GET(req);

    expect(res.status).toBe(429);
  });

  it('returns events in canonical ledger order', async () => {
    const req = makeRequest('');
    const res = await GET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    const ledger = body.events.map((event: { ledger: number }) => event.ledger);
    const sorted = [...ledger].sort((a, b) => a - b);
    expect(ledger).toEqual(sorted);
  });

  it('paginates without skipping or duplicating events', async () => {
    const pageSize = 2;
    const seen: string[] = [];
    let offset = 0;
    let total = Infinity;

    while (offset < total) {
      const req = makeRequest(`?limit=${pageSize}&offset=${offset}`);
      const res = await GET(req);
      expect(res.status).toBe(200);
      const body = await res.json();
      total = typeof body.total === 'number' ? body.total : body.events.length;
      for (const event of body.events) {
        seen.push(event.id);
      }
      if (body.events.length === 0) break;
      offset += pageSize;
    }

    expect(new Set(seen).size).toBe(seen.length);
  });

  it('does not duplicate events across restarts', async () => {
    const firstReq = makeRequest('');
    const firstRes = await GET(firstReq);
    const firstBody = await firstRes.json();
    const firstIds = firstBody.events.map((event: { id: string }) => event.id);

    vi.resetModules();
    const { GET: GETAfterRestart } = await import('./route');
    const secondReq = makeRequest('');
    const secondRes = await GETAfterRestart(secondReq);
    const secondBody = await secondRes.json();
    const secondIds = secondBody.events.map((event: { id: string }) => event.id);

    expect(new Set(secondIds).size).toBe(secondIds.length);
    expect(secondIds).toEqual(firstIds);
  });
});
