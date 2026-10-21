import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Networks, rpc } from '@stellar/stellar-sdk';
import {
  verifyNetworkAndContractIdentity,
  checkTransactionStatus,
} from '@/lib/stellarContract';

describe('stellarContract verification and transaction status', () => {
  const txHash = 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('verifyNetworkAndContractIdentity (Issue #56)', () => {
    it('returns NETWORK_MISMATCH when wallet passphrase does not match configured passphrase', async () => {
      const result = await verifyNetworkAndContractIdentity(Networks.PUBLIC);
      expect(result.isValid).toBe(false);
      expect(result.reason).toBe('NETWORK_MISMATCH');
      expect(result.recoveryGuidance).toContain('Switch your Freighter wallet network');
    });

    it('returns RPC_MISMATCH when RPC passphrase does not match configured passphrase', async () => {
      vi.spyOn(rpc.Server.prototype, 'getNetwork').mockResolvedValueOnce({
        passphrase: 'Wrong Network Passphrase',
        protocolVersion: 20,
      });

      const result = await verifyNetworkAndContractIdentity(Networks.TESTNET);
      expect(result.isValid).toBe(false);
      expect(result.reason).toBe('RPC_MISMATCH');
      expect(result.recoveryGuidance).toContain('NEXT_PUBLIC_STELLAR_RPC_URL');
    });

    it('returns CONTRACT_NOT_FOUND when contract wasm is not found on RPC', async () => {
      vi.spyOn(rpc.Server.prototype, 'getNetwork').mockResolvedValueOnce({
        passphrase: Networks.TESTNET,
        protocolVersion: 20,
      });
      vi.spyOn(rpc.Server.prototype, 'getContractWasmByContractId').mockResolvedValueOnce(null as any);

      const result = await verifyNetworkAndContractIdentity(Networks.TESTNET);
      expect(result.isValid).toBe(false);
      expect(result.reason).toBe('CONTRACT_NOT_FOUND');
      expect(result.recoveryGuidance).toContain('Deploy the contract');
    });

    it('returns isValid: true when all checks pass', async () => {
      vi.spyOn(rpc.Server.prototype, 'getNetwork').mockResolvedValueOnce({
        passphrase: Networks.TESTNET,
        protocolVersion: 20,
      });
      vi.spyOn(rpc.Server.prototype, 'getContractWasmByContractId').mockResolvedValueOnce(
        Buffer.from('mock_wasm') as any,
      );

      const result = await verifyNetworkAndContractIdentity(Networks.TESTNET);
      expect(result.isValid).toBe(true);
      expect(result.reason).toBeUndefined();
    });
  });

  describe('checkTransactionStatus (Issue #57)', () => {
    it('returns confirmed status with ledger when transaction succeeded', async () => {
      vi.spyOn(rpc.Server.prototype, 'getTransaction').mockResolvedValueOnce({
        status: rpc.Api.GetTransactionStatus.SUCCESS,
        latestLedger: 12345,
      } as any);

      const status = await checkTransactionStatus(txHash);
      expect(status.status).toBe('confirmed');
      expect(status.hash).toBe(txHash);
      expect(status.ledger).toBe(12345);
    });

    it('returns failed status when transaction failed on-chain', async () => {
      vi.spyOn(rpc.Server.prototype, 'getTransaction').mockResolvedValueOnce({
        status: rpc.Api.GetTransactionStatus.FAILED,
        latestLedger: 12346,
      } as any);

      const status = await checkTransactionStatus(txHash);
      expect(status.status).toBe('failed');
      expect(status.hash).toBe(txHash);
    });

    it('returns not_found status when transaction is missing from ledger and mempool', async () => {
      vi.spyOn(rpc.Server.prototype, 'getTransaction').mockResolvedValueOnce({
        status: rpc.Api.GetTransactionStatus.NOT_FOUND,
      } as any);

      const status = await checkTransactionStatus(txHash);
      expect(status.status).toBe('not_found');
      expect(status.hash).toBe(txHash);
    });

    it('returns unknown status when RPC inquiry throws', async () => {
      vi.spyOn(rpc.Server.prototype, 'getTransaction').mockRejectedValueOnce(
        new Error('Network timeout'),
      );

      const status = await checkTransactionStatus(txHash);
      expect(status.status).toBe('unknown');
      expect(status.hash).toBe(txHash);
    });
  });
});
