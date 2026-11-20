import { NextRequest, NextResponse } from 'next/server';
import { setTransferStatus } from '@/lib/transferStore';
import { applyRateLimit, getClientIp } from '@/lib/rateLimit';
import {
  authorizeTransferAccess,
  uniformNotFoundResponse,
} from '@/lib/auth/authorizationMatrix';
import {
  applyCorsHeaders,
  enforceCorsPolicy,
} from '@/lib/security/corsPolicy';

const RATE_LIMIT = { maxRequests: 5, windowMs: 60_000 };

// Browser-facing route: restrict cross-origin access to trusted origins only.
const CORS_ROUTE = '/api/transfer-status';

// Temporary memory store to mark cancellation requests.
const cancelledTransfers = new Set<string>();

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ reference: string }> },
) {
  // Reject untrusted origins and preflight requests before any expensive work.
  const corsRejection = enforceCorsPolicy(request, CORS_ROUTE, {
    allowCredentials: true,
  });
  if (corsRejection) return corsRejection;

  const correlationId = extractOrGenerateCorrelationId(request.headers);
  const ip = getClientIp(request);
  const limited = applyRateLimit(ip, '/api/transfer-status', RATE_LIMIT, {
    correlationId,
  });
  if (limited) return limited;

  try {
    const caller = await resolveCallerIdentity(request);
    if (!caller) {
      return unauthorizedResponse('Authentication required to cancel transfer');
    }

    const p = await params;
    const { reference } = p;

    if (!reference) {
      return validationError({
        message: 'Reference is required',
        correlationId,
        issues: [{ path: ['reference'], message: 'Reference is required' }],
      });
    }

    const body = await request.json().catch(() => ({}));
    const clientSessionId = body.clientSessionId as string | undefined;

    // IDOR check: authorize caller before performing cancellation or returning sensitive data.
    // Denials return uniform 404 to avoid leaking record existence.
    const auth = authorizeTransferAccess(request, reference, clientSessionId);
    if (!auth.authorized || !auth.record) {
      return uniformNotFoundResponse();
    }

    const existing = auth.record;
    if (existing.status !== 'pending') {
      return NextResponse.json(
        { success: false, message: 'Only pending transfers can be cancelled' },
        { status: 409 },
      );
    }

    cancelledTransfers.add(reference);
    transitionPayoutStatus({
      reference,
      status: 'cancelled',
      updatedAt: new Date().toISOString(),
      clientSessionId: existing?.clientSessionId,
      failureReason: existing?.failureReason,
      credentialVersion: existing?.credentialVersion,
      timeoutOutcome: existing?.timeoutOutcome,
      reconciled: existing?.reconciled,
    });

    if (!sagaResult.success) {
      if (sagaResult.status === 403) {
        return authorizationError({
          status: 403,
          message: sagaResult.message,
          correlationId,
        });
      }

      return createPayoutErrorResponse({
        status: sagaResult.status,
        code: (sagaResult.code as any) || 'CANCELLATION_REJECTED',
        userMessage: sagaResult.message,
        category:
          sagaResult.status === 404
            ? 'validation'
            : sagaResult.status === 403
              ? 'authorization'
              : 'provider',
        retryable: false,
        correlationId,
      });
    }

    const response = NextResponse.json(
      {
        success: true,
        data: sagaResult.data || {
          reference,
          status: sagaResult.outcome === 'provider_confirmed' ? 'cancelled' : 'pending',
          outcome: sagaResult.outcome,
          message: sagaResult.message,
        },
      },
      { status: sagaResult.status },
    );

    response.headers.set('X-Correlation-Id', correlationId);
    applyCorsHeaders(request, response, CORS_ROUTE, {
      allowCredentials: true,
    });
    return response;
  } catch (error: unknown) {
    console.error('Cancel transfer error:', error);
    return internalError({
      error,
      correlationId,
      message: 'Failed to cancel transfer',
    });
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ reference: string }> },
) {
  // Reject untrusted origins and preflight requests before any expensive work.
  const corsRejection = enforceCorsPolicy(request, CORS_ROUTE, {
    allowCredentials: true,
  });
  if (corsRejection) return corsRejection;

  const correlationId = extractOrGenerateCorrelationId(request.headers);

  try {
    const caller = await resolveCallerIdentity(request);
    if (!caller) {
      return unauthorizedResponse(
        'Authentication required to view transfer status',
      );
    }

    const p = await params;
    const { reference } = p;

    if (!reference) {
      return NextResponse.json(
        { success: false, message: 'Reference is required' },
        { status: 400 },
      );
    }

    // IDOR check: authorize caller before returning transfer status.
    // Denials return uniform 404 to prevent probing and leaking record existence.
    const auth = authorizeTransferAccess(request, reference);
    if (!auth.authorized || !auth.record) {
      return uniformNotFoundResponse();
    }

    const transferRecord = auth.record;

    if (cancelledTransfers.has(reference)) {
      const cancelledResponse = NextResponse.json({
        success: true,
        data: {
          reference,
          status: 'cancelled',
          amount: transferRecord?.amount ?? 0,
          message: 'Transfer cancellation requested successfully',
        },
      });
      cancelledResponse.headers.set('X-Correlation-Id', correlationId);
      applyCorsHeaders(request, cancelledResponse, CORS_ROUTE, {
        allowCredentials: true,
      });
      return cancelledResponse;
    }

    const response = NextResponse.json({
      success: true,
      data: transferRecord,
    });
    response.headers.set('X-Correlation-Id', correlationId);
    applyCorsHeaders(request, response, CORS_ROUTE, {
      allowCredentials: true,
    });
    return response;
  } catch (error: unknown) {
    console.error('Get transfer status error:', error);
    return internalError({
      error,
      correlationId,
      message: 'Failed to retrieve transfer status',
    });
  }
}
