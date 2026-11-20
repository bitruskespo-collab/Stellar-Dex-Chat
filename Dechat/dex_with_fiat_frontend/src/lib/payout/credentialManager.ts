/**
 * Provider Credential Rotation Manager
 * Addresses Issue #105:
 * - Supports bounded overlap with versioned provider credentials.
 * - Dispatches new requests using active credentials while preserving status recovery
 *   for existing in-flight intents using their versioned references.
 * - Logs only credential versions, never secret material.
 */

import { serverEnv } from '@/lib/serverEnv';
import { isLiveSecretKey } from './credentialGuard';

/**
 * Least-privilege access roles for provider credentials (Issue #262).
 * - `read`: status checks, webhook signature verification, reconciliation reads.
 * - `mutate`: initiating/cancelling transfers and other state-changing calls.
 */
export type CredentialAccessRole = 'read' | 'mutate';

export interface ProviderCredential {
  version: string;
  secretKey: string;
  isLive: boolean;
  status: 'active' | 'retiring' | 'revoked';
  addedAt: number;
  /**
   * Roles this credential is permitted to serve. Defaults to both roles when
   * unspecified so existing single-key deployments keep working.
   */
  roles?: CredentialAccessRole[];
}

const ALL_ROLES: CredentialAccessRole[] = ['read', 'mutate'];

/**
 * Rejects wildcard or unnecessary production permissions.
 * A live credential must not carry wildcard scopes and must be explicitly
 * limited to the known access roles.
 */
export function assertLeastPrivilege(
  cred: ProviderCredential,
  role: CredentialAccessRole,
): void {
  const roles = cred.roles ?? ALL_ROLES;
  if (roles.length === 0) {
    throw new Error(
      `Credential ${cred.version} has no permitted roles; refusing to use it.`,
    );
  }
  for (const granted of roles) {
    if (!ALL_ROLES.includes(granted)) {
      throw new Error(
        `Credential ${cred.version} grants unknown role "${String(
          granted,
        )}"; wildcard permissions are not allowed.`,
      );
    }
  }
  if (!roles.includes(role)) {
    throw new Error(
      `Credential ${cred.version} is not permitted for "${role}" access.`,
    );
  }
  if (cred.isLive && roles.length === ALL_ROLES.length) {
    // Live credentials must be split into read/mutate roles where practical.
    throw new Error(
      `Live credential ${cred.version} grants both read and mutate roles; ` +
        'split production credentials into least-privilege roles.',
    );
  }
}

class CredentialManager {
  private activeVersion: string = 'v1';
  private keyring = new Map<string, ProviderCredential>();

  constructor() {
    this.initializeFromEnv();
  }

  public initializeFromEnv(): void {
    this.keyring.clear();

    const activeKey =
      (typeof process !== 'undefined'
        ? process.env.PAYSTACK_SECRET_KEY
        : undefined) ||
      serverEnv.PAYSTACK_SECRET_KEY ||
      '';
    const activeVer =
      (typeof process !== 'undefined'
        ? process.env.PAYSTACK_KEY_VERSION
        : undefined) || 'v1';

    if (activeKey) {
      this.activeVersion = activeVer;
      this.keyring.set(activeVer, {
        version: activeVer,
        secretKey: activeKey,
        isLive: isLiveSecretKey(activeKey),
        status: 'active',
        addedAt: Date.now(),
      });
    }

    const prevKey =
      typeof process !== 'undefined'
        ? process.env.PAYSTACK_PREVIOUS_SECRET_KEY
        : undefined;
    const prevVer =
      (typeof process !== 'undefined'
        ? process.env.PAYSTACK_PREVIOUS_KEY_VERSION
        : undefined) || 'v0';

    if (prevKey && prevKey !== activeKey) {
      this.keyring.set(prevVer, {
        version: prevVer,
        secretKey: prevKey,
        isLive: isLiveSecretKey(prevKey),
        status: 'retiring',
        addedAt: Date.now() - 3600_000,
      });
    }
  }

  /**
   * Returns the current active credential for initiating new transfers and requests.
   */
  public getActiveCredential(): ProviderCredential | null {
    return this.keyring.get(this.activeVersion) ?? null;
  }

  /**
   * Retrieves a credential by version.
   * If version is not provided or not found, falls back to the active credential.
   */
  public getCredential(version?: string): ProviderCredential | null {
    if (version && this.keyring.has(version)) {
      return this.keyring.get(version)!;
    }
    return this.getActiveCredential();
  }

  /**
   * Read-role accessor for status checks, webhook verification and reads.
   * Enforces least-privilege role scoping before returning secret material.
   */
  public getReadCredential(version?: string): ProviderCredential | null {
    const cred = this.getCredential(version);
    if (!cred) return null;
    assertLeastPrivilege(cred, 'read');
    return cred;
  }

  /**
   * Mutation-role accessor for initiating/cancelling transfers.
   * Enforces least-privilege role scoping before returning secret material.
   */
  public getMutationCredential(version?: string): ProviderCredential | null {
    const cred = this.getCredential(version);
    if (!cred) return null;
    assertLeastPrivilege(cred, 'mutate');
    return cred;
  }

  /**
   * Returns all active and retiring credentials for webhook signature verification
   * during bounded overlap.
   */
  public getAllWebhookCredentials(): ProviderCredential[] {
    const valid: ProviderCredential[] = [];
    for (const cred of Array.from(this.keyring.values())) {
      if (cred.status === 'active' || cred.status === 'retiring') {
        // Webhook verification is a read path; skip credentials without read role.
        try {
          assertLeastPrivilege(cred, 'read');
        } catch {
          continue;
        }
        valid.push(cred);
      }
    }
    return valid;
  }

  /**
   * Stages a new credential as active and retains the current active as retiring
   * for bounded overlap.
   */
  public rotateCredential(
    newSecretKey: string,
    newVersion: string,
    roles?: CredentialAccessRole[],
  ): ProviderCredential {
    const currentActive = this.getActiveCredential();
    if (currentActive) {
      currentActive.status = 'retiring';
    }

    const nextCred: ProviderCredential = {
      version: newVersion,
      secretKey: newSecretKey,
      isLive: isLiveSecretKey(newSecretKey),
      status: 'active',
      addedAt: Date.now(),
      roles,
    };

    this.keyring.set(newVersion, nextCred);
    this.activeVersion = newVersion;
    return nextCred;
  }

  /**
   * Registers an existing credential version for testing or recovery.
   */
  public registerCredential(cred: ProviderCredential): void {
    // Validate role scoping up-front so misconfigured credentials fail fast.
    const roles = cred.roles ?? ALL_ROLES;
    for (const granted of roles) {
      if (!ALL_ROLES.includes(granted)) {
        throw new Error(
          `Credential ${cred.version} grants unknown role "${String(
            granted,
          )}"; wildcard permissions are not allowed.`,
        );
      }
    }
    this.keyring.set(cred.version, cred);
  }

  /**
   * Revokes a retiring credential version once all in-flight payouts have reconciled.
   */
  public revokeCredential(version: string): boolean {
    const cred = this.keyring.get(version);
    if (!cred || cred.status === 'active') {
      return false;
    }
    cred.status = 'revoked';
    return true;
  }

  /**
   * Safe log context: outputs credential version ONLY, never secret material.
   */
  public logContext(version?: string): { credentialVersion: string } {
    const resolved = version || this.activeVersion;
    return {
      credentialVersion: resolved,
    };
  }

  public resetForTesting(): void {
    this.initializeFromEnv();
  }
}

export const credentialManager = new CredentialManager();
