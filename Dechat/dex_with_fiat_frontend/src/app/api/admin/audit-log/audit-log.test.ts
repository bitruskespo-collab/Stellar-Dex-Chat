import { describe, it, expect, vi, beforeEach } from 'vitest';

const requireAdminAuthMock = vi.fn<() => Response | null>(() => null);

vi.mock('../_utils/requireAdminAuth', () => ({
  requireAdminAuth: () => requireAdminAuthMock(),
}));

import { DELETE, GET } from './route';

function unauthorizedResponse(): Response {
  return new Response(JSON.stringify({ error: 'Unauthorized' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('/api/admin/audit-log is append-only (#1484)', () => {
  beforeEach(() => {
    requireAdminAuthMock.mockReset();
    requireAdminAuthMock.mockReturnValue(null);
  });

  it('rejects DELETE with 405 and does not clear entries', async () => {
    const res = await DELETE(
      new Request('http://localhost/api/admin/audit-log', { method: 'DELETE' }),
    );
    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toBe('GET');

    const list = await GET(new Request('http://localhost/api/admin/audit-log'));
    const body = await list.json();
    expect(body.total).toBeGreaterThan(0);
  });
});

describe('/api/admin/audit-log authorization (#255)', () => {
  beforeEach(() => {
    requireAdminAuthMock.mockReset();
    requireAdminAuthMock.mockReturnValue(null);
  });

  it('GET without auth returns 401 and does not leak entries', async () => {
    requireAdminAuthMock.mockReturnValue(unauthorizedResponse());

    const res = await GET(new Request('http://localhost/api/admin/audit-log'));
    expect(res.status).toBe(401);
    expect(requireAdminAuthMock).toHaveBeenCalledTimes(1);

    const body = await res.json();
    expect(body.error).toBe('Unauthorized');
    expect(body).not.toHaveProperty('entries');
    expect(body).not.toHaveProperty('total');
  });

  it('GET with valid admin session returns entries', async () => {
    requireAdminAuthMock.mockReturnValue(null);

    const res = await GET(new Request('http://localhost/api/admin/audit-log'));
    expect(res.status).toBe(200);
    expect(requireAdminAuthMock).toHaveBeenCalledTimes(1);

    const body = await res.json();
    expect(body.total).toBeGreaterThan(0);
    expect(Array.isArray(body.entries)).toBe(true);
  });

  it('DELETE without auth returns 401 and does not clear entries', async () => {
    requireAdminAuthMock.mockReturnValue(unauthorizedResponse());

    const res = await DELETE(
      new Request('http://localhost/api/admin/audit-log', { method: 'DELETE' }),
    );
    expect(res.status).toBe(401);
    expect(requireAdminAuthMock).toHaveBeenCalledTimes(1);

    // Entries must remain intact after a denied mutation attempt.
    requireAdminAuthMock.mockReturnValue(null);
    const list = await GET(new Request('http://localhost/api/admin/audit-log'));
    const body = await list.json();
    expect(body.total).toBeGreaterThan(0);
  });

  it('DELETE with admin returns the append-only rejection', async () => {
    requireAdminAuthMock.mockReturnValue(null);

    const res = await DELETE(
      new Request('http://localhost/api/admin/audit-log', { method: 'DELETE' }),
    );
    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toBe('GET');
    expect(requireAdminAuthMock).toHaveBeenCalledTimes(1);
  });

  it('every exported handler enforces requireAdminAuth before doing work', async () => {
    requireAdminAuthMock.mockReturnValue(unauthorizedResponse());

    const getRes = await GET(new Request('http://localhost/api/admin/audit-log'));
    expect(getRes.status).toBe(401);
    expect(requireAdminAuthMock).toHaveBeenCalledTimes(1);

    requireAdminAuthMock.mockClear();
    requireAdminAuthMock.mockReturnValue(unauthorizedResponse());

    const deleteRes = await DELETE(
      new Request('http://localhost/api/admin/audit-log', { method: 'DELETE' }),
    );
    expect(deleteRes.status).toBe(401);
    expect(requireAdminAuthMock).toHaveBeenCalledTimes(1);
  });
});