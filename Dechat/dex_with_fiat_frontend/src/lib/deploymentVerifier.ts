/**
 * Deployment Verifier — Issue #283
 *
 * Programmatic preflight and post-deploy state checks that gate whether the
 * frontend is permitted to issue write transactions against a Stellar/Soroban
 * FiatBridge contract.
 *
 * Design principles:
 *  - All network calls are injected through the `StellarRpcClient` interface
 *    so tests can run entirely offline.
 *  - Write-enable decisions are purely a local boolean; this module never
 *    mutates on-chain state.
 *  - Financial-safety properties (pause state, circuit breaker) are checked
 *    as separate first-class checks, not hidden inside composite assertions.
 *  - No credentials, secrets, or PII ever pass through this module.
 *
 * Usage:
 * ```ts
 * import { DeploymentVerifier } from '@/lib/deploymentVerifier';
 *
 * const verifier = new DeploymentVerifier(rpcClient, {
 *   contractId:      'C…',
 *   expectedNetwork: 'Test SDF Network ; September 2015',
 *   expectedAdmin:   'G…',
 *   expectedOracle:  'G…',
 * });
 *
 * const result = await verifier.runAll();
 * if (!result.writeEnabled) throw new Error('Deployment not verified');
 * ```
 */

// ── Constants ───────────────────────────────────────────────────────────────

export const NETWORK_PASSPHRASE = {
  testnet:    'Test SDF Network ; September 2015',
  futurenet:  'Test SDF Future Network ; April 2020',
  mainnet:    'Public Global Stellar Network ; September 2015',
  standalone: 'Standalone Network ; February 2017',
} as const;

export type NetworkProfile = keyof typeof NETWORK_PASSPHRASE;

// ── Interfaces for injectable RPC transport ─────────────────────────────────

/**
 * Minimal Soroban JSON-RPC response shapes needed by the verifier.
 * Only the fields the verifier actually reads are typed.
 */
export interface RpcHealthResult  { status: string }
export interface RpcNetworkResult { passphrase: string; friendbotUrl?: string }
export interface RpcLedgerResult  { sequence: number; hash: string; closeTime: number }
export interface RpcContractDataResult { entries?: unknown[]; error?: string }

/**
 * Thin injectable RPC client interface.  Pass a real HTTP client in production;
 * pass a stub in tests.
 */
export interface StellarRpcClient {
  getHealth():           Promise<RpcHealthResult>
  getNetwork():          Promise<RpcNetworkResult>
  getLatestLedger():     Promise<RpcLedgerResult>
  /**
   * Simulate a read-only contract invocation.
   * Returns the XDR-decoded result or null when the contract/function is absent.
   */
  invokeReadOnly(contractId: string, functionName: string, args?: unknown[]): Promise<unknown>
  /**
   * Query persisted contract data by key.
   * Returns null when the entry does not exist.
   */
  getContractData(contractId: string, key: string): Promise<unknown>
}

// ── Options ─────────────────────────────────────────────────────────────────

export interface DeploymentVerifierOptions {
  /**
   * Contract ID (Strkey C… format) to probe.  Required for post-deploy checks.
   */
  contractId?: string

  /**
   * Network passphrase the RPC endpoint must report.
   * When omitted the passphrase check is skipped.
   */
  expectedNetwork?: string

  /**
   * Expected on-chain admin address (G… Strkey).
   * When omitted the admin identity check is skipped.
   */
  expectedAdmin?: string

  /**
   * Expected on-chain oracle address.
   * When omitted the oracle identity check is skipped.
   */
  expectedOracle?: string

  /**
   * Expected SHA-256 hex digest of the deployed WASM.
   * When supplied, `wasmDigest` is compared during preflight.
   */
  expectedWasmDigest?: string

  /**
   * Actual WASM digest computed by the build pipeline.
   * Compared against `expectedWasmDigest` when both are present.
   */
  wasmDigest?: string

  /**
   * When true, non-fatal checks emit warnings but do not fail the gate.
   * Fatal checks (network identity, admin mismatch) always fail the gate
   * regardless of this flag.
   */
  lenient?: boolean
}

// ── Result types ────────────────────────────────────────────────────────────

export type CheckSeverity = 'required' | 'advisory'

export interface CheckResult {
  name:     string
  passed:   boolean
  severity: CheckSeverity
  detail:   string
}

export interface DeploymentVerifyResult {
  /**
   * true only when all *required* checks passed.
   * Advisory failures set writeEnabled to false when lenient=false (default).
   */
  writeEnabled: boolean
  checks:       CheckResult[]
  errors:       string[]
  warnings:     string[]
  /** ISO timestamp of evaluation. */
  evaluatedAt:  string
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function collectIssues(checks: CheckResult[], lenient: boolean) {
  const errors:   string[] = []
  const warnings: string[] = []
  for (const c of checks) {
    if (c.passed) continue
    if (c.severity === 'required' || !lenient) {
      errors.push(`[${c.name}] ${c.detail}`)
    } else {
      warnings.push(`[${c.name}] ${c.detail}`)
    }
  }
  return { errors, warnings }
}

// ── Main class ───────────────────────────────────────────────────────────────

export class DeploymentVerifier {
  private readonly rpc:  StellarRpcClient
  private readonly opts: DeploymentVerifierOptions

  constructor(rpc: StellarRpcClient, opts: DeploymentVerifierOptions = {}) {
    this.rpc  = rpc
    this.opts = opts
  }

  // ── Public ─────────────────────────────────────────────────────────────

  /**
   * Run all preflight and post-deploy checks in sequence.
   * Returns a full result with the write-enable decision.
   */
  async runAll(): Promise<DeploymentVerifyResult> {
    const checks: CheckResult[] = []
    checks.push(...await this.runPreflight())
    if (this.opts.contractId) {
      checks.push(...await this.runPostDeploy())
    }
    return this._buildResult(checks)
  }

  /**
   * Run only preflight checks (network, passphrase, WASM digest, latest ledger).
   */
  async runPreflight(): Promise<CheckResult[]> {
    const checks: CheckResult[] = []
    checks.push(await this._checkRpcHealth())
    checks.push(await this._checkNetworkPassphrase())
    checks.push(await this._checkLatestLedger())
    if (this.opts.expectedWasmDigest !== undefined || this.opts.wasmDigest !== undefined) {
      checks.push(this._checkWasmDigest())
    }
    return checks
  }

  /**
   * Run only post-deploy read-only probes against the configured contractId.
   * Throws if no contractId is configured.
   */
  async runPostDeploy(): Promise<CheckResult[]> {
    if (!this.opts.contractId) {
      throw new Error('contractId is required for post-deploy verification')
    }
    const checks: CheckResult[] = []
    checks.push(await this._checkContractQueryable())
    checks.push(await this._checkChainIdentityPostDeploy())
    checks.push(await this._checkAdminIdentity())
    checks.push(await this._checkOracleIdentity())
    checks.push(await this._checkPauseState())
    checks.push(await this._checkCircuitBreaker())
    return checks
  }

  // ── Individual checks ───────────────────────────────────────────────────

  /** RPC endpoint must report status=healthy. */
  async checkRpcHealth(): Promise<CheckResult> { return this._checkRpcHealth() }

  /** Network passphrase must match expectedNetwork when configured. */
  async checkNetworkPassphrase(): Promise<CheckResult> { return this._checkNetworkPassphrase() }

  /** RPC must return a positive ledger sequence. */
  async checkLatestLedger(): Promise<CheckResult> { return this._checkLatestLedger() }

  /** Actual WASM digest must equal expectedWasmDigest when both are configured. */
  checkWasmDigest(): CheckResult { return this._checkWasmDigest() }

  /** Contract must be queryable (getContractData returns a non-error response). */
  async checkContractQueryable(): Promise<CheckResult> { return this._checkContractQueryable() }

  /** Admin address returned by get_admin must match expectedAdmin when configured. */
  async checkAdminIdentity(): Promise<CheckResult> { return this._checkAdminIdentity() }

  /** Oracle address in config snapshot must match expectedOracle when configured. */
  async checkOracleIdentity(): Promise<CheckResult> { return this._checkOracleIdentity() }

  /** Pause state must be readable and global_paused must be false. */
  async checkPauseState(): Promise<CheckResult> { return this._checkPauseState() }

  /** Circuit breaker must be readable and not tripped. */
  async checkCircuitBreaker(): Promise<CheckResult> { return this._checkCircuitBreaker() }

  // ── Private implementations ─────────────────────────────────────────────

  private async _checkRpcHealth(): Promise<CheckResult> {
    const name = 'rpc-health'
    try {
      const r = await this.rpc.getHealth()
      const passed = r.status === 'healthy'
      return {
        name, severity: 'required', passed,
        detail: passed
          ? `RPC endpoint is healthy (status=${r.status}).`
          : `RPC reported status '${r.status}', expected 'healthy'.`,
      }
    } catch (err) {
      return {
        name, severity: 'required', passed: false,
        detail: `RPC health check threw: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }

  private async _checkNetworkPassphrase(): Promise<CheckResult> {
    const name = 'network-passphrase'
    if (!this.opts.expectedNetwork) {
      return { name, severity: 'advisory', passed: true, detail: 'No expectedNetwork configured; check skipped.' }
    }
    try {
      const r = await this.rpc.getNetwork()
      const passed = r.passphrase === this.opts.expectedNetwork
      return {
        name, severity: 'required', passed,
        detail: passed
          ? `Network passphrase matches: ${r.passphrase}`
          : `Network passphrase mismatch. Expected: '${this.opts.expectedNetwork}' — Got: '${r.passphrase}'`,
      }
    } catch (err) {
      return {
        name, severity: 'required', passed: false,
        detail: `getNetwork threw: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }

  private async _checkLatestLedger(): Promise<CheckResult> {
    const name = 'latest-ledger'
    try {
      const r = await this.rpc.getLatestLedger()
      const passed = typeof r.sequence === 'number' && r.sequence > 0
      return {
        name, severity: 'required', passed,
        detail: passed
          ? `Latest ledger sequence: ${r.sequence}`
          : `Invalid ledger sequence: ${r.sequence}`,
      }
    } catch (err) {
      return {
        name, severity: 'required', passed: false,
        detail: `getLatestLedger threw: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }

  private _checkWasmDigest(): CheckResult {
    const name = 'wasm-digest'
    const { expectedWasmDigest, wasmDigest } = this.opts
    if (!expectedWasmDigest) {
      return { name, severity: 'advisory', passed: true, detail: 'No expectedWasmDigest configured; digest pin check skipped.' }
    }
    if (!wasmDigest) {
      return { name, severity: 'advisory', passed: false, detail: 'expectedWasmDigest is set but wasmDigest was not provided.' }
    }
    const expected = expectedWasmDigest.replace(/^sha256:/, '')
    const actual   = wasmDigest.replace(/^sha256:/, '')
    const passed = expected === actual
    return {
      name, severity: 'required', passed,
      detail: passed
        ? `WASM digest pin verified: sha256:${actual}`
        : `WASM digest pin mismatch. Expected: sha256:${expected} — Got: sha256:${actual}`,
    }
  }

  private async _checkContractQueryable(): Promise<CheckResult> {
    const name = 'contract-queryable'
    const { contractId } = this.opts
    if (!contractId) {
      return { name, severity: 'advisory', passed: false, detail: 'No contractId configured.' }
    }
    try {
      const result = await this.rpc.getContractData(contractId, 'ledger')
      // Any non-throwing response — even "not found" — means the RPC endpoint
      // can reach the contract.  A throw means the contract is unreachable.
      const passed = result !== undefined
      return {
        name, severity: 'required', passed,
        detail: passed
          ? `Contract ${contractId} is queryable on-chain.`
          : `getContractData returned undefined for ${contractId}.`,
      }
    } catch (err) {
      return {
        name, severity: 'required', passed: false,
        detail: `getContractData threw for ${contractId}: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }

  private async _checkChainIdentityPostDeploy(): Promise<CheckResult> {
    const name = 'chain-identity-post-deploy'
    if (!this.opts.expectedNetwork) {
      return { name, severity: 'advisory', passed: true, detail: 'No expectedNetwork; post-deploy identity check skipped.' }
    }
    try {
      const r = await this.rpc.getNetwork()
      const passed = r.passphrase === this.opts.expectedNetwork
      return {
        name, severity: 'required', passed,
        detail: passed
          ? `Post-deploy chain identity confirmed: ${r.passphrase}`
          : `Chain identity changed between preflight and post-deploy! Got: '${r.passphrase}'`,
      }
    } catch (err) {
      return {
        name, severity: 'required', passed: false,
        detail: `Post-deploy getNetwork threw: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }

  private async _checkAdminIdentity(): Promise<CheckResult> {
    const name = 'admin-identity'
    const { contractId, expectedAdmin } = this.opts
    if (!contractId) {
      return { name, severity: 'advisory', passed: false, detail: 'No contractId configured.' }
    }
    try {
      const raw = await this.rpc.invokeReadOnly(contractId, 'get_admin')
      if (raw === null || raw === undefined) {
        return {
          name, severity: 'advisory', passed: true,
          detail: 'get_admin returned null — contract not yet initialised (expected before init).',
        }
      }
      const admin = typeof raw === 'string' ? raw.replace(/"/g, '') : String(raw)
      if (!expectedAdmin) {
        return { name, severity: 'advisory', passed: true, detail: `Admin address read: ${admin}. No expectedAdmin configured; identity assertion skipped.` }
      }
      const passed = admin === expectedAdmin
      return {
        name, severity: 'required', passed,
        detail: passed
          ? `Admin identity matches: ${admin}`
          : `Admin identity mismatch. Expected: ${expectedAdmin} — Got: ${admin}`,
      }
    } catch (err) {
      return {
        name, severity: 'advisory', passed: false,
        detail: `get_admin threw: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }

  private async _checkOracleIdentity(): Promise<CheckResult> {
    const name = 'oracle-identity'
    const { contractId, expectedOracle } = this.opts
    if (!contractId) {
      return { name, severity: 'advisory', passed: false, detail: 'No contractId configured.' }
    }
    try {
      const raw = await this.rpc.invokeReadOnly(contractId, 'get_config_snapshot')
      if (raw === null || raw === undefined) {
        return {
          name, severity: 'advisory', passed: true,
          detail: 'get_config_snapshot returned null — contract not yet initialised.',
        }
      }
      const snapshot = typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
      const oracle = typeof snapshot.oracle === 'string' ? snapshot.oracle : undefined
      if (!oracle) {
        return {
          name, severity: 'advisory', passed: true,
          detail: 'Oracle not set in config snapshot (may be pre-init).',
        }
      }
      if (!expectedOracle) {
        return { name, severity: 'advisory', passed: true, detail: `Oracle address read: ${oracle}. No expectedOracle configured; identity assertion skipped.` }
      }
      const passed = oracle === expectedOracle
      return {
        name, severity: 'required', passed,
        detail: passed
          ? `Oracle identity matches: ${oracle}`
          : `Oracle identity mismatch. Expected: ${expectedOracle} — Got: ${oracle}`,
      }
    } catch (err) {
      return {
        name, severity: 'advisory', passed: false,
        detail: `get_config_snapshot threw: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }

  /**
   * Checks that the contract's pause state is readable and that
   * global_paused is false.  A paused contract must NOT receive
   * frontend writes — this is a financial-safety gate.
   */
  private async _checkPauseState(): Promise<CheckResult> {
    const name = 'pause-state'
    const { contractId } = this.opts
    if (!contractId) {
      return { name, severity: 'advisory', passed: false, detail: 'No contractId configured.' }
    }
    try {
      const raw = await this.rpc.invokeReadOnly(contractId, 'get_pause_state')
      if (raw === null || raw === undefined) {
        // Not initialised yet — allowed; frontend writes are not yet possible anyway
        return {
          name, severity: 'advisory', passed: true,
          detail: 'get_pause_state returned null — contract not yet initialised.',
        }
      }
      const state = typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
      const globalPaused = Boolean(state.global ?? false)
      const passed = !globalPaused
      return {
        name, severity: 'required', passed,
        detail: passed
          ? `Pause state OK: global_paused=false`
          : `Contract is GLOBALLY PAUSED. Frontend writes must not proceed.`,
      }
    } catch (err) {
      return {
        name, severity: 'advisory', passed: false,
        detail: `get_pause_state threw: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }

  /**
   * Checks that the contract's circuit breaker is not tripped.
   * A tripped circuit breaker signals a provider outage and blocks writes.
   */
  private async _checkCircuitBreaker(): Promise<CheckResult> {
    const name = 'circuit-breaker'
    const { contractId } = this.opts
    if (!contractId) {
      return { name, severity: 'advisory', passed: false, detail: 'No contractId configured.' }
    }
    try {
      const raw = await this.rpc.invokeReadOnly(contractId, 'is_circuit_breaker_tripped')
      if (raw === null || raw === undefined) {
        return {
          name, severity: 'advisory', passed: true,
          detail: 'is_circuit_breaker_tripped returned null — contract not yet initialised.',
        }
      }
      const tripped = raw === true || raw === 'true'
      return {
        name, severity: 'required', passed: !tripped,
        detail: !tripped
          ? `Circuit breaker is not tripped.`
          : `Circuit breaker is TRIPPED. Frontend writes must not proceed until reset.`,
      }
    } catch (err) {
      return {
        name, severity: 'advisory', passed: false,
        detail: `is_circuit_breaker_tripped threw: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }

  // ── Result builder ──────────────────────────────────────────────────────

  private _buildResult(checks: CheckResult[]): DeploymentVerifyResult {
    const lenient = this.opts.lenient ?? false
    const { errors, warnings } = collectIssues(checks, lenient)
    return {
      writeEnabled: errors.length === 0,
      checks,
      errors,
      warnings,
      evaluatedAt: new Date().toISOString(),
    }
  }
}

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * Build a DeploymentVerifier pre-configured for a known network profile.
 *
 * ```ts
 * const verifier = forProfile('testnet', rpcClient, {
 *   contractId:    'C…',
 *   expectedAdmin: 'G…',
 * });
 * const result = await verifier.runAll();
 * ```
 */
export function forProfile(
  profile: NetworkProfile,
  rpc: StellarRpcClient,
  opts: Omit<DeploymentVerifierOptions, 'expectedNetwork'> = {},
): DeploymentVerifier {
  return new DeploymentVerifier(rpc, {
    ...opts,
    expectedNetwork: NETWORK_PASSPHRASE[profile],
  })
}
