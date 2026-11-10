// Node side of the conformance suite: the analysis must reproduce the recorded expectations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAnalysis } from '../lib/analysis.mjs';
import { compareFidelity, vacuityPlan, assertionSignature } from '../lib/verify.mjs';
import { templatePath, regexFor, stripHarReplay } from '../lib/util.mjs';

const VECTORS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'conformance', 'vectors');
const normalize = (x) => JSON.parse(JSON.stringify(x));

for (const name of fs.existsSync(VECTORS) ? fs.readdirSync(VECTORS) : []) {
  test(`conformance: ${name}`, () => {
    const input = JSON.parse(fs.readFileSync(path.join(VECTORS, name, 'input.json'), 'utf8'));
    const expected = JSON.parse(fs.readFileSync(path.join(VECTORS, name, 'expected.json'), 'utf8'));
    const { analyzedAt, ...analysis } = buildAnalysis({ flow: input.flow, runs: input.runs, harCalls: input.har, origin: input.origin });
    assert.deepEqual(normalize(analysis), expected.analysis);
    if (input.generated) {
      assert.deepEqual(normalize(compareFidelity(analysis.baseline, input.generated)), expected.fidelity);
      assert.deepEqual(normalize(vacuityPlan(input.generated)), expected.vacuityPlan);
      assert.deepEqual((input.generated.assertions || []).map(assertionSignature), expected.signatures);
    }
  });
}

test('templatePath replaces id-like segments', () => {
  assert.equal(templatePath('/api/loans/12/return'), '/api/loans/:id/return');
  assert.equal(templatePath('/orders/ORD-1042?x=1'), '/orders/:id');
  assert.equal(templatePath('/api/products'), '/api/products');
  assert.equal(templatePath('/a/3f2b9c1e-0000-4000-8000-1234567890ab'), '/a/:id');
});

test('regexFor turns numbers into \\d+', () => {
  assert.equal(regexFor('Order #1042 confirmed'), 'Order #\\d+ confirmed');
  assert.equal(regexFor('$45.00'), '\\$\\d+\\.\\d+');
});

test('stripHarReplay removes the routeFromHAR call codegen adds with --save-har', () => {
  const raw = [
    "test('test', async ({ page }) => {",
    "  await page.routeFromHAR('/x/network.har', {",
    "    url: 'http://localhost:4101/**'",
    '  });',
    "  await page.goto('http://localhost:4101/cart');",
    "  await context.routeFromHAR('/x/network.har');",
    "  await page.getByRole('button', { name: 'Apply' }).click();",
    '});',
    '',
  ].join('\n');
  assert.equal(stripHarReplay(raw), [
    "test('test', async ({ page }) => {",
    "  await page.goto('http://localhost:4101/cart');",
    "  await page.getByRole('button', { name: 'Apply' }).click();",
    '});',
    '',
  ].join('\n'));
});
