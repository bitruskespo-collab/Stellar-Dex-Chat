/**
 * @fileoverview Playwright global setup: provision the deterministic fixture
 * environment before any E2E tests run.
 *
 * What this does
 * ──────────────
 * 1. Generates the full-stack fixture from the run seed (default or
 *    E2E_FIXTURE_SEED env var) so every test in the run shares one
 *    deterministic snapshot.
 * 2. Writes the fixture to a temp file so individual test files can import it
 *    without re-running the generator.
 * 3. Optionally starts an in-process payout-provider HTTP stub on
 *    E2E_PAYOUT_PROVIDER_URL (default http://127.0.0.1:8787).  The stub
 *    returns the fixture's deterministic Paystack envelopes for the normal
 *    path and can be switched to failure mode via a `/__fixture/mode` control
 *    endpoint.
 *
 * The setup never touches production Soroban endpoints.  Playwright's
 * webServer handles the Next.js dev/prod process; setup here is limited to
 * the disposable test infrastructure the app routes depend on.
 *
 * Environment variables
 * ──────────────────────
 * E2E_FIXTURE_SEED          Seed string (default: 'stellar-dex-fixture-v1')
 * E2E_PAYOUT_STUB_ENABLED   Set to 'true' to start the in-process provider
 *                            stub (default: off — tests mock at the axios layer)
 * E2E_PAYOUT_PROVIDER_URL   Where to bind the stub (default: http://127.0.0.1:8787)
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { generateFixture, DEFAULT_SEED } from './generator';
import type { FullStackFixture } from './schema';

/** Path where the fixture JSON is written so test files can read it fast. */
export const FIXTURE_TEMP_PATH = path.join(
  os.tmpdir(),
  `e2e-fixture-${process.pid}.json`,
);

/** Global symbol used to store the HTTP server reference for teardown. */
const STUB_SERVER_SYMBOL = '__E2E_PAYOUT_STUB_SERVER__';

declare global {
  // eslint-disable-next-line no-var
  var __E2E_PAYOUT_STUB_SERVER__: http.Server | undefined;
}

export default async function globalSetup(): Promise<void> {
  const seed = process.env['E2E_FIXTURE_SEED'] ?? DEFAULT_SEED;
  const stubEnabled = process.env['E2E_PAYOUT_STUB_ENABLED'] === 'true';
  const stubUrl =
    process.env['E2E_PAYOUT_PROVIDER_URL'] ?? 'http://127.0.0.1:8787';

  // 1. Generate the fixture
  const fixture = generateFixture(seed);
  const fixtureJson = JSON.stringify(fixture, null, 2);

  // 2. Write to temp file for fast access by test files
  fs.writeFileSync(FIXTURE_TEMP_PATH, fixtureJson, 'utf-8');
  process.env['E2E_FIXTURE_PATH'] = FIXTURE_TEMP_PATH;
  process.env['E2E_FIXTURE_SEED'] = seed;

  // 3. Start payout-provider stub (opt-in only, default off)
  if (stubEnabled) {
    const server = createPayoutStub(fixture);
    const parsed = new URL(stubUrl);
    const port = parseInt(parsed.port || '8787', 10);
    const host = parsed.hostname || '127.0.0.1';

    await new Promise<void>((resolve, reject) => {
      server.listen(port, host, resolve);
      server.once('error', reject);
    });

    global[STUB_SERVER_SYMBOL] = server;
    console.log(`[e2e-setup] Payout provider stub running at ${stubUrl}`);
  }

  console.log(
    `[e2e-setup] Fixture generated (seed="${seed}", ` +
    `ledgers=${fixture.ledgerHistory.length}, ` +
    `events=${fixture.events.length}, ` +
    `written to ${FIXTURE_TEMP_PATH})`,
  );
}

/**
 * Load the fixture written by global-setup.  Call this from test files that
 * need the full fixture rather than re-running the generator.
 */
export function loadFixture(): FullStackFixture {
  const fixturePath = process.env['E2E_FIXTURE_PATH'] ?? FIXTURE_TEMP_PATH;
  if (!fs.existsSync(fixturePath)) {
    // Fallback: regenerate from the seed (useful when running a subset of
    // tests directly without the full Playwright runner).
    const seed = process.env['E2E_FIXTURE_SEED'] ?? DEFAULT_SEED;
    return generateFixture(seed);
  }
  return JSON.parse(fs.readFileSync(fixturePath, 'utf-8')) as FullStackFixture;
}

// ─── In-process payout provider stub ─────────────────────────────────────

type StubMode = 'normal' | 'invalidAccount' | 'rateLimited' | 'insufficientFunds' | 'outage' | 'authError';

interface StubState {
  mode: StubMode;
  fixture: FullStackFixture;
}

function createPayoutStub(fixture: FullStackFixture): http.Server {
  const state: StubState = { mode: 'normal', fixture };

  return http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');

    // Control endpoint: POST /__fixture/mode  { "mode": "invalidAccount" }
    if (req.url === '/__fixture/mode' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body) as { mode?: string };
          state.mode = (parsed.mode ?? 'normal') as StubMode;
          res.writeHead(200);
          res.end(JSON.stringify({ ok: true, mode: state.mode }));
        } catch {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'invalid json' }));
        }
      });
      return;
    }

    // Control endpoint: GET /__fixture/state — returns current fixture summary
    if (req.url === '/__fixture/state' && req.method === 'GET') {
      res.writeHead(200);
      res.end(
        JSON.stringify({
          seed: state.fixture.seed,
          mode: state.mode,
          currentLedger: state.fixture.contractState.currentLedger,
          wqDepth: state.fixture.contractState.wqDepth,
        }),
      );
      return;
    }

    // Paystack-compatible API stub
    const url = req.url ?? '/';
    const method = req.method ?? 'GET';
    let body = '';

    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => {
      const response = routePaystack(url, method, body, state);
      res.writeHead(response.status);
      res.end(JSON.stringify(response.body));
    });
  });
}

function routePaystack(
  url: string,
  method: string,
  _body: string,
  state: StubState,
): { status: number; body: unknown } {
  const f = state.fixture.provider;

  // Failure mode routing
  if (state.mode !== 'normal') {
    const errorMap: Partial<Record<StubMode, keyof typeof f.failures>> = {
      invalidAccount: 'invalidAccount',
      rateLimited: 'rateLimited',
      insufficientFunds: 'insufficientFunds',
      outage: 'providerOutage',
      authError: 'authenticationError',
    };
    const errorKey = errorMap[state.mode];
    if (errorKey) {
      const failure = f.failures[errorKey];
      return {
        status: failure.httpStatus,
        body: failure.axiosRejection.response.data,
      };
    }
  }

  // Normal-path routing — Paystack API shape
  if (method === 'GET' && url.includes('/bank/resolve')) {
    return { status: 200, body: f.paystackEnvelopes.resolveAccount };
  }
  if (method === 'POST' && url.includes('/transferrecipient')) {
    return { status: 200, body: f.paystackEnvelopes.createRecipient };
  }
  if (method === 'POST' && url.includes('/transfer')) {
    return { status: 200, body: f.paystackEnvelopes.initiateTransfer };
  }
  if (method === 'GET' && url.match(/\/transfer\/verify\//)) {
    return { status: 200, body: f.paystackEnvelopes.verifyTransfer };
  }
  if (method === 'GET' && url.includes('/bank')) {
    return {
      status: 200,
      body: { status: true, message: 'Banks retrieved', data: f.banks },
    };
  }

  return { status: 404, body: { status: false, message: 'Not found' } };
}
