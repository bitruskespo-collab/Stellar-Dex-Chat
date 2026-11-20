import { NextResponse } from 'next/server';

export const runtime = 'edge';

// Health endpoint is a non-financial, read-only route. It must not be
// callable cross-origin by untrusted parties, and it never needs to answer
// preflight requests. Keep the response minimal and free of sensitive data.
const ALLOWED_ORIGINS: ReadonlySet<string> = new Set(
  (process.env.HEALTH_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0),
);

function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) {
    // Same-origin / non-browser requests do not send an Origin header.
    return true;
  }
  return ALLOWED_ORIGINS.has(origin);
}

function corsHeaders(origin: string | null): Record<string, string> {
  if (!origin) {
    return {};
  }
  return {
    'Access-Control-Allow-Origin': origin,
    Vary: 'Origin',
  };
}

export async function GET(request: Request) {
  const origin = request.headers.get('origin');

  if (!isAllowedOrigin(origin)) {
    return NextResponse.json(
      {
        status: 'error',
        timestamp: new Date().toISOString(),
        message: 'Origin not allowed',
      },
      { status: 403 },
    );
  }

  try {
    return NextResponse.json(
      {
        status: 'ok',
        timestamp: new Date().toISOString(),
      },
      { status: 200, headers: corsHeaders(origin) },
    );
  } catch (error) {
    return NextResponse.json(
      {
        status: 'error',
        timestamp: new Date().toISOString(),
        message: error instanceof Error ? error.message : 'Health check failed',
      },
      { status: 503, headers: corsHeaders(origin) },
    );
  }
}

// Reject preflight requests: this endpoint does not support cross-origin
// state-changing or credentialed access.
export async function OPTIONS() {
  return new NextResponse(null, {
    status: 405,
    headers: { Allow: 'GET' },
  });
}

// Reject any state-changing method explicitly.
export async function POST() {
  return new NextResponse(null, {
    status: 405,
    headers: { Allow: 'GET' },
  });
}

export async function PUT() {
  return new NextResponse(null, {
    status: 405,
    headers: { Allow: 'GET' },
  });
}

export async function PATCH() {
  return new NextResponse(null, {
    status: 405,
    headers: { Allow: 'GET' },
  });
}

export async function DELETE() {
  return new NextResponse(null, {
    status: 405,
    headers: { Allow: 'GET' },
  });
}