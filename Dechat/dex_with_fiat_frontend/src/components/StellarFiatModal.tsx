'use client';

import React, { useState, useEffect, useRef } from 'react';
import {
  X,
  Loader2,
  CheckCircle,
  AlertCircle,
  ArrowDownUp,
  Download,
  WifiOff,
  AlertTriangle,
  RefreshCw,
  Clock,
  ShieldAlert,
} from 'lucide-react';
import EmptyState from '@/components/ui/EmptyState';
import CopyButton from '@/components/ui/CopyButton';
import { useStellarWallet } from '@/contexts/StellarWalletContext';
import { useUserPreferences } from '@/contexts/UserPreferencesContext';
import {
  BRIDGE_LIMIT_WARNING_PERCENT,
  CONTRACT_ID,
  depositToContract,
  withdrawFromContract,
  clearCache,
  pollTransaction,
  checkTransactionStatus,
  verifyNetworkAndContractIdentity,
  type FeeEstimate,
  type VerificationResult,
  type TxStatusResult,
} from '@/lib/stellarContract';
import { xlmToStroops, stroopsToXlm as stroopsToDisplay } from '@/lib/stroops';
import useBridgeStats from '@/hooks/useBridgeStats';
import {
  getTokenPriceWithStatus,
  formatFiatAmount,
} from '@/lib/cryptoPriceService';
import SkeletonPayout from '@/components/ui/skeleton/SkeletonPayout';
import { useNotifications } from '@/hooks/useNotifications';
import { useTxHistory } from '@/hooks/useTxHistory';
import { downloadReceipt } from '@/lib/receipt';
import type { ChatMessage } from '@/types';
import { useAccessibleModal } from '@/hooks/useAccessibleModal';
import { useIdempotentAction } from '@/hooks/useIdempotentAction';
import {
  STELLAR_FIAT_RISK_CONFIRMATION_PHRASE,
  validateStellarFiatModalForm,
} from '@/lib/stellarFiatModalSchema';

interface StellarFiatModalProps {
  isOpen: boolean;
  onClose: () => void;
  defaultAmount?: string;
  fiatCurrency?: string;
  isAdminMode?: boolean;
  recipientAddress?: string;
  onDepositSuccess?: (result: { xlmAmount: number; note?: string }) => void;
  messages?: ChatMessage[];
}

export type TxStatus =
  | 'idle'
  | 'pending'
  | 'loading'
  | 'success'
  | 'error'
  | 'timeout'
  | 'context_changed';

export const getPendingTxKey = (account?: string, network?: string) =>
  `stellar_pending_tx_${network || 'TESTNET'}_${account || 'anonymous'}`;

const SUBMIT_COOLDOWN_MS = 2000;

export interface PendingTxRecord {
  hash: string;
  amount: string;
  isAdminMode: boolean;
  recipient: string;
  idempotencyKey?: string;
  account?: string;
  network?: string;
  timestamp?: number;
}

export default function StellarFiatModal({
  isOpen,
  onClose,
  defaultAmount = '',
  fiatCurrency = 'usd',
  isAdminMode = false,
  recipientAddress = '',
  onDepositSuccess,
  messages = [],
}: StellarFiatModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  // Synchronous guard against rapid double-submits: state updates are batched,
  // so the submit button stays enabled across same-tick clicks. A ref closes
  // that window before React re-renders.
  const lastSubmitAtRef = useRef(0);
  const { connection, signTx, xlmBalance, refreshXlmBalance, contextVersion } = useStellarWallet();
  const { addNotification } = useNotifications();
  const { addEntry } = useTxHistory();
  const { highValueThreshold, twoFactorEnabled } = useUserPreferences();

  const { execute: executeTransaction, isProcessing: isTxProcessing } =
    useIdempotentAction({
      cooldownMs: SUBMIT_COOLDOWN_MS,
      logSuppressed: true,
    });

  const [amount, setAmount] = useState(defaultAmount);
  const [activePreset, setActivePreset] = useState<number | null>(null);
  const [recipient, setRecipient] = useState(recipientAddress);
  const [fiatEstimate, setFiatEstimate] = useState<string | null>(null);
  const [isFiatEstimateStale, setIsFiatEstimateStale] = useState(false);
  const [note, setNote] = useState('');
  const [riskConfirmation, setRiskConfirmation] = useState('');
  const [lastLoggedRiskAmount, setLastLoggedRiskAmount] = useState('');
  const [feeEstimate, setFeeEstimate] = useState<FeeEstimate | null>(null);
  const [requiresPreSignConfirmation, setRequiresPreSignConfirmation] =
    useState(false);
  const [isLoadingFee, setIsLoadingFee] = useState(false);
  const [isDownloadingReceipt, setIsDownloadingReceipt] = useState(false);
  const [status, setStatus] = useState<TxStatus>('idle');
  const [txHash, setTxHash] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [isLoadingUI, setIsLoadingUI] = useState(true);
  const [lastActionTimestamp, setLastActionTimestamp] = useState(0);
  const [showTwoFactorModal, setShowTwoFactorModal] = useState(false);
  const [twoFactorConfirmation, setTwoFactorConfirmation] = useState('');

  // Transaction retry and safe replacement states (Issue #57)
  const [pendingRecord, setPendingRecord] = useState<PendingTxRecord | null>(null);
  const [isCheckingStatus, setIsCheckingStatus] = useState(false);
  const [statusLookupOutcome, setStatusLookupOutcome] = useState<
    'confirmed' | 'failed' | 'not_found' | 'unknown' | null
  >(null);
  const [statusLookupMessage, setStatusLookupMessage] = useState<string>('');
  const [confirmReplacementChecked, setConfirmReplacementChecked] =
    useState(false);

  // Environment & contract verification state (Issue #56)
  const [envVerification, setEnvVerification] =
    useState<VerificationResult | null>(null);

  // Wallet context tracking & recovery state (Issue #54)
  const builtContextRef = useRef<{
    address: string;
    networkPassphrase: string;
  } | null>(null);
  const [recoverableContextMessage, setRecoverableContextMessage] = useState<
    string | null
  >(null);

  // Helpers avoid JSX branch narrowing (pending/loading render a separate view).
  const isStatusPending = (status as TxStatus) === 'pending';
  const isStatusLoading = (status as TxStatus) === 'loading';
  const isTransactionBusy = isStatusPending || isStatusLoading;

  const {
    limit: bridgeLimit,
    loading: isLoadingBridgeLimit,
    error: bridgeLimitError,
    refetchStats,
  } = useBridgeStats();

  const AMOUNT_PRESETS = [5, 10, 25, 50, 100];

  const handlePreset = (value: number) => {
    setAmount(String(value));
    setActivePreset(value);
  };
  const isMounted = useRef(true);

  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (isOpen) {
      setIsLoadingUI(true);
      const timer = setTimeout(() => setIsLoadingUI(false), 500);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    setAmount(defaultAmount);
    setRecipient(recipientAddress);
    setActivePreset(null);
    setStatus('idle');
    setTxHash('');
    setErrorMsg('');
    setFeeEstimate(null);
    setRequiresPreSignConfirmation(false);
    setNote('');
    setRiskConfirmation('');
    setLastLoggedRiskAmount('');
    setLastActionTimestamp(0);
    lastSubmitAtRef.current = 0;

    if (isAdminMode) {
      return;
    }

    let cancelled = false;
    void (async () => {
      if (!cancelled) {
        await refetchStats();
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    defaultAmount,
    isAdminMode,
    isOpen,
    recipientAddress,
    refetchStats,
    connection.network,
  ]);

  // Issue #54: Detect wallet account and network changes during signing or preparation
  useEffect(() => {
    if (!isOpen) return;

    if (builtContextRef.current) {
      const addressChanged =
        builtContextRef.current.address !== connection.address;
      const networkChanged =
        builtContextRef.current.networkPassphrase !==
        connection.networkPassphrase;
      const disconnected = !connection.isConnected;

      if (addressChanged || networkChanged || disconnected) {
        // Invalidate simulation and confirmation state immediately on context change
        setFeeEstimate(null);
        setRequiresPreSignConfirmation(false);

        if (disconnected) {
          setStatus('error');
          setErrorMsg(
            'Wallet disconnected. Please reconnect Freighter to proceed.',
          );
          setRecoverableContextMessage(null);
        } else {
          setStatus('context_changed');
          setRecoverableContextMessage(
            `Wallet context changed to account ${connection.address.slice(0, 6)}…${connection.address.slice(-4)} (${connection.network || 'TESTNET'}). Previous transaction context has been invalidated. Please confirm to rebuild for the new context.`,
          );
        }
      }
    }

    builtContextRef.current = connection.isConnected
      ? {
          address: connection.address,
          networkPassphrase: connection.networkPassphrase,
        }
      : null;
  }, [
    connection.address,
    connection.networkPassphrase,
    connection.isConnected,
    connection.network,
    isOpen,
  ]);

  // Issue #56: Verify chain identity and contract metadata
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    verifyNetworkAndContractIdentity(connection.networkPassphrase)
      .then((res) => {
        if (!cancelled) setEnvVerification(res);
      })
      .catch(() => {
        if (!cancelled) {
          setEnvVerification({
            isValid: false,
            reason: 'RPC_UNAVAILABLE',
            message:
              'Failed to verify chain and contract identity with Soroban RPC.',
            recoveryGuidance: 'Check network connectivity to Soroban RPC.',
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, connection.networkPassphrase]);

  // Issue #57 & #58: Scoped pending transaction recovery and safe status check
  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const pendingKey = getPendingTxKey(connection.publicKey, connection.network);
    const stored =
      localStorage.getItem(pendingKey) ||
      localStorage.getItem('stellar_pending_tx');
    if (!stored) {
      setPendingRecord(null);
      return;
    }

    let pending: PendingTxRecord;
    try {
      pending = JSON.parse(stored) as PendingTxRecord;
    } catch {
      localStorage.removeItem(pendingKey);
      localStorage.removeItem('stellar_pending_tx');
      setPendingRecord(null);
      return;
    }

    // Issue #58: Quarantine pending UI actions that belong to previous account
    if (
      pending.account &&
      connection.publicKey &&
      pending.account !== connection.publicKey
    ) {
      return;
    }

    setPendingRecord(pending);
    setAmount(pending.amount);
    setRecipient(pending.recipient);
    setStatus('loading');
    setErrorMsg('');
    setTxHash('');

    let cancelled = false;
    pollTransaction(pending.hash)
      .then(async (hash) => {
        if (cancelled) return;
        setTxHash(hash);
        setStatus('success');
        localStorage.removeItem(pendingKey);
        localStorage.removeItem('stellar_pending_tx');
        setPendingRecord(null);
        await refreshXlmBalance();
      })
      .catch(async (err) => {
        if (cancelled) return;
        // Check authoritative status before offering retry
        try {
          const statusResult = await checkTransactionStatus(pending.hash);
          if (cancelled) return;
          if (statusResult.status === 'confirmed') {
            setTxHash(pending.hash);
            setStatus('success');
            localStorage.removeItem(pendingKey);
            localStorage.removeItem('stellar_pending_tx');
            setPendingRecord(null);
            await refreshXlmBalance();
            return;
          }
          if (statusResult.status === 'failed') {
            setStatus('timeout');
            setStatusLookupOutcome('failed');
            setStatusLookupMessage(
              'Transaction failed on-chain. It is safe to submit a new transaction.',
            );
            setErrorMsg('Transaction failed on-chain.');
            return;
          }
        } catch {
          // ignore lookup error and proceed to timeout state
        }
        setStatus('timeout');
        setStatusLookupOutcome('unknown');
        setStatusLookupMessage(
          'Authoritative status remains unavailable on the network.',
        );
        setErrorMsg(
          err instanceof Error
            ? err.message
            : 'Transaction confirmation timed out waiting for network confirmation.',
        );
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen, refreshXlmBalance, connection.publicKey, connection.network]);

  useEffect(() => {
    if (!isOpen || !connection.isConnected) {
      setFeeEstimate(null);
      return;
    }

    const currentStroops = xlmToStroops(amount);
    if (!currentStroops || currentStroops <= BigInt(0)) {
      setFeeEstimate(null);
      return;
    }

    let cancelled = false;
    const abortController = new AbortController();
    setIsLoadingFee(true);

    const timer = setTimeout(async () => {
      try {
        let estimate: FeeEstimate | null = null;
        if (isAdminMode) {
          const to = recipient || connection.publicKey;
          const { simulateWithdraw } = await import('@/lib/stellarContract');
          estimate = await simulateWithdraw(
            connection.publicKey,
            to,
            currentStroops,
          );
        } else {
          const { simulateDeposit } = await import('@/lib/stellarContract');
          estimate = await simulateDeposit(
            connection.publicKey,
            currentStroops,
          );
        }
        if (!cancelled) {
          setFeeEstimate(estimate);
        }
      } catch {
        if (!cancelled) {
          setFeeEstimate(null);
        }
      } finally {
        if (!cancelled) {
          setIsLoadingFee(false);
        }
      }
    }, 300);

    return () => {
      cancelled = true;
      abortController.abort();
      clearTimeout(timer);
    };
  }, [
    amount,
    connection.isConnected,
    connection.publicKey,
    isAdminMode,
    isOpen,
    recipient,
  ]);

  useEffect(() => {
    const xlm = parseFloat(amount);
    if (!xlm || xlm <= 0) {
      setFiatEstimate(null);
      setIsFiatEstimateStale(false);
      return;
    }

    let cancelled = false;

    const fetchEstimate = async () => {
      try {
        const quote = await getTokenPriceWithStatus('XLM', fiatCurrency);
        if (!cancelled) {
          setFiatEstimate(
            formatFiatAmount(xlm * quote.price, fiatCurrency),
          );
          setIsFiatEstimateStale(quote.stale);
        }
      } catch {
        if (!cancelled) {
          setFiatEstimate(null);
          setIsFiatEstimateStale(false);
        }
      }
    };

    void fetchEstimate();

    return () => {
      cancelled = true;
    };
  }, [amount, fiatCurrency]);

  const numericAmount = Number.parseFloat(amount);
  const isAmountInvalid = !Number.isFinite(numericAmount) || numericAmount <= 0;
  const stroopsAmount = !isAmountInvalid ? xlmToStroops(amount) : null;
  const hasValidAmount = stroopsAmount !== null && stroopsAmount > BigInt(0);
  const isRiskyAmount =
    twoFactorEnabled &&
    Number.isFinite(numericAmount) &&
    numericAmount >= highValueThreshold;
  const isDepositFlow = !isAdminMode;
  const isLimitUnavailable =
    isDepositFlow &&
    !isLoadingBridgeLimit &&
    (bridgeLimit === null || !!bridgeLimitError);
  const isOverLimit =
    isDepositFlow &&
    bridgeLimit !== null &&
    hasValidAmount &&
    stroopsAmount !== null &&
    stroopsAmount > bridgeLimit;
  const usagePercent =
    isDepositFlow &&
      bridgeLimit !== null &&
      bridgeLimit > BigInt(0) &&
      stroopsAmount !== null
      ? Number((stroopsAmount * 10_000n) / bridgeLimit) / 100
      : 0;
  const isHighLimitUsage =
    isDepositFlow &&
    !isOverLimit &&
    hasValidAmount &&
    usagePercent >= BRIDGE_LIMIT_WARNING_PERCENT;
  const remainingLimit =
    isDepositFlow &&
      bridgeLimit !== null &&
      stroopsAmount !== null &&
      bridgeLimit > stroopsAmount
      ? bridgeLimit - stroopsAmount
      : BigInt(0);
  const isSubmitDisabled =
    isStatusLoading ||
    isStatusPending ||
    !connection.isConnected ||
    isAmountInvalid ||
    (isDepositFlow &&
      (isLoadingBridgeLimit || isLimitUnavailable || isOverLimit)) ||
    (isRiskyAmount &&
      riskConfirmation.trim().toUpperCase() !==
      STELLAR_FIAT_RISK_CONFIRMATION_PHRASE) ||
    Date.now() - lastActionTimestamp < SUBMIT_COOLDOWN_MS ||
    (envVerification !== null && !envVerification.isValid);

  const operationType = isAdminMode ? 'Withdraw' : 'Deposit';
  const txNetwork = connection.network || 'TESTNET';

  useAccessibleModal(isOpen, modalRef, onClose);

  useEffect(() => {
    if (
      !isOpen ||
      !isRiskyAmount ||
      !hasValidAmount ||
      amount === lastLoggedRiskAmount
    ) {
      return;
    }

    addEntry({
      kind: 'risk_warning',
      status: 'warning',
      amount,
      asset: 'XLM',
      note: note.trim() || undefined,
      message: `Large deposit warning shown for ${amount} XLM`,
    });
    addNotification(
      'risk_warning',
      `Large amount warning: ${amount} XLM requires typed confirmation.`,
    );
    setLastLoggedRiskAmount(amount);
  }, [
    addEntry,
    addNotification,
    amount,
    hasValidAmount,
    isOpen,
    isRiskyAmount,
    lastLoggedRiskAmount,
    note,
  ]);

  if (!isOpen) return null;

  const handleRetryStatusLookup = async () => {
    if (!pendingRecord?.hash) return;
    setIsCheckingStatus(true);
    setStatusLookupMessage('');
    try {
      const result = await checkTransactionStatus(pendingRecord.hash);
      setStatusLookupOutcome(result.status);
      if (result.status === 'confirmed') {
        setStatusLookupMessage('Transaction has been confirmed on-chain!');
        setTxHash(pendingRecord.hash);
        setStatus('success');
        const pendingKey = getPendingTxKey(connection.publicKey, connection.network);
        localStorage.removeItem(pendingKey);
        localStorage.removeItem('stellar_pending_tx');
        setPendingRecord(null);
        await refreshXlmBalance();
      } else if (result.status === 'failed') {
        setStatusLookupMessage(
          'Transaction failed on-chain. It is safe to submit a new transaction.',
        );
      } else if (result.status === 'not_found') {
        setStatusLookupMessage(
          'Transaction was not found in ledger or mempool. Please wait or confirm replacement.',
        );
      } else {
        setStatusLookupMessage(
          'Authoritative status remains unavailable on the network.',
        );
      }
    } catch (err) {
      setStatusLookupOutcome('unknown');
      setStatusLookupMessage(
        err instanceof Error ? err.message : 'Failed to query transaction status.',
      );
    } finally {
      setIsCheckingStatus(false);
    }
  };

  const handleConfirmReplacement = () => {
    const pendingKey = getPendingTxKey(connection.publicKey, connection.network);
    localStorage.removeItem(pendingKey);
    localStorage.removeItem('stellar_pending_tx');
    setPendingRecord(null);
    setConfirmReplacementChecked(false);
    setStatusLookupOutcome(null);
    setStatusLookupMessage('');
    setStatus('idle');
    setErrorMsg('');
  };

  const handleConfirmNewContext = () => {
    setStatus('idle');
    setErrorMsg('');
    setRecoverableContextMessage(null);
    setFeeEstimate(null);
    builtContextRef.current = connection.isConnected
      ? {
          address: connection.address,
          networkPassphrase: connection.networkPassphrase,
        }
      : null;
  };

  const handleAction = async () => {
    if (!connection.isConnected) return;

    if (envVerification !== null && !envVerification.isValid) {
      setErrorMsg(
        envVerification.message ||
          'Cannot execute transaction: Network or contract identity mismatch.',
      );
      setStatus('error');
      return;
    }

    // Show two-factor confirmation modal for high-value transfers
    if (isRiskyAmount && twoFactorEnabled && !showTwoFactorModal) {
      setShowTwoFactorModal(true);
      return;
    }

    const zodMessage = validateStellarFiatModalForm({
      isAdminMode,
      amount,
      recipient,
      note,
      riskConfirmation,
      isRiskyAmount,
      twoFactorConfirmation: showTwoFactorModal ? twoFactorConfirmation : undefined,
    });
    if (zodMessage) {
      setErrorMsg(zodMessage);
      setStatus('error');
      return;
    }

    if (
      isAmountInvalid ||
      !amount ||
      stroopsAmount === null ||
      stroopsAmount <= BigInt(0)
    ) {
      setErrorMsg('Invalid amount. Please enter a positive number.');
      setStatus('error');
      return;
    }
    if (isDepositFlow && isLoadingBridgeLimit) {
      setErrorMsg(
        'Still loading the current bridge limit. Please wait a moment.',
      );
      setStatus('error');
      return;
    }
    if (isDepositFlow && (bridgeLimit === null || bridgeLimitError)) {
      setErrorMsg(
        bridgeLimitError ||
        'Unable to validate against the current bridge limit. Please try again.',
      );
      setStatus('error');
      return;
    }
    if (isDepositFlow && bridgeLimit !== null && stroopsAmount > bridgeLimit) {
      setErrorMsg(
        `Requested amount exceeds the current bridge limit of ${stroopsToDisplay(bridgeLimit ?? BigInt(0))} XLM.`,
      );
      setStatus('error');
      return;
    }

    if (status === 'loading' || isTxProcessing) {
      return;
    }

    const now = Date.now();
    if (now - lastSubmitAtRef.current < SUBMIT_COOLDOWN_MS) {
      return;
    }
    lastSubmitAtRef.current = now;
    setLastActionTimestamp(now);

    setStatus('pending');
    setErrorMsg('');

    await executeTransaction(
      async (generatedIdempotencyKey) => {
        setStatus('loading');
        setErrorMsg('');

        console.log(
          `[StellarFiatModal] Initiating ${isAdminMode ? 'withdraw' : 'deposit'} with idempotencyKey: ${generatedIdempotencyKey}`,
        );

        const pendingKey = getPendingTxKey(connection.publicKey, connection.network);
        let capturedHash: string | null = null;
        const onHashKnown = (hash: string) => {
          capturedHash = hash;
          const rec: PendingTxRecord = {
            hash,
            amount,
            isAdminMode,
            recipient,
            account: connection.publicKey,
            network: connection.network,
            idempotencyKey: generatedIdempotencyKey,
          };
          setPendingRecord(rec);
          localStorage.setItem(pendingKey, JSON.stringify(rec));
          localStorage.setItem('stellar_pending_tx', JSON.stringify(rec));
        };

        const signTxWithContext = (xdr: string) =>
          signTx(xdr, {
            address: connection.publicKey,
            networkPassphrase: connection.networkPassphrase,
          });

        try {
          addNotification(
            'tx_submit',
            `Submitting ${isAdminMode ? 'withdrawal' : 'deposit'} transaction...`,
          );
          let hash: string;
          if (isAdminMode) {
            const to = recipient || connection.publicKey;
            hash = await withdrawFromContract(
              connection.publicKey,
              to,
              stroopsAmount,
              signTxWithContext,
              onHashKnown,
            );
          } else {
            hash = await depositToContract(
              connection.publicKey,
              stroopsAmount,
              signTxWithContext,
              onHashKnown,
            );
          }

          setTxHash(hash);
          setStatus('success');
          clearCache();
          localStorage.removeItem(pendingKey);
          localStorage.removeItem('stellar_pending_tx');
          setPendingRecord(null);
          // Refresh wallet balance after successful transaction
          await refreshXlmBalance();
          addNotification(
            'tx_confirm',
            `Transaction confirmed successfully! (${hash.slice(0, 8)}...)`,
          );
          addEntry({
            kind: isAdminMode ? 'payout' : 'deposit',
            status: 'completed',
            amount,
            asset: 'XLM',
            note: note.trim() || undefined,
            txHash: hash,
            message: `${isAdminMode ? 'Withdrawal' : 'Deposit'} confirmed on Stellar.`,
          });
          try {
            await refetchStats();
          } catch {
            // ignore refresh failures after a confirmed transaction
          }
          if (!isAdminMode && onDepositSuccess) {
            onDepositSuccess({
              xlmAmount: parseFloat(amount || '0'),
              note: note.trim() || undefined,
            });
          }
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);

          if (errMsg.includes('WALLET_CONTEXT_CHANGED')) {
            setStatus('context_changed');
            setRecoverableContextMessage(
              'Wallet account or network changed during transaction signing. Transaction context has been invalidated. Please confirm to rebuild.',
            );
            if (!capturedHash) {
              localStorage.removeItem(pendingKey);
              localStorage.removeItem('stellar_pending_tx');
              setPendingRecord(null);
            }
            return;
          }

          if (
            errMsg.toLowerCase().includes('timed out') ||
            (capturedHash && !errMsg.includes('Submission failed'))
          ) {
            setStatus('timeout');
            setErrorMsg(errMsg);
            setStatusLookupOutcome('unknown');
            setStatusLookupMessage(
              'Confirmation timed out. Query authoritative status before attempting replacement.',
            );
            return;
          }

          setErrorMsg(errMsg || 'Transaction failed');
          setStatus('error');
          localStorage.removeItem(pendingKey);
          localStorage.removeItem('stellar_pending_tx');
          setPendingRecord(null);
        }
      },
      `stellar_${isAdminMode ? 'withdraw' : 'deposit'}`,
    );
  };

  const handleClose = () => {
    setStatus('idle');
    setTxHash('');
    setErrorMsg('');
    setRequiresPreSignConfirmation(false);
    onClose();
  };

  return (
    <div className="theme-overlay fixed inset-0 z-50 flex items-center justify-center backdrop-blur-sm">
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-label={isAdminMode ? 'Withdraw from Bridge' : 'Deposit to Bridge'}
        tabIndex={-1}
        className="theme-surface theme-border relative w-full max-w-md mx-4 border rounded-2xl shadow-2xl p-6"
      >
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-2">
            <ArrowDownUp className="w-5 h-5 text-blue-400" />
            <h2 className="theme-text-primary text-lg font-semibold">
              {isAdminMode ? 'Withdraw from Bridge' : 'Deposit to Bridge'}
            </h2>
          </div>
          <button
            onClick={handleClose}
            aria-label="Close"
            className="theme-text-muted hover:theme-text-primary transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {status === 'success' ? (
          <div data-testid="success-message" className="text-center py-6">
            <CheckCircle className="w-14 h-14 text-green-400 mx-auto mb-4" />
            <p className="theme-text-primary font-semibold text-lg mb-2">
              Transaction Confirmed!
            </p>
            <p className="theme-text-secondary text-sm mb-4">
              {isAdminMode ? 'Withdrawal' : 'Deposit'} of{' '}
              <span className="theme-text-primary font-medium">
                {stroopsToDisplay(stroopsAmount ?? BigInt(0))} XLM
              </span>{' '}
              processed successfully.
            </p>
            {note && (
              <p className="theme-text-secondary text-xs mb-4">
                Note: <span className="theme-text-primary">{note}</span>
              </p>
            )}
            <div className="flex items-center justify-center gap-2 mt-1">
              <a
                href={`https://stellar.expert/explorer/testnet/tx/${txHash}`}
                target="_blank"
                rel="noreferrer"
                className="text-blue-400 hover:underline text-xs break-all"
              >
                {txHash}
              </a>
              <CopyButton value={txHash} />
            </div>

            <button
              type="button"
              data-testid="download-receipt-button"
              onClick={async () => {
                setIsDownloadingReceipt(true);
                try {
                  await downloadReceipt({
                    txHash,
                    amount: stroopsToDisplay(stroopsAmount ?? BigInt(0)),
                    wallet: connection.publicKey,
                    network: connection.network || 'TESTNET',
                    timestamp: new Date().toLocaleString(),
                    type: isAdminMode ? 'Withdrawal' : 'Deposit',
                    note: note.trim() || undefined,
                    messages,
                  });
                } finally {
                  setIsDownloadingReceipt(false);
                }
              }}
              disabled={isDownloadingReceipt}
              className="mt-4 w-full flex items-center justify-center gap-2 py-2.5 rounded-lg border border-blue-500/30 text-blue-400 hover:bg-blue-500/10 transition-colors text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Download className="w-4 h-4" />
              {isDownloadingReceipt ? 'Generating...' : 'Download Receipt'}
            </button>

            {!isAdminMode && onDepositSuccess ? (
              <button
                onClick={() =>
                  onDepositSuccess({
                    xlmAmount: parseFloat(amount || '0'),
                    note: note.trim() || undefined,
                  })
                }
                className="theme-primary-button mt-6 w-full py-3 rounded-lg font-medium transition-colors"
              >
                Continue to Fiat Payout
              </button>
            ) : (
              <button
                onClick={handleClose}
                className="theme-primary-button mt-6 w-full py-3 rounded-lg font-medium transition-colors"
              >
                Close
              </button>
            )}
          </div>
        ) : status === 'timeout' ? (
          <div data-testid="timeout-view" className="py-4">
            <div className="flex items-center gap-3 mb-4 text-amber-400">
              <AlertTriangle className="w-8 h-8 flex-shrink-0" />
              <div>
                <h3 className="font-semibold text-base theme-text-primary">
                  Transaction Timeout / In-Doubt
                </h3>
                <p className="theme-text-secondary text-xs">
                  Confirmation timed out on the network.
                </p>
              </div>
            </div>

            {pendingRecord?.hash && (
              <div className="theme-surface-muted theme-border rounded-lg border p-3 mb-4 text-xs font-mono break-all">
                <span className="theme-text-muted block text-[10px] font-sans font-semibold uppercase tracking-wider mb-1">
                  Transaction Reference
                </span>
                <span className="theme-text-primary">{pendingRecord.hash}</span>
                <div className="mt-1">
                  <CopyButton value={pendingRecord.hash} />
                </div>
              </div>
            )}

            <div className="mb-4">
              <button
                type="button"
                data-testid="check-status-button"
                onClick={() => void handleRetryStatusLookup()}
                disabled={isCheckingStatus}
                className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg border border-blue-500/40 text-blue-400 hover:bg-blue-500/10 transition-colors text-xs font-semibold disabled:opacity-50"
              >
                {isCheckingStatus ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Querying network...
                  </>
                ) : (
                  'Query Authoritative Status'
                )}
              </button>

              {statusLookupMessage && (
                <div
                  data-testid="status-outcome"
                  className={`mt-2 p-2.5 rounded-lg border text-xs ${
                    statusLookupOutcome === 'confirmed'
                      ? 'theme-soft-success border-green-500/40'
                      : statusLookupOutcome === 'failed'
                        ? 'theme-soft-danger border-red-500/40'
                        : 'theme-soft-warning border-amber-500/40'
                  }`}
                >
                  <p className="font-medium">
                    Status:{' '}
                    <span className="capitalize">{statusLookupOutcome ?? 'Unknown'}</span>
                  </p>
                  <p className="mt-0.5">{statusLookupMessage}</p>
                </div>
              )}
            </div>

            <div
              data-testid="duplicate-risk-warning"
              className="theme-soft-warning border border-amber-500/30 rounded-lg p-3 mb-4 text-xs"
            >
              <div className="flex items-center gap-2 font-semibold text-amber-300 mb-1">
                <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                <span>Duplicate Risk Notice</span>
              </div>
              <p className="text-amber-200/90 leading-relaxed">
                If the previous transaction was accepted by validators, submitting a replacement transaction could execute twice, causing duplicate funds to be transferred.
              </p>
              {statusLookupOutcome !== 'failed' && (
                <label className="flex items-start gap-2.5 mt-3 pt-2 border-t border-amber-500/20 cursor-pointer">
                  <input
                    type="checkbox"
                    data-testid="duplicate-risk-checkbox"
                    checked={confirmReplacementChecked}
                    onChange={(e) => setConfirmReplacementChecked(e.target.checked)}
                    className="mt-0.5 rounded border-gray-600 text-blue-600 focus:ring-blue-500"
                  />
                  <span className="text-amber-200 text-[11px] font-medium leading-tight">
                    I understand the risk of duplicate transaction execution and want to proceed with replacement.
                  </span>
                </label>
              )}
            </div>

            <div className="flex flex-col gap-2">
              <button
                type="button"
                data-testid="confirm-replacement-button"
                onClick={handleConfirmReplacement}
                disabled={statusLookupOutcome !== 'failed' && !confirmReplacementChecked}
                className="theme-primary-button w-full py-2.5 rounded-lg text-xs font-semibold disabled:opacity-50 disabled:cursor-not-allowed transition-all"
              >
                Abandon & Submit Replacement
              </button>
              <button
                type="button"
                onClick={handleClose}
                className="w-full py-2 text-xs theme-text-muted hover:theme-text-primary transition-colors text-center"
              >
                Close & Check Later
              </button>
            </div>
          </div>
        ) : status === 'context_changed' ? (
          <div data-testid="context-changed-view" className="text-center py-6">
            <AlertTriangle className="w-14 h-14 text-amber-400 mx-auto mb-4" />
            <p className="theme-text-primary font-semibold text-lg mb-2">
              Wallet Context Changed
            </p>
            <p
              data-testid="recoverable-context-message"
              className="theme-text-secondary text-xs mb-6 px-4 leading-relaxed"
            >
              {recoverableContextMessage ||
                'Freighter wallet account or network changed during transaction processing. Simulation and confirmation state have been invalidated to protect your account.'}
            </p>
            <button
              type="button"
              data-testid="confirm-rebuild-button"
              onClick={handleConfirmNewContext}
              className="theme-primary-button w-full py-3 rounded-lg font-medium transition-colors text-sm mb-2"
            >
              Confirm & Rebuild for Current Context
            </button>
            <button
              type="button"
              onClick={handleClose}
              className="w-full py-2 text-xs theme-text-muted hover:theme-text-primary transition-colors"
            >
              Cancel
            </button>
          </div>
        ) : isTransactionBusy ? (
          <div className="text-center py-6">
            <Loader2 className="w-14 h-14 text-blue-400 mx-auto mb-4 animate-spin" />
            <p className="text-white font-semibold text-lg mb-2">
              {isAdminMode ? 'Withdrawal pending…' : 'Deposit pending…'}
            </p>
            <p className="text-gray-400 text-sm mb-4">
              {isAdminMode
                ? 'Your withdrawal is being submitted to the Stellar bridge.'
                : 'Your deposit is being submitted to the Stellar bridge.'}
            </p>
            <p className="text-gray-500 text-xs">
              {stroopsToDisplay(stroopsAmount ?? BigInt(0))} XLM is being processed. You will see confirmation once the transaction completes.
            </p>
          </div>
        ) : isLoadingUI ? (
          <SkeletonPayout />
        ) : (
          <>
            {envVerification && !envVerification.isValid && (
              <div
                data-testid="env-mismatch-banner"
                className="theme-soft-danger border border-red-500/40 rounded-xl p-3.5 mb-4 text-xs"
              >
                <div className="flex items-center gap-2 font-semibold text-red-300 mb-1">
                  <AlertCircle className="w-4 h-4 flex-shrink-0" />
                  <span>Network / Contract Identity Mismatch</span>
                </div>
                <p className="text-red-200 leading-relaxed">
                  {envVerification.message}
                </p>
                {envVerification.recoveryGuidance && (
                  <p className="text-red-300/80 mt-1.5 pt-1.5 border-t border-red-500/20 text-[11px]">
                    <span className="font-semibold">Recovery Guidance:</span>{' '}
                    {envVerification.recoveryGuidance}
                  </p>
                )}
              </div>
            )}

            <div className="mb-4">
              <label className="theme-text-secondary block text-sm mb-1">
                Amount (XLM)
              </label>
              <div className="flex gap-2 mb-2">
                {AMOUNT_PRESETS.map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => handlePreset(preset)}
                    disabled={isTransactionBusy}
                    className={`flex-1 py-1.5 rounded-md text-xs font-medium border transition-colors ${activePreset === preset
                      ? 'bg-blue-600 border-blue-500 text-white'
                      : 'bg-gray-800 border-gray-600 text-gray-300 hover:border-blue-500 hover:text-white'
                      } ${isTransactionBusy ? 'opacity-60 cursor-not-allowed' : ''}`}
                  >
                    {preset}
                  </button>
                ))}
              </div>
              <input
                type="number"
                min="0"
                step="0.0000001"
                value={amount}
                onChange={(e) => {
                  setAmount(e.target.value);
                  setActivePreset(null);
                }}
                placeholder="0.00"
                disabled={isTransactionBusy}
                aria-invalid={isAmountInvalid || isOverLimit ? true : undefined}
                className={`w-full bg-gray-800 border rounded-lg px-4 py-3 text-white placeholder-gray-500 focus:outline-none disabled:opacity-60 disabled:cursor-not-allowed ${isAmountInvalid || isOverLimit
                  ? 'border-red-500 focus:border-red-400'
                  : 'border-gray-600 focus:border-blue-500'
                  }`}
              />
              {isAmountInvalid && amount && (
                <p className="theme-soft-danger flex items-center gap-2 rounded-lg px-3 py-2 mt-2 text-xs">
                  <AlertCircle className="w-3 h-3 flex-shrink-0" />
                  Invalid amount. Please enter a positive number.
                </p>
              )}
              {connection.isConnected && (
                <p className="theme-text-secondary text-xs mt-2">
                  Available:{' '}
                  <span className="theme-text-primary font-medium">
                    {xlmBalance ? `${xlmBalance} XLM` : 'Loading...'}
                  </span>
                </p>
              )}
            </div>

            {fiatEstimate && (
              <p className="theme-text-secondary text-xs -mt-2 mb-4">
                ~={' '}
                <span className="theme-text-primary font-medium">
                  {fiatEstimate}
                </span>{' '}
                at current market rate
              </p>
            )}
              {isFiatEstimateStale && (
                <p role="status" className="text-amber-400 text-xs -mt-2 mb-4">
                  Estimated rate: live market prices are unavailable.
                </p>
              )}

            <div className="mb-4">
              <label className="theme-text-secondary block text-sm mb-1">
                Optional note
              </label>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder={
                  isAdminMode
                    ? 'Add a label for this withdrawal'
                    : 'Add a note for this deposit'
                }
                rows={2}
                maxLength={160}
                className="theme-input w-full border rounded-lg px-4 py-3 text-sm focus:outline-none focus:border-blue-500 resize-none"
              />
            </div>

            {(isLoadingFee || feeEstimate) && (
              <div className="theme-surface-muted theme-border mb-4 rounded-xl border p-4">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="theme-text-muted text-[10px] font-bold uppercase tracking-widest">
                    Simulation Results
                  </h3>
                  {isLoadingFee && (
                    <Loader2 className="w-3 h-3 text-blue-500 animate-spin" />
                  )}
                </div>

                <div className="space-y-2">
                  <div className="flex justify-between text-[11px]">
                    <span className="theme-text-muted">Base Fee</span>
                    <span className="theme-text-secondary font-mono">
                      {isLoadingFee
                        ? '...'
                        : feeEstimate
                          ? `${feeEstimate.baseFee.toFixed(7)} XLM`
                          : '0.0000100 XLM'}
                    </span>
                  </div>
                  <div className="flex justify-between text-[11px]">
                    <span className="theme-text-muted">Resource Fee</span>
                    <span className="theme-text-secondary font-mono">
                      {isLoadingFee
                        ? '...'
                        : feeEstimate
                          ? `${feeEstimate.resourceFee.toFixed(7)} XLM`
                          : '0.0000000 XLM'}
                    </span>
                  </div>
                  <div className="theme-border pt-2 mt-1 border-t flex justify-between text-xs font-semibold">
                    <span className="theme-text-secondary">
                      Total Network Fee
                    </span>
                    <span className="text-blue-400 font-mono">
                      {isLoadingFee
                        ? 'Calculating...'
                        : feeEstimate
                          ? `${feeEstimate.fee.toFixed(7)} XLM`
                          : 'N/A'}
                    </span>
                  </div>
                </div>
              </div>
            )}

            {requiresPreSignConfirmation && !isStatusLoading && (
              <div className="theme-surface-muted theme-border mb-4 rounded-xl border px-4 py-3">
                <h3 className="theme-text-muted text-[10px] font-bold uppercase tracking-widest mb-3">
                  Pre-Sign Transaction Summary
                </h3>
                <div className="space-y-2 text-xs">
                  <div className="flex items-center justify-between">
                    <span className="theme-text-secondary">Operation</span>
                    <span className="theme-text-primary font-medium">
                      {operationType}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="theme-text-secondary">Amount</span>
                    <span className="theme-text-primary font-medium">
                      {stroopsToDisplay(stroopsAmount ?? BigInt(0))} XLM
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="theme-text-secondary">Network</span>
                    <span className="theme-text-primary font-medium">
                      {txNetwork}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="theme-text-secondary">Contract</span>
                    <span className="theme-text-primary font-mono text-[10px] break-all text-right">
                      {CONTRACT_ID}
                    </span>
                  </div>
                </div>
                <div className="flex gap-2 mt-4">
                  <button
                    type="button"
                    onClick={() => setRequiresPreSignConfirmation(false)}
                    className="theme-border theme-text-secondary flex-1 rounded-lg border py-2 text-xs font-medium hover:theme-text-primary transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleAction()}
                    className="theme-primary-button flex-1 rounded-lg py-2 text-xs font-semibold"
                  >
                    Confirm & Sign
                  </button>
                </div>
              </div>
            )}

            {isDepositFlow && (
              <div className="theme-surface-muted theme-border mb-4 rounded-xl border px-4 py-3">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="theme-text-muted text-[10px] font-bold uppercase tracking-widest">
                    Bridge Capacity
                  </h3>
                  <div
                    className={`w-2 h-2 rounded-full ${isOverLimit
                      ? 'bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.5)]'
                      : isHighLimitUsage
                        ? 'bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.5)]'
                        : 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.5)]'
                      }`}
                  />
                </div>

                {isLimitUnavailable ? (
                  <EmptyState
                    icon={WifiOff}
                    title="Bridge data unavailable"
                    description={
                      bridgeLimitError ??
                      'Could not fetch the current bridge limit. Please retry.'
                    }
                    cta={{ label: 'Retry', onClick: () => void refetchStats() }}
                    className="py-2"
                  />
                ) : (
                  <>
                    <div className="flex items-center justify-between text-xs mb-2">
                      <span className="theme-text-secondary">
                        On-chain per-deposit limit
                      </span>
                      <span className="theme-text-primary font-mono">
                        {isLoadingBridgeLimit
                          ? 'Loading...'
                          : bridgeLimit !== null
                            ? `${stroopsToDisplay(bridgeLimit ?? BigInt(0))} XLM`
                            : 'Unavailable'}
                      </span>
                    </div>

                    <div className="h-1.5 w-full rounded-full bg-[var(--color-surface-elevated)] overflow-hidden mb-2">
                      <div
                        className={`h-full rounded-full transition-all duration-500 ${isOverLimit
                          ? 'bg-red-500'
                          : isHighLimitUsage
                            ? 'bg-amber-400'
                            : 'bg-blue-500'
                          }`}
                        style={{ width: `${Math.min(usagePercent, 100)}%` }}
                      />
                    </div>

                    <div className="theme-text-muted flex items-center justify-between text-[10px]">
                      <span>
                        {hasValidAmount && bridgeLimit !== null
                          ? `${usagePercent.toFixed(1)}% used`
                          : 'Limit utilized per transaction'}
                      </span>
                      <span>
                        {hasValidAmount && bridgeLimit !== null
                          ? `${stroopsToDisplay(remainingLimit ?? BigInt(0))} XLM available`
                          : ''}
                      </span>
                    </div>

                    {isOverLimit &&
                      bridgeLimit !== null &&
                      stroopsAmount !== null && (
                        <div className="theme-soft-danger mt-3 rounded-lg border px-3 py-2 text-[11px] leading-tight">
                          Error: Amount exceeds the current bridge limit.
                        </div>
                      )}
                  </>
                )}
              </div>
            )}

            {isRiskyAmount && (
              <div className="theme-soft-warning mb-4 rounded-xl border px-4 py-3">
                <p className="font-semibold text-sm mb-2">
                  Large amount confirmation required
                </p>
                <p className="text-xs mb-3">
                  Amounts above {highValueThreshold} XLM require an
                  additional confirmation phrase before submission.
                </p>
                <input
                  type="text"
                  value={riskConfirmation}
                  onChange={(e) => setRiskConfirmation(e.target.value)}
                  placeholder={STELLAR_FIAT_RISK_CONFIRMATION_PHRASE}
                  className="theme-input w-full border rounded-lg px-4 py-3 text-sm focus:outline-none focus:border-blue-500"
                />
              </div>
            )}

            {isAdminMode && (
              <div className="mb-4">
                <label className="theme-text-secondary block text-sm mb-1">
                  Recipient address (leave blank for self)
                </label>
                <input
                  type="text"
                  value={recipient}
                  onChange={(e) => setRecipient(e.target.value)}
                  placeholder="G..."
                  disabled={isTransactionBusy}
                  className="w-full bg-gray-800 border border-gray-600 rounded-lg px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 disabled:opacity-60 disabled:cursor-not-allowed font-mono text-sm"
                />
              </div>
            )}

            <div
              data-testid="wallet-info"
              className="theme-text-muted flex justify-between text-xs mb-6"
            >
              <span className="flex items-center gap-1">
                <span>
                  Connected: {connection.address.slice(0, 8)}…
                  {connection.address.slice(-4)}
                </span>
                <CopyButton value={connection.address} iconClassName="w-3 h-3" />
              </span>
              <span>Network: {connection.network || 'TESTNET'}</span>
            </div>

            {status === 'error' && (
              <div
                data-testid="error-message"
                className="theme-soft-danger flex items-center gap-2 border rounded-lg px-3 py-2 mb-4 text-sm"
              >
                <AlertCircle className="w-4 h-4 flex-shrink-0" />
                <span>{errorMsg}</span>
              </div>
            )}

            <div className="flex flex-col gap-2">
              <button
                onClick={handleAction}
                disabled={isSubmitDisabled || isTxProcessing}
                className="theme-primary-button w-full flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed text-white py-3 rounded-lg font-semibold transition-all"
              >
                {isStatusLoading || isTxProcessing ? (
                  <>
                    <Loader2
                      data-testid="loading-spinner"
                      className="w-4 h-4 animate-spin"
                    />
                    Signing & submitting…
                  </>
                ) : isAdminMode ? (
                  'Withdraw'
                ) : requiresPreSignConfirmation ? (
                  'Awaiting Confirmation'
                ) : (
                  'Deposit'
                )
                }
              </button>

              <button
                type="button"
                onClick={() => {
                  setAmount('100');
                  setTxHash(
                    'MOCK' +
                    Math.random().toString(36).substring(2, 10).toUpperCase(),
                  );
                  setStatus('success');
                }}
                className="w-full text-[10px] text-gray-500 hover:text-blue-400 transition-colors py-1"
              >
                (Demo: Simulate Success)
              </button>
            </div>

            {!connection.isConnected && (
              <p className="theme-text-muted text-center text-xs mt-3">
                Connect your Freighter wallet to continue.
              </p>
            )}
          </>
        )}
      </div>

      {/* Two-Factor Confirmation Modal */}
      {showTwoFactorModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50">
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 max-w-md w-full mx-4">
            <h3 className="text-white font-semibold text-lg mb-4">
              Two-Factor Confirmation
            </h3>
            <p className="text-gray-300 text-sm mb-4">
              For your security, please enter the last 4 digits of your wallet address to confirm this high-value transfer.
            </p>
            <p className="text-gray-400 text-xs mb-2">
              Your wallet: {connection.address.slice(0, 8)}…{connection.address.slice(-4)}
            </p>
            <input
              type="text"
              value={twoFactorConfirmation}
              onChange={(e) => setTwoFactorConfirmation(e.target.value)}
              placeholder="Enter last 4 digits"
              maxLength={4}
              className="w-full bg-gray-800 border border-gray-600 rounded-lg px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 mb-4"
            />
            <div className="flex gap-3">
              <button
                onClick={() => {
                  setShowTwoFactorModal(false);
                  setTwoFactorConfirmation('');
                }}
                className="flex-1 px-4 py-2 bg-gray-700 text-white rounded-lg hover:bg-gray-600 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleAction}
                className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
