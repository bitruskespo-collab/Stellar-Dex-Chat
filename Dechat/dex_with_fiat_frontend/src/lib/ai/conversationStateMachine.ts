/**
 * Versioned Conversation State Machine
 * Addresses Issue #78: Replace implicit cross-component chat state with explicit
 * transitions for intent capture, clarification, review, signing, and settlement.
 */

export const CONVERSATION_SM_VERSION = 1;

export type ConversationState =
  | 'idle'
  | 'capturing_intent'
  | 'awaiting_clarification'
  | 'reviewing_proposal'
  | 'awaiting_wallet_signature'
  | 'submitting_transaction'
  | 'settled'
  | 'failed';

export type ConversationEvent =
  | { type: 'USER_MESSAGE'; text: string }
  | { type: 'INTENT_PROPOSED'; proposal: Record<string, unknown> }
  | { type: 'CLARIFICATION_NEEDED'; question: string }
  | { type: 'CLARIFICATION_PROVIDED'; field: string; value: string }
  | { type: 'PROPOSAL_CONFIRMED' }
  | { type: 'PROPOSAL_REJECTED' }
  | { type: 'SIGNATURE_ACQUIRED'; signedXdrLength: number }
  | { type: 'TRANSACTION_CONFIRMED'; txHash: string }
  | { type: 'TRANSACTION_FAILED'; errorReason: string }
  | { type: 'RESET' };

export interface PersistedStateMachineContext {
  version: number;
  state: ConversationState;
  activeIntentType?: string;
  verifiedFields: Record<string, string>;
  lastCheckpoint: ConversationState;
  updatedAt: number;
}

export class ConversationStateMachine {
  private state: ConversationState = 'idle';
  private verifiedFields: Record<string, string> = {};
  private activeIntentType?: string;

  constructor(initialContext?: PersistedStateMachineContext) {
    if (initialContext && initialContext.version === CONVERSATION_SM_VERSION) {
      // Validate safe checkpoint
      this.state = this.sanitizeRecoveredState(initialContext.state);
      this.verifiedFields = { ...initialContext.verifiedFields };
      this.activeIntentType = initialContext.activeIntentType;
    }
  }

  private sanitizeRecoveredState(state: ConversationState): ConversationState {
    // If browser crashed mid-signature or mid-submission, safely recover to reviewing_proposal or idle
    if (state === 'awaiting_wallet_signature' || state === 'submitting_transaction') {
      return 'reviewing_proposal';
    }
    return state;
  }

  public getState(): ConversationState {
    return this.state;
  }

  public getContext(): PersistedStateMachineContext {
    return {
      version: CONVERSATION_SM_VERSION,
      state: this.state,
      activeIntentType: this.activeIntentType,
      verifiedFields: { ...this.verifiedFields },
      lastCheckpoint: this.state,
      updatedAt: Date.now(),
    };
  }

  public transition(event: ConversationEvent): { success: boolean; state: ConversationState; error?: string } {
    switch (this.state) {
      case 'idle':
        if (event.type === 'USER_MESSAGE') {
          this.state = 'capturing_intent';
          return { success: true, state: this.state };
        }
        break;

      case 'capturing_intent':
        if (event.type === 'INTENT_PROPOSED') {
          this.state = 'reviewing_proposal';
          return { success: true, state: this.state };
        }
        if (event.type === 'CLARIFICATION_NEEDED') {
          this.state = 'awaiting_clarification';
          return { success: true, state: this.state };
        }
        break;

      case 'awaiting_clarification':
        if (event.type === 'CLARIFICATION_PROVIDED') {
          this.verifiedFields[event.field] = event.value;
          this.state = 'capturing_intent';
          return { success: true, state: this.state };
        }
        break;

      case 'reviewing_proposal':
        if (event.type === 'PROPOSAL_CONFIRMED') {
          this.state = 'awaiting_wallet_signature';
          return { success: true, state: this.state };
        }
        if (event.type === 'PROPOSAL_REJECTED') {
          this.state = 'idle';
          return { success: true, state: this.state };
        }
        break;

      case 'awaiting_wallet_signature':
        if (event.type === 'SIGNATURE_ACQUIRED') {
          this.state = 'submitting_transaction';
          return { success: true, state: this.state };
        }
        if (event.type === 'TRANSACTION_FAILED') {
          this.state = 'reviewing_proposal'; // Safe fallback
          return { success: true, state: this.state };
        }
        break;

      case 'submitting_transaction':
        if (event.type === 'TRANSACTION_CONFIRMED') {
          this.state = 'settled';
          return { success: true, state: this.state };
        }
        if (event.type === 'TRANSACTION_FAILED') {
          this.state = 'failed';
          return { success: true, state: this.state };
        }
        break;

      case 'settled':
      case 'failed':
        if (event.type === 'RESET' || event.type === 'USER_MESSAGE') {
          this.state = 'idle';
          this.verifiedFields = {};
          this.activeIntentType = undefined;
          return { success: true, state: this.state };
        }
        break;
    }

    if (event.type === 'RESET') {
      this.state = 'idle';
      this.verifiedFields = {};
      this.activeIntentType = undefined;
      return { success: true, state: this.state };
    }

    return {
      success: false,
      state: this.state,
      error: `Invalid transition '${event.type}' from state '${this.state}'.`,
    };
  }
}
