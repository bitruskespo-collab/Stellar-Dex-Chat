import { notFound } from 'next/navigation';

/**
 * Route group guard for E2E test harness pages.
 *
 * These pages are only available when NEXT_PUBLIC_E2E='true' is set.
 * In production builds, this returns a 404, preventing the test routes
 * from being included in the build output.
 */
export default function E2ERouteGuard() {
  if (process.env.NEXT_PUBLIC_E2E !== 'true') {
    notFound();
  }
  return null;
}

/**
 * Safe fallback for unavailable or private records reached via a shareable
 * read-only deep link (e.g. /receipt/[id] or /tx/[id]).
 *
 * Renders a neutral message without echoing the requested identifier or any
 * record data, so malformed, missing, or unauthorized links never leak PII or
 * wallet secrets. The identifier is intentionally not read from params here.
 */
export function SharedRecordUnavailable() {
  return (
    <main role="alert" aria-live="polite">
      <h1>Record unavailable</h1>
      <p>
        This shared link is invalid, expired, or private. Ask the sender for a
        new link.
      </p>
    </main>
  );
}
