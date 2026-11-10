// Checks a generated spec against the raw-replay baseline and the Witness rules.
import fs from 'node:fs';
import path from 'node:path';
import { templatePath, statusClass, exists } from './util.mjs';
import { actionClass, lcs, mutationsOf } from './analysis.mjs';

function sig(step) {
  const cls = actionClass(step.method);
  const t = step.target || {};
  const a = Array.isArray(step.args) ? step.args : [];
  return {
    index: step.index, class: cls, role: t.role ?? null, name: t.name ?? null, testId: t.attrs?.testId ?? null, label: t.attrs?.label ?? null,
    locator: t.locator || null, value: ['fill', 'type', 'pressSequentially', 'press', 'selectOption', 'goto'].includes(step.method) ? a[0] : undefined,
    nav: cls === 'nav' ? templatePath(String(a[0] || '').replace(/^https?:\/\/[^/]+/, '')) : null,
  };
}

function sameAction(b, g) {
  const cls = (x) => (x === 'key' ? 'input' : x);
  if (cls(b.class) !== cls(g.class)) return false;
  if (b.class === 'nav') return b.nav === g.nav;
  if (b.role && g.role && b.name && g.name) return b.role === g.role && b.name.toLowerCase() === g.name.toLowerCase();
  if (b.testId && g.testId) return b.testId === g.testId;
  if (b.label && g.label) return b.label === g.label;
  if (b.role && g.role && !b.name && !g.name) return b.role === g.role;
  return false;
}

const fmtA = (a) => `${a.class}${a.nav ? ' ' + a.nav : ''}${a.role ? ` ${a.role}` : ''}${a.name ? ` "${a.name}"` : ''}${a.testId ? ` [testid=${a.testId}]` : ''}`;

export function compareFidelity(baseline, ev) {
  const errors = [], warnings = [], info = [];
  const gen = (ev.steps || []).map(sig);
  const base = baseline.actions;
  const required = base.filter((a) => !a.optional);
  const { pairs, onlyA, onlyB } = lcs(base, gen, sameAction, (a) => (a.optional ? 1 : 1000));
  for (const a of onlyA) {
    if (a.optional) info.push(`dropped optional step ${a.index} (${a.optional}): ${fmtA(a)}`);
    else errors.push(`missing action from the recording: step ${a.index} ${fmtA(a)}`);
  }
  for (const g of onlyB) {
    if (g.class === 'hover' || g.class === 'nav') warnings.push(`extra action not in the recording: ${fmtA(g)}`);
    else errors.push(`extra action not in the recording: ${fmtA(g)} (${g.locator || ''})`);
  }
  for (const [b, g] of pairs) {
    if (b.value !== undefined && g.value !== undefined && JSON.stringify(b.value) !== JSON.stringify(g.value) && b.class !== 'nav') {
      info.push(`value substituted at recorded step ${b.index}: ${JSON.stringify(b.value)} → ${JSON.stringify(g.value)}`);
    }
  }
  const matchedRequired = pairs.filter(([b]) => !b.optional).length;

  const genNav = (ev.requests || []).filter((r) => r.sameOrigin && r.resourceType === 'document').map((r) => templatePath(r.path)).filter((x, i, l) => i === 0 || x !== l[i - 1]);
  const navCmp = lcs(baseline.navigation, genNav, (a, b) => a === b);
  for (const n of navCmp.onlyA) errors.push(`page visited in the recording but not by the test: ${n}`);
  for (const n of navCmp.onlyB) warnings.push(`page visited by the test but not in the recording: ${n}`);

  const genMut = mutationsOf(ev).map((m) => ({ method: m.method, template: m.template, statusClass: statusClass(m.status) }));
  const mutCmp = lcs(baseline.mutations, genMut, (a, b) => a.method === b.method && a.template === b.template);
  for (const m of mutCmp.onlyA) errors.push(`app call in the recording missing from the test: ${m.method} ${m.template} (${m.statusClass})`);
  for (const m of mutCmp.onlyB) errors.push(`app call made by the test but not in the recording: ${m.method} ${m.template} (${m.statusClass})`);
  for (const [a, b] of mutCmp.pairs) if (a.statusClass !== b.statusClass) errors.push(`app call ${a.method} ${a.template} returned ${b.statusClass}, recording had ${a.statusClass}`);

  return {
    ok: errors.length === 0, errors, warnings, info,
    stats: { requiredActions: required.length, matchedRequired, generatedActions: gen.length },
  };
}

export function vacuityPlan(ev) {
  const assertions = (ev.assertions || [])
    .filter((a) => a.kind === 'locator' || a.kind === 'page')
    .map((a) => ({ order: a.order, afterStep: a.afterStep, kind: a.kind, matcher: a.matcher, pyMatcher: a.pyMatcher, isNot: a.isNot, args: a.args, kwargs: a.kwargs, selector: a.selector, locator: a.locator }))
    .filter((a) => a.afterStep >= 0);
  const INPUT = ['fill', 'type', 'pressSequentially', 'selectOption'];
  const values = (ev.steps || [])
    .filter((s) => INPUT.includes(s.method) && Array.isArray(s.args) && typeof s.args[0] === 'string')
    .map((s) => ({ step: s.index, value: s.args[0] }));
  return { assertions, values };
}

export function vacuityResults(plan, ev) {
  const errors = [], warnings = [];
  const byOrder = new Map((ev.vacuity || []).map((v) => [v.order, v]));
  for (const p of plan.assertions) {
    const r = byOrder.get(p.order);
    const desc = `${p.locator}${p.isNot ? '.not' : ''}.${p.matcher}(${(p.args || []).filter((x) => !(x && typeof x === 'object' && !Array.isArray(x) && !('$regex' in x))).map((x) => JSON.stringify(x)).join(', ')})`;
    if (!r || !r.checked) warnings.push(`could not check whether assertion is vacuous: ${desc}`);
    else if (r.passedBeforeAction) errors.push(`vacuous assertion (already true before the action it follows, step ${p.afterStep}): ${desc}`);
  }
  return { ok: errors.length === 0, errors, warnings, checked: plan.assertions.length };
}

/** Assertion signature used by the lock: what is asserted, not how the element is located. */
export function assertionSignature(a) {
  const args = (a.args || []).filter((x) => !(x && typeof x === 'object' && !Array.isArray(x) && !('$regex' in x) && !('$locator' in x)));
  return `${a.isNot ? 'not.' : ''}${a.matcher}(${JSON.stringify(args)})`;
}

export function lockCheck(flowMeta, ev) {
  if (!flowMeta || !flowMeta.checkpoints) return { ok: true, locked: false, errors: [], warnings: ['assertions are not locked yet (run `witness lock` after the first passing verify)'] };
  const want = flowMeta.checkpoints.map((c) => c.signature).sort();
  const have = (ev.assertions || []).filter((a) => a.kind !== 'value').map(assertionSignature).sort();
  const errors = [];
  const w = [...want], h = [...have];
  for (const s of want) { const i = h.indexOf(s); if (i >= 0) { h.splice(i, 1); w.splice(w.indexOf(s), 1); } }
  for (const s of w) errors.push(`locked checkpoint missing or changed: ${s}`);
  for (const s of h) errors.push(`assertion not in the locked set: ${s}`);
  if (errors.length) errors.push('Assertions can only change through a re-record (/witness:re-record).');
  return { ok: errors.length === 0, locked: true, errors, warnings: [] };
}

const LINT = [
  { re: /waitForTimeout\s*\(/, msg: 'uses waitForTimeout (fixed sleeps hide timing bugs); wait on a web-first assertion instead', level: 'error' },
  { re: /page\.pause\s*\(/, msg: 'contains page.pause()', level: 'error' },
  { re: /nth-child|nth-of-type/, msg: 'uses positional CSS (nth-child/nth-of-type)', level: 'error' },
  { re: /\.only\s*\(/, msg: 'contains test.only', level: 'error' },
  { re: /locator\(\s*['"`](?:#|\.|div|span|button|input|\/\/)/, msg: 'uses a CSS/XPath locator; prefer role, label or test id (fine only when no accessible alternative exists)', level: 'warning' },
  { re: /\.(first|last)\(\)|\.nth\(\d+\)/, msg: 'uses first()/last()/nth(); scope the locator to a row or list item instead', level: 'warning' },
];

export function lint(specFile) {
  const src = fs.readFileSync(specFile, 'utf8');
  const errors = [], warnings = [];
  for (const r of LINT) if (r.re.test(src)) (r.level === 'error' ? errors : warnings).push(r.msg);
  const n = (src.match(/\bexpect\s*\(/g) || []).length;
  if (n === 0) errors.push('no assertions: a Witness test must assert the checkpoints');
  if (n > 8) warnings.push(`${n} assertions: keep 2–5 checkpoints per flow`);
  return { ok: errors.length === 0, errors, warnings };
}

/** Scan the spec and the local files it imports for credential values. */
export function secretScan(specFile, credentials) {
  const files = new Set([specFile]);
  const src = fs.readFileSync(specFile, 'utf8');
  for (const m of src.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
    for (const ext of ['', '.ts', '.js', '.mjs', '/index.ts']) {
      const p = path.resolve(path.dirname(specFile), m[1] + ext);
      if (exists(p) && fs.statSync(p).isFile()) { files.add(p); break; }
    }
  }
  const errors = [];
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    for (const c of credentials) if (text.includes(c.value)) errors.push(`${path.basename(f)} contains the value of ${c.name}; read it from process.env instead`);
  }
  return { ok: errors.length === 0, errors, scanned: [...files].map((f) => path.basename(f)) };
}
