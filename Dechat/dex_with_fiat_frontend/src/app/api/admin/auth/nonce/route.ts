import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getAdmin } from '@/lib/stellarContract';
import { verifySignedTransaction } from '@/lib/stellarSignature';
import { setAdminSession } from '../../_utils/requireAdminAuth';
import {
  issueNonce,
  consumeNonce,
  resolveRequestOrigin,
} from '@/lib/auth/nonceStore';

export const dynamic = 'force-dynamic';

const ADMIN_SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

export async function GET(request: NextRequest) {
  const origin = resolveRequestOrigin(request);
  if (!origin) {
    return NextResponse.json(
      { error: 'Unable to determine request origin' },
      { status: 400 },
    );
  }

  // Optional wallet binding: the nonce can only be consumed by this address.
  const wallet = request.nextUrl.searchParams.get('wallet')?.trim() || undefined;

  const { nonce, expires } = issueNonce({ origin, wallet });

  return NextResponse.json({ nonce, expires });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { nonce, signature, address } = body;

    if (!nonce || !signature || !address) {
      return NextResponse.json(
        { error: 'Missing required fields: nonce, signature, address' },
        { status: 400 },
      );
    }

    const origin = resolveRequestOrigin(request);
    if (!origin) {
      return NextResponse.json(
        { error: 'Unable to determine request origin' },
        { status: 400 },
      );
    }

    // Atomically consume the nonce before doing any expensive verification.
    // This guarantees a nonce can be used at most once, even under concurrent
    // replay attempts (compare-and-delete semantics).
    const consumed = consumeNonce(nonce, { origin, wallet: address });
    if (!consumed.ok) {
      switch (consumed.reason) {
        case 'expired':
          return NextResponse.json({ error: 'Nonce expired' }, { status: 400 });
        case 'wallet_mismatch':
          return NextResponse.json(
            { error: 'Nonce was issued for a different wallet' },
            { status: 403 },
          );
        case 'origin_mismatch':
          return NextResponse.json(
            { error: 'Nonce was issued for a different origin' },
            { status: 403 },
          );
        case 'not_found':
        default:
          return NextResponse.json(
            { error: 'Invalid or expired nonce' },
            { status: 400 },
          );
      }
    }

    // Verify the signed transaction
    const isValid = await verifySignedTransaction(signature, nonce, address);
    if (!isValid) {
      return NextResponse.json(
        { error: 'Invalid signature or nonce mismatch' },
        { status: 401 },
      );
    }

    // Verify the address matches the on-chain admin
    const adminAddress = await getAdmin();
    if (address !== adminAddress) {
      return NextResponse.json(
        { error: 'Address is not the admin' },
        { status: 403 },
      );
    }

    // Create session cookie
    const cookieStore = await cookies();
    const sessionToken = crypto.randomUUID();

    // Store session data using shared session store
    setAdminSession(sessionToken, address, ADMIN_SESSION_TTL_MS);

    // Set httpOnly cookie
    cookieStore.set('admin_session', sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: ADMIN_SESSION_TTL_MS / 1000,
      path: '/',
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Admin auth error:', error);
    return NextResponse.json(
      { error: 'Authentication failed' },
      { status: 500 },
    );
  }
}
