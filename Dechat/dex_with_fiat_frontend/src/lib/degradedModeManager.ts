/**
 * Degraded Read-Only Mode Manager for RPC Outages
 * Addresses Issue #93: Allow safe inspection during RPC/provider outages
 * without letting stale state authorize writes.
 */

export interface SubsystemHealth {
  status: 'healthy' | 'degraded' | 'unreachable';
  lastCheckedAt: number;
  message?: string;
}

export interface SystemHealthStatus {
  wallet: SubsystemHealth;
  sorobanRpc: SubsystemHealth;
  contractReads: SubsystemHealth;
  fiatPayoutProvider: SubsystemHealth;
}

export class DegradedModeManager {
  private health: SystemHealthStatus = {
    wallet: { status: 'healthy', lastCheckedAt: Date.now() },
    sorobanRpc: { status: 'healthy', lastCheckedAt: Date.now() },
    contractReads: { status: 'healthy', lastCheckedAt: Date.now() },
    fiatPayoutProvider: { status: 'healthy', lastCheckedAt: Date.now() },
  };

  public updateSubsystem(name: keyof SystemHealthStatus, health: SubsystemHealth): void {
    this.health[name] = health;
  }

  public getHealth(): SystemHealthStatus {
    return { ...this.health };
  }

  /**
   * Evaluates whether writes (deposits, signing, withdrawals) are permitted.
   * In degraded mode, inspection/cached reads are allowed, but writes are blocked.
   */
  public canSubmitTransactions(): { allowed: boolean; reason?: string } {
    if (this.health.sorobanRpc.status === 'unreachable') {
      return { allowed: false, reason: 'Soroban RPC is offline. Write transactions are disabled to prevent stale authorization.' };
    }
    if (this.health.contractReads.status === 'degraded' || this.health.contractReads.status === 'unreachable') {
      return { allowed: false, reason: 'Contract state read is degraded. Writes blocked.' };
    }
    if (this.health.fiatPayoutProvider.status === 'unreachable') {
      return { allowed: false, reason: 'Fiat payout gateway is offline. Deposits paused.' };
    }
    return { allowed: true };
  }
}
