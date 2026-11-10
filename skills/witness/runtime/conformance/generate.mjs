#!/usr/bin/env node
// Builds conformance vectors from evidence produced by the eval suite (both runtimes).
// The Node implementation is the reference: expected outputs come from it, and both
// runtime test suites must reproduce them exactly from the same inputs.
//
//   node skills/witness/runtime/conformance/generate.mjs   (after `npm run eval -- --lang both --keep`)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readHar } from '../node/lib/har.mjs';
import { buildAnalysis } from '../node/lib/analysis.mjs';
import { compareFidelity, vacuityPlan, assertionSignature } from '../node/lib/verify.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../../..');
const SOURCES = [
  { name: 'ts-shop-apply-coupon-raw', project: 'examples/shop/e2e', flow: 'apply-coupon', runs: ['raw-run-1'], har: true },
  { name: 'ts-shop-apply-coupon-prepared', project: 'examples/shop/e2e', flow: 'apply-coupon', runs: ['prepared-run-1', 'prepared-run-2'], verify: true },
  { name: 'ts-shop-admin-product-raw', project: 'examples/shop/e2e', flow: 'admin-product', runs: ['raw-run-1'], har: true },
  { name: 'ts-clinic-book-appointment-raw', project: 'examples/clinic/e2e', flow: 'book-appointment', runs: ['raw-run-1'], har: true },
  { name: 'py-library-borrow-return-raw', project: 'examples/library/e2e-py', flow: 'borrow-return', runs: ['raw-run-1', 'raw-run-2'], har: true, verify: true },
  { name: 'py-clinic-new-patient-prepared', project: 'examples/clinic/e2e-py', flow: 'new-patient', runs: ['prepared-run-1', 'prepared-run-2'], verify: true },
];

const strip = (a) => { const { analyzedAt, ...rest } = a; return rest; };
let made = 0;
for (const s of SOURCES) {
  const dir = path.join(ROOT, s.project, '.witness', 'recordings', s.flow);
  const ev = (n) => path.join(dir, 'evidence', `${n}.json`);
  if (!s.runs.every((n) => fs.existsSync(ev(n)))) { console.log(`skip ${s.name} (no evidence; run the evals with --keep first)`); continue; }
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, s.project, '.witness', 'config.json'), 'utf8'));
  const origin = new URL(cfg.baseURL).origin;
  const runs = s.runs.map((n) => JSON.parse(fs.readFileSync(ev(n), 'utf8')));
  const har = s.har ? readHar(path.join(dir, 'network.har')) : null;
  const input = { flow: s.flow, origin, har, runs };
  const analysis = buildAnalysis({ flow: s.flow, runs, harCalls: har, origin });
  const expected = { analysis: strip(analysis) };
  if (s.verify && fs.existsSync(ev('verify-observe'))) {
    input.generated = JSON.parse(fs.readFileSync(ev('verify-observe'), 'utf8'));
    expected.fidelity = compareFidelity(analysis.baseline, input.generated);
    expected.vacuityPlan = vacuityPlan(input.generated);
    expected.signatures = (input.generated.assertions || []).map(assertionSignature);
  }
  const out = path.join(HERE, 'vectors', s.name);
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'input.json'), JSON.stringify(input));
  fs.writeFileSync(path.join(out, 'expected.json'), JSON.stringify(expected, null, 1));
  made++;
  console.log(`wrote ${s.name}`);
}
console.log(`${made} vector(s)`);
