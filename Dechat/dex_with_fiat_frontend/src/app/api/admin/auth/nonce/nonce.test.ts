import { describe, it, expect, beforeEach, vi } from 'vitest';
import { POST, GET } from './route';
import { NextRequest } from 'next/server';
import { setAdminSession, deleteAdminSession } from '../../_utils/requireAdminAuth';

// Mock the dependencies
vi.mock('@/lib/stellarContract', () => ({
  getAdmin: vi.fn(() => Promise.resolve('GADMIN12345678901234567890123456789012345678901234567890123')),
}));

vi.mock('@/lib/stellarSignature', () => ({
  verifySignedTransaction: vi.fn(() => Promise.resolve(true)),
}));

describe('Admin Auth Nonce Route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('GET should return a nonce', async () => {
    const response = await GET();
    const data = await response.json();
    
    expect(response.status).toBe(200);
    expect(data).toHaveProperty('nonce');
    expect(data).toHaveProperty('expires');
    expect(typeof data.nonce).toBe('string');
    expect(typeof data.expires).toBe('number');
    expect(data.expires).toBeGreaterThan(Date.now());
  });

  it('POST should authenticate with valid signature and nonce', async () => {
    // First get a nonce
    const getResponse = await GET();
    const { nonce } = await getResponse.json();
    
    // Create a mock signed transaction
    const mockSignature = 'mock-signed-xdr';
    const mockAddress = 'GADMIN12345678901234567890123456789012345678901234567890123';
    
    const request = new NextRequest('http://localhost/api/admin/auth/nonce', {
      method: 'POST',
      body: JSON.stringify({
        nonce,
        signature: mockSignature,
        address: mockAddress,
      }),
    });
    
    const response = await POST(request);
    const data = await response.json();
    
    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
  });

  it('POST should reject missing fields', async () => {
    const request = new NextRequest('http://localhost/api/admin/auth/nonce', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    
    const response = await POST(request);
    const data = await response.json();
    
    expect(response.status).toBe(400);
    expect(data.error).toContain('Missing required fields');
  });

  it('POST should reject invalid nonce', async () => {
    const request = new NextRequest('http://localhost/api/admin/auth/nonce', {
      method: 'POST',
      body: JSON.stringify({
        nonce: 'invalid-nonce',
        signature: 'mock-signature',
        address: 'GADMIN12345678901234567890123456789012345678901234567890123',
      }),
    });
    
    const response = await POST(request);
    const data = await response.json();
    
    expect(response.status).toBe(400);
    expect(data.error).toContain('Invalid or expired nonce');
  });

  it('POST should reject non-admin address', async () => {
    const { verifySignedTransaction } = await import('@/lib/stellarSignature');
    vi.mocked(verifySignedTransaction).mockResolvedValueOnce(true);
    
    // First get a nonce
    const getResponse = await GET();
    const { nonce } = await getResponse.json();
    
    const request = new NextRequest('http://localhost/api/admin/auth/nonce', {
      method: 'POST',
      body: JSON.stringify({
        nonce,
        signature: 'mock-signed-xdr',
        address: 'GNOTADMIN1234567890123456789012345678901234567890123456',
      }),
    });
    
    const response = await POST(request);
    const data = await response.json();
    
    expect(response.status).toBe(403);
    expect(data.error).toContain('Address is not the admin');
  });

  it('POST should reject invalid signature', async () => {
    const { verifySignedTransaction } = await import('@/lib/stellarSignature');
    vi.mocked(verifySignedTransaction).mockResolvedValueOnce(false);
    
    // First get a nonce
    const getResponse = await GET();
    const { nonce } = await getResponse.json();
    
    const request = new NextRequest('http://localhost/api/admin/auth/nonce', {
      method: 'POST',
      body: JSON.stringify({
        nonce,
        signature: 'invalid-signature',
        address: 'GADMIN12345678901234567890123456789012345678901234567890123',
      }),
    });
    
    const response = await POST(request);
    const data = await response.json();
    
    expect(response.status).toBe(401);
    expect(data.error).toContain('Invalid signature');
  });
});

describe('Admin Auth Nonce Rotation and Replay Safety', () => {
  const ADMIN_ADDRESS = 'GADMIN12345678901234567890123456789012345678901234567890123';
  const OTHER_ADDRESS = 'GNOTADMIN1234567890123456789012345678901234567890123456';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  const postNonce = (body: Record<string, unknown>, origin = 'http://localhost') =>
    POST(
      new NextRequest(`${origin}/api/admin/auth/nonce`, {
        method: 'POST',
        headers: { origin },
        body: JSON.stringify(body),
      }),
    );

  it('consumes a nonce exactly once under concurrent replay', async () => {
    const getResponse = await GET();
    const { nonce } = await getResponse.json();

    const attempts = await Promise.all(
      Array.from({ length: 5 }, () =>
        postNonce({
          nonce,
          signature: 'mock-signed-xdr',
          address: ADMIN_ADDRESS,
        }),
      ),
    );

    const statuses = attempts.map((response) => response.status);
    expect(statuses.filter((status) => status === 200)).toHaveLength(1);
    expect(statuses.filter((status) => status !== 200)).toHaveLength(4);
  });

  it('rejects a nonce that has already been consumed', async () => {
    const getResponse = await GET();
    const { nonce } = await getResponse.json();

    const first = await postNonce({
      nonce,
      signature: 'mock-signed-xdr',
      address: ADMIN_ADDRESS,
    });
    expect(first.status).toBe(200);

    const replay = await postNonce({
      nonce,
      signature: 'mock-signed-xdr',
      address: ADMIN_ADDRESS,
    });
    const data = await replay.json();

    expect(replay.status).toBe(400);
    expect(data.error).toContain('Invalid or expired nonce');
  });

  it('rejects an expired nonce', async () => {
    const getResponse = await GET();
    const { nonce, expires } = await getResponse.json();

    // Simulate the nonce lifetime elapsing before consumption.
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(expires + 1);
    try {
      const response = await postNonce({
        nonce,
        signature: 'mock-signed-xdr',
        address: ADMIN_ADDRESS,
      });
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toContain('Invalid or expired nonce');
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('rejects a nonce issued for one wallet when consumed by another wallet', async () => {
    const getResponse = await GET();
    const { nonce } = await getResponse.json();

    const response = await postNonce({
      nonce,
      signature: 'mock-signed-xdr',
      address: OTHER_ADDRESS,
    });
    const data = await response.json();

    expect(response.status).toBe(403);
    expect(data.error).toContain('Address is not the admin');

    // The nonce must not be consumable by the legitimate wallet afterwards.
    const retry = await postNonce({
      nonce,
      signature: 'mock-signed-xdr',
      address: ADMIN_ADDRESS,
    });
    expect(retry.status).toBe(400);
  });

  it('rejects a nonce issued for one origin when consumed from another origin', async () => {
    const getResponse = await GET();
    const { nonce } = await getResponse.json();

    const response = await postNonce(
      {
        nonce,
        signature: 'mock-signed-xdr',
        address: ADMIN_ADDRESS,
      },
      'http://evil.example',
    );
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toContain('Invalid or expired nonce');
  });
});

describe('Admin Session Management', () => {
  it('should set and validate admin session', () => {
    const sessionToken = 'test-session-token';
    const address = 'GADMIN12345678901234567890123456789012345678901234567890123';
    const ttlMs = 30000;
    
    setAdminSession(sessionToken, address, ttlMs);
    
    // Session should be set
    const mockRequest = new Request('http://localhost', {
      headers: { cookie: `admin_session=${sessionToken}` },
    });
    
    const { requireAdminAuth } = require('../../_utils/requireAdminAuth');
    const result = requireAdminAuth(mockRequest);
    
    // Should return null (no error) for valid session
    expect(result).toBeNull();
  });

  it('should reject expired session', async () => {
    const sessionToken = 'expired-session-token';
    const address = 'GADMIN12345678901234567890123456789012345678901234567890123';
    const ttlMs = 1; // 1ms - will expire immediately
    
    setAdminSession(sessionToken, address, ttlMs);
    
    // Wait for session to expire
    await new Promise(resolve => setTimeout(resolve, 10));
    
    const mockRequest = new Request('http://localhost', {
      headers: { cookie: `admin_session=${sessionToken}` },
    });
    
    const { requireAdminAuth } = require('../../_utils/requireAdminAuth');
    const result = requireAdminAuth(mockRequest);
    
    // Should return 401 error for expired session
    expect(result).not.toBeNull();
    expect(result?.status).toBe(401);
  });

  it('should delete session', () => {
    const sessionToken = 'delete-session-token';
    const address = 'GADMIN12345678901234567890123456789012345678901234567890123';
    const ttlMs = 30000;
    
    setAdminSession(sessionToken, address, ttlMs);
    deleteAdminSession(sessionToken);
    
    const mockRequest = new Request('http://localhost', {
      headers: { cookie: `admin_session=${sessionToken}` },
    });
    
    const { requireAdminAuth } = require('../../_utils/requireAdminAuth');
    const result = requireAdminAuth(mockRequest);
    
    // Should return 401 error for deleted session
    expect(result).not.toBeNull();
    expect(result?.status).toBe(401);
  });
});
