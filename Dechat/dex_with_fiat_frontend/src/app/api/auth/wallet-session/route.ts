import { NextRequest, NextResponse } from 'next/server';
import { verifySignature } from '@/lib/stellarSignature';
import { createWalletSessionToken } from '@/lib/payout/auth';

const TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000; // 5 minutes

export async function POST(request: NextRequest) {
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
