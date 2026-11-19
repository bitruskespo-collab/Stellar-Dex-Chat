import '@testing-library/jest-dom';
import { afterEach, beforeEach, vi } from 'vitest';
import { resetNetworkQueueForTests } from '@/lib/networkQueue';
import { resetRateLimitersForTests } from '@/lib/rateLimit';
import { resetTransferStoreForTests } from '@/lib/transferStore';
import { resetProviderMocksForTests } from '@/lib/providers';

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

beforeEach(() => {
  // Contract tests must only ever see synthetic fixtures; fail fast if a
  // real credential or user identifier leaks into the environment.
  const forbiddenEnvKeys = [
    'DEX_API_KEY',
    'DEX_API_SECRET',
    'PROVIDER_API_KEY',
    'PROVIDER_API_SECRET',
  ];
  for (const key of forbiddenEnvKeys) {
    if (process.env[key]) {
      throw new Error(
        `Contract tests must not run with real credentials (${key} is set).`,
      );
    }
  }
  resetProviderMocksForTests();
  resetTransferStoreForTests();
  resetRateLimitersForTests();
});

afterEach(() => {
  resetNetworkQueueForTests();
  resetProviderMocksForTests();
  resetTransferStoreForTests();
  resetRateLimitersForTests();
});
