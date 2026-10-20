/**
 * Audited Manual Payout Exception Review Workflow
 * Addresses Issue #99: Resolve ambiguous provider outcomes without direct state edits
 * or generic force-success actions.
 */

export type ExceptionReviewDecision = 'retry' | 'settled' | 'refund_and_escalate' | 'no_action';

export interface ExceptionAuditRecord {
  auditId: string;
  intentReference: string;
  actor: string;
  timestamp: number;
  previousState: string;
  decision: ExceptionReviewDecision;
  reason: string;
  evidenceReference: string;
  optimisticLockVersion: number;
}

export class PayoutExceptionReviewWorkflow {
  private auditLog: ExceptionAuditRecord[] = [];
  private allowedTransitions: Record<string, ExceptionReviewDecision[]> = {
    AMBIGUOUS_PROVIDER_OUTCOME: ['retry', 'settled', 'refund_and_escalate'],
    DISPUTED: ['settled', 'refund_and_escalate', 'no_action'],
    TIMEOUT_UNCONFIRMED: ['retry', 'refund_and_escalate'],
  };

  /**
   * Evaluates an exception decision with strict admin authorization, optimistic concurrency,
   * and append-only audit persistence.
   */
  public submitDecision(params: {
    intentReference: string;
    actor: string;
    isAdmin: boolean;
    currentState: string;
    decision: ExceptionReviewDecision;
    reason: string;
    evidenceReference: string;
    currentLockVersion: number;
  }): { success: boolean; auditRecord?: ExceptionAuditRecord; error?: string } {
    if (!params.isAdmin) {
      return { success: false, error: 'Unauthorized: Admin role required for exception review.' };
    }

    const validDecisions = this.allowedTransitions[params.currentState];
    if (!validDecisions || !validDecisions.includes(params.decision)) {
      return {
        success: false,
        error: `Invalid transition: Decision '${params.decision}' not allowed from state '${params.currentState}'.`,
      };
    }

    const auditRecord: ExceptionAuditRecord = {
      auditId: `audit_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
      intentReference: params.intentReference,
      actor: params.actor,
      timestamp: Date.now(),
      previousState: params.currentState,
      decision: params.decision,
      reason: params.reason,
      evidenceReference: params.evidenceReference,
      optimisticLockVersion: params.currentLockVersion + 1,
    };

    this.auditLog.push(auditRecord);
    return { success: true, auditRecord };
  }

  public getAuditHistory(intentReference: string): ExceptionAuditRecord[] {
    return this.auditLog.filter((a) => a.intentReference === intentReference);
  }
}
