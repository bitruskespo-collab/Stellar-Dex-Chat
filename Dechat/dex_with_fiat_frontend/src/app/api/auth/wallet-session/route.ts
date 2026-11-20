import { NextRequest, NextResponse } from 'next/server';
import { verifySignature } from '@/lib/stellarSignature';
import { createWalletSessionToken } from '@/lib/payout/auth';
import { consumeWalletNonce } from '@/lib/payout/walletNonce';

const TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000; // 5 minutes

function getRequestOrigin(request: NextRequest): string {
  const origin = request.headers.get('origin');
  if (origin) {
    return origin;
  }
  const host = request.headers.get('host');
  if (!host) {
    return '';
  }
  const proto =
    request.headers.get('x-forwarded-proto') ??
    request.nextUrl.protocol.replace(':', '');
  return `${proto}://${host}`;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const { address, signature, timestamp, nonce } = body;

    if (!address || !signature || !timestamp || !nonce) {
      return NextResponse.json(
        {
          success: false,
          message:
            'Missing required authentication fields: address, signature, timestamp, nonce',
        },
        { status: 400 },
      );
    }

    const ts = Number(timestamp);
    if (
      !Number.isFinite(ts) ||
      Math.abs(Date.now() - ts) > TIMESTAMP_TOLERANCE_MS
    ) {
      return NextResponse.json(
        {
          success: false,
          message: 'Signature expired or invalid timestamp',
        },
        { status: 401 },
      );
    }

    // Atomically consume the server-issued nonce. This is a one-time use
    // operation: concurrent replays, expired nonces, wallet mismatches and
    // origin mismatches are all rejected here before signature verification.
    const nonceResult = consumeWalletNonce({
      nonce: String(nonce),
      address: String(address),
      origin: getRequestOrigin(request),
    });

    if (!nonceResult.ok) {
      return NextResponse.json(
        {
          success: false,
          message: 'Invalid, expired, or already used authentication nonce',
        },
        { status: 401 },
      );
    }

    const payload = nonceResult.message;
    const isValid = await verifySignature(payload, signature, address);

    if (!isValid) {
      return NextResponse.json(
        {
          success: false,
          message: 'Invalid signature for wallet address',
        },
        { status: 401 },
      );
    }

    const session = createWalletSessionToken(address);

    const response = NextResponse.json({
      success: true,
      data: {
        sessionToken: session.sessionToken,
        expiresAt: session.expiresAt,
        address: session.address,
      },
    });

    response.cookies.set('wallet_session', session.sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: Math.floor((session.expiresAt - Date.now()) / 1000),
      path: '/',
    });

    return response;
  } catch (error) {
    console.error('Wallet session authentication error:', error);
    return NextResponse.json(
      { success: false, message: 'Authentication failed' },
      { status: 500 },
    );
  }
}
