'use client';

import { useEffect, useState } from 'react';
import {
  validateDeepLinkDestination,
  type DestinationValidationResult,
} from '../lib/urlDestinationValidator';

export type DeepLinkState =
  | { status: 'idle' }
  | { status: 'loading'; sessionId: string }
  | { status: 'not-found'; sessionId: string }
  | { status: 'rejected'; reason: string };

/**
 * Reads the URL hash on mount and attempts to navigate to the referenced
 * chat session.  Expected format: /chat#<session-id>
 *
 * The hash is validated against the centralized destination allowlist before
 * being followed.  Malformed, external, or otherwise disallowed destinations
 * are rejected safely and never passed to `loadChatSession`.
 *
 * @param loadChatSession - Callback that loads a session by ID and returns
 *   whether the session was found.
 */
export function useDeepLink(
  loadChatSession: (sessionId: string) => void,
  hasSessionLoaded: (sessionId: string) => boolean,
): DeepLinkState {
  const [state, setState] = useState<DeepLinkState>({ status: 'idle' });

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const rawHash = window.location.hash.slice(1).trim(); // strip leading '#'
    if (!rawHash) return;

    const validation: DestinationValidationResult = validateDeepLinkDestination(
      rawHash,
      window.location.origin,
    );

    if (!validation.ok) {
      setState({ status: 'rejected', reason: validation.reason });
      return;
    }

    const sessionId = validation.sessionId;
    if (!sessionId) return;

    setState({ status: 'loading', sessionId });

    // loadChatSession is synchronous; after calling it, check whether the
    // session is now current to determine success vs. not-found.
    loadChatSession(sessionId);

    if (hasSessionLoaded(sessionId)) {
      setState({ status: 'idle' });
    } else {
      setState({ status: 'not-found', sessionId });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // run once on mount

  return state;
}