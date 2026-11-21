import type { TransferStatusRecord } from '@/lib/transferStore';

export interface PaymentStatusEvent {
  id?: string;
  reference: string;
  status: TransferStatusRecord['status'];
  updatedAt: string;
  amount?: number;
  failureReason?: string;
}

type PaymentStatusListener = (event: PaymentStatusEvent) => void;

const listenersBySession = new Map<string, Set<PaymentStatusListener>>();
const replayBySession = new Map<string, PaymentStatusEvent[]>();
const cursorBySession = new Map<string, bigint>();

export const PAYMENT_STATUS_REPLAY_LIMIT = 100;
export const PAYMENT_STATUS_QUEUE_LIMIT = 100;

export interface PaymentStatusReplay {
  events: PaymentStatusEvent[];
  latestCursor: string;
  expired: boolean;
}

function nextCursor(clientSessionId: string): string {
  const current = cursorBySession.get(clientSessionId) ?? 0n;
  const cursor = current + 1n;
  cursorBySession.set(clientSessionId, cursor);
  return cursor.toString();
}

export function subscribeToPaymentStatus(
  clientSessionId: string,
  listener: PaymentStatusListener,
) {
  const listeners = listenersBySession.get(clientSessionId) ?? new Set();
  listeners.add(listener);
  listenersBySession.set(clientSessionId, listeners);

  return () => {
    const current = listenersBySession.get(clientSessionId);
    if (!current) {
      return;
    }

    current.delete(listener);
    if (current.size === 0) {
      listenersBySession.delete(clientSessionId);
    }
  };
}

export function publishPaymentStatus(
  clientSessionId: string | undefined,
  event: PaymentStatusEvent,
) {
  if (!clientSessionId) {
    return;
  }

  const stampedEvent = {
    ...event,
    id: nextCursor(clientSessionId),
  };
  const replay = replayBySession.get(clientSessionId) ?? [];
  replay.push(stampedEvent);
  if (replay.length > PAYMENT_STATUS_REPLAY_LIMIT) {
    replay.splice(0, replay.length - PAYMENT_STATUS_REPLAY_LIMIT);
  }
  replayBySession.set(clientSessionId, replay);

  const listeners = listenersBySession.get(clientSessionId);
  if (!listeners) {
    return;
  }

  listeners.forEach((listener) => {
    try {
      listener(stampedEvent);
    } catch (error) {
      console.error(
        'Failed to deliver payment status event to a listener:',
        error,
      );
    }
  });
}

export function getPaymentStatusReplay(
  clientSessionId: string,
  afterCursor?: string,
): PaymentStatusReplay {
  const replay = replayBySession.get(clientSessionId) ?? [];
  const latestCursor = getPaymentStatusCursor(clientSessionId);
  if (!afterCursor) {
    return { events: [], latestCursor, expired: false };
  }

  const after = BigInt(afterCursor);
  const firstCursor = replay[0]?.id ? BigInt(replay[0].id) : undefined;
  const latest = BigInt(latestCursor);
  const expired =
    after > latest || (firstCursor !== undefined && after < firstCursor - 1n);

  return {
    events: expired
      ? []
      : replay.filter((event) => event.id && BigInt(event.id) > after),
    latestCursor,
    expired,
  };
}

export function getPaymentStatusCursor(clientSessionId: string): string {
  return (cursorBySession.get(clientSessionId) ?? 0n).toString();
}

export function resetPaymentStatusEventsForTest(): void {
  listenersBySession.clear();
  replayBySession.clear();
  cursorBySession.clear();
}
