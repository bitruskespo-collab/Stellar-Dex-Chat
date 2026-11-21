#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const TARGETS = [
  'fixtures',
  'src/lib/fixtures',
  'src/lib/payout/__fixtures__',
  'tests/fixtures',
  '../stellar-contracts/fixtures',
];

const FORBIDDEN_PATTERNS = [
  { reason: 'Live Paystack secret key', regex: /\bsk_live_[A-Za-z0-9]+\b/g },
  { reason: 'Live Paystack public key', regex: /\bpk_live_[A-Za-z0-9]+\b/g },
  { reason: 'Stripe live key', regex: /\b(?:rk_live|sk_live|pk_live)_[A-Za-z0-9]+\b/g },
  { reason: 'AWS access key id', regex: /\bAKIA[0-9A-Z]{16}\b/g },
  { reason: 'GitHub token', regex: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g },
  { reason: 'Private key block', regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
];

const SENSITIVE_ASSIGNMENT =
  /\b(api[_-]?key|secret|password|token|credential|private[_-]?key)\b"?\s*[:=]\s*["']([^"'\n]{8,})["']/gi;
const ALLOWED_VALUE_PATTERNS = [
  /^test/i,
  /^fake/i,
  /^synthetic/i,
  /^dummy/i,
  /^example/i,
  /^placeholder/i,
  /^changeme/i,
  /^sk_test_/i,
  /^pk_test_/i,
  /^rk_test_/i,
  /^whsec_test_/i,
  /^xoxb-test/i,
  /^G[A-Z2-7]{55}$/,
  /^C[A-Z2-7]{55}$/,
  /^\*+$/,
  /^\[REDACTED\]$/,
];

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(json|ts|tsx|js|mjs|cjs|md|ya?ml)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function isAllowed(value) {
  return ALLOWED_VALUE_PATTERNS.some((p) => p.test(value));
}

const violations = [];
for (const target of TARGETS) {
  for (const file of walk(path.join(ROOT, target))) {
    const rel = path.relative(ROOT, file);
    if (rel.endsWith('src/lib/fixtures/fixtures.test.ts')) continue; // self-test contains intentional violation strings
    const text = fs.readFileSync(file, 'utf8');
    for (const { reason, regex } of FORBIDDEN_PATTERNS) {
      regex.lastIndex = 0;
      if (regex.test(text)) violations.push(`${rel}: ${reason}`);
    }
    SENSITIVE_ASSIGNMENT.lastIndex = 0;
    let m;
    while ((m = SENSITIVE_ASSIGNMENT.exec(text)) !== null) {
      const key = m[1];
      const value = m[2];
      if (!isAllowed(value)) violations.push(`${rel}: sensitive assignment looks non-synthetic (${key})`);
    }
  }
}

if (violations.length > 0) {
  console.error('Fixture privacy guard failed:');
  for (const v of violations) console.error(`- ${v}`);
  process.exit(1);
}
console.log('Fixture privacy guard passed.');
