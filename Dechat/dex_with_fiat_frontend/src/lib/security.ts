import { NextResponse } from 'next/server';
import net from 'node:net';
import { serverEnv as env } from '@/lib/serverEnv';
import {
  getClientIp,
  isValidIp,
  normalizeCandidateIp,
  type RequestWithClientIp,
} from './clientIp';

export type RequestWithIp = RequestWithClientIp;

interface AdminIpAllowlistConfig {
  allowlist: string[];
  invalidEntries: string[];
  bypassLocal: boolean;
  nodeEnv: string;
  enabled: boolean;
}

export interface AdminIpAllowlistValidation {
  reason:
    | 'allowlist_disabled'
    | 'allowlist_bypass_local'
    | 'allowlist_allowed'
    | 'allowlist_denied'
    | 'allowlist_ip_unresolved'
    | 'allowlist_misconfigured';
  requestIp: string | null;
  allowlistEnabled: boolean;
  bypassLocal: boolean;
  allowlistCount: number;
  invalidEntries: string[];
}

export interface AdminIpAllowlistEvaluation {
  allowed: boolean;
  status: number | null;
  code: string | null;
  message: string | null;
  validation: AdminIpAllowlistValidation;
}

interface ConfigInput {
  allowlistRaw?: string;
  bypassLocal?: boolean;
  nodeEnv?: string;
}

const LOOPBACK_IPV6 = '::1';

function isLoopbackIp(ip: string): boolean {
  if (ip === LOOPBACK_IPV6) return true;
  return ip.startsWith('127.');
}

function readAdminIpAllowlistConfig(
  input?: ConfigInput,
): AdminIpAllowlistConfig {
  const parsed = parseIpAllowlist(
    input?.allowlistRaw ?? env.ADMIN_IP_ALLOWLIST,
  );
  return {
    allowlist: parsed.allowlist,
    invalidEntries: parsed.invalidEntries,
    bypassLocal: input?.bypassLocal ?? env.ADMIN_IP_ALLOWLIST_BYPASS_LOCAL,
    nodeEnv: input?.nodeEnv ?? process.env.NODE_ENV ?? 'development',
    enabled: parsed.allowlist.length > 0,
  };
}

export function parseIpAllowlist(rawAllowlist?: string): {
  allowlist: string[];
  invalidEntries: string[];
} {
  if (!rawAllowlist || !rawAllowlist.trim()) {
    return { allowlist: [], invalidEntries: [] };
  }

  const allowlist = new Set<string>();
  const invalidEntries: string[] = [];

  for (const entry of rawAllowlist.split(',')) {
    const normalized = normalizeCandidateIp(entry);

    if (!normalized) continue;

    if (!isValidIp(normalized)) {
      invalidEntries.push(entry.trim());
      continue;
    }

    allowlist.add(normalized);
  }

  return {
    allowlist: [...allowlist],
    invalidEntries,
  };
}

export function resolveClientIp(request: RequestWithIp): string | null {
  const clientIp = getClientIp(request);
  return clientIp === 'unknown' ? null : clientIp;
}

export function evaluateAdminIpAllowlist(
  request: RequestWithIp,
  input?: ConfigInput,
): AdminIpAllowlistEvaluation {
  const config = readAdminIpAllowlistConfig(input);
  const requestIp = resolveClientIp(request);

  if (config.invalidEntries.length > 0) {
    return {
      allowed: false,
      status: 500,
      code: 'ADMIN_IP_ALLOWLIST_INVALID',
      message: 'Admin IP allowlist is misconfigured.',
      validation: {
        reason: 'allowlist_misconfigured',
        requestIp,
        allowlistEnabled: config.enabled,
        bypassLocal: config.bypassLocal,
        allowlistCount: config.allowlist.length,
        invalidEntries: config.invalidEntries,
      },
    };
  }

  if (!config.enabled) {
    return {
      allowed: true,
      status: null,
      code: null,
      message: null,
      validation: {
        reason: 'allowlist_disabled',
        requestIp,
        allowlistEnabled: false,
        bypassLocal: config.bypassLocal,
        allowlistCount: 0,
        invalidEntries: [],
      },
    };
  }

  const bypassInEffect =
    config.bypassLocal &&
    config.nodeEnv !== 'production' &&
    requestIp !== null &&
    isLoopbackIp(requestIp);

  if (bypassInEffect) {
    return {
      allowed: true,
      status: null,
      code: null,
      message: null,
      validation: {
        reason: 'allowlist_bypass_local',
        requestIp,
        allowlistEnabled: true,
        bypassLocal: true,
        allowlistCount: config.allowlist.length,
        invalidEntries: [],
      },
    };
  }

  if (!requestIp) {
    return {
      allowed: false,
      status: 403,
      code: 'ADMIN_IP_UNRESOLVED',
      message:
        'Forbidden: unable to resolve client IP for admin allowlist validation.',
      validation: {
        reason: 'allowlist_ip_unresolved',
        requestIp: null,
        allowlistEnabled: true,
        bypassLocal: config.bypassLocal,
        allowlistCount: config.allowlist.length,
        invalidEntries: [],
      },
    };
  }

  if (!config.allowlist.includes(requestIp)) {
    return {
      allowed: false,
      status: 403,
      code: 'ADMIN_IP_NOT_ALLOWLISTED',
      message: 'Forbidden: request IP is not authorized for this admin route.',
      validation: {
        reason: 'allowlist_denied',
        requestIp,
        allowlistEnabled: true,
        bypassLocal: config.bypassLocal,
        allowlistCount: config.allowlist.length,
        invalidEntries: [],
      },
    };
  }

  return {
    allowed: true,
    status: null,
    code: null,
    message: null,
    validation: {
      reason: 'allowlist_allowed',
      requestIp,
      allowlistEnabled: true,
      bypassLocal: config.bypassLocal,
      allowlistCount: config.allowlist.length,
      invalidEntries: [],
    },
  };
}

export function enforceAdminIpAllowlist(
  request: RequestWithIp,
  input?: ConfigInput,
): NextResponse | null {
  const evaluation = evaluateAdminIpAllowlist(request, input);
  if (evaluation.allowed) return null;

  return NextResponse.json(
    {
      error: evaluation.message,
      code: evaluation.code,
      validation: evaluation.validation,
    },
    { status: evaluation.status ?? 403 },
  );
}

// ---------------------------------------------------------------------------
// URL destination validation
// ---------------------------------------------------------------------------

export type UrlDestinationKind =
  | 'redirect'
  | 'callback'
  | 'deep_link'
  | 'payment_return';

export type UrlDestinationReason =
  | 'url_allowed'
  | 'url_missing'
  | 'url_malformed'
  | 'url_scheme_not_allowed'
  | 'url_host_not_allowed'
  | 'url_encoded_bypass'
  | 'url_scheme_host_confusion'
  | 'url_credentials_present'
  | 'url_control_chars';

export interface UrlDestinationPolicy {
  /** Schemes permitted for this destination kind (lowercase, no colon). */
  allowedSchemes: string[];
  /** Hosts permitted for network schemes (lowercase). Empty => any host. */
  allowedHosts?: string[];
  /** When true, relative (path-only) destinations are permitted. */
  allowRelative?: boolean;
  /** When true, custom schemes (e.g. app deep links) are permitted. */
  allowCustomScheme?: boolean;
}

export interface UrlDestinationValidation {
  allowed: boolean;
  reason: UrlDestinationReason;
  /** Normalized absolute URL, or normalized relative path when allowed. */
  normalized: string | null;
  scheme: string | null;
  host: string | null;
  kind: UrlDestinationKind;
}

const NETWORK_SCHEMES = new Set(['http', 'https']);
const DEFAULT_REDIRECT_SCHEMES = ['https'];
const DEFAULT_CALLBACK_SCHEMES = ['https'];
const DEFAULT_PAYMENT_RETURN_SCHEMES = ['https'];
const DEFAULT_DEEP_LINK_SCHEMES = ['https'];

// Characters that must never appear in a destination (CR/LF/tab/NUL etc.).
const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/;

// Percent-encoded control characters and separators used for bypass attempts.
const ENCODED_BYPASS_PATTERN = /%(?:0[0-9a-f]|1[0-9a-f]|7f|2f|5c|3a|40)/i;

function defaultPolicyFor(kind: UrlDestinationKind): UrlDestinationPolicy {
  switch (kind) {
    case 'redirect':
      return { allowedSchemes: DEFAULT_REDIRECT_SCHEMES, allowRelative: true };
    case 'callback':
      return { allowedSchemes: DEFAULT_CALLBACK_SCHEMES };
    case 'payment_return':
      return { allowedSchemes: DEFAULT_PAYMENT_RETURN_SCHEMES };
    case 'deep_link':
      return {
        allowedSchemes: DEFAULT_DEEP_LINK_SCHEMES,
        allowCustomScheme: true,
      };
    default:
      return { allowedSchemes: DEFAULT_REDIRECT_SCHEMES };
  }
}

function buildValidation(
  kind: UrlDestinationKind,
  reason: UrlDestinationReason,
  extra: Partial<UrlDestinationValidation> = {},
): UrlDestinationValidation {
  return {
    allowed: reason === 'url_allowed',
    reason,
    normalized: null,
    scheme: null,
    host: null,
    kind,
    ...extra,
  };
}

/**
 * Decode a candidate destination repeatedly to surface encoded bypasses.
 * Returns null when decoding fails or the input contains control characters.
 */
function decodeCandidate(raw: string): string | null {
  if (CONTROL_CHAR_PATTERN.test(raw)) return null;

  let current = raw;
  for (let i = 0; i < 3; i += 1) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      return null;
    }
    if (decoded === current) break;
    if (CONTROL_CHAR_PATTERN.test(decoded)) return null;
    current = decoded;
  }
  return current;
}

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, '');
}

function hostMatchesAllowlist(host: string, allowlist: string[]): boolean {
  const normalizedHost = normalizeHost(host);
  return allowlist.some((entry) => {
    const normalizedEntry = normalizeHost(entry);
    if (!normalizedEntry) return false;
    if (normalizedEntry.startsWith('*.')) {
      const suffix = normalizedEntry.slice(1); // ".example.com"
      return (
        normalizedHost.endsWith(suffix) &&
        normalizedHost.length > suffix.length
      );
    }
    return normalizedHost === normalizedEntry;
  });
}

/**
 * Centralized validator for redirect, callback, deep-link, and payment-return
 * destinations. Rejects scheme/host confusion, encoded bypasses, embedded
 * credentials, and destinations outside the configured allowlists.
 */
export function validateUrlDestination(
  raw: string | null | undefined,
  kind: UrlDestinationKind,
  policy?: Partial<UrlDestinationPolicy>,
): UrlDestinationValidation {
  const effectivePolicy: UrlDestinationPolicy = {
    ...defaultPolicyFor(kind),
    ...policy,
  };

  if (raw === null || raw === undefined || raw.trim() === '') {
    return buildValidation(kind, 'url_missing');
  }

  const trimmed = raw.trim();

  if (CONTROL_CHAR_PATTERN.test(trimmed)) {
    return buildValidation(kind, 'url_control_chars');
  }

  // Detect encoded bypass attempts (encoded slashes, colons, @, controls).
  if (ENCODED_BYPASS_PATTERN.test(trimmed)) {
    return buildValidation(kind, 'url_encoded_bypass');
  }

  const decoded = decodeCandidate(trimmed);
  if (decoded === null) {
    return buildValidation(kind, 'url_malformed');
  }

  // Reject scheme/host confusion: backslashes, protocol-relative, whitespace
  // inside the authority, and multiple scheme separators.
  if (decoded.includes('\\')) {
    return buildValidation(kind, 'url_scheme_host_confusion');
  }
  if (decoded.startsWith('//')) {
    return buildValidation(kind, 'url_scheme_host_confusion');
  }
  if (/\s/.test(decoded)) {
    return buildValidation(kind, 'url_scheme_host_confusion');
  }

  const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(decoded);
  const hasScheme = schemeMatch !== null;

  // Relative destinations (path-only) are only allowed when explicitly opted in.
  if (!hasScheme) {
    if (effectivePolicy.allowRelative) {
      if (!decoded.startsWith('/')) {
        return buildValidation(kind, 'url_malformed');
      }
      return buildValidation(kind, 'url_allowed', {
        normalized: decoded,
      });
    }
    return buildValidation(kind, 'url_scheme_not_allowed');
  }

  const scheme = schemeMatch![1].toLowerCase();
  const allowedSchemes = effectivePolicy.allowedSchemes.map((s) =>
    s.toLowerCase(),
  );

  const isNetworkScheme = NETWORK_SCHEMES.has(scheme);
  const isCustomScheme = !isNetworkScheme;

  if (isCustomScheme && !effectivePolicy.allowCustomScheme) {
    return buildValidation(kind, 'url_scheme_not_allowed', { scheme });
  }

  if (!allowedSchemes.includes(scheme)) {
    return buildValidation(kind, 'url_scheme_not_allowed', { scheme });
  }

  let parsed: URL;
  try {
    parsed = new URL(decoded);
  } catch {
    return buildValidation(kind, 'url_malformed', { scheme });
  }

  if (parsed.protocol.toLowerCase() !== `${scheme}:`) {
    return buildValidation(kind, 'url_scheme_host_confusion', { scheme });
  }

  if (parsed.username || parsed.password) {
    return buildValidation(kind, 'url_credentials_present', {
      scheme,
      host: parsed.hostname || null,
    });
  }

  const host = parsed.hostname ? normalizeHost(parsed.hostname) : null;

  if (isNetworkScheme) {
    if (!host) {
      return buildValidation(kind, 'url_malformed', { scheme });
    }
    const allowedHosts = effectivePolicy.allowedHosts ?? [];
    if (allowedHosts.length > 0 && !hostMatchesAllowlist(host, allowedHosts)) {
      return buildValidation(kind, 'url_host_not_allowed', { scheme, host });
    }
  }

  return buildValidation(kind, 'url_allowed', {
    normalized: parsed.toString(),
    scheme,
    host,
  });
}

/** Convenience helper for auth redirect destinations. */
export function validateRedirectDestination(
  raw: string | null | undefined,
  allowedHosts?: string[],
): UrlDestinationValidation {
  return validateUrlDestination(raw, 'redirect', { allowedHosts });
}

/** Convenience helper for OAuth / payment callback destinations. */
export function validateCallbackDestination(
  raw: string | null | undefined,
  allowedHosts?: string[],
): UrlDestinationValidation {
  return validateUrlDestination(raw, 'callback', { allowedHosts });
}

/** Convenience helper for payment return destinations. */
export function validatePaymentReturnDestination(
  raw: string | null | undefined,
  allowedHosts?: string[],
): UrlDestinationValidation {
  return validateUrlDestination(raw, 'payment_return', { allowedHosts });
}

/** Convenience helper for app deep-link destinations. */
export function validateDeepLinkDestination(
  raw: string | null | undefined,
  allowedSchemes?: string[],
  allowedHosts?: string[],
): UrlDestinationValidation {
  return validateUrlDestination(raw, 'deep_link', {
    allowedSchemes,
    allowedHosts,
  });
}

/**
 * Returns the normalized destination when allowed, otherwise the provided
 * fallback. Intended for safe use in redirect flows.
 */
export function safeDestinationOr(
  raw: string | null | undefined,
  kind: UrlDestinationKind,
  fallback: string,
  policy?: Partial<UrlDestinationPolicy>,
): string {
  const result = validateUrlDestination(raw, kind, policy);
  return result.allowed && result.normalized ? result.normalized : fallback;
}