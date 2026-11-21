import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type {
  PaymentStatusEvent,
  PaymentStatusReplay,
} from '@/lib/paymentStatusEvents';

type PaymentStatusListener = (event: PaymentStatusEvent) => void;

const applyRateLimitMock = vi.fn<
  (
    ...args: Parameters<typeof import('@/lib/rateLimit').applyRateLimit>
  ) => ReturnType<typeof import('@/lib/rateLimit').applyRateLimit>
>(() => null);
const unsubscribeMock = vi.fn();
let paymentStatusListener: PaymentStatusListener | undefined;
const subscribeToPaymentStatusMock = vi.fn(
  (_sessionId: string, listener: PaymentStatusListener) => {
    paymentStatusListener = listener;
    return unsubscribeMock;
  },
);
const getPaymentStatusReplayMock = vi.fn<
  (sessionId: string, afterCursor?: string) => PaymentStatusReplay
>(() => ({ events: [], latestCursor: '0', expired: false }));

vi.mock('@/lib/rateLimit', () => ({
  applyRateLimit: (
    ...args: Parameters<typeof import('@/lib/rateLimit').applyRateLimit>
  ) => applyRateLimitMock(...args),
  getClientIp: vi.fn(() => '127.0.0.1'),
}));

vi.mock('@/lib/paymentStatusEvents', () => ({
  getPaymentStatusReplay: (
    ...args: Parameters<
      typeof import('@/lib/paymentStatusEvents').getPaymentStatusReplay
    >
  ) => getPaymentStatusReplayMock(...args),
  PAYMENT_STATUS_QUEUE_LIMIT: 2,
  subscribeToPaymentStatus: (
    ...args: Parameters<
      typeof import('@/lib/paymentStatusEvents').subscribeToPaymentStatus
    >
  ) => subscribeToPaymentStatusMock(...args),
}));

const { GET } = await import('./route');

function makeRequest(
  query: string,
  options: { headers?: HeadersInit; signal?: AbortSignal } = {},
) {
  return new NextRequest(
    new Request(`http://localhost/api/payment-status/stream${query}`, options),
  );
}

function paymentEvent(id: string): PaymentStatusEvent {
  return {
    id,
    reference: `ref-${id}`,
    status: 'success',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

async function readText(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const { value } = await reader.read();
  return new TextDecoder().decode(value);
}

describe('GET /api/payment-status/stream', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    paymentStatusListener = undefined;
    applyRateLimitMock.mockReturnValue(null);
    subscribeToPaymentStatusMock.mockImplementation((_sessionId, listener) => {
      paymentStatusListener = listener;
      return unsubscribeMock;
    });
    getPaymentStatusReplayMock.mockReturnValue({
      events: [],
      latestCursor: '0',
      expired: false,
    });
  });

  it('returns a validation error when the session id is missing', async () => {
    const response = await GET(makeRequest(''));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.errors[0].path).toEqual(['sessionId']);
    expect(subscribeToPaymentStatusMock).not.toHaveBeenCalled();
  });

  it('rejects malformed event cursors before subscribing', async () => {
    const response = await GET(
      makeRequest('?sessionId=session-abc&lastEventId=not-a-cursor'),
    );

    expect(response.status).toBe(400);
    expect(subscribeToPaymentStatusMock).not.toHaveBeenCalled();
  });

  it('opens the stream and emits event IDs as SSE cursors', async () => {
    const response = await GET(makeRequest('?sessionId=session-abc'));
    const reader = response.body!.getReader();

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/event-stream');
    expect(await readText(reader)).toContain('retry: 3000');

    paymentStatusListener?.(paymentEvent('1'));
    const eventFrame = await readText(reader);

    expect(eventFrame).toContain('id: 1\n');
    expect(eventFrame).toContain('"reference":"ref-1"');
    await reader.cancel();
    expect(unsubscribeMock).toHaveBeenCalledOnce();
  });

  it('replays events after the Last-Event-ID header', async () => {
    getPaymentStatusReplayMock.mockReturnValue({
      events: [paymentEvent('4')],
      latestCursor: '4',
      expired: false,
    });
    const response = await GET(
      makeRequest('?sessionId=session-abc', {
        headers: { 'Last-Event-ID': '3' },
      }),
    );
    const reader = response.body!.getReader();

    expect(getPaymentStatusReplayMock).toHaveBeenCalledWith('session-abc', '3');
    await readText(reader);
    expect(await readText(reader)).toContain('id: 4\n');
    await reader.cancel();
  });

  it('emits a resync event when the replay cursor has expired', async () => {
    getPaymentStatusReplayMock.mockReturnValue({
      events: [],
      latestCursor: '12',
      expired: true,
    });
    const response = await GET(
      makeRequest('?sessionId=session-abc&lastEventId=1'),
    );
    const reader = response.body!.getReader();

    await readText(reader);
    const resyncFrame = await readText(reader);
    expect(resyncFrame).toContain('event: resync');
    expect(resyncFrame).toContain('id: 12\n');
    await reader.cancel();
  });

  it('closes and unsubscribes after the bounded queue overflows', async () => {
    const response = await GET(makeRequest('?sessionId=session-abc'));
    paymentStatusListener?.(paymentEvent('1'));
    paymentStatusListener?.(paymentEvent('2'));
    paymentStatusListener?.(paymentEvent('3'));

    expect(unsubscribeMock).toHaveBeenCalledOnce();
    const reader = response.body!.getReader();
    await readText(reader);
    expect((await reader.read()).done).toBe(false);
    expect((await reader.read()).done).toBe(false);
    expect((await reader.read()).done).toBe(true);
  });

  it('sends heartbeat comments while the connection is idle', async () => {
    vi.useFakeTimers();
    const response = await GET(makeRequest('?sessionId=session-abc'));
    const reader = response.body!.getReader();
    await readText(reader);

    await vi.advanceTimersByTimeAsync(15_000);

    expect(await readText(reader)).toContain(': ping');
    await reader.cancel();
    vi.useRealTimers();
  });

  it('returns 429 before validating the request when rate limited', async () => {
    applyRateLimitMock.mockReturnValueOnce(
      new Response(JSON.stringify({ success: false }), { status: 429 }),
    );
    const response = await GET(makeRequest(''));

    expect(response.status).toBe(429);
    expect(subscribeToPaymentStatusMock).not.toHaveBeenCalled();
  });

  it('cleans up the subscription when the request is aborted', async () => {
    const abortController = new AbortController();
    await GET(
      makeRequest('?sessionId=session-abc', {
        signal: abortController.signal,
      }),
    );

    abortController.abort();

    expect(unsubscribeMock).toHaveBeenCalledOnce();
  });
});
