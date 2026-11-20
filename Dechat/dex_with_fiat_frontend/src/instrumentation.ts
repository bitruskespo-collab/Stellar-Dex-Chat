import * as Sentry from '@sentry/nextjs';
import { redactSensitiveData } from './lib/logging/redact';

export async function register() {
  // Sentry config files were removed in merge
  // if (process.env.NEXT_RUNTIME === 'nodejs') {
  //   await import('../sentry.server.config');
  // }

  // if (process.env.NEXT_RUNTIME === 'edge') {
  //   await import('../sentry.edge.config');
  // }
}

/**
 * Redact sensitive fields from an error and its attached context before
 * forwarding to Sentry. Errors are not plain objects, so we scrub the
 * enumerable own properties (including `cause`, `context`, `extra`, etc.)
 * in place and return the same error instance.
 */
function scrubError(error: unknown): unknown {
  if (!error || typeof error !== 'object') {
    return error;
  }

  const err = error as Record<string, unknown>;

  // Scrub enumerable own properties (message, stack, cause, context, ...).
  for (const key of Object.keys(err)) {
    try {
      err[key] = redactSensitiveData(err[key]);
    } catch {
      // Never let redaction failures break error reporting; drop the value.
      try {
        err[key] = '[REDACTED]';
      } catch {
        // Property may be non-writable; ignore.
      }
    }
  }

  return err;
}

export const onRequestError: typeof Sentry.captureRequestError = (
  ...args: Parameters<typeof Sentry.captureRequestError>
) => {
  const [error, request, context] = args;

  const scrubbedError = scrubError(error);
  const scrubbedRequest = redactSensitiveData(request);
  const scrubbedContext = redactSensitiveData(context);

  return Sentry.captureRequestError(
    scrubbedError as Parameters<typeof Sentry.captureRequestError>[0],
    scrubbedRequest as Parameters<typeof Sentry.captureRequestError>[1],
    scrubbedContext as Parameters<typeof Sentry.captureRequestError>[2],
  );
};