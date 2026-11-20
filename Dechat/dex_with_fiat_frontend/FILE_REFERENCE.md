# 📁 Audit Log Feature - File Reference Guide

## Security Hardening Modules (Issues #257–#260)

This section documents the security boundary modules that sit between request
handling / persistence and any log, trace, or response emission. Contributor and
operator documentation for these modules lives alongside the code; the summary
below is the canonical reference.

### 1. Log redaction boundary — `src/lib/logRedaction.ts`

**Purpose:** Centralize redaction of sensitive fields before any log line or
trace span is emitted.

**Redacted categories:**
- Bank details (IBAN, account/routing numbers, BIC/SWIFT)
- Credentials (passwords, API keys, bearer tokens, cookies)
- Wallet/session tokens (session IDs, JWT, wallet signatures)
- Prompt content (LLM prompt/response bodies)
- Provider payloads (raw third-party request/response bodies)

**Contract:**
- All structured logging MUST go through `redactForLog()` (or the logger
  wrapper that calls it). Direct `console.*` / raw logger calls with
  request-derived data are disallowed.
- Redaction is recursive: nested objects, arrays, and encoded values
  (base64/URL-encoded/JSON-stringified) are inspected and redacted.
- Redaction is fail-closed: unknown shapes are replaced with `[REDACTED]`
  rather than passed through.
- Key identifiers (e.g. `keyId`) are preserved; key material is never logged.

**Tests:** `src/lib/__tests__/logRedaction.test.ts` — adversarial fixtures for
nested and encoded values. Fixtures MUST use synthetic data only; never commit
real credentials, tokens, or user data.

### 2. Payout field key rotation — `src/lib/payoutKeyRotation.ts`

**Purpose:** Manage active/previous data keys for stored payout fields and
support re-encryption, rollback, and retirement.

**Operational procedure:**
1. **Introduce** a new key as `previous` while the current key remains `active`.
2. **Re-encrypt** stored payout fields in batches; progress is tracked and
   resumable. Both active and previous keys can decrypt during the window.
3. **Verify** all records report the new `keyId` before proceeding.
4. **Retire** the previous key only after verification; retirement removes
   decryption capability for the old key.
5. **Rollback** is supported while the previous key is still retained: revert
   `active` to the previous key and re-run re-encryption.

**Contract:**
- Only key identifiers (`keyId`) are stored with ciphertext; key material is
  never persisted or logged.
- Decryption with a retired key MUST fail closed.

**Tests:** `src/lib/__tests__/payoutKeyRotation.test.ts` — active/previous
decryption, re-encryption progress, rollback, retirement, and key-id-only
storage. Uses test keys only.

### 3. Cross-origin policy — `src/lib/corsPolicy.ts`

**Purpose:** Define allowed origins and credential behavior per browser-facing
route and reject untrusted preflight and state-changing requests.

**Policy:**
- Financial routes (payout, deposit, admin, audit) use an explicit allowlist;
  wildcard origins are rejected.
- Credentialed requests are only permitted for explicitly allowlisted origins.
- Untrusted `Origin` on preflight (`OPTIONS`) or state-changing methods
  (`POST`/`PUT`/`PATCH`/`DELETE`) is rejected.
- **Production:** allowlist is sourced from configuration; no localhost origins.
- **Local development:** localhost origins are permitted only when explicitly
  enabled for development.

**Tests:** `src/lib/__tests__/corsPolicy.test.ts` — production and
local-development configurations, preflight rejection, and state-changing
request rejection.

### 4. Rate-limit identity — `src/lib/rateLimitIdentity.ts`

**Purpose:** Derive client IP and wallet identity only from trusted sources and
apply bounded limits before expensive work.

**Trusted proxy configuration:**
- Client IP is derived from forwarding headers ONLY when the request arrives
  from a configured trusted proxy (see `TRUSTED_PROXY_CIDRS`). Otherwise the
  socket/peer address is used.
- Wallet identity is derived from the verified session, never from
  client-supplied headers or body fields.
- Limits are applied before expensive work (DB, crypto, provider calls).

**Tests:** `src/lib/__tests__/rateLimitIdentity.test.ts` — spoofed forwarding
headers, identity changes, and untrusted-proxy fallback.

### Fixture hygiene (all modules)

Fixtures and tests MUST NOT contain real credentials, tokens, keys, or user
data. Use synthetic values and clearly fake identifiers.

---

## Implementation File Structure

```
dex_with_fiat_frontend/
├── src/
│   ├── lib/
│   │   ├── auditLog.ts                    ✨ NEW - Core service (200+ lines)
│   │   ├── auditLogExamples.ts           ✨ NEW - Integration examples (150+ lines)
│   │   ├── journeySlo.ts                 ✨ NEW - User-journey SLO definitions & alert thresholds
│   │   └── [other existing files...] 
│   ├── app/
│   │   ├── admin/
│   │   │   └── page.tsx                   ✏️ UPDATED - Added AuditTable component
│   │   └── api/
│   │       └── admin-audit/              ✨ NEW DIRECTORY
│   │           └── route.ts              ✨ NEW - API endpoint (120+ lines)
│   ├── components/
│   │   ├── AuditTable.tsx                ✨ NEW - Filterable UI component (400+ lines)
│   │   └── [other existing components...]
│   └── types/
│       └── index.ts                      ✏️ UPDATED - Added audit types
├── IMPLEMENTATION_SUMMARY.md              ✨ NEW - This guide
├── AUDIT_LOG_TESTING.md                   ✨ NEW - Testing guide
└── [other project files...]
```

## File Details & Purpose

### 1. Core Service: `src/lib/auditLog.ts`

**Purpose:** Append-only audit log service with in-memory storage using localStorage

**Key Exports:**
- `AuditEntry` interface
- `AuditLogFilter` interface
- `AuditLogService` class with methods:
  - `recordAction()` - Record a new audit entry
  - `getAuditEntries()` - Retrieve entries with optional filtering
  - `getEntriesByAdmin()` - Get entries for specific admin
  - `getEntriesByActionType()` - Get entries by action type
  - `getEntryByTxHash()` - Find entry by transaction hash
  - `getRecentEntries()` - Get last N entries
  - `getEntryCount()` - Get total count
  - `exportLog()` - Export as JSON
  - `clearLog()` - Clear all entries

**Usage:**
```typescript
import AuditLogService from '@/lib/auditLog';

const entry = AuditLogService.recordAction(
  adminAddress,
  'deposit',
  'Processed deposit',
  { amount: '100' },
  'txhash123',
  'success'
);
```

---

### 2. API Endpoint: `src/app/api/admin-audit/route.ts`

**Purpose:** Read-only REST API endpoint for querying audit log entries

**Endpoint:** `GET /api/admin-audit`

**Query Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `actionType` | string | Filter by action type |
| `status` | string | Filter by status |
| `adminAddress` | string | Filter by admin address |
| `txHash` | string | Filter by transaction hash |
| `startDate` | ISO string | Filter from date |
| `endDate` | ISO string | Filter until date |
| `limit` | number | Max entries (default: 100, max: 1000) |
| `offset` | number | Pagination offset (default: 0) |

**Response:**
```typescript
{
  entries: AuditEntry[],
  total: number,
  limit: number,
  offset: number,
  hasMore: boolean
}
```

**HTTP Methods:**
- `GET` - ✅ Allowed
- `POST` - ❌ 405 Not Allowed
- `PUT` - ❌ 405 Not Allowed
- `DELETE` - ❌ 405 Not Allowed

**Examples:**
```bash
# Get all entries
GET /api/admin-audit

# Filter by action type
GET /api/admin-audit?actionType=deposit

# Paginate
GET /api/admin-audit?limit=20&offset=0

# Date range
GET /api/admin-audit?startDate=2024-03-01&endDate=2024-03-31
```

---

### 3. UI Component: `src/components/AuditTable.tsx`

**Purpose:** Interactive, filterable audit log table component

**Component Props:**
```typescript
interface AuditTableProps {
  onRefresh?: () => void;  // Optional callback on data refresh
}
```

**Features:**
- 6 filter fields (actionType, status, admin, txHash, dates)
- Pagination (20 entries per page)
- Real-time filtering
- Status badges with color coding
- Responsive design (mobile, tablet, desktop)
- Dark mode support
- Loading states
- Error handling
- Empty state UI

**Usage:**
```typescript
import AuditTable from '@/components/AuditTable';

export default function AdminPage() {
  return (
    <div>
      <h1>Admin Dashboard</h1>
      <AuditTable onRefresh={() => console.log('Refreshed')} />
    </div>
  );
}
```

---

### 4. Types Definition: `src/types/index.ts` (UPDATED)

**New Interfaces Added:**

```typescript
export interface AuditEntry {
  id: string;
  timestamp: Date;
  adminAddress: string;
  actionType: 'deposit' | 'payout' | 'reconciliation' | 'user_update' | 'settings_change';
  actionDescription: string;
  txHash?: string;
  metadata: Record<string, unknown>;
  status: 'success' | 'failed' | 'pending';
}

export interface AuditLogFilter {
  actionType?: AuditEntry['actionType'];
  adminAddress?: string;
  startDate?: Date;
  endDate?: Date;
  status?: AuditEntry['status'];
  txHash?: string;
}
```

---

### 5. Integration Examples: `src/lib/auditLogExamples.ts`

**Purpose:** Usage patterns and helper functions for recording audit actions

**Exported Functions:**
- `recordDepositAction()` - Record deposit transaction
- `recordPayoutAction()` - Record payout transaction
- `recordFailedTransaction()` - Record transaction failure
- `recordReconciliationAction()` - Record reconciliation
- `recordUserUpdateAction()` - Record user updates
- `recordSettingsChangeAction()` - Record setting changes

**Example:**
```typescript
import { recordDepositAction } from '@/lib/auditLogExamples';

recordDepositAction(
  adminAddress,
  '500',
  recipientAddress,
  'txhash123'
);
```

---

### 6. Admin Page: `src/app/admin/page.tsx` (UPDATED)

**Changes Made:**
- Added import: `import AuditTable from '@/components/AuditTable';`
- Added section at bottom:
  ```jsx
  {/* Audit Log Section */}
  <div className="mt-12">
    <h2 className="text-2xl font-bold text-gray-900 dark:text-white mb-6">
      Audit Log
    </h2>
    <AuditTable />
  </div>
  ```

---

### 7. Testing Guide: `AUDIT_LOG_TESTING.md`

**Contains:**
- Acceptance criteria verification
- End-to-end test workflow
- API query examples
- Integration points
- Production readiness checklist
- Deployment notes

---

### 8. Implementation Summary: `IMPLEMENTATION_SUMMARY.md`

**Contains:**
- Executive summary
- Deliverables checklist
- Step-by-step testing instructions
- Integration guide
- Production readiness verification
- Performance characteristics
- Next steps and recommendations

---

## Quick Navigation

### To Record an Audit Entry
**File:** `src/lib/auditLog.ts`  
**Method:** `AuditLogService.recordAction()`  
**Example:** See `src/lib/auditLogExamples.ts`

### To Query Audit Entries
**File:** `src/app/api/admin-audit/route.ts`  
**Method:** `GET /api/admin-audit`  
**Docs:** See `AUDIT_LOG_TESTING.md`

### To View Audit Table
**File:** `src/components/AuditTable.tsx`  
**Location:** `/admin` page (bottom section)  
**Props:** `AuditTableProps`

### To Add New Action Type
**File 1:** `src/types/index.ts` - Update `AuditEntry.actionType` union  
**File 2:** `src/lib/auditLogExamples.ts` - Add helper function  
**File 3:** `src/components/AuditTable.tsx` - Update filter dropdown

---

## Storage & Persistence

### localStorage Key
```
audit_log_entries
```

### Storage Structure
```json
[
  {
    "id": "audit_1711522400000_a7f3k2j1",
    "timestamp": "2024-03-27T...",
    "adminAddress": "GDQF3...",
    "actionType": "deposit",
    "actionDescription": "...",
    "txHash": "...",
    "metadata": {},
    "status": "success"
  }
]
```

### Storage Limits
- Max capacity: 5-10MB per domain (browser dependent)
- Max entries: 10,000 (oldest auto-pruned when limit reached)
- Per-entry avg size: ~500 bytes

---

## Dependencies

### No New External Dependencies Added ✅

The implementation uses:
- React (already in project)
- Next.js (already in project)
- TypeScript (already in project)
- Tailwind CSS (already in project)
- localStorage API (browser native)

---

## Environment Variables

**None required** for this feature

---

## Build & Deployment

### Development
```bash
npm run dev
```

### Production Build
```bash
npm run build
npm start
```

### Testing
```bash
npm run test:unit          # If vitest configured
npm run test:e2e           # If playwright configured
```

---

## Code Quality

- ✅ TypeScript strict mode compatible
- ✅ No console warnings with d

/* … truncated 2192 chars — edit only what you need near the top … */
