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
 *   2 - Sensitive payout encryption variables are misconfigured, or
 *       wildcard / unnecessary production permissions were detected
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
 * Environment variables that describe service credentials, roles or data-store
 * privileges. In production these must be least-privilege: no wildcard scopes
 * and no broad administrative roles.
 */
const PERMISSION_VARIABLE_PATTERN = /(PERMISSION|ROLE|SCOPE|PRIVILEGE|GRANT)/i;

/**
 * Tokens that indicate an over-broad permission grant. Matched as whole tokens
 * (case-insensitive) so that values like "readonly" or "reader" are allowed.
 */
const WILDCARD_PERMISSION_TOKENS = ['*', 'all', 'admin', 'superuser', 'root', 'owner'];

/**
 * Split a permission value into individual tokens. Supports comma, whitespace,
 * semicolon and pipe separated lists.
 */
function tokenizePermissionValue(value: string): string[] {
  return value
    .split(/[\s,;|]+/)
    .map(token => token.trim())
    .filter(token => token !== '');
}

/**
 * Determine whether a permission value contains a wildcard or unnecessary
 * broad grant. Returns the offending tokens (empty when the value is fine).
 */
export function findWildcardPermissions(value: string): string[] {
  const offending: string[] = [];
  for (const token of tokenizePermissionValue(value)) {
    const normalized = token.toLowerCase();
    if (WILDCARD_PERMISSION_TOKENS.includes(normalized)) {
      offending.push(token);
      continue;
    }
    // Catch scoped wildcards such as "payments:*" or "db.*".
    if (normalized.includes('*')) {
      offending.push(token);
    }
  }
  return offending;
}

/**
 * Inspect permission/role related assignments for wildcard grants. Only
 * enforced when NODE_ENV is production so local development stays ergonomic.
 */
export function validateProductionPermissions(
  assignments: Map<string, string>,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): boolean {
  if (nodeEnv !== 'production') {
    return true;
  }

  let isValid = true;
  for (const [key, value] of assignments) {
    if (!PERMISSION_VARIABLE_PATTERN.test(key)) {
      continue;
    }
    const offending = findWildcardPermissions(value);
    if (offending.length > 0) {
      console.error(
        `❌ ERROR: ${key} grants wildcard or unnecessary production permissions ` +
          `(${offending.join(', ')}). Use a least-privilege role instead.`,
      );
      isValid = false;
    }
  }

  return isValid;
}

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

  if (!validateProductionPermissions(extractEnvExampleAssignments())) {
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
