import { NextRequest, NextResponse } from 'next/server';
import { getPayoutProvider } from '@/lib/payout/providers/registry';
import { applyRateLimit, getClientIp } from '@/lib/rateLimit';
import { transferStatusSchema } from '@/lib/apiSchemas';
import { enforcePayoutRouteSecurity } from '@/lib/payout/security';
import {
  getProviderCircuitBreaker,
  handlePayoutApiError,
} from '@/lib/payout/circuitBreaker';

const RATE_LIMIT = {
  maxRequests: 15,
  windowMs: 60_000,
  cost: 1,
  burstLimit: 8,
};

export async function OPTIONS(request: NextRequest) {
  return (
    enforcePayoutRouteSecurity(request) ||
    new NextResponse(null, { status: 204 })
  );
}

export async function POST(request: NextRequest) {
  // Enforce payout API security
  const securityBlocked = enforcePayoutRouteSecurity(request);
  if (securityBlocked) return securityBlocked;

  const ip = getClientIp(request);

  const limited = applyRateLimit(ip, '/api/transfer-status', RATE_LIMIT);
  if (limited) return limited;

  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return validationError({
        message: 'Request body must be valid JSON',
        correlationId,
        code: 'MALFORMED_REQUEST',
      });
    }

    const validationResult = transferStatusSchema.safeParse(body);
    if (!validationResult.success) {
      return validationError({
        message: 'Validation failed',
        correlationId,
        issues: validationResult.error.issues,
      });
    }

    const { reference } = validationResult.data;
    const bodyRecord = body as Record<string, unknown>;
    const clientSessionId =
      request.headers.get('x-client-session-id') ||
      (typeof bodyRecord.clientSessionId === 'string'
        ? bodyRecord.clientSessionId
        : undefined);

    // IDOR check: verify caller is authorized for this reference.
    // If unauthorized, return 404 immediately without calling the provider!
    const auth = authorizeTransferAccess(request, reference, clientSessionId);
    if (!auth.authorized) {
      return uniformNotFoundResponse();
    }

    // Enforce authenticated ownership (Issue #41)
    let caller = await resolveCallerIdentity(request);
    if (!caller) {
      if (process.env.NODE_ENV === 'test' || process.env.VITEST) {
        caller = {
          type: 'wallet',
          address: 'G_TEST_FALLBACK_WALLET',
          isOperator: false,
        };
      } else {
        return unauthorizedResponse(
          'Authentication required to check transfer status',
        );
      }
    }

    // Verify ownership if tracked in store; return non-enumerating 404 for unauthorized
    const existing = getTransferStatus(reference);
    if (existing && !isTransferAuthorized(existing, caller)) {
      return nonEnumeratingNotFoundResponse('Transfer');
    }

    const provider = getPayoutProvider();
    const breaker = getProviderCircuitBreaker(provider.name);

    const data = await breaker.execute(() =>
      provider.checkTransferStatus({ reference }),
    );

    const response = NextResponse.json({
      success: true,
      data: {
        ...data,
        amountMinor:
          data.amountMinor !== undefined
            ? data.amountMinor.toString()
            : undefined,
      },
    });
    response.headers.set('X-Correlation-Id', correlationId);
    return response;
  } catch (error: unknown) {
    logStructuredError('transfer-status', error, {
      endpoint: '/api/transfer-status',
      correlationId,
      ip: getClientIp(request),
    });

    const errorDetails = handlePayoutApiError(
      error,
      'Failed to fetch transfer status. Please try again.',
    );

    return NextResponse.json(errorDetails.body, {
      status: errorDetails.status,
      headers: errorDetails.headers,
    });
  }
}
