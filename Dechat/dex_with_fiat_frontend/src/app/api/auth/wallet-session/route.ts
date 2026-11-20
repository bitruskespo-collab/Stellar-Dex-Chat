import { NextRequest, NextResponse } from 'next/server';
import { verifySignature } from '@/lib/stellarSignature';
import { createWalletSessionToken } from '@/lib/payout/auth';
import {
  applyCorsHeaders,
  isOriginAllowed,
  rejectDisallowedOrigin,
} from '@/lib/security/cors';

const TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000; // 5 minutes

export async function OPTIONS(request: NextRequest) {
  if (!isOriginAllowed(request, 'wallet-session')) {
    return rejectDisallowedOrigin();
  }

  const response = new NextResponse(null, { status: 204 });
  return applyCorsHeaders(request, response, 'wallet-session');
}

export async function POST(request: NextRequest) {
  if (!isOriginAllowed(request, 'wallet-session')) {
    return rejectDisallowedOrigin();
  }

  try {
    const body = await request.json().catch(() => ({}));
    const { address, signature, timestamp, message } = body;

    if (!address || !signature || !timestamp) {
      return NextResponse.json(
        {
          success: false,
          message:
            'Missing required authentication fields: address, signature, timestamp',
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

    const payload = message || `authenticate:${address}:${ts}`;
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

    // Bind the session to the verified address only; never echo client input.
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
      sameSite: 'strict',
      maxAge: Math.floor((session.expiresAt - Date.now()) / 1000),
      path: '/',
    });

    return applyCorsHeaders(request, response, 'wallet-session');
  } catch (error) {
    console.error('Wallet session authentication error:', error);
    return applyCorsHeaders(
      request,
      NextResponse.json(
        { success: false, message: 'Authentication failed' },
        { status: 500 },
      ),
      'wallet-session',
    );
  }
}
