import { NextRequest, NextResponse } from 'next/server';
import {
  getPaymentStatusReplay,
  PAYMENT_STATUS_QUEUE_LIMIT,
  subscribeToPaymentStatus,
  type PaymentStatusEvent,
} from '@/lib/paymentStatusEvents';
import { applyRateLimit, getClientIp } from '@/lib/rateLimit';
import { paymentStatusStreamQuerySchema } from '@/lib/apiSchemas';

export const dynamic = 'force-dynamic';

const RATE_LIMIT = { maxRequests: 60, windowMs: 60_000 };
const HEARTBEAT_INTERVAL_MS = 15_000;

function formatEvent(event: PaymentStatusEvent): string {
  const id = event.id ? `id: ${event.id}\n` : '';
  return `${id}data: ${JSON.stringify(event)}\n\n`;
}

export async function GET(request: NextRequest) {
  const ip = getClientIp(request);
  const limited = applyRateLimit(ip, '/api/payment-status/stream', RATE_LIMIT);
  if (limited) return limited;

  const parsed = paymentStatusStreamQuerySchema.safeParse({
    sessionId: request.nextUrl.searchParams.get('sessionId') ?? undefined,
    lastEventId:
      request.headers.get('last-event-id') ??
      request.nextUrl.searchParams.get('lastEventId') ??
      undefined,
  });

  if (!parsed.success) {
    return NextResponse.json(
      {
        success: false,
        message: 'Validation failed',
        errors: parsed.error.issues,
      },
      { status: 400 },
    );
  }

  const { sessionId, lastEventId } = parsed.data;
  const replay = getPaymentStatusReplay(sessionId, lastEventId);
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let streamController: ReadableStreamDefaultController<Uint8Array> | null =
    null;
  let isClosed = false;
  let closingAfterDrain = false;
  let queue: string[] = [];

  const cleanup = () => {
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
    unsubscribe?.();
    unsubscribe = null;
    request.signal.removeEventListener('abort', handleAbort);
  };

  const closeAfterDrain = (
    controller: ReadableStreamDefaultController<Uint8Array>,
  ) => {
    if (!closingAfterDrain || queue.length > 0 || isClosed) return;
    isClosed = true;
    cleanup();
    if (controller.desiredSize !== null) controller.close();
  };

  const flush = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (
      isClosed ||
      controller.desiredSize === null ||
      controller.desiredSize <= 0
    ) {
      return;
    }

    const next = queue.shift();
    if (next !== undefined) {
      controller.enqueue(encoder.encode(next));
    }
    closeAfterDrain(controller);
  };

  const handleAbort = () => {
    isClosed = true;
    queue = [];
    cleanup();
    if (streamController && streamController.desiredSize !== null) {
      streamController.close();
    }
  };

  const stream = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        streamController = controller;
        if (request.signal.aborted) {
          handleAbort();
          return;
        }

        controller.enqueue(encoder.encode('retry: 3000\n\n: connected\n\n'));
        request.signal.addEventListener('abort', handleAbort, { once: true });

        unsubscribe = subscribeToPaymentStatus(sessionId, (event) => {
          if (isClosed || closingAfterDrain) return;
          if (queue.length >= PAYMENT_STATUS_QUEUE_LIMIT) {
            closingAfterDrain = true;
            cleanup();
            flush(controller);
            return;
          }
          queue.push(formatEvent(event));
          flush(controller);
        });

        if (replay.expired) {
          queue.push(
            `event: resync\nid: ${replay.latestCursor}\ndata: ${JSON.stringify({
              reason: 'replay_cursor_expired',
            })}\n\n`,
          );
        } else {
          queue.push(...replay.events.map(formatEvent));
        }
        flush(controller);

        heartbeat = setInterval(() => {
          if (
            !isClosed &&
            !closingAfterDrain &&
            queue.length === 0 &&
            controller.desiredSize !== null &&
            controller.desiredSize > 0
          ) {
            controller.enqueue(encoder.encode(': ping\n\n'));
          }
        }, HEARTBEAT_INTERVAL_MS);
      },
      pull(controller) {
        flush(controller);
      },
      cancel() {
        isClosed = true;
        queue = [];
        cleanup();
      },
    },
    { highWaterMark: 1 },
  );

  return new NextResponse(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
