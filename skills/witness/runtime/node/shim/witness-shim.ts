/*
 * Witness instrumentation shim for @playwright/test.
 *
 * The Witness runner copies a project's test files into .witness/tmp/<run>/ and rewrites their
 * '@playwright/test' imports to this file. User files are never modified.
 *
 * Modes (env WITNESS_MODE):
 *   observe  – per-step evidence: aria snapshots before/after, effects, network, dialogs, settle time,
 *              verified locator candidates, assertions.
 *   vacuity  – like plain, but before each action evaluates the assertions that follow it
 *              (from WITNESS_VACUITY_PLAN). An assertion that already passes is vacuous.
 *   plain    – minimal bookkeeping (actions + assertion outcomes), no extra waits. Used for repeat runs.
 *
 * Output: one JSON evidence file per test run in WITNESS_EVIDENCE_DIR.
 * Uses only public Playwright APIs, plus Locator#_selector (read-only) for vacuity re-evaluation.
 */
import { test as base, expect as baseExpect } from '@playwright/test';
import type { Page, Locator, TestInfo } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

export * from '@playwright/test';

const MODE = (process.env.WITNESS_MODE || 'plain') as 'observe' | 'vacuity' | 'plain';
const OUT_DIR = process.env.WITNESS_EVIDENCE_DIR || '';
// Effects such as toasts often arrive a few hundred ms after the response; wait for a quiet window.
const SETTLE_MAX = Number(process.env.WITNESS_SETTLE_MAX_MS || 5000);
const SETTLE_QUIET = Number(process.env.WITNESS_SETTLE_QUIET_MS || 800);
const THROTTLE = Number(process.env.WITNESS_CPU_THROTTLE || 0);
const TEST_ID_ATTR = process.env.WITNESS_TEST_ID_ATTRIBUTE || 'data-testid';
// Plan for vacuity runs: { assertions: [...], values: [{ step, value }] }. The values are what each step
// typed in the observe run; tests that generate unique data type different values in each run, so the
// assertions' selectors and expected values are rewritten with this run's values before evaluation.
const VACUITY: { assertions: any[]; values: { step: number; value: string }[] } = (() => {
  try {
    if (!process.env.WITNESS_VACUITY_PLAN) return { assertions: [], values: [] };
    const p = JSON.parse(fs.readFileSync(process.env.WITNESS_VACUITY_PLAN, 'utf8'));
    return Array.isArray(p) ? { assertions: p, values: [] } : { assertions: p.assertions || [], values: p.values || [] };
  } catch { return { assertions: [], values: [] }; }
})();

const ACTIONS_LOCATOR = ['click', 'dblclick', 'fill', 'press', 'pressSequentially', 'type', 'check', 'uncheck',
  'setChecked', 'selectOption', 'setInputFiles', 'hover', 'tap', 'dragTo', 'clear', 'selectText', 'dispatchEvent'];
const ACTIONS_PAGE = ['goto', 'reload', 'goBack', 'goForward'];
const NO_EXPECTED = new Set(['toBeVisible', 'toBeHidden', 'toBeEnabled', 'toBeDisabled', 'toBeChecked', 'toBeEditable',
  'toBeEmpty', 'toBeFocused', 'toBeAttached', 'toBeInViewport']);

// ---------------------------------------------------------------- serialization helpers

function ser(v: any, depth = 0): any {
  if (v instanceof RegExp) return { $regex: v.source, flags: v.flags };
  if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) return v;
  if (v === undefined) return { $undefined: true };
  if (Array.isArray(v)) return depth > 3 ? '[array]' : v.map((x) => ser(x, depth + 1));
  if (typeof v === 'object') {
    if (typeof (v as any)._selector === 'string') return { $locator: String(v) };
    if (depth > 3) return '[object]';
    const o: any = {};
    for (const [k, x] of Object.entries(v)) if (typeof x !== 'function') o[k] = ser(x, depth + 1);
    return o;
  }
  return String(v);
}

function deser(v: any): any {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    if ('$regex' in v) return new RegExp(v.$regex, v.flags);
    if ('$undefined' in v) return undefined;
    const o: any = {};
    for (const [k, x] of Object.entries(v)) o[k] = deser(x);
    return o;
  }
  if (Array.isArray(v)) return v.map(deser);
  return v;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function parseAriaLine(snapshot: string) {
  const first = (snapshot || '').split('\n').find((l) => l.trim()) || '';
  const m = first.trim().match(/^-\s+([a-zA-Z]+)(?:\s+"((?:[^"\\]|\\.)*)")?((?:\s*\[[^\]]*\])*)\s*(?::\s*(.*))?$/);
  if (!m) return { ariaLine: first.trim(), role: null as string | null, name: null as string | null, text: null as string | null };
  return { ariaLine: first.trim(), role: m[1], name: m[2] ? m[2].replace(/\\"/g, '"') : null, text: m[4] || null };
}

// Line-level diff of two aria snapshots, keeping each line's ancestor path for context.
function linesWithPath(snapshot: string) {
  const out: { line: string; path: string[] }[] = [];
  const stack: { indent: number; line: string }[] = [];
  for (const raw of (snapshot || '').split('\n')) {
    if (!raw.trim()) continue;
    const indent = raw.search(/\S/);
    const line = raw.trim();
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    out.push({ line, path: stack.map((s) => s.line.replace(/:$/, '')) });
    stack.push({ indent, line });
  }
  return out;
}

function diffSnapshots(before: string, after: string) {
  const b = linesWithPath(before), a = linesWithPath(after);
  const key = (x: { line: string; path: string[] }) => x.path.join(' > ') + ' >> ' + x.line;
  const count = new Map<string, number>();
  for (const x of b) count.set(key(x), (count.get(key(x)) || 0) + 1);
  const added: typeof a = [];
  for (const x of a) {
    const k = key(x), c = count.get(k) || 0;
    if (c > 0) count.set(k, c - 1); else added.push(x);
  }
  const countA = new Map<string, number>();
  for (const x of a) countA.set(key(x), (countA.get(key(x)) || 0) + 1);
  const removed: typeof b = [];
  for (const x of b) {
    const k = key(x), c = countA.get(k) || 0;
    if (c > 0) countA.set(k, c - 1); else removed.push(x);
  }
  return { added, removed };
}

// ---------------------------------------------------------------- recorder

type Req = { id: number; method: string; url: string; path: string; resourceType: string; sameOrigin: boolean;
  step: number | null; status?: number; failure?: string; postData?: string; responseExcerpt?: string; t: number };

class Recorder {
  steps: any[] = [];
  assertions: any[] = [];
  requests: Req[] = [];
  dialogs: any[] = [];
  vacuity: any[] = [];
  busy = false;
  currentStep: number | null = null;
  inflight = 0;
  origin = '';
  initial: any = null;
  errors: string[] = [];
  private reqIds = new WeakMap<object, Req>();
  private seq = 0;

  constructor(public page: Page, public testInfo: TestInfo) {}

  attach() {
    const ctx = this.page.context();
    ctx.on('request', (r) => {
      this.inflight++;
      let u: URL | null = null;
      try { u = new URL(r.url()); } catch { /* data: urls etc. */ }
      if (!this.origin && r.resourceType() === 'document' && u) this.origin = u.origin;
      const rec: Req = {
        id: ++this.seq, method: r.method(), url: r.url(), path: u ? u.pathname + u.search : r.url(),
        resourceType: r.resourceType(), sameOrigin: !!u && (!this.origin || u.origin === this.origin),
        step: this.currentStep, t: Date.now(),
      };
      if (MODE === 'observe' && rec.method !== 'GET') {
        const pd = r.postData();
        if (pd) rec.postData = redact(pd).slice(0, 2000);
      }
      this.reqIds.set(r, rec);
      if (['document', 'xhr', 'fetch'].includes(rec.resourceType) || rec.method !== 'GET') this.requests.push(rec);
    });
    const done = async (r: any, failure?: string) => {
      this.inflight = Math.max(0, this.inflight - 1);
      const rec = this.reqIds.get(r);
      if (!rec) return;
      if (failure) { rec.failure = failure; return; }
      try {
        const resp = await r.response();
        rec.status = resp ? resp.status() : undefined;
        if (MODE === 'observe' && resp && ['xhr', 'fetch'].includes(rec.resourceType) && (rec.method !== 'GET' || (rec.status || 0) >= 400)) {
          const body = await resp.text().catch(() => '');
          rec.responseExcerpt = redact(body).slice(0, 600);
        }
      } catch { /* page closed */ }
    };
    ctx.on('requestfinished', (r) => { void done(r); });
    ctx.on('requestfailed', (r) => { void done(r, r.failure()?.errorText || 'failed'); });
    this.page.on('dialog', (d) => {
      this.dialogs.push({ step: this.currentStep, type: d.type(), message: d.message() });
      // Preserve Playwright's default (auto-dismiss) when the test registered no handler of its own.
      if ((this.page as any).listenerCount && (this.page as any).listenerCount('dialog') <= 1) d.dismiss().catch(() => {});
    });
  }

  async snap(page: Page): Promise<string> {
    try { return await page.locator('body').ariaSnapshot({ timeout: 2000 }); } catch { return ''; }
  }

  async settle(page: Page, start: string) {
    const t0 = Date.now();
    let last = start, lastChange = 0;
    while (Date.now() - t0 < SETTLE_MAX) {
      await sleep(100);
      const s = await this.snap(page);
      const now = Date.now() - t0;
      if (s !== last) { last = s; lastChange = now; }
      if (now - lastChange >= SETTLE_QUIET && this.inflight === 0 && now >= SETTLE_QUIET) break;
    }
    return { snapshot: last, settleMs: lastChange, timedOut: Date.now() - t0 >= SETTLE_MAX };
  }

  async describeTarget(loc: Locator) {
    const page = loc.page();
    const target: any = { locator: String(loc), selector: (loc as any)._selector };
    try { await loc.waitFor({ state: 'attached', timeout: 5000 }); } catch { target.unresolved = true; return target; }
    let handle: any = null;
    try {
      handle = await loc.elementHandle({ timeout: 2000 });
      const aria = await loc.ariaSnapshot({ timeout: 2000 }).catch(() => '');
      Object.assign(target, parseAriaLine(aria));
      target.inMainFrame = (await handle.ownerFrame()) === page.mainFrame();
      target.attrs = await handle.evaluate((el: any, testIdAttr: string) => {
        const label = el.labels && el.labels[0] ? el.labels[0].innerText.trim() : null;
        const container = el.closest('tr,li,[role=row],[role=listitem],article,[role=dialog],dialog,form,section');
        let containerRole: string | null = null, containerText: string | null = null;
        if (container) {
          const tag = container.tagName.toLowerCase();
          containerRole = container.getAttribute('role') || ({ tr: 'row', li: 'listitem', article: 'article', dialog: 'dialog', form: 'form', section: 'region' } as any)[tag] || null;
          const key = container.querySelector('strong,h1,h2,h3,h4,td,th,legend');
          containerText = key ? (key as HTMLElement).innerText.trim().slice(0, 60) : null;
        }
        return {
          tag: el.tagName.toLowerCase(), id: el.id || null, testId: el.getAttribute(testIdAttr), nameAttr: el.getAttribute('name'),
          type: el.getAttribute('type'), placeholder: el.getAttribute('placeholder'), ariaLabel: el.getAttribute('aria-label'),
          title: el.getAttribute('title'), label, text: (el.innerText || '').trim().slice(0, 80) || null, containerRole, containerText,
        };
      }, TEST_ID_ATTR);
      if (target.inMainFrame) target.candidates = await this.candidates(page, target, handle);
    } catch (e: any) {
      target.describeError = String(e && e.message || e).split('\n')[0];
    } finally {
      if (handle) await handle.dispose().catch(() => {});
    }
    return target;
  }

  async candidates(page: Page, t: any, handle: any) {
    const a = t.attrs || {};
    const list: { kind: string; loc: Locator }[] = [];
    const roleOk = t.role && !['text', 'generic', 'paragraph', 'none', 'presentation'].includes(t.role);
    if (roleOk) list.push({ kind: 'role', loc: page.getByRole(t.role, t.name ? { name: t.name, exact: true } : {}) });
    if (a.label) list.push({ kind: 'label', loc: page.getByLabel(a.label, { exact: true }) });
    if (a.placeholder) list.push({ kind: 'placeholder', loc: page.getByPlaceholder(a.placeholder, { exact: true }) });
    if (a.testId) list.push({ kind: 'testid', loc: page.getByTestId(a.testId) });
    if (a.text && a.text.length <= 60 && !a.text.includes('\n')) list.push({ kind: 'text', loc: page.getByText(a.text, { exact: true }) });
    if (roleOk && a.containerRole && a.containerText) {
      const scope = page.getByRole(a.containerRole as any).filter({ hasText: a.containerText });
      list.push({ kind: 'scoped-role', loc: scope.getByRole(t.role, t.name ? { name: t.name, exact: true } : {}) });
    }
    const out: any[] = [];
    for (const c of list) {
      try {
        const count = await c.loc.count();
        const index = count ? await c.loc.evaluateAll((els, el) => els.indexOf(el as any), handle) : -1;
        out.push({ kind: c.kind, code: String(c.loc), count, matchesTarget: count === 1 && index === 0, index });
      } catch (e: any) {
        out.push({ kind: c.kind, code: String(c.loc), error: String(e.message || e).split('\n')[0] });
      }
    }
    return out;
  }

  async step(self: any, method: string, args: any[], run: () => Promise<any>) {
    const isPage = typeof self.goto === 'function' && typeof self.mainFrame === 'function';
    const page: Page = isPage ? self : self.page();
    const index = this.steps.length;
    const step: any = { index, method, on: isPage ? 'page' : 'locator', args: ser(args), startedAt: Date.now() };
    this.steps.push(step);
    this.busy = true;
    try {
      if (MODE === 'vacuity') {
        if (typeof args[0] === 'string' && ['fill', 'type', 'pressSequentially', 'selectOption'].includes(method)) this.typed[index] = args[0];
        await this.checkVacuity(page, index);
      }
      if (MODE === 'observe') {
        // Resolve the target first: the state "before" an action is the state once its target exists.
        if (!isPage) step.target = await this.describeTarget(self);
        step.urlBefore = page.url();
        step.snapshotBefore = await this.snap(page);
        if (!this.initial) this.initial = { url: step.urlBefore, snapshot: step.snapshotBefore };
      } else if (!isPage) {
        step.target = { locator: String(self), selector: self._selector };
      }
    } finally { this.busy = false; }

    this.currentStep = index;
    let result: any;
    try {
      result = await run();
    } catch (e: any) {
      step.error = String(e && e.message || e).replace(/\u001b\[[0-9;]*m/g, '').split('\n').slice(0, 3).join(' ');
      step.durationMs = Date.now() - step.startedAt;
      this.currentStep = null;
      throw e;
    }
    this.busy = true;
    try {
      if (MODE === 'observe') {
        const s = await this.settle(page, await this.snap(page));
        step.snapshotAfter = s.snapshot;
        step.settleMs = s.settleMs;
        step.settleTimedOut = s.timedOut;
        step.urlAfter = page.url();
        const d = diffSnapshots(step.snapshotBefore, step.snapshotAfter);
        step.added = d.added;
        step.removed = d.removed;
      }
    } finally { this.busy = false; }
    this.currentStep = null;
    step.durationMs = Date.now() - step.startedAt;
    return result;
  }

  typed: Record<number, string> = {};

  /** Replace values typed in the observe run with the values typed in this run (longest first). */
  substitute(text: string): string {
    const pairs = VACUITY.values
      .filter((v) => typeof this.typed[v.step] === 'string' && this.typed[v.step] !== v.value && String(v.value).length >= 3)
      .map((v) => [String(v.value), this.typed[v.step]] as [string, string])
      .sort((a, b) => b[0].length - a[0].length);
    let out = text;
    for (const [from, to] of pairs) out = out.split(from).join(to);
    return out;
  }

  async checkVacuity(page: Page, actionIndex: number) {
    for (const p of VACUITY.assertions.filter((x) => x.afterStep === actionIndex)) {
      const r: any = { order: p.order, afterStep: p.afterStep, matcher: p.matcher, isNot: p.isNot };
      try {
        if (!p.selector && p.kind === 'locator') { r.checked = false; r.reason = 'no selector'; this.vacuity.push(r); continue; }
        const selector = p.selector ? this.substitute(p.selector) : p.selector;
        const target = p.kind === 'page' ? page : page.locator(selector);
        const json = JSON.stringify(p.args || []);
        const args = deser(JSON.parse(this.substitute(json)));
        if (selector !== p.selector || JSON.stringify(args) !== json) r.substituted = true;
        const optIndex = NO_EXPECTED.has(p.matcher) ? 0 : 1;
        args[optIndex] = Object.assign({}, args[optIndex] || {}, { timeout: 300 });
        let e: any = baseExpect(target as any);
        if (p.isNot) e = e.not;
        await e[p.matcher](...args);
        r.checked = true; r.passedBeforeAction = true;
      } catch (err: any) {
        r.checked = true; r.passedBeforeAction = false;
      }
      this.vacuity.push(r);
    }
  }

  write(testInfo: TestInfo) {
    if (!OUT_DIR) return;
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const slug = (s: string) => s.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
    const file = path.join(OUT_DIR, `${slug(path.basename(testInfo.file))}__${slug(testInfo.title)}__${slug(testInfo.project.name || 'p')}__r${testInfo.repeatEachIndex}__t${testInfo.retry}.json`);
    const data = {
      version: 1, runtime: 'node', mode: MODE, file: testInfo.file, title: testInfo.title, titlePath: testInfo.titlePath,
      project: testInfo.project.name, repeat: testInfo.repeatEachIndex, status: testInfo.status, durationMs: testInfo.duration,
      error: testInfo.error ? String(testInfo.error.message || '').replace(/\u001b\[[0-9;]*m/g, '').split('\n').slice(0, 6).join('\n') : null,
      origin: this.origin, initial: this.initial,
      final: MODE === 'observe' ? { url: this.page.isClosed() ? null : this.page.url(), snapshot: this.lastSnapshot } : null,
      steps: this.steps, assertions: this.assertions, requests: this.requests, dialogs: this.dialogs, vacuity: this.vacuity,
    };
    fs.writeFileSync(file, JSON.stringify(data, null, 1));
  }

  lastSnapshot = '';
}

function redact(s: string) {
  let out = s;
  for (const [k, v] of Object.entries(process.env)) {
    if (v && v.length >= 4 && /(PASS|SECRET|TOKEN|KEY|PWD)/i.test(k)) out = out.split(v).join('«redacted:' + k + '»');
  }
  return out.replace(/("(?:password|pass|secret|token|apiKey|api_key)"\s*:\s*")[^"]*"/gi, '$1«redacted»"');
}

// ---------------------------------------------------------------- patching

let current: Recorder | null = null;
let patched = false;

function wrap(proto: any, names: string[]) {
  for (const name of names) {
    const orig = proto[name];
    if (typeof orig !== 'function' || orig.__witness) continue;
    // Call through bind() so Playwright still names the call "locator.click" (not "locator.apply")
    // in error messages, reports and traces.
    const w = function (this: any, ...args: any[]) {
      const call = orig.bind(this);
      const rec = current;
      if (!rec || rec.busy) return call(...args);
      return rec.step(this, name, args, () => call(...args));
    };
    (w as any).__witness = true;
    proto[name] = w;
  }
}

function patch(page: Page) {
  if (patched) return;
  patched = true;
  wrap(Object.getPrototypeOf(page.locator('body')), ACTIONS_LOCATOR);
  wrap(Object.getPrototypeOf(page), ACTIONS_PAGE);
}

// ---------------------------------------------------------------- expect wrapper

function wrapMatchers(target: any, actual: any, isNot: boolean): any {
  return new Proxy(target, {
    get(t, prop: any, recv) {
      const v = Reflect.get(t, prop, recv);
      if (prop === 'not') return wrapMatchers(v, actual, !isNot);
      if (typeof prop !== 'string' || typeof v !== 'function' || !prop.startsWith('to')) return v;
      return (...args: any[]) => {
        const rec = current;
        if (!rec || rec.busy) return v.apply(t, args);
        const isLocator = actual && typeof actual._selector === 'string';
        const isPage = actual && typeof actual.goto === 'function' && typeof actual.mainFrame === 'function';
        const entry: any = {
          order: rec.assertions.length, afterStep: rec.steps.length - 1, matcher: prop, isNot,
          kind: isLocator ? 'locator' : isPage ? 'page' : 'value', args: ser(args),
          locator: isLocator ? String(actual) : isPage ? 'page' : null, selector: isLocator ? actual._selector : null,
        };
        rec.assertions.push(entry);
        const finish = (ok: boolean, err?: any) => { entry.passed = ok; if (err) entry.error = String(err.message || err).split('\n')[0]; };
        try {
          const r = v.apply(t, args);
          if (r && typeof r.then === 'function') return r.then((x: any) => { finish(true); return x; }, (e: any) => { finish(false, e); throw e; });
          finish(true);
          return r;
        } catch (e) { finish(false, e); throw e; }
      };
    },
  });
}

export const expect: typeof baseExpect = new Proxy(baseExpect, {
  apply(t, thisArg, args: any[]) {
    const real = Reflect.apply(t as any, thisArg, args);
    return wrapMatchers(real, args[0], false);
  },
}) as any;

// ---------------------------------------------------------------- fixture

export const test = base.extend<{ _witness: void }>({
  _witness: [async ({ page }, use, testInfo) => {
    patch(page);
    if (THROTTLE > 1) {
      try {
        const cdp = await page.context().newCDPSession(page);
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
      } catch { /* non-chromium */ }
    }
    const rec = new Recorder(page, testInfo);
    rec.attach();
    current = rec;
    try {
      await use();
    } finally {
      if (MODE === 'observe' && !page.isClosed()) {
        rec.busy = true;
        rec.lastSnapshot = await rec.snap(page);
        rec.busy = false;
      }
      current = null;
      rec.write(testInfo);
    }
  }, { auto: true }],
});

export default test;
