/**
 * @fileoverview Playwright global teardown: clean up fixture temp files and
 * the optional payout-provider stub started by global-setup.
 *
 * Teardown runs even when tests fail, so resources are always freed.
 */

import * as fs from 'node:fs';
import { FIXTURE_TEMP_PATH } from './global-setup';

export default async function globalTeardown(): Promise<void> {
  // Stop the payout stub server if it was started
  const server = (
    global as Record<string, unknown>
  )['__E2E_PAYOUT_STUB_SERVER__'];

  if (server && typeof (server as { close?: unknown }).close === 'function') {
    await new Promise<void>((resolve) => {
      (server as { close: (cb: () => void) => void }).close(resolve);
    });
    console.log('[e2e-teardown] Payout provider stub stopped');
  }

  // Remove the fixture temp file
  const fixturePath = process.env['E2E_FIXTURE_PATH'] ?? FIXTURE_TEMP_PATH;
  if (fs.existsSync(fixturePath)) {
    fs.unlinkSync(fixturePath);
    console.log(`[e2e-teardown] Removed fixture file: ${fixturePath}`);
  }
}
