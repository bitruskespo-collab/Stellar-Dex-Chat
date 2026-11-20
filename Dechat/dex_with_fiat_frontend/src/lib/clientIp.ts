import net from 'node:net';

export interface RequestWithClientIp {
  headers: Headers;
  ip?: string | null;
}

export function normalizeCandidateIp(raw: string): string {
  let candidate = raw.trim();

  if (candidate.toLowerCase().startsWith('for=')) {
    candidate = candidate.slice(4).trim();
  }
  if (candidate.includes(';')) candidate = candidate.split(';')[0].trim();
  if (candidate.startsWith('"')) candidate = candidate.slice(1);
  if (candidate.endsWith('"')) candidate = candidate.slice(0, -1);
  if (candidate.startsWith('[') && candidate.includes(']')) {
    candidate = candidate.slice(1, candidate.indexOf(']'));
  }

  const ipv4WithPortMatch = candidate.match(/^([\d.]+):\d+$/);
  if (ipv4WithPortMatch) candidate = ipv4WithPortMatch[1];
  if (candidate.startsWith('::ffff:')) {
    candidate = candidate.slice('::ffff:'.length);
  }

  return candidate;
}

export function isValidIp(value: string): boolean {
  return net.isIP(value) !== 0;
}

function parseTrustedProxyHops(): number {
  const configured = Number(process.env.TRUSTED_PROXY_HOPS ?? '0');
  return Number.isSafeInteger(configured) && configured > 0 ? configured : 0;
}

/**
 * Headers that may carry the client IP. Only headers listed here (comma
 * separated, lower-cased) are consulted, and only when at least one trusted
 * proxy hop is configured. Anything else is treated as attacker-controlled.
 */
function parseTrustedProxyHeaders(): string[] {
  const configured = process.env.TRUSTED_PROXY_HEADERS ?? '';
  return configured
    .split(',')
    .map((header) => header.trim().toLowerCase())
    .filter((header) => header.length > 0);
}

function validAddress(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const normalized = normalizeCandidateIp(raw);
  return isValidIp(normalized) ? normalized : null;
}

export function getClientIp(request: RequestWithClientIp): string {
  const requestIp = validAddress(request.ip);
  if (requestIp) return requestIp;

  const trustedHops = parseTrustedProxyHops();
  if (trustedHops === 0) return 'unknown';

  const trustedHeaders = parseTrustedProxyHeaders();
  if (trustedHeaders.length === 0) return 'unknown';

  for (const headerName of trustedHeaders) {
    if (headerName === 'x-forwarded-for') continue;
    const address = validAddress(request.headers.get(headerName));
    if (address) return address;
  }

  if (trustedHeaders.includes('x-forwarded-for')) {
    const forwardedFor = request.headers.get('x-forwarded-for');
    if (forwardedFor) {
      const chain = forwardedFor.split(',').map((hop) => validAddress(hop));
      if (chain.every((hop): hop is string => hop !== null)) {
        const clientIndex = chain.length - trustedHops - 1;
        if (clientIndex >= 0) return chain[clientIndex];
      }
    }
  }

  return 'unknown';
}
