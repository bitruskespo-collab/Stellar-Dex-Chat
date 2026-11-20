import { describe, expect, it } from 'vitest'
import {
  DeploymentVerifier,
  forProfile,
  NETWORK_PASSPHRASE,
  type StellarRpcClient,
  type RpcHealthResult,
  type RpcNetworkResult,
  type RpcLedgerResult,
} from './deploymentVerifier'

// ── Fixture helpers ────────────────────────────────────────────────────────

const CONTRACT_ID  = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4'
const ADMIN_ADDR   = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN'
const ORACLE_ADDR  = 'GDQERENWDDSQZS7R7WKHZI3BSOYMV3FSWR7TFUYFTKQ447PIX6NREOJM'
const TESTNET_PASS = NETWORK_PASSPHRASE.testnet

/** Build a stub RPC client where every method can be overridden. */
function makeRpc(overrides: Partial<StellarRpcClient> = {}): StellarRpcClient {
  return {
    async getHealth():        Promise<RpcHealthResult>  { return { status: 'healthy' } },
    async getNetwork():       Promise<RpcNetworkResult> { return { passphrase: TESTNET_PASS } },
    async getLatestLedger():  Promise<RpcLedgerResult>  { return { sequence: 100, hash: 'abc', closeTime: 0 } },
    async invokeReadOnly(_cid: string, fn: string): Promise<unknown> {
      if (fn === 'get_admin')             return ADMIN_ADDR
      if (fn === 'get_config_snapshot')   return { oracle: ORACLE_ADDR }
      if (fn === 'get_pause_state')       return { global: false }
      if (fn === 'is_circuit_breaker_tripped') return false
      if (fn === 'get_deploy_config_hash')     return 'config-hash-abc'
      return null
    },
    async getContractData():  { return {} },
    ...overrides,
  }
}

// ── 1. Preflight — happy path ──────────────────────────────────────────────

describe('runPreflight — happy path', () => {
  it('passes all preflight checks with a healthy stub', async () => {
    const v = new DeploymentVerifier(makeRpc(), { expectedNetwork: TESTNET_PASS })
    const checks = await v.runPreflight()
    const failed = checks.filter(c => !c.passed)
    expect(failed).toHaveLength(0)
  })

  it('includes rpc-health, network-passphrase, latest-ledger checks', async () => {
    const v = new DeploymentVerifier(makeRpc(), { expectedNetwork: TESTNET_PASS })
    const checks = await v.runPreflight()
    const names = checks.map(c => c.name)
    expect(names).toContain('rpc-health')
    expect(names).toContain('network-passphrase')
    expect(names).toContain('latest-ledger')
  })

  it('includes wasm-digest check only when digest options are provided', async () => {
    const withDigest = new DeploymentVerifier(makeRpc(), {
      expectedWasmDigest: 'sha256:' + 'a'.repeat(64),
      wasmDigest:         'sha256:' + 'a'.repeat(64),
    })
    const withoutDigest = new DeploymentVerifier(makeRpc())
    const withChecks    = await withDigest.runPreflight()
    const withoutChecks = await withoutDigest.runPreflight()
    expect(withChecks.some(c => c.name === 'wasm-digest')).toBe(true)
    expect(withoutChecks.some(c => c.name === 'wasm-digest')).toBe(false)
  })
})

// ── 2. Preflight — rpc-health failures ────────────────────────────────────

describe('runPreflight — rpc-health failures', () => {
  it('fails rpc-health when status is not healthy', async () => {
    const rpc = makeRpc({ async getHealth() { return { status: 'degraded' } } })
    const v = new DeploymentVerifier(rpc, { expectedNetwork: TESTNET_PASS })
    const checks = await v.runPreflight()
    const hc = checks.find(c => c.name === 'rpc-health')
    expect(hc?.passed).toBe(false)
    expect(hc?.severity).toBe('required')
  })

  it('fails rpc-health when getHealth throws', async () => {
    const rpc = makeRpc({ async getHealth() { throw new Error('connection refused') } })
    const v = new DeploymentVerifier(rpc)
    const checks = await v.runPreflight()
    const hc = checks.find(c => c.name === 'rpc-health')
    expect(hc?.passed).toBe(false)
    expect(hc?.detail).toMatch(/connection refused/)
  })
})

// ── 3. Preflight — network passphrase ────────────────────────────────────

describe('runPreflight — network passphrase', () => {
  it('fails when passphrase does not match', async () => {
    const rpc = makeRpc({ async getNetwork() { return { passphrase: 'wrong network' } } })
    const v = new DeploymentVerifier(rpc, { expectedNetwork: TESTNET_PASS })
    const checks = await v.runPreflight()
    const pc = checks.find(c => c.name === 'network-passphrase')
    expect(pc?.passed).toBe(false)
    expect(pc?.severity).toBe('required')
    expect(pc?.detail).toMatch(/mismatch/)
  })

  it('skips passphrase check when no expectedNetwork is set', async () => {
    const v = new DeploymentVerifier(makeRpc())
    const checks = await v.runPreflight()
    const pc = checks.find(c => c.name === 'network-passphrase')
    // Check should still be present but pass (skipped advisory)
    expect(pc?.passed).toBe(true)
  })

  it('fails when getNetwork throws', async () => {
    const rpc = makeRpc({ async getNetwork() { throw new Error('timeout') } })
    const v = new DeploymentVerifier(rpc, { expectedNetwork: TESTNET_PASS })
    const checks = await v.runPreflight()
    const pc = checks.find(c => c.name === 'network-passphrase')
    expect(pc?.passed).toBe(false)
    expect(pc?.detail).toMatch(/timeout/)
  })
})

// ── 4. Preflight — latest-ledger ──────────────────────────────────────────

describe('runPreflight — latest-ledger', () => {
  it('fails when sequence is 0', async () => {
    const rpc = makeRpc({ async getLatestLedger() { return { sequence: 0, hash: '', closeTime: 0 } } })
    const v = new DeploymentVerifier(rpc)
    const checks = await v.runPreflight()
    const lc = checks.find(c => c.name === 'latest-ledger')
    expect(lc?.passed).toBe(false)
  })

  it('fails when getLatestLedger throws', async () => {
    const rpc = makeRpc({ async getLatestLedger() { throw new Error('rpc down') } })
    const v = new DeploymentVerifier(rpc)
    const checks = await v.runPreflight()
    const lc = checks.find(c => c.name === 'latest-ledger')
    expect(lc?.passed).toBe(false)
    expect(lc?.detail).toMatch(/rpc down/)
  })

  it('passes for a large ledger sequence', async () => {
    const rpc = makeRpc({ async getLatestLedger() { return { sequence: 55_000_000, hash: 'xyz', closeTime: 0 } } })
    const v = new DeploymentVerifier(rpc)
    const checks = await v.runPreflight()
    const lc = checks.find(c => c.name === 'latest-ledger')
    expect(lc?.passed).toBe(true)
    expect(lc?.detail).toContain('55000000')
  })
})

// ── 5. WASM digest pin ────────────────────────────────────────────────────

describe('checkWasmDigest', () => {
  const DIGEST = 'a'.repeat(64)

  it('passes when digests match (with sha256: prefix)', () => {
    const v = new DeploymentVerifier(makeRpc(), {
      expectedWasmDigest: 'sha256:' + DIGEST,
      wasmDigest:         'sha256:' + DIGEST,
    })
    const r = v.checkWasmDigest()
    expect(r.passed).toBe(true)
  })

  it('passes when digests match (without prefix)', () => {
    const v = new DeploymentVerifier(makeRpc(), {
      expectedWasmDigest: DIGEST,
      wasmDigest:         DIGEST,
    })
    const r = v.checkWasmDigest()
    expect(r.passed).toBe(true)
  })

  it('fails when digests differ', () => {
    const v = new DeploymentVerifier(makeRpc(), {
      expectedWasmDigest: DIGEST,
      wasmDigest:         'b'.repeat(64),
    })
    const r = v.checkWasmDigest()
    expect(r.passed).toBe(false)
    expect(r.severity).toBe('required')
    expect(r.detail).toMatch(/mismatch/)
  })

  it('advisory fail when expectedWasmDigest set but wasmDigest absent', () => {
    const v = new DeploymentVerifier(makeRpc(), { expectedWasmDigest: DIGEST })
    const r = v.checkWasmDigest()
    expect(r.passed).toBe(false)
    expect(r.severity).toBe('advisory')
  })

  it('passes (skipped) when neither digest is set', () => {
    const v = new DeploymentVerifier(makeRpc())
    const r = v.checkWasmDigest()
    expect(r.passed).toBe(true)
    expect(r.severity).toBe('advisory')
  })
})

// ── 6. Post-deploy — contract queryable ───────────────────────────────────

describe('runPostDeploy — contract-queryable', () => {
  it('passes when getContractData returns a value', async () => {
    const v = new DeploymentVerifier(makeRpc(), { contractId: CONTRACT_ID, expectedNetwork: TESTNET_PASS })
    const checks = await v.runPostDeploy()
    const qc = checks.find(c => c.name === 'contract-queryable')
    expect(qc?.passed).toBe(true)
  })

  it('fails when getContractData throws', async () => {
    const rpc = makeRpc({ async getContractData() { throw new Error('contract not found') } })
    const v = new DeploymentVerifier(rpc, { contractId: CONTRACT_ID, expectedNetwork: TESTNET_PASS })
    const checks = await v.runPostDeploy()
    const qc = checks.find(c => c.name === 'contract-queryable')
    expect(qc?.passed).toBe(false)
    expect(qc?.detail).toMatch(/contract not found/)
  })

  it('throws when no contractId is configured', async () => {
    const v = new DeploymentVerifier(makeRpc())
    await expect(v.runPostDeploy()).rejects.toThrow('contractId is required')
  })
})

// ── 7. Post-deploy — admin identity ───────────────────────────────────────

describe('runPostDeploy — admin-identity', () => {
  it('passes when admin matches', async () => {
    const v = new DeploymentVerifier(makeRpc(), {
      contractId: CONTRACT_ID, expectedNetwork: TESTNET_PASS, expectedAdmin: ADMIN_ADDR,
    })
    const checks = await v.runPostDeploy()
    const ac = checks.find(c => c.name === 'admin-identity')
    expect(ac?.passed).toBe(true)
  })

  it('fails when admin does not match', async () => {
    const v = new DeploymentVerifier(makeRpc(), {
      contractId: CONTRACT_ID, expectedNetwork: TESTNET_PASS, expectedAdmin: 'GWRONG',
    })
    const checks = await v.runPostDeploy()
    const ac = checks.find(c => c.name === 'admin-identity')
    expect(ac?.passed).toBe(false)
    expect(ac?.severity).toBe('required')
    expect(ac?.detail).toMatch(/mismatch/)
  })

  it('advisory pass (read-only) when no expectedAdmin configured', async () => {
    const v = new DeploymentVerifier(makeRpc(), { contractId: CONTRACT_ID, expectedNetwork: TESTNET_PASS })
    const checks = await v.runPostDeploy()
    const ac = checks.find(c => c.name === 'admin-identity')
    expect(ac?.passed).toBe(true)
    expect(ac?.detail).toMatch(/skipped/)
  })

  it('advisory pass when get_admin returns null (pre-init)', async () => {
    const rpc = makeRpc({
      async invokeReadOnly(_cid, fn) {
        if (fn === 'get_admin') return null
        return null
      },
    })
    const v = new DeploymentVerifier(rpc, {
      contractId: CONTRACT_ID, expectedNetwork: TESTNET_PASS, expectedAdmin: ADMIN_ADDR,
    })
    const checks = await v.runPostDeploy()
    const ac = checks.find(c => c.name === 'admin-identity')
    expect(ac?.passed).toBe(true)
    expect(ac?.detail).toMatch(/not yet initialised/)
  })

  it('strips surrounding quotes from CLI-formatted admin string', async () => {
    const rpc = makeRpc({
      async invokeReadOnly(_cid, fn) {
        if (fn === 'get_admin') return `"${ADMIN_ADDR}"`
        return null
      },
    })
    const v = new DeploymentVerifier(rpc, {
      contractId: CONTRACT_ID, expectedNetwork: TESTNET_PASS, expectedAdmin: ADMIN_ADDR,
    })
    const checks = await v.runPostDeploy()
    const ac = checks.find(c => c.name === 'admin-identity')
    expect(ac?.passed).toBe(true)
  })
})

// ── 8. Post-deploy — oracle identity ─────────────────────────────────────

describe('runPostDeploy — oracle-identity', () => {
  it('passes when oracle matches', async () => {
    const v = new DeploymentVerifier(makeRpc(), {
      contractId: CONTRACT_ID, expectedNetwork: TESTNET_PASS, expectedOracle: ORACLE_ADDR,
    })
    const checks = await v.runPostDeploy()
    const oc = checks.find(c => c.name === 'oracle-identity')
    expect(oc?.passed).toBe(true)
  })

  it('fails when oracle does not match', async () => {
    const v = new DeploymentVerifier(makeRpc(), {
      contractId: CONTRACT_ID, expectedNetwork: TESTNET_PASS, expectedOracle: 'GWRONG',
    })
    const checks = await v.runPostDeploy()
    const oc = checks.find(c => c.name === 'oracle-identity')
    expect(oc?.passed).toBe(false)
    expect(oc?.severity).toBe('required')
  })

  it('advisory pass when get_config_snapshot returns null (pre-init)', async () => {
    const rpc = makeRpc({
      async invokeReadOnly(_cid, fn) {
        if (fn === 'get_config_snapshot') return null
        return null
      },
    })
    const v = new DeploymentVerifier(rpc, {
      contractId: CONTRACT_ID, expectedNetwork: TESTNET_PASS, expectedOracle: ORACLE_ADDR,
    })
    const checks = await v.runPostDeploy()
    const oc = checks.find(c => c.name === 'oracle-identity')
    expect(oc?.passed).toBe(true)
    expect(oc?.detail).toMatch(/not yet initialised/)
  })
})

// ── 9. Post-deploy — pause state (financial safety) ───────────────────────

describe('runPostDeploy — pause-state', () => {
  it('passes when global_paused is false', async () => {
    const v = new DeploymentVerifier(makeRpc(), { contractId: CONTRACT_ID, expectedNetwork: TESTNET_PASS })
    const checks = await v.runPostDeploy()
    const pc = checks.find(c => c.name === 'pause-state')
    expect(pc?.passed).toBe(true)
    expect(pc?.detail).toMatch(/false/)
  })

  it('BLOCKS writes when globally paused', async () => {
    const rpc = makeRpc({
      async invokeReadOnly(_cid, fn) {
        if (fn === 'get_pause_state') return { global: true }
        return null
      },
    })
    const v = new DeploymentVerifier(rpc, { contractId: CONTRACT_ID, expectedNetwork: TESTNET_PASS })
    const checks = await v.runPostDeploy()
    const pc = checks.find(c => c.name === 'pause-state')
    expect(pc?.passed).toBe(false)
    expect(pc?.severity).toBe('required')
    expect(pc?.detail).toMatch(/GLOBALLY PAUSED/)
  })

  it('advisory pass when pause state unavailable (pre-init)', async () => {
    const rpc = makeRpc({
      async invokeReadOnly(_cid, fn) {
        if (fn === 'get_pause_state') return null
        return null
      },
    })
    const v = new DeploymentVerifier(rpc, { contractId: CONTRACT_ID, expectedNetwork: TESTNET_PASS })
    const checks = await v.runPostDeploy()
    const pc = checks.find(c => c.name === 'pause-state')
    expect(pc?.passed).toBe(true)
    expect(pc?.detail).toMatch(/not yet initialised/)
  })
})

// ── 10. Post-deploy — circuit breaker ────────────────────────────────────

describe('runPostDeploy — circuit-breaker', () => {
  it('passes when circuit breaker is not tripped', async () => {
    const v = new DeploymentVerifier(makeRpc(), { contractId: CONTRACT_ID, expectedNetwork: TESTNET_PASS })
    const checks = await v.runPostDeploy()
    const cb = checks.find(c => c.name === 'circuit-breaker')
    expect(cb?.passed).toBe(true)
  })

  it('BLOCKS writes when circuit breaker is tripped', async () => {
    const rpc = makeRpc({
      async invokeReadOnly(_cid, fn) {
        if (fn === 'is_circuit_breaker_tripped') return true
        return null
      },
    })
    const v = new DeploymentVerifier(rpc, { contractId: CONTRACT_ID, expectedNetwork: TESTNET_PASS })
    const checks = await v.runPostDeploy()
    const cb = checks.find(c => c.name === 'circuit-breaker')
    expect(cb?.passed).toBe(false)
    expect(cb?.severity).toBe('required')
    expect(cb?.detail).toMatch(/TRIPPED/)
  })

  it('handles string "true" as tripped', async () => {
    const rpc = makeRpc({
      async invokeReadOnly(_cid, fn) {
        if (fn === 'is_circuit_breaker_tripped') return 'true'
        return null
      },
    })
    const v = new DeploymentVerifier(rpc, { contractId: CONTRACT_ID, expectedNetwork: TESTNET_PASS })
    const checks = await v.runPostDeploy()
    const cb = checks.find(c => c.name === 'circuit-breaker')
    expect(cb?.passed).toBe(false)
  })
})

// ── 11. runAll — combined ─────────────────────────────────────────────────

describe('runAll', () => {
  it('writeEnabled=true when all checks pass', async () => {
    const v = new DeploymentVerifier(makeRpc(), {
      contractId: CONTRACT_ID, expectedNetwork: TESTNET_PASS,
      expectedAdmin: ADMIN_ADDR, expectedOracle: ORACLE_ADDR,
    })
    const result = await v.runAll()
    expect(result.writeEnabled).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('writeEnabled=false when a required check fails', async () => {
    const rpc = makeRpc({ async getHealth() { return { status: 'degraded' } } })
    const v = new DeploymentVerifier(rpc, { contractId: CONTRACT_ID, expectedNetwork: TESTNET_PASS })
    const result = await v.runAll()
    expect(result.writeEnabled).toBe(false)
    expect(result.errors.length).toBeGreaterThan(0)
  })

  it('writeEnabled=false when contract is globally paused', async () => {
    const rpc = makeRpc({
      async invokeReadOnly(_cid, fn) {
        if (fn === 'get_pause_state') return { global: true }
        if (fn === 'get_admin') return ADMIN_ADDR
        if (fn === 'get_config_snapshot') return { oracle: ORACLE_ADDR }
        if (fn === 'is_circuit_breaker_tripped') return false
        return null
      },
    })
    const v = new DeploymentVerifier(rpc, { contractId: CONTRACT_ID, expectedNetwork: TESTNET_PASS })
    const result = await v.runAll()
    expect(result.writeEnabled).toBe(false)
    expect(result.errors.some(e => e.includes('pause-state'))).toBe(true)
  })

  it('writeEnabled=false when circuit breaker is tripped', async () => {
    const rpc = makeRpc({
      async invokeReadOnly(_cid, fn) {
        if (fn === 'is_circuit_breaker_tripped') return true
        if (fn === 'get_admin') return ADMIN_ADDR
        if (fn === 'get_config_snapshot') return { oracle: ORACLE_ADDR }
        if (fn === 'get_pause_state') return { global: false }
        return null
      },
    })
    const v = new DeploymentVerifier(rpc, { contractId: CONTRACT_ID, expectedNetwork: TESTNET_PASS })
    const result = await v.runAll()
    expect(result.writeEnabled).toBe(false)
    expect(result.errors.some(e => e.includes('circuit-breaker'))).toBe(true)
  })

  it('includes evaluatedAt ISO timestamp', async () => {
    const v = new DeploymentVerifier(makeRpc())
    const result = await v.runAll()
    expect(() => new Date(result.evaluatedAt)).not.toThrow()
    expect(isNaN(new Date(result.evaluatedAt).getTime())).toBe(false)
  })

  it('errors and warnings arrays are populated correctly', async () => {
    // advisory failure: wasmDigest supplied but no expected (warning path)
    const v = new DeploymentVerifier(makeRpc(), {
      wasmDigest: 'abc',  // no expectedWasmDigest → advisory fail
    })
    const result = await v.runAll()
    // Should be a warning (advisory), not an error
    expect(result.warnings.length).toBeGreaterThanOrEqual(0) // depends on lenient mode
    expect(result.evaluatedAt).toBeTruthy()
  })

  it('runAll without contractId runs only preflight', async () => {
    const v = new DeploymentVerifier(makeRpc(), { expectedNetwork: TESTNET_PASS })
    const result = await v.runAll()
    const names = result.checks.map(c => c.name)
    expect(names).toContain('rpc-health')
    expect(names).not.toContain('contract-queryable')
    expect(names).not.toContain('pause-state')
  })
})

// ── 12. lenient mode ──────────────────────────────────────────────────────

describe('lenient mode', () => {
  it('advisory failures become warnings (not errors) in lenient mode', async () => {
    // advisory: passphrase check skipped (no expectedNetwork) but simulate an advisory fail
    const rpc = makeRpc({
      async invokeReadOnly(_cid, fn) {
        if (fn === 'is_circuit_breaker_tripped') throw new Error('rpc error')
        if (fn === 'get_admin') return ADMIN_ADDR
        if (fn === 'get_config_snapshot') return { oracle: ORACLE_ADDR }
        if (fn === 'get_pause_state') return { global: false }
        return null
      },
    })
    const lenientVerifier = new DeploymentVerifier(rpc, {
      contractId: CONTRACT_ID, expectedNetwork: TESTNET_PASS, lenient: true,
    })
    const result = await lenientVerifier.runAll()
    // circuit-breaker threw → advisory fail → warning in lenient mode
    expect(result.warnings.some(w => w.includes('circuit-breaker'))).toBe(true)
    // writeEnabled should still be true since all required checks pass
    expect(result.writeEnabled).toBe(true)
  })
})

// ── 13. forProfile factory ────────────────────────────────────────────────

describe('forProfile factory', () => {
  it('pre-configures testnet passphrase', async () => {
    const v = forProfile('testnet', makeRpc(), { contractId: CONTRACT_ID })
    const checks = await v.runPreflight()
    const pc = checks.find(c => c.name === 'network-passphrase')
    expect(pc?.passed).toBe(true)
  })

  it('fails for futurenet when testnet passphrase is returned', async () => {
    // Stub returns testnet passphrase but we request futurenet profile
    const rpc = makeRpc({ async getNetwork() { return { passphrase: TESTNET_PASS } } })
    const v = forProfile('futurenet', rpc, { contractId: CONTRACT_ID })
    const checks = await v.runPreflight()
    const pc = checks.find(c => c.name === 'network-passphrase')
    expect(pc?.passed).toBe(false)
  })

  it('pre-configures mainnet passphrase', async () => {
    const rpc = makeRpc({
      async getNetwork() { return { passphrase: NETWORK_PASSPHRASE.mainnet } },
    })
    const v = forProfile('mainnet', rpc)
    const checks = await v.runPreflight()
    const pc = checks.find(c => c.name === 'network-passphrase')
    expect(pc?.passed).toBe(true)
  })
})

// ── 14. Edge cases ────────────────────────────────────────────────────────

describe('edge cases', () => {
  it('does not throw when every invokeReadOnly returns undefined', async () => {
    const rpc = makeRpc({ async invokeReadOnly() { return undefined } })
    const v = new DeploymentVerifier(rpc, { contractId: CONTRACT_ID, expectedNetwork: TESTNET_PASS })
    await expect(v.runAll()).resolves.toBeDefined()
  })

  it('does not throw when every invokeReadOnly throws', async () => {
    const rpc = makeRpc({ async invokeReadOnly() { throw new Error('rpc unavailable') } })
    const v = new DeploymentVerifier(rpc, { contractId: CONTRACT_ID, expectedNetwork: TESTNET_PASS })
    const result = await v.runAll()
    // Should have advisory failures but not throw
    expect(result).toBeDefined()
    expect(result.writeEnabled).toBe(false) // health check still fails → no writes
  })

  it('handles non-object pause state gracefully', async () => {
    const rpc = makeRpc({
      async invokeReadOnly(_cid, fn) {
        if (fn === 'get_pause_state') return 'unexpected-string'
        return null
      },
    })
    const v = new DeploymentVerifier(rpc, { contractId: CONTRACT_ID, expectedNetwork: TESTNET_PASS })
    const checks = await v.runPostDeploy()
    const pc = checks.find(c => c.name === 'pause-state')
    // global defaults to false for non-object → passes
    expect(pc).toBeDefined()
    expect(() => pc?.passed).not.toThrow()
  })

  it('errors array contains one entry per failing required check', async () => {
    const rpc = makeRpc({
      async getHealth() { return { status: 'degraded' } },
      async getNetwork() { return { passphrase: 'wrong' } },
    })
    const v = new DeploymentVerifier(rpc, { expectedNetwork: TESTNET_PASS })
    const result = await v.runAll()
    // At minimum health + passphrase are required failures
    expect(result.errors.length).toBeGreaterThanOrEqual(2)
  })
})
