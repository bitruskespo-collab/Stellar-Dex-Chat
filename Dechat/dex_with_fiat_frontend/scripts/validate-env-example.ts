#!/usr/bin/env tsx
/**
 * Validates that .env.example contains all variables declared in src/lib/env.ts
 * and does not list variables that are not read by the application.
 *
 * Usage:
 *   pnpm exec tsx scripts/validate-env-example.ts
 *
 * Exit codes:
 *   0 - All variables match
 *   1 - Missing variables or extra variables found
 *   2 - Sensitive payout encryption variables are misconfigured
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const ENV_EXAMPLE_PATH = join(__dirname, '../.env.example');
const ENV_TS_PATH = join(__dirname, '../src/lib/env.ts');

/**
 * Variables that hold payout encryption key material. These must never be
 * committed with real values and must be supplied through the configured
 * secret-management boundary (see SECURITY.md).
 */
const PAYOUT_KEY_VARIABLES = [
  'PAYOUT_ENCRYPTION_KEYS',
  'PAYOUT_ENCRYPTION_ACTIVE_KEY_ID',
  'PAYOUT_LOOKUP_DIGEST_KEY',
];

/**
 * Extract variable names from env.ts schema definitions
 */
function extractEnvTsVariables(): Set<string> {
  const envTsContent = readFileSync(ENV_TS_PATH, 'utf-8');
  const variables = new Set<string>();

  // Match lines like: VARIABLE_NAME: z.string()...
  const schemaPattern = /^\s*([A-Z_][A-Z0-9_]*)\s*:/gm;
  let match;

  while ((match = schemaPattern.exec(envTsContent)) !== null) {
    variables.add(match[1]);
  }

  return variables;
}

/**
 * Extract non-comment variable names from .env.example
 */
function extractEnvExampleVariables(): Set<string> {
  const envExampleContent = readFileSync(ENV_EXAMPLE_PATH, 'utf-8');
  const variables = new Set<string>();

  const lines = envExampleContent.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    
    // Skip comments and empty lines
    if (trimmed.startsWith('#') || trimmed === '') {
      continue;
    }

    // Extract variable name from KEY=value or # KEY=value
    const match = trimmed.match(/^#?\s*([A-Z_][A-Z0-9_]*)=/);
    if (match) {
      variables.add(match[1]);
    }
  }

  return variables;
}

/**
 * Extract raw KEY=value pairs (non-comment) from .env.example so we can
 * verify that sensitive payout key material is never committed with a value.
 */
function extractEnvExampleAssignments(): Map<string, string> {
  const envExampleContent = readFileSync(ENV_EXAMPLE_PATH, 'utf-8');
  const assignments = new Map<string, string>();

  for (const line of envExampleContent.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || trimmed === '') {
      continue;
    }
    const match = trimmed.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match) {
      assignments.set(match[1], match[2].trim());
    }
  }

  return assignments;
}

/**
 * Ensure payout encryption key material is declared but never populated with a
 * real value in .env.example. Keys must come from the secret-management
 * boundary at runtime; committing them would defeat the encryption guarantee.
 */
function validatePayoutKeyMaterial(): boolean {
  const assignments = extractEnvExampleAssignments();
  let isValid = true;

  for (const key of PAYOUT_KEY_VARIABLES) {
    if (!assignments.has(key)) {
      continue;
    }
    const value = assignments.get(key) ?? '';
    if (value !== '') {
      console.error(
        `❌ ERROR: ${key} must not be committed with a value in .env.example. ` +
          'Supply it via the configured secret-management boundary.',
      );
      isValid = false;
    }
  }

  return isValid;
}

/**
 * Main validation logic
 */
function validateEnvExample(): boolean {
  const schemaVars = extractEnvTsVariables();
  const exampleVars = extractEnvExampleVariables();

  // Find variables in schema but not in .env.example
  const missingInExample = [...schemaVars].filter(v => !exampleVars.has(v));

  // Find variables in .env.example but not in schema
  const extraInExample = [...exampleVars].filter(v => !schemaVars.has(v));

  let isValid = true;

  if (missingInExample.length > 0) {
    console.error('❌ ERROR: Variables declared in env.ts but missing from .env.example:');
    missingInExample.forEach(v => console.error(`  - ${v}`));
    isValid = false;
  }

  if (extraInExample.length > 0) {
    console.error('❌ ERROR: Variables in .env.example that are not read by env.ts:');
    extraInExample.forEach(v => console.error(`  - ${v}`));
    isValid = false;
  }

  if (!validatePayoutKeyMaterial()) {
    isValid = false;
  }

  if (isValid) {
    console.log('✅ SUCCESS: .env.example matches env.ts schema');
    console.log(`   Found ${schemaVars.size} variables`);
  }

  return isValid;
}

// Run validation
const envValid = validateEnvExample();
const alertsValid = validateAlertThresholds();
process.exit(envValid && alertsValid ? 0 : 1);
