import { NextRequest, NextResponse } from 'next/server';
import { verifySignature } from '@/lib/stellarSignature';
import { createWalletSessionToken } from '@/lib/payout/auth';
import {
  validateRedirectDestination,
  type DestinationValidationResult,
} from '@/lib/security/validateDestination';

const TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Collects every caller-supplied destination parameter that must be validated
 * against the allowlist before a session is issued.
 */
function collectDestinations(
  request: NextRequest,
  body: Record<string, unknown>,
): Array<{ field: string; value: unknown }> {
  const fields = ['redirect', 'redirectUrl', 'callback', 'callbackUrl', 'returnTo'];
  const destinations: Array<{ field: string; value: unknown }> = [];

  for (const field of fields) {
    const fromQuery = request.nextUrl.searchParams.get(field);
    if (fromQuery !== null) {
      destinations.push({ field, value: fromQuery });
    }
    if (body[field] !== undefined && body[field] !== null) {
      destinations.push({ field, value: body[field] });
    }
  }

  return destinations;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const { address, signature, timestamp, message } = body;

    // Validate all redirect/callback destinations before any session work.
    const destinations = collectDestinations(request, body);
    const validatedDestinations: Record<string, string> = {};

    for (const { field, value } of destinations) {
      const result: DestinationValidationResult = validateRedirectDestination(value);
      if (!result.ok) {
        return NextResponse.json(
          {
            success: false,
            message: `Invalid ${field} destination: ${result.reason}`,
          },
          { status: 400 },
        );
      }
      validatedDestinations[field] = result.url;
    }

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
        ...(Object.keys(validatedDestinations).length > 0
          ? { destinations: validatedDestinations }
          : {}),
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
