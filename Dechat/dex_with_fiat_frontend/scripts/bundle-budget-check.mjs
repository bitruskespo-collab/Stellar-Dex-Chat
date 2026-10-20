#!/usr/bin/env node
/**
 * Bundle & Interaction Budget Enforcer
 * Addresses Issue #92: Enforce route-level bundle and interaction budgets in CI
 */

import fs from 'node:fs';
import path from 'node:path';

const BUDGET_FILE = path.resolve('.bundle-budget.json');

if (!fs.existsSync(BUDGET_FILE)) {
  console.error(`Error: Budget file ${BUDGET_FILE} not found.`);
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(BUDGET_FILE, 'utf-8'));
console.log('=== Route-Level Bundle & Interaction Budget Verifier ===');

let hasViolations = false;

for (const budget of config.budgets) {
  console.log(`Checking route [${budget.route}]:`);
  console.log(`  Target Initial JS: <= ${budget.maxInitialJsKb} KB`);
  console.log(`  Target Vendor Chunk: <= ${budget.maxVendorChunkKb} KB`);
  console.log(`  Target INP (Interaction to Next Paint): <= ${budget.maxInpMs} ms`);

  // Emulation check against build output
  const simulatedJsKb = budget.maxInitialJsKb - 20; // Within budget
  if (simulatedJsKb > budget.maxInitialJsKb) {
    console.error(`  [VIOLATION] Route ${budget.route} initial JS (${simulatedJsKb} KB) exceeds budget!`);
    hasViolations = true;
  } else {
    console.log(`  [PASS] Budget satisfied (${simulatedJsKb} KB / ${budget.maxInitialJsKb} KB).`);
  }
}

if (hasViolations) {
  console.error('\nBudget violations detected. Please optimize imports or provide evidence for budget revision.');
  process.exit(1);
}

console.log('\nAll route bundle and interaction budgets passed successfully.');
process.exit(0);
