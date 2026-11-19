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
  type FeeEstimate,
  type PreSignSimulationResult,
} from '@/lib/stellarContract';
import { xlmToStroops, stroopsToXlm as stroopsToDisplay } from '@/lib/stroops';
import { parseAssetAmount, formatAssetAmount } from '@/lib/exactAmount';
import {
  savePendingRecoveryRecord,
  getPendingRecoveryRecord,
  clearPendingRecoveryRecord,
  lookupTransactionStatus,
} from '@/lib/transactionRecovery';
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
import WithdrawalQueueStatus from './WithdrawalQueueStatus';
import {
  QuoteSnapshot,
  BalanceSnapshot,
  createQuoteSnapshot,
  createBalanceSnapshot,
  revalidateFormInputs,
} from '@/lib/transactionFormProtection';
import * as protectionModule from '@/lib/transactionFormProtection';
import * as stellarContractModule from '@/lib/stellarContract';

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
  const {
    connection,
    signTx,
    xlmBalance,
    refreshXlmBalance,
    sessionExpired,
    reconnect,
  } = useStellarWallet();
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
  const [simulationResult, setSimulationResult] =
    useState<PreSignSimulationResult | null>(null);
  const [simulationError, setSimulationError] = useState<string | null>(null);
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
  const [quoteSnapshot, setQuoteSnapshot] = useState<QuoteSnapshot | null>(null);
  const [balanceSnapshot, setBalanceSnapshot] = useState<BalanceSnapshot | null>(null);
  const [reconfirmationNotice, setReconfirmationNotice] = useState<string | null>(null);
  const [hasConfirmedUpdatedValues, setHasConfirmedUpdatedValues] = useState(false);

  useEffect(() => {
    const addr = connection.address || connection.publicKey;
    if (addr) {
      try {
        const fetchBalanceFn = (
          stellarContractModule as Record<string, unknown>
        ).fetchXlmBalance as ((pk: string) => Promise<string>) | undefined;

        if (typeof fetchBalanceFn === 'function') {
          const p = fetchBalanceFn(addr);
          if (p && typeof p.then === 'function') {
            void p
              .then((bal) => {
                setBalanceSnapshot(createBalanceSnapshot(bal || '0.00', addr));
              })
              .catch(() => {});
          }
        }
      } catch {
        // Mock does not export fetchXlmBalance in specific unit tests
      }
    }
  }, [connection.address, connection.publicKey]);

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
    setReconfirmationNotice(null);
    setHasConfirmedUpdatedValues(false);
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

  const hasInitializedOpenRef = useRef(false);

  useEffect(() => {
    if (!isOpen) {
      hasInitializedOpenRef.current = false;
      return;
    }

    if (hasInitializedOpenRef.current) {
      return;
    }
    hasInitializedOpenRef.current = true;

    if (getPendingRecoveryRecord()) {
      return;
    }

    setAmount(defaultAmount);
    setRecipient(recipientAddress);
    setActivePreset(null);
    setStatus('idle');
    setTxHash('');
    setErrorMsg('');
    setFeeEstimate(null);
    setSimulationResult(null);
    setSimulationError(null);
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

    const pending = getPendingRecoveryRecord();
    if (!pending) {
      return;
    }

    setPendingRecord(pending);
    setAmount(pending.amount);
    if (pending.recipient) {
      setRecipient(pending.recipient);
    }
    setStatus('loading');
    setErrorMsg('');
    setTxHash(pending.hash);

    let cancelled = false;
    void (async () => {
      const outcome = await lookupTransactionStatus(pending.hash);
      if (cancelled) return;

      if (outcome === 'confirmed') {
        setStatus('success');
        clearPendingRecoveryRecord();
        await refreshXlmBalance();
        addNotification(
          'tx_confirm',
          `Recovered transaction confirmed! (${pending.hash.slice(0, 8)}...)`,
        );
      } else if (outcome === 'failed') {
        setStatus('error');
        setErrorMsg('Recovered transaction failed on-chain');
        clearPendingRecoveryRecord();
      } else if (outcome === 'unknown') {
        setStatus('error');
        setErrorMsg(
          'Transaction status unknown: network unreachable. The transaction may still be pending on-chain. Recovery will not re-submit to prevent duplicates.',
        );
      } else {
        try {
          const { pollTransaction } = await import('@/lib/stellarContract');
          const finalHash = await pollTransaction(pending.hash);
          if (cancelled) return;
          setStatus('success');
          setTxHash(finalHash);
          clearPendingRecoveryRecord();
          await refreshXlmBalance();
          addNotification(
            'tx_confirm',
            `Transaction confirmed successfully! (${finalHash.slice(0, 8)}...)`,
          );
        } catch {
          if (cancelled) return;
          setStatus('error');
          setErrorMsg('Recovered transaction failed or timed out on-chain');
          clearPendingRecoveryRecord();
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isOpen, refreshXlmBalance, addNotification]);

  useEffect(() => {
    if (!isOpen || !connection.isConnected) {
      setFeeEstimate(null);
      setSimulationResult(null);
      setSimulationError(null);
      return;
    }

    const parsed = parseAssetAmount(amount, { decimals: 7 });
    if (!parsed.success || parsed.stroops <= 0n) {
      setFeeEstimate(null);
      setSimulationResult(null);
      setSimulationError(null);
      return;
    }

    const currentStroops = parsed.stroops;

    let cancelled = false;
    const abortController = new AbortController();
    setIsLoadingFee(true);

    const timer = setTimeout(async () => {
      try {
        const { simulateTransactionPayload } = await import('@/lib/stellarContract');
        const sim = await simulateTransactionPayload({
          operation: isAdminMode ? 'withdraw' : 'deposit',
          account: connection.publicKey,
          amount: currentStroops,
          recipient: isAdminMode ? (recipient || connection.publicKey) : undefined,
          network: connection.network || 'TESTNET',
        });
        if (!cancelled) {
          setSimulationResult(sim);
          setFeeEstimate(sim.feeEstimate);
          setSimulationError(null);
        }
      } catch (err) {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : 'Simulation failed';
          setFeeEstimate(null);
          setSimulationResult(null);
          setSimulationError(msg);
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
    connection.network,
    connection.publicKey,
    isAdminMode,
    isOpen,
    recipient,
  ]);

  useEffect(() => {
    const parsed = parseAssetAmount(amount, { decimals: 7 });
    if (!parsed.success || parsed.stroops <= 0n) {
      setFiatEstimate(null);
      setIsFiatEstimateStale(false);
      return;
    }

    const xlm = Number(parsed.stroops) / 1e7;

    let cancelled = false;

    const fetchEstimate = async () => {
      try {
        const quote = await getTokenPriceWithStatus('XLM', fiatCurrency);
        if (!cancelled) {
          const snapshot = createQuoteSnapshot(
            quote.price,
            'XLM',
            fiatCurrency,
            quote.source,
          );
          setQuoteSnapshot(snapshot);
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

  const parsedAmountResult = parseAssetAmount(amount, { decimals: 7 });
  const stroopsAmount =
    parsedAmountResult.success && parsedAmountResult.stroops > 0n
      ? parsedAmountResult.stroops
      : null;
  const hasValidAmount = stroopsAmount !== null && stroopsAmount > 0n;
  const amountFeedback = !amount
    ? null
    : !parsedAmountResult.success
      ? parsedAmountResult.error
      : parsedAmountResult.stroops <= 0n
        ? 'Amount must be greater than zero'
        : null;
  const isAmountInvalid = amountFeedback !== null;
  const isRiskyAmount =
    twoFactorEnabled &&
    stroopsAmount !== null &&
    stroopsAmount >= BigInt(highValueThreshold) * 10_000_000n;
  const isSimulationStale = Boolean(
    simulationResult &&
    (simulationResult.account !== connection.publicKey ||
      simulationResult.network !== (connection.network || 'TESTNET') ||
      simulationResult.operation !== (isAdminMode ? 'withdraw' : 'deposit') ||
      simulationResult.amountStroops !== stroopsAmount ||
      (isAdminMode && (recipient || connection.publicKey) !== simulationResult.recipient))
  );
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
    sessionExpired ||
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
    if (!connection.isConnected || sessionExpired) {
      setErrorMsg(
        sessionExpired
          ? 'Wallet session has expired. Please reconnect to continue.'
          : 'Wallet disconnected. Please reconnect to continue.',
      );
      setStatus('error');
      return;
    }

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
      stroopsAmount <= 0n
    ) {
      setErrorMsg(amountFeedback || 'Invalid amount. Please enter a positive number.');
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

    // Step 1: Pre-Sign Confirmation Requirement
    if (!requiresPreSignConfirmation) {
      if (simulationError) {
        setErrorMsg(`Simulation failed: ${simulationError}. Signing blocked.`);
        setStatus('error');
        return;
      }
      setIsLoadingFee(true);
      try {
        const { simulateTransactionPayload } = await import('@/lib/stellarContract');
        const sim = await simulateTransactionPayload({
          operation: isAdminMode ? 'withdraw' : 'deposit',
          account: connection.publicKey,
          amount: stroopsAmount,
          recipient: isAdminMode ? (recipient || connection.publicKey) : undefined,
          network: connection.network || 'TESTNET',
        });
        setSimulationResult(sim);
        setFeeEstimate(sim.feeEstimate);
        setSimulationError(null);
        setRequiresPreSignConfirmation(true);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Simulation failed';
        setSimulationError(msg);
        setErrorMsg(`Simulation failed: ${msg}. Signing blocked.`);
        setStatus('error');
      } finally {
        setIsLoadingFee(false);
      }
      return;
    }

    // Step 2: Ensure simulation is not stale or failed
    if (isSimulationStale) {
      setErrorMsg('Account or network changed since simulation. Please re-simulate before signing.');
      setStatus('error');
      return;
    }
    if (simulationError) {
      setErrorMsg(`Simulation failed: ${simulationError}. Signing blocked.`);
      setStatus('error');
      return;
    }

    if (status === 'loading' || isTxProcessing) {
      return;
    }

    // Protect transaction forms from stale quotes and balances (#62)
    if (!hasConfirmedUpdatedValues && !shouldBypass) {
      const revalidation = await protectionModule.revalidateFormInputs({
        quoteSnapshot,
        balanceSnapshot,
        currentAmountXlm: amount,
        walletAddress: connection.address || connection.publicKey,
        fiatCurrency,
      });

      if (!revalidation.valid) {
        if (revalidation.latestQuote) {
          setQuoteSnapshot(revalidation.latestQuote);
          const xlm = parseFloat(amount);
          if (xlm > 0) {
            setFiatEstimate(
              formatFiatAmount(xlm * revalidation.latestQuote.price, fiatCurrency),
            );
          }
        }
        if (revalidation.latestBalance) {
          setBalanceSnapshot(revalidation.latestBalance);
        }
        setReconfirmationNotice(
          revalidation.explanation ||
            'Critical values changed while reviewing. Please reconfirm to proceed.',
        );
        return;
      }
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
          savePendingRecoveryRecord({
            hash,
            operation: isAdminMode ? 'withdraw' : 'deposit',
            amount,
            amountStroops: stroopsAmount.toString(),
            recipient: isAdminMode ? (recipient || connection.publicKey) : undefined,
            network: connection.network || 'TESTNET',
            account: connection.publicKey,
            timestamp: Date.now(),
            stage: 'pending_confirmation',
            idempotencyKey: generatedIdempotencyKey,
          });
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
          clearPendingRecoveryRecord();
          setRequiresPreSignConfirmation(false);
          // Refresh wallet balance after successful transaction
          await refreshXlmBalance?.();
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
              xlmAmount: Number(stroopsAmount) / 1e7,
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
          clearPendingRecoveryRecord();
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
    setSimulationResult(null);
    setSimulationError(null);
    onClose();
  };

  return (
    <div
      className="theme-overlay fixed inset-0 z-50 flex items-center justify-center backdrop-blur-sm"
      data-testid="stellar-fiat-modal-overlay"
      data-tx-status={status}
    >
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-label={isAdminMode ? 'Withdraw from Bridge' : 'Deposit to Bridge'}
        tabIndex={-1}
        data-testid="stellar-fiat-modal"
        data-flow={isAdminMode ? 'withdraw' : 'deposit'}
        data-wallet-connected={connection.isConnected ? 'true' : 'false'}
        data-wallet-address={connection.address || ''}
        data-wallet-network={txNetwork}
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
            data-testid="close-modal-button"
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
                href={
                  (connection.network || '').toLowerCase().includes('public')
                    ? `https://stellar.expert/explorer/public/tx/${txHash}`
                    : `https://stellar.expert/explorer/testnet/tx/${txHash}`
                }
                target="_blank"
                rel="noreferrer"
                data-testid="tx-hash-link"
                className="text-blue-400 hover:underline text-xs break-all"
              >
                {txHash}
              </a>
              <CopyButton value={txHash} />