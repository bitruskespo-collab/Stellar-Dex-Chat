import '@testing-library/jest-dom';
import { afterEach, beforeAll, beforeEach, vi } from 'vitest';
import { resetNetworkQueueForTests } from '@/lib/networkQueue';

vi.mock('server-only', () => ({}));

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] || null),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value.toString();
    }),
    clear: vi.fn(() => {
      store = {};
    }),
    removeItem: vi.fn((key: string) => {
      delete store[key];
    }),
    key: vi.fn((index: number) => Object.keys(store)[index] || null),
    get length() {
      return Object.keys(store).length;
    },
  };
})();

Object.defineProperty(window, 'localStorage', { value: localStorageMock });

global.ResizeObserver = vi.fn().mockImplementation(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
}));

// Mock scrollIntoView for all elements
Element.prototype.scrollIntoView = vi.fn();
window.scrollTo = vi.fn();

// Mock fetch by default
if (!global.fetch) {
  global.fetch = vi
    .fn()
    .mockImplementation(() => Promise.resolve(new Response()));
} else {
  vi.spyOn(global, 'fetch').mockImplementation(() =>
    Promise.resolve(new Response()),
  );
}

const originalError = console.error;
console.error = (...args: unknown[]) => {
  if (
    typeof args[0] === 'string' &&
    (args[0].includes('act(') || args[0].includes('Warning: An update to'))
  ) {
    return;
  }
  originalError.apply(console, args);
};

afterEach(() => {
  resetNetworkQueueForTests();
});

// ---------------------------------------------------------------------------
// Database-backed concurrency suite setup.
//
// The payout idempotency race tests run against the production database engine
// (Postgres) using a throwaway, locally provisioned database. They are opt-in:
// when TEST_DATABASE_URL is not set the suite is skipped so the default unit
// test run never requires a database. Fixtures must never contain real
// credentials or user data; only synthetic values are used.
// ---------------------------------------------------------------------------
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

export const hasTestDatabase = Boolean(TEST_DATABASE_URL);

// Tables touched by the payout idempotency race tests. Truncated between tests
// so each case starts from a clean slate; CASCADE handles dependent rows.
const PAYOUT_TABLES = [
  'payout_retry_jobs',
  'webhook_events',
  'payouts',
  'payout_recipients',
] as const;

if (hasTestDatabase) {
  // Lazily import the DB helpers so the default (no database) run never loads
  // the Postgres driver.
  const loadDb = async () => {
    const { applyMigrations, truncateTables } = await import(
      '@/lib/db/testDatabase'
    );
    return { applyMigrations, truncateTables };
  };

  beforeAll(async () => {
    const { applyMigrations } = await loadDb();
    await applyMigrations(TEST_DATABASE_URL as string);
  }, 60_000);

  beforeEach(async () => {
    const { truncateTables } = await loadDb();
    await truncateTables(TEST_DATABASE_URL as string, [...PAYOUT_TABLES]);
  });
} else {
  // Mark the DB-backed suite as skipped when no test database is configured.
  beforeAll(() => {
    // eslint-disable-next-line no-console
    console.warn(
      '[vitest] TEST_DATABASE_URL not set; skipping database concurrency tests.',
    );
  });
}
