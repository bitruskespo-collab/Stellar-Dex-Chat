'use client';

import React, { useMemo, useState } from 'react';
import ChatMessages from '@/components/ChatMessages';
import { ChatMessage } from '@/types';

interface IntentProposal {
  asset: string;
  amount: string;
  recipient: string;
  network: string;
}

interface IntentConfirmationState {
  asset: boolean;
  amount: boolean;
  recipient: boolean;
  network: boolean;
}

const EMPTY_ACK: IntentConfirmationState = {
  asset: false,
  amount: false,
  recipient: false,
  network: false,
};

const INTENT_FIELDS: Array<{ key: keyof IntentConfirmationState; label: string }> = [
  { key: 'asset', label: 'Asset' },
  { key: 'amount', label: 'Amount' },
  { key: 'recipient', label: 'Recipient' },
  { key: 'network', label: 'Network' },
];

function validateIntentProposal(
  proposal: Partial<IntentProposal> | null | undefined
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!proposal) {
    return { valid: false, errors: ['No intent proposal provided'] };
  }
  if (!proposal.asset || !proposal.asset.trim()) errors.push('Asset is missing');
  if (!proposal.amount || !proposal.amount.trim()) errors.push('Amount is missing');
  if (!proposal.recipient || !proposal.recipient.trim()) errors.push('Recipient is missing');
  if (!proposal.network || !proposal.network.trim()) errors.push('Network is missing');
  return { valid: errors.length === 0, errors };
}

const sampleMessages: ChatMessage[] = [
  {
    id: 'm1',
    role: 'assistant',
    content: 'Hello! This message contains a [link](https://example.com), some **bold** text, and *italic* emphasis with `inline code`.',
    timestamp: new Date(),
    metadata: {
      status: 'sent',
    },
  },
  {
    id: 'm2',
    role: 'assistant',
    content: 'Here is a transaction preview',
    timestamp: new Date(),
    metadata: {
      status: 'sent',
      transactionData: {
        type: 'fiat_conversion',
        tokenIn: 'XLM',
        amountIn: '123.45',
        fiatAmount: '10.00',
        fiatCurrency: 'USD',
        transactionId: 'tx-abcdef1234567890',
        txHash: '0xdeadbeefcafebabe',
        receiptId: 'r-1234567890abcdef',
        note: 'Test deposit',
      },
      confirmationRequired: true,
    },
  },
  {
    id: 'm3',
    role: 'assistant',
    content: 'This message has suggested actions',
    timestamp: new Date(),
    metadata: {
      status: 'sent',
      suggestedActions: [
        { id: 'a1', label: 'Confirm', type: 'confirm_fiat', priority: true },
        { id: 'a2', label: 'Cancel', type: 'cancel', priority: false },
      ],
    },
  },
  {
    id: 'm4',
    role: 'user',
    content: 'This is a user message',
    timestamp: new Date(),
    metadata: { status: 'sent' },
  },
  {
    id: 'm5',
    role: 'assistant',
    content: 'This message simulates a failure',
    timestamp: new Date(),
    error: { message: 'Failed to send', timestamp: new Date(), retryAttempts: 2 },
    metadata: { status: 'failed' },
  },
  {
    id: 'm6',
    role: 'assistant',
    content: 'The current XLM/USD rate is 0.1234 USD per XLM.',
    timestamp: new Date(),
    metadata: {
      status: 'sent',
      financialFact: {
        kind: 'rate',
        pair: 'XLM/USD',
        value: '0.1234',
        source: {
          name: 'Stellar DEX oracle',
          url: 'https://example.com/rates/xlm-usd',
        },
        observedAt: new Date(Date.now() - 30 * 1000),
        validUntil: new Date(Date.now() + 60 * 1000),
        freshness: 'fresh',
      },
    },
  },
  {
    id: 'm7',
    role: 'assistant',
    content: 'The last known XLM/USD rate was 0.1201 USD per XLM.',
    timestamp: new Date(),
    metadata: {
      status: 'sent',
      financialFact: {
        kind: 'rate',
        pair: 'XLM/USD',
        value: '0.1201',
        source: {
          name: 'Stellar DEX oracle',
          url: 'https://example.com/rates/xlm-usd',
        },
        observedAt: new Date(Date.now() - 30 * 60 * 1000),
        validUntil: new Date(Date.now() - 10 * 60 * 1000),
        freshness: 'stale',
      },
    },
  },
  {
    id: 'm8',
    role: 'assistant',
    content: 'I could not retrieve a current XLM/USD rate right now.',
    timestamp: new Date(),
    metadata: {
      status: 'sent',
      financialFact: {
        kind: 'rate',
        pair: 'XLM/USD',
        freshness: 'missing',
      },
    },
  },
  {
    id: 'm9',
    role: 'assistant',
    content: 'Based on the current rate, 100 XLM would be approximately 12.34 USD. This is an estimate, not a guaranteed payout.',
    timestamp: new Date(),
    metadata: {
      status: 'sent',
      financialFact: {
        kind: 'payout_estimate',
        pair: 'XLM/USD',
        value: '12.34',
        source: {
          name: 'Stellar DEX oracle',
          url: 'https://example.com/rates/xlm-usd',
        },
        observedAt: new Date(Date.now() - 20 * 1000),
        validUntil: new Date(Date.now() + 40 * 1000),
        freshness: 'fresh',
        isEstimate: true,
      },
    },
  },
];

const sampleIntentProposal: IntentProposal = {
  asset: 'XLM',
  amount: '123.45',
  recipient: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUV',
  network: 'Stellar Mainnet',
};

function IntentConfirmation({
  proposal,
  onConfirmed,
}: {
  proposal: Partial<IntentProposal> | null | undefined;
  onConfirmed: (proposal: IntentProposal) => void;
}) {
  const validation = useMemo(() => validateIntentProposal(proposal), [proposal]);
  const [ack, setAck] = useState<IntentConfirmationState>(EMPTY_ACK);
  const [rejected, setRejected] = useState(false);

  const allAcknowledged = INTENT_FIELDS.every((f) => ack[f.key]);
  const canConfirm = validation.valid && allAcknowledged;

  const toggle = (key: keyof IntentConfirmationState) => {
    setRejected(false);
    setAck((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const handleConfirm = () => {
    if (!validation.valid || !allAcknowledged) return;
    onConfirmed(proposal as IntentProposal);
  };

  const handleReject = () => {
    setRejected(true);
    setAck(EMPTY_ACK);
  };

  return (
    <section
      aria-label="Transaction intent confirmation"
      style={{ padding: 16, borderTop: '1px solid #ddd' }}
    >
      <h2 style={{ marginTop: 0 }}>Confirm transaction intent</h2>
      {!validation.valid ? (
        <div role="alert" style={{ color: '#b00020' }}>
          <p>This intent proposal cannot be confirmed:</p>
          <ul>
            {validation.errors.map((err) => (
              <li key={err}>{err}</li>
            ))}
          </ul>
        </div>
      ) : (
        <>
          <dl>
            <dt>Asset</dt>
            <dd>{proposal?.asset}</dd>
            <dt>Amount</dt>
            <dd>{proposal?.amount}</dd>
            <dt>Recipient</dt>
            <dd style={{ wordBreak: 'break-all' }}>{proposal?.recipient}</dd>
            <dt>Network</dt>
            <dd>{proposal?.network}</dd>
          </dl>
          <fieldset>
            <legend>Acknowledge each field before continuing</legend>
            {INTENT_FIELDS.map((f) => (
              <label key={f.key} style={{ display: 'block' }}>
                <input
                  type="checkbox"
                  checked={ack[f.key]}
                  onChange={() => toggle(f.key)}
                />{' '}
                I confirm the {f.label.toLowerCase()}
              </label>
            ))}
          </fieldset>
          {rejected && (
            <p role="status" style={{ color: '#b00020' }}>
              Confirmation rejected. No wallet action was dispatched.
            </p>
          )}
          <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
            <button type="button" onClick={handleConfirm} disabled={!canConfirm}>
              Confirm and continue
            </button>
            <button type="button" onClick={handleReject}>
              Reject
            </button>
          </div>
        </>
      )}
    </section>
  );
}

export default function Page() {
  const [dispatched, setDispatched] = useState<IntentProposal | null>(null);

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <h1 style={{ padding: 16 }}>Test Message Fixtures</h1>
      <div style={{ flex: 1 }}>
        <ChatMessages
          messages={sampleMessages}
          onActionClick={() => undefined}
        />
      </div>
      <IntentConfirmation
        proposal={sampleIntentProposal}
        onConfirmed={(proposal) => setDispatched(proposal)}
      />
      {dispatched && (
        <p role="status" style={{ padding: 16 }}>
          Wallet action dispatched for {dispatched.amount} {dispatched.asset} to{' '}
          {dispatched.recipient} on {dispatched.network}.
        </p>
      )}
    </div>
  );
}
