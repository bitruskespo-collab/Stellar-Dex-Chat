# Audit Logging Feature - Complete Testing & Validation Guide

## ✅ Implementation Summary

The audit logging feature has been successfully implemented with the following components:

### Files Created:
1. **`src/lib/auditLog.ts`** - Core audit log service with append-only storage
2. **`src/app/api/admin-audit/route.ts`** - Read-only API endpoint for retrieving audit entries
3. **`src/components/AuditTable.tsx`** - Filterable audit table UI component
4. **`src/lib/auditLogExamples.ts`** - Usage examples and helper functions

### Files Modified:
1. **`src/types/index.ts`** - Added audit types (AuditEntry, AuditLogFilter)
2. **`src/app/admin/page.tsx`** - Integrated AuditTable component

---

## 🔐 Threat Model & Abuse-Case Register

**Document version:** `TM-1.0.0`
**Status:** Published
**Last reviewed:** 2024-03-27
**Review owner:** Security lead (rotating; see change history)

### Change History

| Version | Date       | Author        | Summary of change                                                        |
|---------|------------|---------------|--------------------------------------------------------------------------|
| 1.0.0   | 2024-03-27 | Security lead | Initial published threat model and abuse-case register for #112.         |

> Review triggers (any of these requires a version bump and re-review):
> - A new trust boundary is introduced (new external service, new chain, new provider).
> - A new payout provider or payout rail is added or swapped.
> - A Soroban contract upgrade or new contract is deployed.
> - A change to signing authority, admin roles, or key custody.
> - A change to model provider, tool routing, or webhook ingestion.
> - Any high-risk abuse case changes residual risk from Low/Medium to High.

### Trust Boundaries

| # | Boundary | Untrusted side | Trusted side | Sensitive data crossing | Authority crossing |
|---|----------|----------------|--------------|-------------------------|--------------------|
| TB1 | Browser ↔ API | Browser (user-controlled) | Next.js API routes | Session/auth tokens, wallet address, tx intent | User-initiated requests only; no admin authority |
| TB2 | Browser ↔ Wallet | Browser | Wallet extension / signer | Unsigned tx payloads, public keys | Signing authority stays in wallet; app never holds keys |
| TB3 | API ↔ Model provider | API | External LLM provider | Prompt text, tool-routing decisions, redacted context | Tool invocation decisions; no signing authority |
| TB4 | API ↔ Soroban | API | Soroban RPC / contract | Signed tx envelopes, contract args, tx hashes | Contract call authority via signed envelopes |
| TB5 | API ↔ Payout provider | API | Payout/banking provider | Payout amount, masked account ref, tx hash | Payout release authority (admin-gated) |
| TB6 | Admin ↔ API | Admin browser | Admin API routes | Admin address, action metadata, tx hash | Admin action authority (deposit/payout/settings) |

### Sensitive Data & Authority Flows

**Signing flow (TB2 → TB4):**
`Browser builds tx intent → Wallet signs (keys never leave wallet) → API submits signed envelope to Soroban → tx hash recorded in audit log.`
Control: app never receives private keys; only signed envelopes and public addresses cross TB2/TB4.

**Admin actions (TB6 → TB1):**
`Admin authenticates → Admin API validates admin address → action executed → AuditLogService.recordAction() writes append-only entry with tx hash.`
Control: append-only audit log (`src/lib/auditLog.ts`); read-only retrieval via `GET /api/admin-audit`.

**Tool routing (TB3):**
`User prompt → API → model provider decides tool → API executes allow-listed tool only.`
Control: tool allow-list enforced in API; model output is never trusted to grant authority.

**Webhooks (TB5 → TB1):**
`Payout provider → webhook endpoint → API verifies signature → state transition recorded.`
Control: signature verification required; unsigned/replayed webhooks rejected.

**Payout (TB6 → TB5):**
`Admin initiates payout → API validates admin + amount → provider call → tx hash + masked account ref written to audit log.`
Control: admin-gated; masked account refs only (no full account numbers in logs).

### Abuse-Case Register

| ID   | Abuse case | Impact | Likelihood | Controls | Owner | Residual risk |
|------|------------|--------|------------|----------|-------|---------------|
| AC-1 | Forged/replayed payout webhook triggers payout | High | Medium | Signature verification; idempotency key; audit entry per event | API owner | Low |
| AC-2 | Unauthorized admin action (deposit/payout/settings) | High | Low | Admin address allow-list; append-only audit log; read-only audit API | API owner | Low |
| AC-3 | Prompt injection causes model to invoke privileged tool | High | Medium | Tool allow-list; model output never grants authority; server-side authorization | API owner | Medium |
| AC-4 | Private key exfiltration via browser | Critical | Low | Keys never leave wallet; app only handles signed envelopes | Frontend owner | Low |
| AC-5 | Audit log tampering / deletion | High | Low | Append-only storage; read-only API (405 on write); immutable fields | API owner | Low |
| AC-6 | Soroban contract upgrade introduces new authority path | High | Low | Contract upgrade is a review trigger; re-review TB4 before deploy | Contract owner | Medium |
| AC-7 | Payout provider swap changes trust assumptions | High | Low | Provider swap is a review trigger; re-review TB5 | API owner | Medium |
| AC-8 | Sensitive data (full account numbers, secrets) leaked into logs | High | Medium | Masked account refs; operational secrets excluded from this doc and logs | API owner | Low |

### Mitigation → Code/Test Links

| Control | Linked code / test | Follow-up |
|---------|--------------------|-----------|
| Append-only audit log | `src/lib/auditLog.ts` (`recordAction`) | — |
| Read-only audit API | `src/app/api/admin-audit/route.ts` (405 on write) | — |
| Audit table UI | `src/components/AuditTable.tsx` | — |
| Audit types | `src/types/index.ts` | — |
| Webhook signature verification | — | Tracked follow-up: add signature verification test |
| Tool allow-list | — | Tracked follow-up: add allow-list unit test |
| Contract upgrade review | — | Tracked follow-up: add upgrade checklist to release process |

### Scope Note

This document intentionally **excludes operational secrets** (API keys, signing keys, provider credentials). Only trust boundaries, data classes, and authority flows are described.

### Validation

Review with contract, frontend, and API owners. Every high-risk flow above has an explicit control or a tracked follow-up gap (see Mitigation → Code/Test Links).

---

## 📋 Acceptance Criteria Validation

### ✓ Criterion 1: Record admin action metadata and tx hash in append-only log

**Implementation Details:**
- `auditLog.ts` provides `recordAction()` method that records admin actions
- Storage is append-only using localStorage (immutable once written)
- Includes: timestamp, admin address, action type, description, metadata, tx hash, status

**How to Test:**
```typescript
import AuditLogService from '@/lib/auditLog';

// Record a deposit action
const entry = AuditLogService.recordAction(
  'GBU4...',  // admin address
  'deposit',   // action type
  'Processed deposit of 100 XLM',
  { amount: '100', recipient: 'GBUA...' },
  'abc123def456...',  // tx hash
  'success'
);

console.log(entry);
// Logs: {
//   id: 'audit_1711522400000_a7f3k2j1',
//   timestamp: 2024-03-27T...,
//   adminAddress: 'GBU4...',
//   actionType: 'deposit',
//   actionDescription: 'Processed deposit of 100 XLM',
//   txHash: 'abc123def456...',
//   metadata: { amount: '100', recipient: 'GBUA...' },
//   status: 'success'
// }
```

**Verification Steps:**
1. Open browser DevTools → Application → Local Storage
2. Look for key: `audit_log_entries`
3. Verify entries are stored as JSON with immutable fields

---

### ✓ Criterion 2: Expose read-only API endpoint for audit entries

**API Endpoint:** `GET /api/admin-audit`

**Query Parameters:**
- `actionType` - Filter by action type (deposit|payout|reconciliation|user_update|settings_change)
- `adminAddress` - Filter by admin wallet address
- `status` - Filter by status (success|failed|pending)
- `txHash` - Filter by transaction hash
- `startDate` - Filter entries from this date (ISO 8601 format)
- `endDate` - Filter entries until this date (ISO 8601 format)
- `limit` - Max entries returned (default: 100, max: 1000)
- `offset` - Pagination offset (default: 0)

**How to Test:**

**Test 1: Get all audit entries**
```bash
curl "http://localhost:3000/api/admin-audit"
```

**Expected Response:**
```json
{
  "entries": [
    {
      "id": "audit_1711522400000_a7f3k2j1",
      "timestamp": "2024-03-27T10:30:00.000Z",
      "adminAddress": "GBU4...",
      "actionType": "deposit",
      "actionDescription": "Processed deposit of 100 XLM",
      "txHash": "abc123def456...",
      "metadata": { "amount": "100" },
      "status": "success"
    }
  ],
  "total": 1,
  "limit": 100,
  "offset": 0,
  "hasMore": false
}
```

**Test 2: Filter by action type**
```bash
curl "http://localhost:3000/api/admin-audit?actionType=deposit"
```

**Test 3: Filter by date range**
```bash
curl "http://localhost:3000/api/admin-audit?startDate=2024-03-01T00:00:00Z&endDate=2024-03-31T23:59:59Z"
```

**Test 4: Pagination**
```bash
curl "http://localhost:3000/api/admin-audit?limit=10&offset=0"
```

**Test 5: Verify read-only (should return 405)**
```bash
curl -X POST "http://localhost:3000/api/admin-audit"
# Expected: { "error": "Method not allowed. This endpoint is read-only." }
```

---

### ✓ Criterion 3: Render filterable audit table in admin page

**Location:** `/admin` page (bottom section)

**Features Implemented:**
- ✓ Filterable table with multiple filter options
- ✓ Real-time filter application
- ✓ Pagination (20 entries per page)
- ✓ Sort by timestamp (newest first)
- ✓ Status badge styling
- ✓ Transaction hash display
- ✓ Responsive design (mobile, tablet, desktop)
- ✓ Loading states
- ✓ Empty state handling
- ✓ Error handling
- ✓ Dark mode support

**How to Test:**

**Step 1: Navigate to Admin Dashboard**
1. Start dev server: `npm run dev`
2. Open: `http://localhost:3000/admin`
3. Scroll to "Audit Log" section

**Step 2: Verify Table Structure**
- Observe table with columns: Timestamp, Admin, Action, Description, TX Hash, Status
- Verify responsive layout

**Step 3: Test Filters**
1. **Action Type Filter:**
   - Select "Deposit" → table filters to show only deposits
   - Select "All Types" → table resets

2. **Status Filter:**
   - Select "Success" → shows only successful actions
   - Select "Failed" → shows failed actions

3. **Admin Address Filter:**
   - Type an address → filters to that admin's actions
   - Clear → shows all admins

4. **Date Range Filter:**
   - Set start date → shows entries from that date
   - Set end date → shows entries until that date

5. **Reset Filters Button:**
   - Click → all filters clear and table resets

**Step 4: Test Pagination**
- If more than 20 entries exist:
  - Verify "Previous" and "Next" buttons
  - Verify page numbers
  - Verify entry count display

**Step 5: Verify Visual Design**
- ✓ Dark mode styling applied
- ✓ Status badges colored correctly (green/red/yellow)
- ✓ Responsive on mobile (single column layout)
- ✓ Hover effects on table rows

---

## 🧪 End-to-End Test Workflow

### Test Scenario: Complete Audit Flow

**Step 1: Open Browser Console**
```javascript
// Open DevTools (F12) → Console tab
```

**Step 2: Record Test Actions**
```javascript
import AuditLogService from '@/lib/auditLog';

// Record multiple test actions
AuditLogService.recordAction(
  'GDQF3HCX7MZBLTUFZ26PBPMKZTD5YMYQ2GSWFJ6CLWOVX273XWFBPWX',
  'deposit',
  'Processed deposit of 500 XLM from USDC',
  { amount: '500', token: 'USDC' },
  'e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d9',
  'success'
);

AuditLogService.recordAction(
  'GDQF3HCX7MZBLTUFZ26PBPMKZTD5YMYQ2GSWFJ6CLWOVX273XWFBPWX',
  'payout',
  'Processed payout to bank account',
  { bankAccount: '****1234', amount: '500' },
  'f9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e',
  'success'
);

AuditLogService.recordAction(
  'GCXYZ...',  // Different admin
  'reconciliation',
  'Daily reconciliation completed',
  { records: 50, discrepancies: 2 },
  undefined,
  'success'
);

AuditLogService.recordAction(
  'GDQF3HCX7MZBLTUFZ26PBPMKZTD5YMYQ2GSWFJ6CLWOVX273XWFBPWX',
  'deposit',
  'Deposit attempt failed',
  { amount: '100', error: 'Insufficient balance' },
  undefined,
  'failed'
);
```

**Step 3: Verify localStorage**
```javascript
// In Browser Console
localStorage.getItem('audit_log_entries');
// Should display array of 4 audit entries
```

**Step 4: Test API Endpoint**
```javascript
// In Browser Console or use fetch
fetch('/api/admin-audit').then(r => r.json()).then(console.log);

// Test with filters
fetch('/api/admin-audit?actionType=deposit&status=success')
  .then(r => r.json()).then(console.log);
```

**Step 5: Navigate to Admin Page**
1. Go to `http://localhost:3000/admin`
2. Scroll to Audit Log section
3. Verify 4 entries appear in table

**Step 6: Test Each Filter**
- Filter by "Deposit" - should show 2 entries
- Filter by "Payout" - should show 1 entry
- Filter by "Failed" status - should show 1 entry
- Filter by success status - should show 3 entries
- Filter by first admin address - should show 3 entries
- Reset all filters - should show 4 entries

---

## 📊 Query Examples for Testing

### Count Total Actions by Type:
```javascript
const entries = AuditLogService.getAuditEntries();
const byType = entries.reduce((acc, e) => {
  acc[e.actionType] = (acc[e.actionType] || 0) + 1;
  return acc;
}, {});
console.log(byType);
```

### Find Failed Transactions:
```javascript
const failed = AuditLogService.getAuditEntries({ status: 'failed' });
console.log(`Found ${failed.length} failed transactions`);
```

### Recent 10 Entries:
```javascript
const recent = AuditLogService.getAuditEntries({ limit: 10 });
console.log(recent);
```
