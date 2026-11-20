/**
 * Credential guard to prevent live-money operations in non-production environments.
 * Addresses Issue #106:
 * - Refuses live-mode credentials in sandbox and test suites.
 * - Protects against accidental live transfers.
 *
 * Addresses Issue #262 (least-privilege runtime permissions):
 * - Defines a runtime permission inventory for application services, split into
 *   read-only and mutation roles where practical.
 * - Rejects wildcard or overly broad permissions in production.
 * - Exports helpers used by deployment checks.
 *
 * Runtime permission inventory (least-privilege):
 * -----------------------------------------------------------------------------
 * Service              Role                Access        Notes
 * -----------------------------------------------------------------------------
 * payout-reader        read-only           SELECT        Reads payout intents,
 *                                                         ledger entries, and
 *                                                         reconciliation state.
 * payout-writer        mutation            SELECT,INSERT,UPDATE
 *                                                         Creates/updates payout
 *                                                         intents; no DELETE.
 * ledger-reader        read-only           SELECT        Reads ledger balances
 *                                                         and journal entries.
 * ledger-writer        mutation            SELECT,INSERT
 *                                                         Appends journal
 *                                                         entries; append-only,
 *                                                         no UPDATE/DELETE.
 * reconciliation-job   read-only           SELECT        Reads state to compute
 *                                                         reconciliation reports.
 * -----------------------------------------------------------------------------
 * Wildcards ("*", "all", "admin", "superuser", "owner") and destructive
 * privileges (DELETE, DROP, TRUNCATE, GRANT, ALTER) are never permitted for
 * runtime application services in production.
 */

export class LiveCredentialsRefusedError extends Error {
  public readonly code = 'LIVE_CREDENTIALS_REFUSED';

  constructor(
    message = 'Live credentials (sk_live_*) are strictly forbidden in sandbox/test environments!',
  ) {
    super(message);
    this.name = 'LiveCredentialsRefusedError';
  }
}

/**
 * Error raised when a runtime credential/role violates least-privilege rules.
 * Addresses Issue #262.
 */
export class OverbroadPermissionError extends Error {
  public readonly code = 'OVERBROAD_PERMISSION';
  public readonly violations: string[];

  constructor(violations: string[], message?: string) {
    super(
      message ??
        `Overbroad runtime permissions detected: ${violations.join('; ')}`,
    );
    this.name = 'OverbroadPermissionError';
    this.violations = violations;
  }
}

/**
 * Checks whether a secret key matches live-mode provider patterns.
 */
export function isLiveSecretKey(key?: string): boolean {
  if (!key) return false;
  const trimmed = key.trim();
  return (
    trimmed.startsWith('sk_live_') ||
    trimmed.startsWith('live_') ||
    trimmed.includes('_live_')
  );
}

/**
 * Asserts that the provided key is a sandbox/test key.
 * Throws LiveCredentialsRefusedError if a live key is detected.
 */
export function assertSandboxSecretKey(key?: string): void {
  if (isLiveSecretKey(key)) {
    throw new LiveCredentialsRefusedError(
      'Live credentials are not permitted in sandbox or test runs. Refusing execution to prevent live-money transfers.',
    );
  }
}

/**
 * Access mode for a runtime role.
 * - 'read-only': may only read data (SELECT).
 * - 'mutation': may read and mutate data (INSERT/UPDATE), but never destructive ops.
 */
export type RuntimeAccessMode = 'read-only' | 'mutation';

/**
 * Descriptor for a runtime credential/role used by an application service.
 * Addresses Issue #262.
 */
export interface RuntimeRoleDescriptor {
  /** Stable identifier for the service that uses this role. */
  service: string;
  /** Role name as provisioned in the data store. */
  role: string;
  /** Whether the role is read-only or may mutate data. */
  access: RuntimeAccessMode;
  /** Explicit privileges granted to the role (least-privilege allow-list). */
  privileges: string[];
  /** Optional human-readable notes for operators. */
  notes?: string;
}

/**
 * Privileges that are never permitted for runtime application services.
 * These are destructive or administrative and must be handled out-of-band.
 */
export const FORBIDDEN_PRIVILEGES: readonly string[] = [
  'delete',
  'drop',
  'truncate',
  'grant',
  'alter',
  'create',
  'revoke',
];

/**
 * Tokens that indicate a wildcard or overly broad grant.
 */
export const WILDCARD_TOKENS: readonly string[] = [
  '*',
  'all',
  'all privileges',
  'admin',
  'superuser',
  'owner',
  'root',
];

/**
 * Canonical least-privilege inventory of runtime roles.
 * Deployment checks should validate provisioned roles against this inventory.
 * Addresses Issue #262.
 */
export const RUNTIME_PERMISSION_INVENTORY: readonly RuntimeRoleDescriptor[] = [
  {
    service: 'payout-reader',
    role: 'payout_reader',
    access: 'read-only',
    privileges: ['select'],
    notes: 'Reads payout intents, ledger entries, and reconciliation state.',
  },
  {
    service: 'payout-writer',
    role: 'payout_writer',
    access: 'mutation',
    privileges: ['select', 'insert', 'update'],
    notes: 'Creates/updates payout intents; no DELETE.',
  },
  {
    service: 'ledger-reader',
    role: 'ledger_reader',
    access: 'read-only',
    privileges: ['select'],
    notes: 'Reads ledger balances and journal entries.',
  },
  {
    service: 'ledger-writer',
    role: 'ledger_writer',
    access: 'mutation',
    privileges: ['select', 'insert'],
    notes: 'Appends journal entries; append-only, no UPDATE/DELETE.',
  },
  {
    service: 'reconciliation-job',
    role: 'reconciliation_job',
    access: 'read-only',
    privileges: ['select'],
    notes: 'Reads state to compute reconciliation reports.',
  },
];

/**
 * Normalizes a privilege token for comparison.
 */
function normalizePrivilege(privilege: string): string {
  return privilege.trim().toLowerCase();
}

/**
 * Returns true if the privilege token is a wildcard or overly broad grant.
 */
export function isWildcardPrivilege(privilege: string): boolean {
  const normalized = normalizePrivilege(privilege);
  if (!normalized) return false;
  if (normalized.includes('*')) return true;
  return WILDCARD_TOKENS.includes(normalized);
}

/**
 * Returns true if the privilege token is a forbidden destructive/admin privilege.
 */
export function isForbiddenPrivilege(privilege: string): boolean {
  const normalized = normalizePrivilege(privilege);
  return FORBIDDEN_PRIVILEGES.includes(normalized);
}

/**
 * Collects least-privilege violations for a single role descriptor.
 * Returns an array of human-readable violation messages (empty when compliant).
 * Addresses Issue #262.
 */
export function collectRoleViolations(
  descriptor: RuntimeRoleDescriptor,
): string[] {
  const violations: string[] = [];
  const label = `${descriptor.service} (${descriptor.role})`;

  if (!descriptor.role || !descriptor.role.trim()) {
    violations.push(`${label}: role name is required`);
  }

  if (!Array.isArray(descriptor.privileges) || descriptor.privileges.length === 0) {
    violations.push(`${label}: at least one explicit privilege is required`);
    return violations;
  }

  for (const privilege of descriptor.privileges) {
    if (isWildcardPrivilege(privilege)) {
      violations.push(`${label}: wildcard/overbroad privilege "${privilege}"`);
    }
    if (isForbiddenPrivilege(privilege)) {
      violations.push(`${label}: forbidden privilege "${privilege}"`);
    }
  }

  const normalized = descriptor.privileges.map(normalizePrivilege);

  if (descriptor.access === 'read-only') {
    const nonRead = normalized.filter((p) => p !== 'select');
    if (nonRead.length > 0) {
      violations.push(
        `${label}: read-only role must only have "select", found [${nonRead.join(', ')}]`,
      );
    }
  }

  if (descriptor.access === 'mutation' && !normalized.includes('select')) {
    violations.push(`${label}: mutation role must include "select"`);
  }

  return violations;
}

/**
 * Validates a set of runtime role descriptors against least-privilege rules.
 * Throws OverbroadPermissionError when any violation is found.
 * Addresses Issue #262.
 */
export function assertLeastPrivilegeRoles(
  descriptors: readonly RuntimeRoleDescriptor[],
): void {
  const violations: string[] = [];
  for (const descriptor of descriptors) {
    violations.push(...collectRoleViolations(descriptor));
  }
  if (violations.length > 0) {
    throw new OverbroadPermissionError(violations);
  }
}

/**
 * Returns true when the environment is production-like.
 * Production is the only environment where overbroad grants are hard-failures.
 */
export function isProductionEnvironment(env?: string): boolean {
  if (!env) return false;
  const normalized = env.trim().toLowerCase();
  return normalized === 'production' || normalized === 'prod';
}

/**
 * Deployment check: validates provisioned runtime roles against the
 * least-privilege inventory. In production, any wildcard or forbidden
 * privilege is rejected. In non-production, the same rules apply to the
 * inventory but the caller may choose to warn instead of fail.
 *
 * Returns the list of violations (empty when compliant). Throws
 * OverbroadPermissionError in production when violations are present.
 * Addresses Issue #262.
 */
export function checkRuntimePermissions(
  descriptors: readonly RuntimeRoleDescriptor[],
  options: { env?: string; failOnViolation?: boolean } = {},
): string[] {
  const violations: string[] = [];
  for (const descriptor of descriptors) {
    violations.push(...collectRoleViolations(descriptor));
  }

  const failOnViolation =
    options.failOnViolation ?? isProductionEnvironment(options.env);

  if (failOnViolation && violations.length > 0) {
    throw new OverbroadPermissionError(violations);
  }

  return violations;
}

/**
 * Deployment check: verifies that every service in the canonical inventory
 * has a matching provisioned descriptor and that no extra roles are present.
 * Returns violations (empty when compliant). Throws OverbroadPermissionError
 * in production when violations are present.
 * Addresses Issue #262.
 */
export function checkInventoryCoverage(
  provisioned: readonly RuntimeRoleDescriptor[],
  options: { env?: string; failOnViolation?: boolean } = {},
): string[] {
  const violations: string[] = [];
  const expected = new Map(
    RUNTIME_PERMISSION_INVENTORY.map((d) => [d.service, d]),
  );
  const seen = new Set<string>();

  for (const descriptor of provisioned) {
    const expectedDescriptor = expected.get(descriptor.service);
    if (!expectedDescriptor) {
      violations.push(
        `${descriptor.service}: role not present in least-privilege inventory`,
      );
      continue;
    }
    seen.add(descriptor.service);
    if (descriptor.access !== expectedDescriptor.access) {
      violations.push(
        `${descriptor.service}: access mode "${descriptor.access}" does not match inventory "${expectedDescriptor.access}"`,
      );
    }
  }

  for (const service of expected.keys()) {
    if (!seen.has(service)) {
      violations.push(`${service}: missing provisioned runtime role`);
    }
  }

  const failOnViolation =
    options.failOnViolation ?? isProductionEnvironment(options.env);

  if (failOnViolation && violations.length > 0) {
    throw new OverbroadPermissionError(violations);
  }

  return violations;
}